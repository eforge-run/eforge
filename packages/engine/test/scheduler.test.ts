/**
 * Tests for QueueScheduler event emissions:
 * - daemon:scheduler:dequeued
 * - daemon:scheduler:capacity-blocked
 * - daemon:scheduler:dependency-blocked
 *
 * Uses a real EventEmitter + AsyncEventQueue with synthetic PRDs.
 * No mocks: spawnPrdChild is a plain function that never resolves so the
 * synchronously-pushed scheduler events are drained before any build completes.
 */
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { QueueScheduler } from '@eforge-build/engine/queue/scheduler';
import { AsyncEventQueue } from '@eforge-build/engine/concurrency';
import { DEFAULT_CONFIG } from '@eforge-build/engine/config';
import type { EforgeEvent } from '@eforge-build/engine/events';
import type { QueuedPrd } from '@eforge-build/engine/prd-queue';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal QueuedPrd without touching the filesystem. */
function makePrd(id: string, dependsOn: string[] = []): QueuedPrd {
  return {
    id,
    filePath: `/nonexistent/${id}.md`,
    frontmatter: {
      title: id,
      depends_on: dependsOn.length > 0 ? dependsOn : undefined,
    },
    content: `---\ntitle: ${id}\n---\n`,
    lastCommitHash: '',
    lastCommitDate: '',
  };
}

/** spawnPrdChild that never settles — tests drain the queue before any build finishes. */
const spawnNeverResolves = (): Promise<'completed' | 'failed' | 'skipped'> =>
  new Promise(() => {});

const CONFIG_PROFILE = {
  name: null,
  source: 'none' as const,
  scope: null,
  config: null,
};

function buildScheduler(
  initialPrds: QueuedPrd[],
  parallelism: number,
): {
  scheduler: QueueScheduler;
  eventQueue: AsyncEventQueue<EforgeEvent>;
  bus: EventEmitter;
} {
  const eventQueue = new AsyncEventQueue<EforgeEvent>();
  const bus = new EventEmitter();
  const scheduler = new QueueScheduler({
    bus,
    cwd: '/nonexistent/cwd',
    // Non-existent path so discoverNewPrds() fails gracefully and returns early.
    queueDir: '/nonexistent/queue',
    config: DEFAULT_CONFIG,
    configProfile: CONFIG_PROFILE,
    parallelism,
    abortController: new AbortController(),
    eventQueue,
    spawnPrdChild: spawnNeverResolves,
    options: {},
    initialPrds,
  });
  return { scheduler, eventQueue, bus };
}

// ---------------------------------------------------------------------------
// daemon:scheduler:dequeued
// ---------------------------------------------------------------------------

describe('daemon:scheduler:dequeued', () => {
  it('emits one dequeued event per successful start, up to the parallelism limit', async () => {
    const N = 5;
    const K = 2;
    const prds = Array.from({ length: N }, (_, i) => makePrd(`prd-${i}`));
    const { scheduler, eventQueue } = buildScheduler(prds, K);

    await scheduler.start();

    const events = eventQueue.drainAvailable();
    const dequeued = events.filter((e) => e.type === 'daemon:scheduler:dequeued');

    // Exactly K PRDs start in the first tick.
    expect(dequeued).toHaveLength(K);

    // First dequeue: queueDepth = N-1 (prd-0 moved to running), capacityRemaining = K-1.
    expect(dequeued[0]).toMatchObject({
      type: 'daemon:scheduler:dequeued',
      prdId: 'prd-0',
      queueDepth: N - 1,
      capacityRemaining: K - 1,
    });

    // Second dequeue: queueDepth = N-2, capacityRemaining = K-2 = 0.
    expect(dequeued[1]).toMatchObject({
      type: 'daemon:scheduler:dequeued',
      prdId: 'prd-1',
      queueDepth: N - 2,
      capacityRemaining: K - 2,
    });
  });
});

// ---------------------------------------------------------------------------
// daemon:scheduler:capacity-blocked
// ---------------------------------------------------------------------------

describe('daemon:scheduler:capacity-blocked', () => {
  it('emits exactly one capacity-blocked event per tick when N > K', async () => {
    const N = 5;
    const K = 2;
    const prds = Array.from({ length: N }, (_, i) => makePrd(`prd-${i}`));
    const { scheduler, eventQueue } = buildScheduler(prds, K);

    await scheduler.start();

    const events = eventQueue.drainAvailable();
    const capacityBlocked = events.filter((e) => e.type === 'daemon:scheduler:capacity-blocked');

    expect(capacityBlocked).toHaveLength(1);

    type CapacityBlockedEvent = Extract<EforgeEvent, { type: 'daemon:scheduler:capacity-blocked' }>;
    const payload = capacityBlocked[0] as CapacityBlockedEvent;
    expect(payload.runningCount).toBe(K);
    expect(payload.limit).toBe(K);
    // N - K PRDs remain pending when capacity is exhausted.
    expect(payload.queueDepth).toBe(N - K);
  });

  it('dedup resets each tick: two capacity-blocked ticks produce two events', async () => {
    const N = 5;
    const K = 2;
    const prds = Array.from({ length: N }, (_, i) => makePrd(`prd-${i}`));
    const { scheduler, eventQueue } = buildScheduler(prds, K);

    // Tick 1: start() triggers the initial scan and startReadyPrds().
    await scheduler.start();

    // Tick 2: access the private tick() via cast to trigger a second round.
    await (scheduler as unknown as { tick(): Promise<void> }).tick();

    const events = eventQueue.drainAvailable();
    const capacityBlocked = events.filter((e) => e.type === 'daemon:scheduler:capacity-blocked');

    // Both ticks are capacity-blocked; one event per tick.
    expect(capacityBlocked).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// daemon:scheduler:dependency-blocked
// ---------------------------------------------------------------------------

describe('daemon:scheduler:dependency-blocked', () => {
  it('emits exactly one dependency-blocked event per prdId per tick regardless of how many deps are unmet', async () => {
    // prd-blocked has 3 unmet dependencies — still only 1 event with all 3 in blockedBy.
    const prds = [
      makePrd('dep-a'),
      makePrd('dep-b'),
      makePrd('dep-c'),
      makePrd('prd-blocked', ['dep-a', 'dep-b', 'dep-c']),
    ];
    // parallelism=1 so dep-a starts and dep-b/dep-c are capacity-blocked;
    // prd-blocked stays dependency-blocked (all 3 deps are not completed/skipped).
    const { scheduler, eventQueue } = buildScheduler(prds, 1);

    await scheduler.start();

    const events = eventQueue.drainAvailable();
    const depBlocked = events.filter((e) => e.type === 'daemon:scheduler:dependency-blocked');

    // One event for prd-blocked, not three (one per dep).
    expect(depBlocked).toHaveLength(1);

    type DepBlockedEvent = Extract<EforgeEvent, { type: 'daemon:scheduler:dependency-blocked' }>;
    const payload = depBlocked[0] as DepBlockedEvent;
    expect(payload.prdId).toBe('prd-blocked');
    expect(payload.blockedBy).toHaveLength(3);
    expect(payload.blockedBy).toContain('dep-a');
    expect(payload.blockedBy).toContain('dep-b');
    expect(payload.blockedBy).toContain('dep-c');
  });

  it('emits one dependency-blocked event per blocked prdId when multiple PRDs share the same unmet dep', async () => {
    // prd-1 and prd-2 both depend on prd-0 which starts but does not complete.
    const prds = [
      makePrd('prd-0'),
      makePrd('prd-1', ['prd-0']),
      makePrd('prd-2', ['prd-0']),
    ];
    const { scheduler, eventQueue } = buildScheduler(prds, 1);

    await scheduler.start();

    const events = eventQueue.drainAvailable();
    const depBlocked = events.filter((e) => e.type === 'daemon:scheduler:dependency-blocked');

    // One event per blocked prdId (prd-1 and prd-2).
    expect(depBlocked).toHaveLength(2);
    const prdIds = depBlocked.map(
      (e) => (e as Extract<EforgeEvent, { type: 'daemon:scheduler:dependency-blocked' }>).prdId,
    );
    expect(prdIds).toContain('prd-1');
    expect(prdIds).toContain('prd-2');
  });
});
