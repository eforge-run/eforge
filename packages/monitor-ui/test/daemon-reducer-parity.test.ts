/**
 * Daemon-reducer parity test.
 *
 * Asserts that `daemonReducer` applied to a seed snapshot plus a live-event
 * tail produces the same `state.runs` and `state.queue` as a one-shot
 * BATCH_SEED of the final snapshot.
 *
 * Covers the full lifecycle:
 *   - Runs: enqueue start/complete/failed, phase start/end
 *   - Queue: discover, start, skip, complete, stale(proceed/revise/obsolete),
 *            commit-failed
 *
 * This test CANNOT mock any state — it must use the real daemonReducer and
 * real eventRegistry project functions to prove live projection parity with
 * the snapshot path.
 */
import { describe, it, expect } from 'vitest';
import { daemonReducer, initialDaemonState } from '@/lib/daemon-reducer';
import type { DaemonState, DaemonAction } from '@/lib/daemon-reducer';
import type { EforgeEvent } from '@/lib/types';
import type { RunInfo, QueueItem } from '@/lib/types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TS = '2025-01-15T10:00:00.000Z';

function makeEvent<T extends EforgeEvent['type']>(
  type: T,
  extra: object,
): EforgeEvent {
  return { type, timestamp: TS, ...extra } as unknown as EforgeEvent;
}

function applyEvents(events: EforgeEvent[]): DaemonState {
  return events.reduce(
    (state, event, i) =>
      daemonReducer(state, {
        type: 'ADD_EVENT',
        event,
        eventId: `ev-${i}`,
      } satisfies DaemonAction),
    initialDaemonState,
  );
}

function applyBatchSeed(runs: RunInfo[], queue: QueueItem[]): DaemonState {
  return daemonReducer(initialDaemonState, {
    type: 'BATCH_SEED',
    runs,
    queue,
    sessionMetadata: {},
    autoBuild: null,
  } satisfies DaemonAction);
}

// ---------------------------------------------------------------------------
// Run fixtures
// ---------------------------------------------------------------------------

const ENQUEUE_RUN: RunInfo = {
  id: 'run-enq-1',
  sessionId: 'sess-enq-1',
  planSet: 'feature-x',
  command: 'enqueue',
  status: 'completed',
  startedAt: TS,
  completedAt: TS,
  cwd: '/projects/myapp',
};

const BUILD_RUN: RunInfo = {
  id: 'run-build-1',
  sessionId: 'sess-build-1',
  planSet: 'feature-x',
  command: 'build',
  status: 'completed',
  startedAt: TS,
  completedAt: TS,
  cwd: '/projects/myapp',
};

const FAILED_ENQUEUE_RUN: RunInfo = {
  id: 'run-enq-fail',
  sessionId: 'sess-enq-fail',
  planSet: 'feature-y',
  command: 'enqueue',
  status: 'failed',
  startedAt: TS,
  completedAt: TS,
  cwd: '/projects/myapp',
};

// ---------------------------------------------------------------------------
// Queue fixtures
// ---------------------------------------------------------------------------

const PENDING_PRD: QueueItem = { id: 'prd-pending', title: 'Pending Feature', status: 'pending' };
const RUNNING_PRD: QueueItem = { id: 'prd-running', title: 'Running Feature', status: 'running' };
const FAILED_PRD: QueueItem = { id: 'prd-failed', title: 'Failed Feature', status: 'failed' };

// ---------------------------------------------------------------------------
// Run lifecycle parity
// ---------------------------------------------------------------------------

describe('daemon:run:upsert live projection parity', () => {
  it('enqueue start→complete: live projection equals snapshot', () => {
    // Live-event sequence
    const events: EforgeEvent[] = [
      makeEvent('daemon:run:upsert', {
        run: { ...ENQUEUE_RUN, status: 'running', completedAt: undefined, planSet: 'feature-x-src' },
      }),
      makeEvent('daemon:run:upsert', {
        run: ENQUEUE_RUN,
      }),
    ];

    const liveState = applyEvents(events);
    const snapshotState = applyBatchSeed([ENQUEUE_RUN], []);

    expect(liveState.runs).toEqual(snapshotState.runs);
  });

  it('phase start→end (build): live projection equals snapshot', () => {
    const events: EforgeEvent[] = [
      makeEvent('daemon:run:upsert', {
        run: { ...BUILD_RUN, status: 'running', completedAt: undefined },
      }),
      makeEvent('daemon:run:upsert', {
        run: BUILD_RUN,
      }),
    ];

    const liveState = applyEvents(events);
    const snapshotState = applyBatchSeed([BUILD_RUN], []);

    expect(liveState.runs).toEqual(snapshotState.runs);
  });

  it('enqueue failed: live projection equals snapshot', () => {
    const events: EforgeEvent[] = [
      makeEvent('daemon:run:upsert', {
        run: { ...FAILED_ENQUEUE_RUN, status: 'running', completedAt: undefined },
      }),
      makeEvent('daemon:run:upsert', {
        run: FAILED_ENQUEUE_RUN,
      }),
    ];

    const liveState = applyEvents(events);
    const snapshotState = applyBatchSeed([FAILED_ENQUEUE_RUN], []);

    expect(liveState.runs).toEqual(snapshotState.runs);
  });

  it('multiple runs: live projection preserves all runs and equals snapshot', () => {
    const events: EforgeEvent[] = [
      makeEvent('daemon:run:upsert', { run: { ...ENQUEUE_RUN, status: 'running', completedAt: undefined } }),
      makeEvent('daemon:run:upsert', { run: ENQUEUE_RUN }),
      makeEvent('daemon:run:upsert', { run: { ...BUILD_RUN, status: 'running', completedAt: undefined } }),
      makeEvent('daemon:run:upsert', { run: BUILD_RUN }),
    ];

    const liveState = applyEvents(events);

    // The projector prepends new runs and updates in-place, so after this
    // sequence the live order is [BUILD_RUN, ENQUEUE_RUN] (BUILD_RUN was
    // upserted second so it sits at index 0). A snapshot seeded in the same
    // order must deep-equal the live projection.
    const snapshotState = applyBatchSeed([BUILD_RUN, ENQUEUE_RUN], []);
    expect(liveState.runs).toEqual(snapshotState.runs);

    // Cross-check: both runs are present with their final completed state.
    expect(liveState.runs).toHaveLength(2);
    const enqRun = liveState.runs.find((r) => r.id === ENQUEUE_RUN.id);
    const buildRun = liveState.runs.find((r) => r.id === BUILD_RUN.id);
    expect(enqRun?.status).toBe('completed');
    expect(buildRun?.status).toBe('completed');
  });

  it('daemon:run:upsert updates in-place without duplicating runs', () => {
    const events: EforgeEvent[] = [
      makeEvent('daemon:run:upsert', { run: { ...BUILD_RUN, status: 'running', completedAt: undefined } }),
      // Re-upsert same run with different status
      makeEvent('daemon:run:upsert', { run: BUILD_RUN }),
    ];

    const liveState = applyEvents(events);

    // Must have exactly 1 run, not 2
    expect(liveState.runs).toHaveLength(1);
    expect(liveState.runs[0].id).toBe(BUILD_RUN.id);
    expect(liveState.runs[0].status).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// Queue lifecycle parity
// ---------------------------------------------------------------------------

describe('queue lifecycle live projection parity', () => {
  it('queue:prd:discovered adds item to queue', () => {
    const events: EforgeEvent[] = [
      makeEvent('queue:prd:discovered', { prdId: PENDING_PRD.id, title: PENDING_PRD.title }),
    ];

    const liveState = applyEvents(events);
    const snapshotState = applyBatchSeed([], [PENDING_PRD]);

    expect(liveState.queue).toEqual(snapshotState.queue);
  });

  it('queue:prd:start transitions item to running', () => {
    const events: EforgeEvent[] = [
      makeEvent('queue:prd:discovered', { prdId: RUNNING_PRD.id, title: RUNNING_PRD.title }),
      makeEvent('queue:prd:start', { prdId: RUNNING_PRD.id, title: RUNNING_PRD.title }),
    ];

    const liveState = applyEvents(events);
    const snapshotState = applyBatchSeed([], [RUNNING_PRD]);

    expect(liveState.queue).toEqual(snapshotState.queue);
  });

  it('queue:prd:skip removes item from queue', () => {
    const events: EforgeEvent[] = [
      makeEvent('queue:prd:discovered', { prdId: 'prd-skip', title: 'Skip Me' }),
      makeEvent('queue:prd:skip', { prdId: 'prd-skip', reason: 'already done' }),
    ];

    const liveState = applyEvents(events);

    expect(liveState.queue).toHaveLength(0);
  });

  it('queue:prd:complete(completed) removes item from queue', () => {
    const events: EforgeEvent[] = [
      makeEvent('queue:prd:discovered', { prdId: 'prd-done', title: 'Done Feature' }),
      makeEvent('queue:prd:start', { prdId: 'prd-done', title: 'Done Feature' }),
      makeEvent('queue:prd:complete', { prdId: 'prd-done', status: 'completed' }),
    ];

    const liveState = applyEvents(events);

    expect(liveState.queue).toHaveLength(0);
  });

  it('queue:prd:complete(failed) marks item as failed', () => {
    const events: EforgeEvent[] = [
      makeEvent('queue:prd:discovered', { prdId: FAILED_PRD.id, title: FAILED_PRD.title }),
      makeEvent('queue:prd:start', { prdId: FAILED_PRD.id, title: FAILED_PRD.title }),
      makeEvent('queue:prd:complete', { prdId: FAILED_PRD.id, status: 'failed' }),
    ];

    const liveState = applyEvents(events);
    const snapshotState = applyBatchSeed([], [FAILED_PRD]);

    expect(liveState.queue).toEqual(snapshotState.queue);
  });

  it('queue:prd:stale(proceed) is a no-op on queue state', () => {
    const events: EforgeEvent[] = [
      makeEvent('queue:prd:discovered', { prdId: PENDING_PRD.id, title: PENDING_PRD.title }),
      makeEvent('queue:prd:stale', {
        prdId: PENDING_PRD.id,
        title: PENDING_PRD.title,
        verdict: 'proceed',
        justification: 'No significant changes',
      }),
    ];

    const liveState = applyEvents(events);
    const snapshotState = applyBatchSeed([], [PENDING_PRD]);

    // Item should still be pending (proceed = no change) and the queue must
    // deep-equal a snapshot containing only the pending PRD.
    expect(liveState.queue).toEqual(snapshotState.queue);
  });

  it('queue:prd:stale(revise) removes item from queue (file moved by engine)', () => {
    const events: EforgeEvent[] = [
      makeEvent('queue:prd:discovered', { prdId: PENDING_PRD.id, title: PENDING_PRD.title }),
      makeEvent('queue:prd:stale', {
        prdId: PENDING_PRD.id,
        title: PENDING_PRD.title,
        verdict: 'revise',
        justification: 'Codebase has changed significantly',
        revision: '# Revised PRD\n',
      }),
    ];

    const liveState = applyEvents(events);

    // Item should be removed — engine rewrites the file and it moves out of queue
    expect(liveState.queue).toHaveLength(0);
  });

  it('queue:prd:stale(obsolete) removes item from queue', () => {
    const events: EforgeEvent[] = [
      makeEvent('queue:prd:discovered', { prdId: 'prd-obsolete', title: 'Obsolete Feature' }),
      makeEvent('queue:prd:stale', {
        prdId: 'prd-obsolete',
        title: 'Obsolete Feature',
        verdict: 'obsolete',
        justification: 'Already implemented',
      }),
    ];

    const liveState = applyEvents(events);

    expect(liveState.queue).toHaveLength(0);
  });

  it('queue:prd:commit-failed marks item as failed', () => {
    const events: EforgeEvent[] = [
      makeEvent('queue:prd:discovered', { prdId: PENDING_PRD.id, title: PENDING_PRD.title }),
      makeEvent('queue:prd:commit-failed', {
        prdId: PENDING_PRD.id,
        title: PENDING_PRD.title,
        error: 'git commit failed: lock file',
      }),
    ];

    const liveState = applyEvents(events);
    const snapshotState = applyBatchSeed([], [{ ...PENDING_PRD, status: 'failed' }]);

    expect(liveState.queue).toEqual(snapshotState.queue);
  });

  it('queue:prd:commit-failed on unknown item is a no-op', () => {
    const events: EforgeEvent[] = [
      makeEvent('queue:prd:commit-failed', {
        prdId: 'unknown-prd',
        title: 'Unknown',
        error: 'lock file',
      }),
    ];

    const liveState = applyEvents(events);

    // No item was in the queue, so no change
    expect(liveState.queue).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Full lifecycle: BATCH_SEED followed by live deltas equals a fresh BATCH_SEED
// ---------------------------------------------------------------------------

describe('live-event tail applied to BATCH_SEED equals final snapshot BATCH_SEED', () => {
  it('enqueue lifecycle: seed(initial) + live events == seed(final)', () => {
    const initialRun: RunInfo = {
      id: 'run-e2e-enq',
      sessionId: 'sess-e2e',
      planSet: 'my-feature',
      command: 'enqueue',
      status: 'running',
      startedAt: TS,
      cwd: '/app',
    };
    const finalRun: RunInfo = { ...initialRun, status: 'completed', completedAt: TS, planSet: 'my-feature' };

    // Path 1: seed initial state, apply live event
    const seedState = daemonReducer(initialDaemonState, {
      type: 'BATCH_SEED',
      runs: [initialRun],
      queue: [],
      sessionMetadata: {},
      autoBuild: null,
    });
    const liveState = daemonReducer(seedState, {
      type: 'ADD_EVENT',
      event: makeEvent('daemon:run:upsert', { run: finalRun }),
      eventId: 'ev-final',
    });

    // Path 2: seed final state directly
    const directState = daemonReducer(initialDaemonState, {
      type: 'BATCH_SEED',
      runs: [finalRun],
      queue: [],
      sessionMetadata: {},
      autoBuild: null,
    });

    expect(liveState.runs).toEqual(directState.runs);
  });

  it('queue lifecycle: seed(with pending items) + live events == seed(final)', () => {
    const prd1: QueueItem = { id: 'prd-1', title: 'Feature 1', status: 'pending' };
    const prd2: QueueItem = { id: 'prd-2', title: 'Feature 2', status: 'pending' };

    // Path 1: start with both pending, apply events
    const seedState = daemonReducer(initialDaemonState, {
      type: 'BATCH_SEED',
      runs: [],
      queue: [prd1, prd2],
      sessionMetadata: {},
      autoBuild: null,
    });

    // prd-1 completes, prd-2 fails via commit-failed
    const state1 = daemonReducer(seedState, {
      type: 'ADD_EVENT',
      event: makeEvent('queue:prd:start', { prdId: prd1.id, title: prd1.title }),
      eventId: 'ev-1',
    });
    const state2 = daemonReducer(state1, {
      type: 'ADD_EVENT',
      event: makeEvent('queue:prd:complete', { prdId: prd1.id, status: 'completed' }),
      eventId: 'ev-2',
    });
    const liveState = daemonReducer(state2, {
      type: 'ADD_EVENT',
      event: makeEvent('queue:prd:commit-failed', { prdId: prd2.id, title: prd2.title, error: 'lock' }),
      eventId: 'ev-3',
    });

    // Path 2: direct snapshot of final state
    const finalQueue: QueueItem[] = [{ ...prd2, status: 'failed' }];
    const directState = daemonReducer(initialDaemonState, {
      type: 'BATCH_SEED',
      runs: [],
      queue: finalQueue,
      sessionMetadata: {},
      autoBuild: null,
    });

    expect(liveState.queue).toEqual(directState.queue);
  });
});
