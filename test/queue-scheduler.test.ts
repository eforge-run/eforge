/**
 * Unit tests for QueueScheduler.
 *
 * Drives the scheduler in isolation with a stub EventEmitter bus and a stub
 * spawnPrdChild. No subprocess, no daemon, no filesystem watcher.
 *
 * Tests:
 *   1. queue:mutation event triggers discovery + spawn of a newly-discovered PRD.
 *   2. queue:prd:complete (completed) triggers discovery + spawn of a dependent PRD.
 *   3. queue:prd:complete (failed) marks dependents as blocked (no spawn).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueScheduler, SCHEDULER_INPUT_TYPES, type SchedulerInputEvent } from '@eforge-build/engine/queue/scheduler';
import { AsyncEventQueue } from '@eforge-build/engine/concurrency';
import type { EforgeEvent } from '@eforge-build/engine/events';
import type { QueuedPrd } from '@eforge-build/engine/prd-queue';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeQueuedPrd(id: string, dependsOn: string[] = []): QueuedPrd {
  return {
    id,
    filePath: `/tmp/${id}.md`,
    frontmatter: { title: id, depends_on: dependsOn.length ? dependsOn : undefined },
    content: `---\ntitle: ${id}\n---\n\n# ${id}`,
    lastCommitHash: '',
    lastCommitDate: '',
  };
}

async function createTestEnv(): Promise<{
  cwd: string;
  queueDir: string;
  bus: EventEmitter;
  eventQueue: AsyncEventQueue<EforgeEvent>;
  spawnPrdChild: ReturnType<typeof vi.fn>;
  makeScheduler: (initialPrds: QueuedPrd[]) => QueueScheduler;
}> {
  const cwd = await mkdtemp(join(tmpdir(), 'eforge-sched-unit-'));
  const queueDir = 'eforge/queue';
  await mkdir(join(cwd, 'eforge', 'queue'), { recursive: true });

  const bus = new EventEmitter();
  const eventQueue = new AsyncEventQueue<EforgeEvent>();
  // Keep the queue alive for the duration of the test (watcher producer).
  eventQueue.addProducer();

  // Stub spawnPrdChild: resolves to 'completed' by default.
  const spawnPrdChild = vi.fn<[QueuedPrd, unknown, string], Promise<'completed' | 'failed' | 'skipped'>>()
    .mockResolvedValue('completed');

  const abortController = new AbortController();

  const makeScheduler = (initialPrds: QueuedPrd[]): QueueScheduler =>
    new QueueScheduler({
      bus,
      cwd,
      queueDir,
      config: {
        maxConcurrentBuilds: 2,
        prdQueue: { dir: queueDir, watchPollIntervalMs: 0 },
        plugins: { enabled: false },
      } as unknown as import('@eforge-build/engine/config').EforgeConfig,
      configProfile: { name: null, source: 'none', scope: null, config: null },
      parallelism: 2,
      abortController,
      eventQueue,
      spawnPrdChild,
      options: { auto: true },
      initialPrds,
    });

  return { cwd, queueDir, bus, eventQueue, spawnPrdChild, makeScheduler };
}

// ---------------------------------------------------------------------------
// SCHEDULER_INPUT_TYPES export check
// ---------------------------------------------------------------------------

describe('SCHEDULER_INPUT_TYPES', () => {
  it('contains queue:mutation and queue:prd:complete', () => {
    expect(SCHEDULER_INPUT_TYPES.has('queue:mutation')).toBe(true);
    expect(SCHEDULER_INPUT_TYPES.has('queue:prd:complete')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 1: queue:mutation triggers discovery and spawn
// ---------------------------------------------------------------------------

describe('QueueScheduler — queue:mutation event', () => {
  it('triggers discoverNewPrds and startReadyPrds when injected', async () => {
    const { cwd, queueDir, bus, eventQueue, spawnPrdChild, makeScheduler } = await createTestEnv();

    // Start with empty initial PRDs
    const scheduler = makeScheduler([]);
    await scheduler.start();

    // Write a PRD file to the queue directory
    const prdContent = '---\ntitle: New PRD\nstatus: pending\n---\n\n# New PRD\n\nDo something.';
    await writeFile(join(cwd, 'eforge', 'queue', 'new-prd.md'), prdContent);

    // Inject a queue:mutation event
    const mutationEvent: SchedulerInputEvent = {
      type: 'queue:mutation',
      reason: 'enqueue',
      timestamp: new Date().toISOString(),
    };
    bus.emit('queue:mutation', mutationEvent);

    // Wait for the scheduler to react: discoverNewPrds + startReadyPrds
    await new Promise((r) => setTimeout(r, 200));

    // Drain available events from the queue
    const events = eventQueue.drainAvailable();
    const types = events.map((e) => e.type);

    // Should have discovered the PRD
    expect(types).toContain('queue:prd:discovered');
    const discovered = events.find((e) => e.type === 'queue:prd:discovered') as { prdId: string } | undefined;
    expect(discovered?.prdId).toBe('new-prd');

    // Should have spawned a build (session:start emitted before spawnPrdChild)
    expect(types).toContain('session:start');
    expect(spawnPrdChild).toHaveBeenCalledOnce();
    expect(spawnPrdChild.mock.calls[0][0].id).toBe('new-prd');

    // Release the watcher producer so the queue can terminate
    eventQueue.removeProducer();
  });
});

// ---------------------------------------------------------------------------
// Test 2: queue:prd:complete (completed) unblocks dependent PRD
// ---------------------------------------------------------------------------

describe('QueueScheduler — queue:prd:complete (completed)', () => {
  it('spawns dependent PRD after upstream completes', async () => {
    const { bus, eventQueue, spawnPrdChild, makeScheduler } = await createTestEnv();

    // Two PRDs: 'foundation' (no deps) and 'feature' (depends_on: ['foundation'])
    const foundation = makeQueuedPrd('foundation');
    const feature = makeQueuedPrd('feature', ['foundation']);

    // spawnPrdChild: foundation completes successfully; feature also resolves
    spawnPrdChild.mockResolvedValueOnce('completed').mockResolvedValueOnce('completed');

    const scheduler = makeScheduler([foundation, feature]);
    await scheduler.start();

    // start() calls startReadyPrds() — 'foundation' is ready, 'feature' is not yet
    await new Promise((r) => setTimeout(r, 50));
    expect(spawnPrdChild).toHaveBeenCalledTimes(1);
    expect(spawnPrdChild.mock.calls[0][0].id).toBe('foundation');

    // Simulate foundation completing: the pump would emit this on the bus
    const completeEvent: SchedulerInputEvent = {
      type: 'queue:prd:complete',
      prdId: 'foundation',
      status: 'completed',
      timestamp: new Date().toISOString(),
    };
    bus.emit('queue:prd:complete', completeEvent);

    // Wait for onComplete to run (async)
    await new Promise((r) => setTimeout(r, 200));

    // Feature should now be spawned
    expect(spawnPrdChild).toHaveBeenCalledTimes(2);
    expect(spawnPrdChild.mock.calls[1][0].id).toBe('feature');

    // Counters: foundation processed (not skipped)
    expect(scheduler.processed).toBe(1);
    expect(scheduler.skipped).toBe(0);

    eventQueue.removeProducer();
  });
});

// ---------------------------------------------------------------------------
// Test 3: queue:prd:complete (failed) blocks dependents
// ---------------------------------------------------------------------------

describe('QueueScheduler — queue:prd:complete (failed)', () => {
  it('marks dependent PRDs as blocked without spawning them', async () => {
    const { bus, eventQueue, spawnPrdChild, makeScheduler } = await createTestEnv();

    const foundation = makeQueuedPrd('foundation');
    const feature = makeQueuedPrd('feature', ['foundation']);

    // foundation fails
    spawnPrdChild.mockResolvedValueOnce('failed');

    const scheduler = makeScheduler([foundation, feature]);
    await scheduler.start();

    // Only foundation is spawned initially
    await new Promise((r) => setTimeout(r, 50));
    expect(spawnPrdChild).toHaveBeenCalledTimes(1);
    expect(spawnPrdChild.mock.calls[0][0].id).toBe('foundation');

    // Simulate foundation failing
    const failEvent: SchedulerInputEvent = {
      type: 'queue:prd:complete',
      prdId: 'foundation',
      status: 'failed',
      timestamp: new Date().toISOString(),
    };
    bus.emit('queue:prd:complete', failEvent);

    // Wait for onComplete to run
    await new Promise((r) => setTimeout(r, 200));

    // Feature should NOT have been spawned (it's blocked)
    expect(spawnPrdChild).toHaveBeenCalledTimes(1);

    // Finalize counts: foundation processed (failed), feature will be counted as skipped
    scheduler.finalizeBlockedAsSkipped();
    expect(scheduler.processed).toBe(1); // foundation was processed (failed, not skipped)
    expect(scheduler.skipped).toBe(1);   // feature was blocked → skipped

    eventQueue.removeProducer();
  });
});

// ---------------------------------------------------------------------------
// Test 4: pause() prevents new PRD from being dequeued
// ---------------------------------------------------------------------------

describe('QueueScheduler — pause() suspends new launches', () => {
  it('pause() causes a ready PRD to NOT be dequeued until resume()', async () => {
    const { cwd, queueDir, bus, eventQueue, spawnPrdChild, makeScheduler } = await createTestEnv();

    // Pause the scheduler before start to ensure no launch on first tick
    const scheduler = makeScheduler([]);
    // Start with no initial PRDs, then pause, write file, inject mutation
    await scheduler.start();

    scheduler.pause();
    expect(scheduler.isSuspended).toBe(true);

    // Write a PRD file to the queue directory
    const prdContent = '---\ntitle: PRD A\nstatus: pending\n---\n\n# PRD A\n\nDo something.';
    await writeFile(join(cwd, queueDir, 'prd-a.md'), prdContent);

    // Inject a queue:mutation to trigger discovery
    const mutationEvent: SchedulerInputEvent = {
      type: 'queue:mutation',
      reason: 'enqueue',
      timestamp: new Date().toISOString(),
    };
    bus.emit('queue:mutation', mutationEvent);

    // Wait for the async discovery to run
    await new Promise((r) => setTimeout(r, 200));

    // PRD should be discovered but NOT spawned (suspended)
    const events = eventQueue.drainAvailable();
    const types = events.map((e) => e.type);
    expect(types).toContain('queue:prd:discovered');
    expect(types).not.toContain('daemon:scheduler:dequeued');
    expect(spawnPrdChild).not.toHaveBeenCalled();

    // Now resume — should immediately dequeue prd-a
    scheduler.resume();
    expect(scheduler.isSuspended).toBe(false);
    await new Promise((r) => setTimeout(r, 200));

    const eventsAfterResume = eventQueue.drainAvailable();
    const typesAfterResume = eventsAfterResume.map((e) => e.type);
    expect(typesAfterResume).toContain('daemon:scheduler:resumed');
    expect(typesAfterResume).toContain('daemon:scheduler:dequeued');
    expect(spawnPrdChild).toHaveBeenCalledTimes(1);
    expect(spawnPrdChild.mock.calls[0][0].id).toBe('prd-a');

    eventQueue.removeProducer();
  });
});

// ---------------------------------------------------------------------------
// Test 5: onComplete still runs while suspended (state finalization)
// ---------------------------------------------------------------------------

describe('QueueScheduler — onComplete runs while suspended', () => {
  it('failed completion finalizes prdState to failed even when suspended', async () => {
    const { bus, eventQueue, spawnPrdChild, makeScheduler } = await createTestEnv();

    const foundation = makeQueuedPrd('foundation');
    const feature = makeQueuedPrd('feature', ['foundation']);

    spawnPrdChild.mockResolvedValueOnce('failed');

    const scheduler = makeScheduler([foundation, feature]);
    await scheduler.start();

    // foundation is spawned; pause before the completion arrives
    await new Promise((r) => setTimeout(r, 50));
    expect(spawnPrdChild).toHaveBeenCalledTimes(1);

    scheduler.pause();

    // Simulate foundation failing while suspended
    const failEvent: SchedulerInputEvent = {
      type: 'queue:prd:complete',
      prdId: 'foundation',
      status: 'failed',
      timestamp: new Date().toISOString(),
    };
    bus.emit('queue:prd:complete', failEvent);

    // Wait for onComplete to run
    await new Promise((r) => setTimeout(r, 200));

    // onComplete should have processed the failure: counter incremented
    expect(scheduler.processed).toBe(1);

    // feature should be blocked (propagateBlocked ran)
    scheduler.finalizeBlockedAsSkipped();
    expect(scheduler.skipped).toBe(1);

    // No new builds should have started (suspended)
    expect(spawnPrdChild).toHaveBeenCalledTimes(1);

    eventQueue.removeProducer();
  });
});
