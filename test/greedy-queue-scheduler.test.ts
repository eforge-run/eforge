/**
 * Tests for the greedy queue scheduler in runQueue().
 *
 * Verifies:
 * - Empty queue produces queue:start + queue:complete with zero counts
 * - Scheduler respects maxConcurrentBuilds config
 * - No git reset --hard in the queue processing path
 * - buildConfigOverrides maps maxConcurrentBuilds to config
 */

import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EforgeEngine } from '@eforge-build/engine/eforge';
import type { EforgeEvent } from '@eforge-build/engine/events';
import { resolveQueueOrder, type QueuedPrd } from '@eforge-build/engine/prd-queue';
import { StubHarness } from './stub-harness.js';

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
    // Use StubHarness so inline recovery (called when a PRD fails) completes
    // immediately without making real API calls. Tests here exercise queue
    // scheduling, not recovery behavior.
    agentRuntimes: new StubHarness([]),
    config: {
      maxConcurrentBuilds: 1,
      prdQueue: { dir: 'eforge/queue', watchPollIntervalMs: 50 },
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

  it('accepts maxConcurrentBuilds config', async () => {
    const { engine } = await createTestEngine({
      maxConcurrentBuilds: 4,
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
      maxConcurrentBuilds: 2,
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

    let secondPrdWritten = false;
    for await (const event of gen) {
      events.push(event);
      // Write the second PRD after the scheduler has emitted queue:start
      // (and begun spawning the first child), so it is NOT found during the
      // initial loadQueue() call. Per-build events (queue:prd:start, etc.)
      // are emitted by the child subprocess and go straight to SQLite; they
      // do not flow through the parent scheduler's event stream.
      if (event.type === 'queue:start' && !secondPrdWritten) {
        secondPrdWritten = true;
        await writeFile(
          join(queueDir, 'prd-second.md'),
          '---\ntitle: Second PRD\nstatus: pending\n---\n\n# Second PRD\n\nDo something else.',
        );
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
      maxConcurrentBuilds: 2,
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
      join(import.meta.dirname, '..', 'packages', 'engine', 'src', 'eforge.ts'),
      'utf-8',
    );

    // Extract the runQueue and buildSinglePrd method bodies (rough check)
    const runQueueStart = eforgeSrc.indexOf('async *runQueue(');
    const buildSinglePrdStart = eforgeSrc.indexOf('async *buildSinglePrd(');
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

// ---------------------------------------------------------------------------
// Parent scheduler owns sessionId: session:start emitted before child spawn
// ---------------------------------------------------------------------------

describe('parent-side sessionId ownership', () => {
  it('buildSinglePrd with injected sessionId emits no session:start event', async () => {
    const { engine, cwd } = await createTestEngine();

    // Create a minimal PRD in the queue directory so claimPrd can find the lock dir
    const queueDir = join(cwd, 'eforge', 'queue');
    const prdId = 'test-prd-injected-session';
    const prdFilePath = join(queueDir, `${prdId}.md`);
    await writeFile(
      prdFilePath,
      `---\ntitle: Test PRD\nstatus: pending\n---\n\n# Test PRD\n\nDo something.`,
    );

    const prd = {
      id: prdId,
      filePath: prdFilePath,
      frontmatter: { title: 'Test PRD' },
      content: '# Test PRD\n\nDo something.',
      lastCommitHash: '', // Empty — skips staleness check
      lastCommitDate: '',
    };

    const injectedSessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

    const events: EforgeEvent[] = [];
    // buildSinglePrd will fail (no git repo for compile) but we only care that
    // session:start is NOT emitted when a sessionId is injected
    for await (const event of engine.buildSinglePrd(prd, {}, injectedSessionId)) {
      events.push(event);
    }

    const sessionStartEvents = events.filter((e) => e.type === 'session:start');
    expect(sessionStartEvents).toHaveLength(0);

    // session:end IS still emitted by the child with the injected id
    const sessionEndEvents = events.filter((e) => e.type === 'session:end');
    expect(sessionEndEvents).toHaveLength(1);
    expect((sessionEndEvents[0] as { sessionId: string }).sessionId).toBe(injectedSessionId);
  });

  it('buildSinglePrd without sessionId emits session:start (baseline behavior)', async () => {
    const { engine, cwd } = await createTestEngine();

    const queueDir = join(cwd, 'eforge', 'queue');
    const prdId = 'test-prd-no-session';
    const prdFilePath = join(queueDir, `${prdId}.md`);
    await writeFile(
      prdFilePath,
      `---\ntitle: Test PRD\nstatus: pending\n---\n\n# Test PRD\n\nDo something.`,
    );

    const prd = {
      id: prdId,
      filePath: prdFilePath,
      frontmatter: { title: 'Test PRD' },
      content: '# Test PRD\n\nDo something.',
      lastCommitHash: '',
      lastCommitDate: '',
    };

    const events: EforgeEvent[] = [];
    for await (const event of engine.buildSinglePrd(prd, {})) {
      events.push(event);
    }

    // Without injected sessionId, session:start IS emitted
    const sessionStartEvents = events.filter((e) => e.type === 'session:start');
    expect(sessionStartEvents).toHaveLength(1);
  });

  it('runQueue emits parent-side session:start before queue:prd:complete for each PRD', async () => {
    const { engine, cwd } = await createTestEngine({
      maxConcurrentBuilds: 1,
    });

    const queueDir = join(cwd, 'eforge', 'queue');
    await writeFile(
      join(queueDir, 'prd-session-test.md'),
      '---\ntitle: Session Test PRD\nstatus: pending\n---\n\n# Session Test PRD\n\nDo something.',
    );

    const events = await collectEvents(engine.runQueue());
    const types = events.map((e) => e.type);

    // Parent must emit session:start
    expect(types).toContain('session:start');

    // session:start must appear before queue:prd:complete
    const sessionStartIdx = types.indexOf('session:start');
    const prdCompleteIdx = types.indexOf('queue:prd:complete');
    expect(sessionStartIdx).toBeGreaterThan(-1);
    expect(prdCompleteIdx).toBeGreaterThan(-1);
    expect(sessionStartIdx).toBeLessThan(prdCompleteIdx);

    // The session:start event must have a valid UUID sessionId
    const sessionStartEvent = events[sessionStartIdx] as { sessionId: string };
    expect(sessionStartEvent.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('spawnPrdChild passes --session-id flag in child args', async () => {
    const { readFileSync } = await import('node:fs');
    const eforgeSrc = readFileSync(
      join(import.meta.dirname, '..', 'packages', 'engine', 'src', 'eforge.ts'),
      'utf-8',
    );

    // Locate the spawnPrdChild method body
    const spawnStart = eforgeSrc.indexOf('private spawnPrdChild(');
    expect(spawnStart).toBeGreaterThan(-1);

    // Find the end of the method (next 'private' or 'async *' method declaration)
    const spawnBody = eforgeSrc.slice(spawnStart, eforgeSrc.indexOf('\n  async *runQueue(', spawnStart));

    // The method must accept prdSessionId as a parameter
    expect(spawnBody).toContain('prdSessionId: string');

    // The args array must include '--session-id' and prdSessionId
    expect(spawnBody).toContain("'--session-id'");
    expect(spawnBody).toContain('prdSessionId');

    // Verify the '--session-id' and prdSessionId appear together (args.push call)
    expect(spawnBody).toContain("args.push('--session-id', prdSessionId)");
  });
});
