/**
 * Integration-style regression tests for the scheduler pause/resume lifecycle.
 *
 * Uses real QueueScheduler, real EventEmitter, real AsyncEventQueue, and a stub
 * spawnPrdChild whose return value the test controls. No subprocess, no daemon.
 *
 * Tests:
 *   1. With maxConcurrentBuilds:2, PRDs a, b, c (independent): fail a, verify state
 *      finalizes and c dequeues after resume.
 *   2. While pause is held, subsequent queue:mutation events do NOT dequeue new PRDs.
 *      After resume(), eligible PRDs are dequeued on the next tick.
 *   3. onComplete still runs while suspended: a failed completion still transitions
 *      prdState to 'failed' and propagateBlocked runs on dependent PRDs.
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueScheduler, type SchedulerInputEvent } from '@eforge-build/engine/queue/scheduler';
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

async function createTestEnv(parallelism = 2): Promise<{
  cwd: string;
  queueDir: string;
  bus: EventEmitter;
  eventQueue: AsyncEventQueue<EforgeEvent>;
  spawnPrdChild: ReturnType<typeof vi.fn>;
  makeScheduler: (initialPrds: QueuedPrd[]) => QueueScheduler;
}> {
  const cwd = await mkdtemp(join(tmpdir(), 'eforge-resume-test-'));
  const queueDir = 'eforge/queue';
  await mkdir(join(cwd, 'eforge', 'queue'), { recursive: true });

  const bus = new EventEmitter();
  const eventQueue = new AsyncEventQueue<EforgeEvent>();
  // Keep the queue alive for the duration of the test (watcher producer).
  eventQueue.addProducer();

  const spawnPrdChild = vi.fn<[QueuedPrd, unknown, string], Promise<'completed' | 'failed' | 'skipped'>>()
    .mockResolvedValue('completed');

  const abortController = new AbortController();

  const makeScheduler = (initialPrds: QueuedPrd[]): QueueScheduler =>
    new QueueScheduler({
      bus,
      cwd,
      queueDir,
      config: {
        maxConcurrentBuilds: parallelism,
        prdQueue: { dir: queueDir, watchPollIntervalMs: 0 },
        plugins: { enabled: false },
      } as unknown as import('@eforge-build/engine/config').EforgeConfig,
      configProfile: { name: null, source: 'none', scope: null, config: null },
      parallelism,
      abortController,
      eventQueue,
      spawnPrdChild,
      options: { auto: true },
      initialPrds,
    });

  return { cwd, queueDir, bus, eventQueue, spawnPrdChild, makeScheduler };
}

// ---------------------------------------------------------------------------
// Test 1: Failure pause + resume with maxConcurrentBuilds:2
// ---------------------------------------------------------------------------

describe('scheduler pause/resume — failure + independent pending PRD', () => {
  it('after pause and resume, independent pending PRD c is dequeued', async () => {
    const { cwd, queueDir, bus, eventQueue, spawnPrdChild, makeScheduler } = await createTestEnv(2);

    const prdA = makeQueuedPrd('prd-a');
    const prdB = makeQueuedPrd('prd-b');

    // prd-c will be added to the queue directory (simulates a queued PRD)
    const prdContent = '---\ntitle: PRD C\nstatus: pending\n---\n\n# PRD C\n\nDo something.';
    await writeFile(join(cwd, queueDir, 'prd-c.md'), prdContent);

    // a fails, b completes
    spawnPrdChild
      .mockResolvedValueOnce('failed')   // prd-a
      .mockResolvedValueOnce('completed') // prd-b
      .mockResolvedValueOnce('completed'); // prd-c

    const scheduler = makeScheduler([prdA, prdB]);
    await scheduler.start();

    // a and b are launched immediately (parallelism=2)
    await new Promise((r) => setTimeout(r, 50));
    expect(spawnPrdChild).toHaveBeenCalledTimes(2);

    // Pause the scheduler (simulating maybePauseOnFailure behavior)
    scheduler.pause();
    expect(scheduler.isSuspended).toBe(true);

    // Simulate prd-a completing as failed (bus receives the event)
    const failEvent: SchedulerInputEvent = {
      type: 'queue:prd:complete',
      prdId: 'prd-a',
      status: 'failed',
      timestamp: new Date().toISOString(),
    };
    bus.emit('queue:prd:complete', failEvent);

    // Wait for onComplete to finalize state
    await new Promise((r) => setTimeout(r, 200));

    // onComplete should have run: prd-a processed, state finalized
    expect(scheduler.processed).toBe(1);

    // Finalize prd-b to exercise the real capacity-recovery path. The scheduler
    // spawns prd-b asynchronously and pushes its queue:prd:complete to eventQueue,
    // but there is no pump loop here to re-emit it on the bus. Emit it manually
    // so onComplete() fires and runningCount drops to 0 before resume.
    const bCompleteEvent: SchedulerInputEvent = {
      type: 'queue:prd:complete',
      prdId: 'prd-b',
      status: 'completed',
      timestamp: new Date().toISOString(),
    };
    bus.emit('queue:prd:complete', bCompleteEvent);
    await new Promise((r) => setTimeout(r, 50));
    expect(scheduler.processed).toBe(2);

    // While still suspended, inject a mutation to trigger discovery of prd-c
    const mutationEvent: SchedulerInputEvent = {
      type: 'queue:mutation',
      reason: 'enqueue',
      timestamp: new Date().toISOString(),
    };
    bus.emit('queue:mutation', mutationEvent);
    await new Promise((r) => setTimeout(r, 100));

    // prd-c should have been discovered but NOT dequeued (still suspended)
    const eventsWhilePaused = eventQueue.drainAvailable();
    const typesWhilePaused = eventsWhilePaused.map((e) => e.type);
    expect(typesWhilePaused).toContain('queue:prd:discovered');
    // prd-b may or may not have been dequeued before pause — we only check prd-c was NOT
    const dequeuedIds = eventsWhilePaused
      .filter((e) => e.type === 'daemon:scheduler:dequeued')
      .map((e) => (e as { prdId: string }).prdId);
    expect(dequeuedIds).not.toContain('prd-c');

    // Resume the scheduler
    scheduler.resume();
    expect(scheduler.isSuspended).toBe(false);

    // Wait for discovery tick triggered by resume()
    await new Promise((r) => setTimeout(r, 200));

    // prd-c should now be dequeued
    const eventsAfterResume = eventQueue.drainAvailable();
    const typesAfterResume = eventsAfterResume.map((e) => e.type);
    expect(typesAfterResume).toContain('daemon:scheduler:resumed');
    expect(typesAfterResume).toContain('daemon:scheduler:dequeued');
    const dequeuedAfterResume = eventsAfterResume
      .filter((e) => e.type === 'daemon:scheduler:dequeued')
      .map((e) => (e as { prdId: string }).prdId);
    expect(dequeuedAfterResume).toContain('prd-c');

    eventQueue.removeProducer();
  });
});

// ---------------------------------------------------------------------------
// Test 2: While paused, queue:mutation does NOT dequeue; resume() does
// ---------------------------------------------------------------------------

describe('scheduler pause/resume — queue:mutation ignored while suspended', () => {
  it('mutation events are processed but launches are gated until resume', async () => {
    const { cwd, queueDir, bus, eventQueue, spawnPrdChild, makeScheduler } = await createTestEnv(2);

    // Start with empty queue
    const scheduler = makeScheduler([]);
    await scheduler.start();

    // Pause immediately
    scheduler.pause();

    // Write two PRDs and inject a mutation
    const prdContent1 = '---\ntitle: PRD X\nstatus: pending\n---\n\n# PRD X\n\nDo something.';
    const prdContent2 = '---\ntitle: PRD Y\nstatus: pending\n---\n\n# PRD Y\n\nDo something.';
    await writeFile(join(cwd, queueDir, 'prd-x.md'), prdContent1);
    await writeFile(join(cwd, queueDir, 'prd-y.md'), prdContent2);

    const mutationEvent: SchedulerInputEvent = {
      type: 'queue:mutation',
      reason: 'enqueue',
      timestamp: new Date().toISOString(),
    };
    bus.emit('queue:mutation', mutationEvent);

    // Wait for discovery
    await new Promise((r) => setTimeout(r, 200));

    // PRDs discovered but not launched
    expect(spawnPrdChild).not.toHaveBeenCalled();
    const pausedEvents = eventQueue.drainAvailable();
    const pausedTypes = pausedEvents.map((e) => e.type);
    expect(pausedTypes).toContain('queue:prd:discovered');
    expect(pausedTypes).not.toContain('daemon:scheduler:dequeued');

    // Resume
    scheduler.resume();
    await new Promise((r) => setTimeout(r, 200));

    // Both PRDs should now be launched (parallelism=2)
    expect(spawnPrdChild).toHaveBeenCalledTimes(2);
    const resumeEvents = eventQueue.drainAvailable();
    const resumeTypes = resumeEvents.map((e) => e.type);
    expect(resumeTypes).toContain('daemon:scheduler:resumed');
    expect(resumeTypes.filter((t) => t === 'daemon:scheduler:dequeued').length).toBe(2);

    eventQueue.removeProducer();
  });
});

// ---------------------------------------------------------------------------
// Test 3: onComplete finalizes state while suspended
// ---------------------------------------------------------------------------

describe('scheduler pause/resume — onComplete runs while suspended', () => {
  it('failed completion finalizes prdState and propagates blocked deps while suspended', async () => {
    const { bus, eventQueue, spawnPrdChild, makeScheduler } = await createTestEnv(2);

    const foundation = makeQueuedPrd('foundation');
    const dependent = makeQueuedPrd('dependent', ['foundation']);

    spawnPrdChild.mockResolvedValueOnce('failed');

    const scheduler = makeScheduler([foundation, dependent]);
    await scheduler.start();

    // foundation spawned; pause before the completion arrives
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

    // Wait for onComplete
    await new Promise((r) => setTimeout(r, 200));

    // onComplete ran: foundation counted as processed
    expect(scheduler.processed).toBe(1);

    // dependent is blocked (propagateBlocked ran inside onComplete)
    scheduler.finalizeBlockedAsSkipped();
    expect(scheduler.skipped).toBe(1);

    // No new builds started
    expect(spawnPrdChild).toHaveBeenCalledTimes(1);

    eventQueue.removeProducer();
  });
});
