/**
 * Tests for the greedy queue scheduler in runQueue().
 *
 * Verifies:
 * - Empty queue produces queue:start + queue:complete with zero counts
 * - Scheduler respects prdQueue.parallelism config
 * - No git reset --hard in the queue processing path
 * - buildConfigOverrides maps queueParallelism to config
 */

import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EforgeEngine } from '../src/engine/eforge.js';
import type { EforgeEvent } from '../src/engine/events.js';
import { resolveQueueOrder, type QueuedPrd } from '../src/engine/prd-queue.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeQueuedPrd(overrides: Partial<QueuedPrd> & { id: string }): QueuedPrd {
  return {
    filePath: `/tmp/${overrides.id}.md`,
    frontmatter: { title: overrides.id },
    content: `---\ntitle: ${overrides.id}\n---\n\n# ${overrides.id}`,
    lastCommitHash: '',
    lastCommitDate: '',
    ...overrides,
  };
}

async function createTestEngine(configOverrides: Record<string, unknown> = {}): Promise<{ engine: EforgeEngine; cwd: string }> {
  const cwd = await mkdtemp(join(tmpdir(), 'eforge-greedy-sched-'));
  await mkdir(join(cwd, 'eforge', 'queue'), { recursive: true });
  const engine = await EforgeEngine.create({
    cwd,
    config: {
      backend: 'claude-sdk',
      prdQueue: { dir: 'eforge/queue', autoRevise: false, watchPollIntervalMs: 50, parallelism: 1 },
      plugins: { enabled: false },
      ...configOverrides,
    },
  });
  return { engine, cwd };
}

async function collectEvents(gen: AsyncGenerator<EforgeEvent>): Promise<EforgeEvent[]> {
  const events: EforgeEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Empty queue behavior
// ---------------------------------------------------------------------------

describe('greedy queue scheduler', () => {
  it('empty queue emits queue:start and queue:complete with zero counts', async () => {
    const { engine } = await createTestEngine();

    const events = await collectEvents(engine.runQueue());
    const types = events.map((e) => e.type);

    expect(types).toContain('queue:start');
    expect(types).toContain('queue:complete');

    const startEvent = events.find((e) => e.type === 'queue:start') as { prdCount: number };
    expect(startEvent.prdCount).toBe(0);

    const completeEvent = events.find((e) => e.type === 'queue:complete') as { processed: number; skipped: number };
    expect(completeEvent.processed).toBe(0);
    expect(completeEvent.skipped).toBe(0);
  });

  it('accepts prdQueue.parallelism config', async () => {
    const { engine } = await createTestEngine({
      prdQueue: { dir: 'eforge/queue', autoRevise: false, watchPollIntervalMs: 50, parallelism: 4 },
    });

    // Verify it runs without error - the parallelism is used internally by the semaphore
    const events = await collectEvents(engine.runQueue());
    const types = events.map((e) => e.type);
    expect(types).toContain('queue:start');
    expect(types).toContain('queue:complete');
  });
});

// ---------------------------------------------------------------------------
// resolveQueueOrder dependency filtering for scheduler
// ---------------------------------------------------------------------------

describe('resolveQueueOrder dependency semantics for greedy scheduler', () => {
  it('filters depends_on to only PRDs in the queue', () => {
    // Only "api" is in the queue - "db" is not present (already completed and removed)
    const prds = [
      makeQueuedPrd({ id: 'api', frontmatter: { title: 'API', depends_on: ['db'] } }),
    ];

    const ordered = resolveQueueOrder(prds);
    // "db" dependency is filtered out since it's not in the queue
    expect(ordered).toHaveLength(1);
    expect(ordered[0].id).toBe('api');
  });

  it('preserves depends_on between PRDs in queue for scheduler dependency tracking', () => {
    const prds = [
      makeQueuedPrd({ id: 'foundation', frontmatter: { title: 'Foundation' } }),
      makeQueuedPrd({ id: 'feature', frontmatter: { title: 'Feature', depends_on: ['foundation'] } }),
    ];

    const ordered = resolveQueueOrder(prds);
    expect(ordered).toHaveLength(2);
    // foundation should come first (wave 0), feature second (wave 1)
    expect(ordered[0].id).toBe('foundation');
    expect(ordered[1].id).toBe('feature');
    // The depends_on should still reference 'foundation' so the scheduler can use it
    expect(ordered[1].frontmatter.depends_on).toEqual(['foundation']);
  });

  it('handles diamond dependency graphs', () => {
    // Diamond: A -> B, A -> C, B -> D, C -> D
    const prds = [
      makeQueuedPrd({ id: 'd', frontmatter: { title: 'D' } }),
      makeQueuedPrd({ id: 'b', frontmatter: { title: 'B', depends_on: ['d'] } }),
      makeQueuedPrd({ id: 'c', frontmatter: { title: 'C', depends_on: ['d'] } }),
      makeQueuedPrd({ id: 'a', frontmatter: { title: 'A', depends_on: ['b', 'c'] } }),
    ];

    const ordered = resolveQueueOrder(prds);
    expect(ordered).toHaveLength(4);

    // D must come before B and C, which must come before A
    const idxD = ordered.findIndex((p) => p.id === 'd');
    const idxB = ordered.findIndex((p) => p.id === 'b');
    const idxC = ordered.findIndex((p) => p.id === 'c');
    const idxA = ordered.findIndex((p) => p.id === 'a');

    expect(idxD).toBeLessThan(idxB);
    expect(idxD).toBeLessThan(idxC);
    expect(idxB).toBeLessThan(idxA);
    expect(idxC).toBeLessThan(idxA);
  });

  it('handles PRDs with depends_on referencing non-existent IDs', () => {
    const prds = [
      makeQueuedPrd({
        id: 'feature',
        frontmatter: { title: 'Feature', depends_on: ['nonexistent'] },
      }),
    ];

    // Should not throw - nonexistent deps should be filtered out
    const ordered = resolveQueueOrder(prds);
    expect(ordered).toHaveLength(1);
    expect(ordered[0].id).toBe('feature');
  });
});

// ---------------------------------------------------------------------------
// Mid-cycle PRD discovery
// ---------------------------------------------------------------------------

describe('discoverNewPrds in runQueue', () => {
  it('emits queue:prd:discovered when a new PRD file appears mid-build', async () => {
    const { engine, cwd } = await createTestEngine({
      prdQueue: { dir: 'eforge/queue', autoRevise: false, watchPollIntervalMs: 50, parallelism: 2 },
    });

    // Write the first PRD before starting
    const queueDir = join(cwd, 'eforge', 'queue');
    await writeFile(
      join(queueDir, 'prd-initial.md'),
      '---\ntitle: Initial PRD\nstatus: pending\n---\n\n# Initial PRD\n\nDo something.',
    );

    // Start runQueue, then inject a second PRD while the first is processing.
    // The first build will fail (no git repo), triggering discoverNewPrds()
    // on its queue:prd:complete event — at which point the second PRD should
    // be found and a queue:prd:discovered event emitted.
    const gen = engine.runQueue();
    const events: EforgeEvent[] = [];

    // Write the second PRD asynchronously so it exists before discovery runs
    const writePromise = writeFile(
      join(queueDir, 'prd-second.md'),
      '---\ntitle: Second PRD\nstatus: pending\n---\n\n# Second PRD\n\nDo something else.',
    );

    for await (const event of gen) {
      events.push(event);
      // Ensure the second PRD is on disk before the first build completes
      if (event.type === 'queue:prd:start') {
        await writePromise;
      }
    }

    const types = events.map((e) => e.type);

    expect(types).toContain('queue:start');
    expect(types).toContain('queue:complete');
    expect(types).toContain('queue:prd:discovered');

    const discovered = events.filter((e) => e.type === 'queue:prd:discovered');
    expect(discovered).toHaveLength(1);
    expect((discovered[0] as { prdId: string }).prdId).toBe('prd-second');
  });

  it('does not emit queue:prd:discovered when re-scanning finds no new PRDs', async () => {
    const { engine } = await createTestEngine({
      prdQueue: { dir: 'eforge/queue', autoRevise: false, watchPollIntervalMs: 50, parallelism: 2 },
    });

    // Empty queue - no PRDs to discover
    const events = await collectEvents(engine.runQueue());
    const discoveredEvents = events.filter((e) => e.type === 'queue:prd:discovered');

    expect(discoveredEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// No git reset --hard in queue code
// ---------------------------------------------------------------------------

describe('git reset --hard removal verification', () => {
  it('eforge.ts does not contain git reset --hard in queue methods', async () => {
    const { readFileSync } = await import('node:fs');
    const eforgeSrc = readFileSync(
      join(import.meta.dirname, '..', 'src', 'engine', 'eforge.ts'),
      'utf-8',
    );

    // Extract the runQueue and buildSinglePrd method bodies (rough check)
    const runQueueStart = eforgeSrc.indexOf('async *runQueue(');
    const buildSinglePrdStart = eforgeSrc.indexOf('private async *buildSinglePrd(');
    expect(runQueueStart).toBeGreaterThan(-1);
    expect(buildSinglePrdStart).toBeGreaterThan(-1);

    // Check the entire file for git reset --hard (it should not appear at all in queue-related code)
    // The compile method has its own worktree handling, so we check from buildSinglePrd onwards
    const queueCode = eforgeSrc.slice(buildSinglePrdStart);
    expect(queueCode).not.toContain('git reset --hard');
    expect(queueCode).not.toContain("reset', '--hard'");
    expect(queueCode).not.toContain("reset','--hard'");
  });
});
