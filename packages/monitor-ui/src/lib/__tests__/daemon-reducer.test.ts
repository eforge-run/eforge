import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  daemonReducer,
  initialDaemonState,
  selectLatestSessionId,
  selectAutoBuildEnabled,
  selectQueueItems,
  selectRuns,
  selectDaemonActivity,
  selectHeartbeatStaleness,
  ACTIVITY_BUFFER_CAP,
  type DaemonState,
  type HeartbeatPayload,
} from '../daemon-reducer';
import type { EforgeEvent } from '../types';
import type { AutoBuildState } from '../api';
import type { RunInfo, QueueItem } from '../types';

// Hand-crafted event helper following the "cast through unknown" test pattern.
function makeEvent<T extends EforgeEvent['type']>(
  type: T,
  extra: object,
): Extract<EforgeEvent, { type: T }> {
  return {
    type,
    timestamp: '2024-01-15T10:00:00.000Z',
    sessionId: 'session-1',
    ...extra,
  } as unknown as Extract<EforgeEvent, { type: T }>;
}

function makeRun(overrides: Partial<RunInfo> = {}): RunInfo {
  return {
    id: 'run-1',
    sessionId: 'session-1',
    planSet: 'my-set',
    command: 'build',
    status: 'running',
    startedAt: '2024-01-15T09:00:00.000Z',
    cwd: '/home/user/project',
    ...overrides,
  };
}

function makeQueueItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 'prd-1',
    title: 'My Feature',
    status: 'pending',
    ...overrides,
  };
}

function makeAutoBuildState(enabled = true): AutoBuildState {
  return {
    enabled,
    watcher: { running: true, pid: 1234, sessionId: 'watcher-session-1' },
    desired: enabled ? 'enabled' : 'disabled',
    mode: enabled ? 'running' : 'disabled',
    scheduler: { alive: enabled, paused: false, lastMutationReason: 'enqueue' },
    lastTransition: {
      at: '2024-01-15T09:59:00.000Z',
      previousMode: enabled ? 'starting' : 'running',
      nextMode: enabled ? 'running' : 'disabled',
      desired: enabled ? 'enabled' : 'disabled',
      reason: enabled ? 'startup complete' : 'manual disable',
      source: 'test',
    },
    reason: enabled ? 'startup complete' : 'manual disable',
  };
}

describe('daemonReducer', () => {
  // ---------------------------------------------------------------------------
  // BATCH_SEED
  // ---------------------------------------------------------------------------
  describe('BATCH_SEED', () => {
    it('seeds all slices from the snapshot', () => {
      const runs = [makeRun()];
      const queue = [makeQueueItem()];
      const sessionMetadata = { 'session-1': { planCount: 3, baseProfile: 'errand' } };
      const autoBuild = makeAutoBuildState();

      const state = daemonReducer(initialDaemonState, {
        type: 'BATCH_SEED',
        runs,
        queue,
        sessionMetadata,
        autoBuild,
      });

      expect(state.runs).toEqual(runs);
      expect(state.queue).toEqual(queue);
      expect(state.sessionMetadata).toEqual(sessionMetadata);
      expect(state.autoBuild).toEqual(autoBuild);
      expect(state.autoBuild?.mode).toBe('running');
      expect(state.autoBuild?.scheduler?.lastMutationReason).toBe('enqueue');
      expect(state.autoBuild?.lastTransition?.reason).toBe('startup complete');
    });

    it('preserves connectionStatus across BATCH_SEED', () => {
      const seeded = daemonReducer(
        { ...initialDaemonState, connectionStatus: 'connected' },
        {
          type: 'BATCH_SEED',
          runs: [],
          queue: [],
          sessionMetadata: {},
          autoBuild: null,
        },
      );
      expect(seeded.connectionStatus).toBe('connected');
    });

    it('appends recentActivity entries to daemonActivity', () => {
      const activity = [
        {
          id: '1',
          event: makeEvent('session:start', { sessionId: 'sess-a' }) as unknown as EforgeEvent,
        },
      ];

      const state = daemonReducer(initialDaemonState, {
        type: 'BATCH_SEED',
        runs: [],
        queue: [],
        sessionMetadata: {},
        autoBuild: null,
        recentActivity: activity,
      });

      expect(state.daemonActivity).toHaveLength(1);
      expect(state.daemonActivity[0].id).toBe('1');
    });

    it('dedupes recentActivity by id — dispatching BATCH_SEED twice with overlapping ids leaves each id exactly once', () => {
      const event1 = makeEvent('session:start', { sessionId: 'sess-a' }) as unknown as EforgeEvent;
      const event2 = makeEvent('session:end', { sessionId: 'sess-a', result: { status: 'completed', summary: '' } }) as unknown as EforgeEvent;

      const activity1 = [{ id: '1', event: event1 }];
      const activity2 = [{ id: '1', event: event1 }, { id: '2', event: event2 }];

      const s1 = daemonReducer(initialDaemonState, {
        type: 'BATCH_SEED',
        runs: [],
        queue: [],
        sessionMetadata: {},
        autoBuild: null,
        recentActivity: activity1,
      });
      expect(s1.daemonActivity).toHaveLength(1);

      const s2 = daemonReducer(s1, {
        type: 'BATCH_SEED',
        runs: [],
        queue: [],
        sessionMetadata: {},
        autoBuild: null,
        recentActivity: activity2,
      });
      // id '1' is already present — only '2' is new
      expect(s2.daemonActivity).toHaveLength(2);
      const ids = s2.daemonActivity.map((a) => a.id);
      expect(ids).toEqual(['1', '2']); // newest at end
    });

    it('dedupes recentActivity, caps at ACTIVITY_BUFFER_CAP', () => {
      // Fill the buffer to near-cap with existing entries
      let state = initialDaemonState;
      for (let i = 0; i < ACTIVITY_BUFFER_CAP - 1; i++) {
        const ev = makeEvent('daemon:lifecycle:starting', { pid: i, port: 8080, version: '1.0.0', mode: 'dev' }) as unknown as EforgeEvent;
        state = daemonReducer(state, { type: 'ADD_EVENT', event: ev, eventId: String(i) });
      }
      expect(state.daemonActivity).toHaveLength(ACTIVITY_BUFFER_CAP - 1);

      // BATCH_SEED with 3 new entries: total = 502, should be capped at 500
      const newActivity = [
        { id: 'new-a', event: makeEvent('session:start', {}) as unknown as EforgeEvent },
        { id: 'new-b', event: makeEvent('session:start', {}) as unknown as EforgeEvent },
        { id: 'new-c', event: makeEvent('session:start', {}) as unknown as EforgeEvent },
      ];
      const capped = daemonReducer(state, {
        type: 'BATCH_SEED',
        runs: [],
        queue: [],
        sessionMetadata: {},
        autoBuild: null,
        recentActivity: newActivity,
      });
      expect(capped.daemonActivity).toHaveLength(ACTIVITY_BUFFER_CAP);
      // Newest entries are at the end
      const lastThree = capped.daemonActivity.slice(-3).map((a) => a.id);
      expect(lastThree).toEqual(['new-a', 'new-b', 'new-c']);
    });

    it('sets latestHeartbeat from snapshot liveness field', () => {
      const latestHeartbeat = {
        at: 1_000_000,
        payload: makeHeartbeatPayload({ uptime: 42_000, queueDepth: 3, runningBuilds: 1 }),
      };

      const state = daemonReducer(initialDaemonState, {
        type: 'BATCH_SEED',
        runs: [],
        queue: [],
        sessionMetadata: {},
        autoBuild: null,
        latestHeartbeat,
      });

      expect(state.latestHeartbeat).toEqual(latestHeartbeat);
    });

    it('does not overwrite latestHeartbeat when latestHeartbeat is undefined in action', () => {
      const existing = {
        at: 999_999,
        payload: makeHeartbeatPayload(),
      };
      const startState = { ...initialDaemonState, latestHeartbeat: existing };

      // BATCH_SEED without latestHeartbeat field → should not clear existing
      const state = daemonReducer(startState, {
        type: 'BATCH_SEED',
        runs: [],
        queue: [],
        sessionMetadata: {},
        autoBuild: null,
        // latestHeartbeat omitted intentionally
      });

      expect(state.latestHeartbeat).toEqual(existing);
    });
  });

  // ---------------------------------------------------------------------------
  // session:start
  //
  // Since v25: session:start no longer synthesizes run rows. daemon:run:upsert
  // is the authoritative source of DaemonState.runs. The projector returns
  // undefined for all session:start events, so runs remain unchanged.
  // ---------------------------------------------------------------------------
  describe('ADD_EVENT: session:start', () => {
    it('does NOT create a new run entry (daemon:run:upsert is authoritative)', () => {
      const existing = makeRun({ id: 'old-run', sessionId: 'old-session' });
      const state: DaemonState = { ...initialDaemonState, runs: [existing] };
      const event = makeEvent('session:start', { sessionId: 'new-session' });

      const next = daemonReducer(state, { type: 'ADD_EVENT', event, eventId: 'e1' });

      // Runs must be unchanged — no synthetic run created
      expect(next.runs).toHaveLength(1);
      expect(next.runs[0]).toEqual(existing);
      // Activity entry must still be appended
      expect(next.daemonActivity).toHaveLength(1);
      expect(next.daemonActivity[0].id).toBe('e1');
    });

    it('does NOT update an existing run status (daemon:run:upsert is authoritative)', () => {
      const existing = makeRun({ status: 'completed' });
      const state: DaemonState = { ...initialDaemonState, runs: [existing] };
      const event = makeEvent('session:start', { sessionId: 'session-1' });

      const next = daemonReducer(state, { type: 'ADD_EVENT', event, eventId: 'e1' });

      // Status must remain unchanged
      expect(next.runs).toHaveLength(1);
      expect(next.runs[0].status).toBe('completed');
    });
  });

  // ---------------------------------------------------------------------------
  // session:end
  //
  // Since v25: session:end no longer updates run status. Run termination is
  // reflected via daemon:run:upsert emitted by the recorder.
  // The projector returns undefined so runs remain unchanged.
  // ---------------------------------------------------------------------------
  describe('ADD_EVENT: session:end', () => {
    it('does NOT update run status to completed (daemon:run:upsert is authoritative)', () => {
      const state: DaemonState = { ...initialDaemonState, runs: [makeRun()] };
      const event = makeEvent('session:end', {
        sessionId: 'session-1',
        result: { status: 'completed', summary: 'done' },
      });

      const next = daemonReducer(state, { type: 'ADD_EVENT', event, eventId: 'e1' });

      // Status must remain 'running' (unchanged) — daemon:run:upsert handles completion
      expect(next.runs[0].status).toBe('running');
      expect(next.runs[0].completedAt).toBeUndefined();
    });

    it('does NOT update run status to failed (daemon:run:upsert is authoritative)', () => {
      const state: DaemonState = { ...initialDaemonState, runs: [makeRun()] };
      const event = makeEvent('session:end', {
        sessionId: 'session-1',
        result: { status: 'failed', summary: 'error' },
      });

      const next = daemonReducer(state, { type: 'ADD_EVENT', event, eventId: 'e1' });

      // Status must remain 'running' (unchanged)
      expect(next.runs[0].status).toBe('running');
    });

    it('leaves runs unchanged when sessionId is not found but still appends to activity', () => {
      const state: DaemonState = { ...initialDaemonState, runs: [makeRun()] };
      const event = makeEvent('session:end', {
        sessionId: 'unknown-session',
        result: { status: 'completed', summary: '' },
      });

      const next = daemonReducer(state, { type: 'ADD_EVENT', event, eventId: 'e1' });

      expect(next.runs).toEqual(state.runs);
      expect(next.daemonActivity).toHaveLength(1);
      expect(next.daemonActivity[0].id).toBe('e1');
    });
  });

  // ---------------------------------------------------------------------------
  // queue events
  // ---------------------------------------------------------------------------
  describe('ADD_EVENT: queue:prd:discovered', () => {
    it('adds a new pending queue item', () => {
      const event = makeEvent('queue:prd:discovered', {
        prdId: 'prd-42',
        title: 'New Feature',
      });

      const next = daemonReducer(initialDaemonState, { type: 'ADD_EVENT', event, eventId: 'e1' });

      expect(next.queue).toHaveLength(1);
      expect(next.queue[0]).toMatchObject({ id: 'prd-42', title: 'New Feature', status: 'pending' });
    });

    it('ignores duplicate prdIds but still appends to activity', () => {
      const state: DaemonState = { ...initialDaemonState, queue: [makeQueueItem()] };
      const event = makeEvent('queue:prd:discovered', { prdId: 'prd-1', title: 'Dup' });

      const next = daemonReducer(state, { type: 'ADD_EVENT', event, eventId: 'e1' });

      expect(next.queue).toEqual(state.queue);
      expect(next.daemonActivity).toHaveLength(1);
      expect(next.daemonActivity[0].id).toBe('e1');
    });
  });

  describe('ADD_EVENT: queue:prd:complete', () => {
    it('updates item to failed status', () => {
      const state: DaemonState = { ...initialDaemonState, queue: [makeQueueItem()] };
      const event = makeEvent('queue:prd:complete', { prdId: 'prd-1', status: 'failed' });

      const next = daemonReducer(state, { type: 'ADD_EVENT', event, eventId: 'e1' });

      expect(next.queue[0].status).toBe('failed');
    });

    it('removes completed items from the queue', () => {
      const state: DaemonState = { ...initialDaemonState, queue: [makeQueueItem()] };
      const event = makeEvent('queue:prd:complete', { prdId: 'prd-1', status: 'completed' });

      const next = daemonReducer(state, { type: 'ADD_EVENT', event, eventId: 'e1' });

      expect(next.queue).toHaveLength(0);
    });
  });

  describe('ADD_EVENT: queue:complete', () => {
    it('removes all non-failed items', () => {
      const items: QueueItem[] = [
        makeQueueItem({ id: 'prd-1', status: 'running' }),
        makeQueueItem({ id: 'prd-2', status: 'failed' }),
        makeQueueItem({ id: 'prd-3', status: 'pending' }),
      ];
      const state: DaemonState = { ...initialDaemonState, queue: items };
      const event = makeEvent('queue:complete', { processed: 2, skipped: 0 });

      const next = daemonReducer(state, { type: 'ADD_EVENT', event, eventId: 'e1' });

      expect(next.queue).toHaveLength(1);
      expect(next.queue[0].id).toBe('prd-2');
    });
  });

  // ---------------------------------------------------------------------------
  // daemon:auto-build:paused
  // ---------------------------------------------------------------------------
  describe('ADD_EVENT: daemon:auto-build:paused', () => {
    it('sets autoBuild.enabled to false', () => {
      const state: DaemonState = {
        ...initialDaemonState,
        autoBuild: makeAutoBuildState(true),
      };
      const event = makeEvent('daemon:auto-build:paused', { reason: 'Build failed' });

      const next = daemonReducer(state, { type: 'ADD_EVENT', event, eventId: 'e1' });

      expect(next.autoBuild?.enabled).toBe(false);
    });

    it('leaves autoBuild null when autoBuild is null but still appends to activity', () => {
      const state: DaemonState = { ...initialDaemonState, autoBuild: null };
      const event = makeEvent('daemon:auto-build:paused', { reason: 'whatever' });

      const next = daemonReducer(state, { type: 'ADD_EVENT', event, eventId: 'e1' });

      expect(next.autoBuild).toBeNull();
      expect(next.daemonActivity).toHaveLength(1);
      expect(next.daemonActivity[0].id).toBe('e1');
    });
  });

  // ---------------------------------------------------------------------------
  // SET_AUTO_BUILD
  // ---------------------------------------------------------------------------
  describe('SET_AUTO_BUILD', () => {
    it('replaces the autoBuild slice', () => {
      const newState = makeAutoBuildState(false);
      const next = daemonReducer(initialDaemonState, {
        type: 'SET_AUTO_BUILD',
        autoBuild: newState,
      });
      expect(next.autoBuild).toEqual(newState);
    });

    it('accepts null to clear autoBuild', () => {
      const state: DaemonState = { ...initialDaemonState, autoBuild: makeAutoBuildState() };
      const next = daemonReducer(state, { type: 'SET_AUTO_BUILD', autoBuild: null });
      expect(next.autoBuild).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // SET_CONNECTION_STATUS
  // ---------------------------------------------------------------------------
  describe('SET_CONNECTION_STATUS', () => {
    it('updates connectionStatus', () => {
      const next = daemonReducer(initialDaemonState, {
        type: 'SET_CONNECTION_STATUS',
        status: 'connected',
      });
      expect(next.connectionStatus).toBe('connected');
    });
  });
});

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

describe('selectLatestSessionId', () => {
  it('returns the sessionId of runs[0]', () => {
    const run = makeRun({ sessionId: 'latest-session' });
    const state: DaemonState = { ...initialDaemonState, runs: [run] };
    expect(selectLatestSessionId(state)).toBe('latest-session');
  });

  it('returns null when runs is empty', () => {
    expect(selectLatestSessionId(initialDaemonState)).toBeNull();
  });
});

describe('selectAutoBuildEnabled', () => {
  it('returns true when autoBuild.enabled is true', () => {
    const state: DaemonState = { ...initialDaemonState, autoBuild: makeAutoBuildState(true) };
    expect(selectAutoBuildEnabled(state)).toBe(true);
  });

  it('returns false when autoBuild is null', () => {
    expect(selectAutoBuildEnabled(initialDaemonState)).toBe(false);
  });
});

describe('selectQueueItems', () => {
  it('returns the queue array', () => {
    const queue = [makeQueueItem()];
    const state: DaemonState = { ...initialDaemonState, queue };
    expect(selectQueueItems(state)).toBe(queue);
  });
});

describe('selectRuns', () => {
  it('returns the runs array', () => {
    const runs = [makeRun()];
    const state: DaemonState = { ...initialDaemonState, runs };
    expect(selectRuns(state)).toBe(runs);
  });
});

// ---------------------------------------------------------------------------
// daemonActivity ring buffer
// ---------------------------------------------------------------------------

describe('daemonActivity ring buffer', () => {
  it('appends non-heartbeat events to daemonActivity', () => {
    const event = makeEvent('daemon:lifecycle:starting', {
      pid: 42,
      port: 8080,
      version: '1.0.0',
      mode: 'development',
    });

    const next = daemonReducer(initialDaemonState, {
      type: 'ADD_EVENT',
      event,
      eventId: 'e1',
    });

    expect(next.daemonActivity).toHaveLength(1);
    expect(next.daemonActivity[0].id).toBe('e1');
    expect(next.daemonActivity[0].event).toBe(event);
    expect(typeof next.daemonActivity[0].receivedAt).toBe('number');
  });

  it('caps at 500 entries and drops the oldest on overflow', () => {
    let state = initialDaemonState;
    for (let i = 0; i < 501; i++) {
      const event = makeEvent('daemon:lifecycle:starting', {
        pid: i,
        port: 8080,
        version: '1.0.0',
        mode: 'dev',
      });
      state = daemonReducer(state, {
        type: 'ADD_EVENT',
        event,
        eventId: `e${i}`,
      });
    }

    expect(state.daemonActivity).toHaveLength(500);
    // e0 was dropped; e1 is the oldest remaining
    expect(state.daemonActivity[0].id).toBe('e1');
    // e500 is the newest
    expect(state.daemonActivity[499].id).toBe('e500');
  });
});

// ---------------------------------------------------------------------------
// daemon:heartbeat
// ---------------------------------------------------------------------------

function makeHeartbeatPayload(overrides: Partial<HeartbeatPayload> = {}): HeartbeatPayload {
  return {
    uptime: 60_000,
    queueDepth: 0,
    runningBuilds: 0,
    autoBuild: {
      enabled: true,
      paused: false,
      desired: 'enabled',
      mode: 'running',
      scheduler: { alive: true, paused: false, lastMutationReason: 'enqueue' },
      lastTransition: {
        at: '2024-01-15T09:59:00.000Z',
        previousMode: 'starting',
        nextMode: 'running',
        desired: 'enabled',
        reason: 'startup complete',
        source: 'test',
      },
      reason: 'startup complete',
    },
    subscribers: 1,
    ...overrides,
  };
}

describe('ADD_EVENT: daemon:heartbeat', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('updates latestHeartbeat and does NOT append to daemonActivity', () => {
    const event = makeEvent('daemon:heartbeat', {
      uptime: 5_000,
      queueDepth: 2,
      runningBuilds: 1,
      autoBuild: { enabled: true, paused: false },
      subscribers: 3,
    });

    const next = daemonReducer(initialDaemonState, {
      type: 'ADD_EVENT',
      event,
      eventId: 'hb1',
    });

    expect(next.latestHeartbeat).not.toBeNull();
    expect(next.latestHeartbeat!.payload.uptime).toBe(5_000);
    expect(next.latestHeartbeat!.payload.queueDepth).toBe(2);
    expect(next.latestHeartbeat!.payload.runningBuilds).toBe(1);
    expect(next.latestHeartbeat!.payload.autoBuild).toEqual({ enabled: true, paused: false });
    expect(next.latestHeartbeat!.payload.subscribers).toBe(3);
    // heartbeat must NOT go into the activity buffer
    expect(next.daemonActivity).toHaveLength(0);
  });

  it('overwrites latestHeartbeat on successive heartbeats', () => {
    const event1 = makeEvent('daemon:heartbeat', makeHeartbeatPayload({ uptime: 1_000 }));
    const event2 = makeEvent('daemon:heartbeat', makeHeartbeatPayload({ uptime: 2_000 }));

    const s1 = daemonReducer(initialDaemonState, {
      type: 'ADD_EVENT',
      event: event1,
      eventId: 'hb1',
    });
    const s2 = daemonReducer(s1, {
      type: 'ADD_EVENT',
      event: event2,
      eventId: 'hb2',
    });

    expect(s2.latestHeartbeat!.payload.uptime).toBe(2_000);
    expect(s2.daemonActivity).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// New daemon event types — state deltas
// ---------------------------------------------------------------------------

describe('ADD_EVENT: daemon:lifecycle events', () => {
  it('appends daemon:lifecycle:starting to daemonActivity with no other state change', () => {
    const event = makeEvent('daemon:lifecycle:starting', {
      pid: 1,
      port: 8080,
      version: '1.0.0',
      mode: 'production',
    });

    const next = daemonReducer(initialDaemonState, {
      type: 'ADD_EVENT',
      event,
      eventId: 'e1',
    });

    expect(next.daemonActivity).toHaveLength(1);
    expect(next.runs).toEqual(initialDaemonState.runs);
    expect(next.queue).toEqual(initialDaemonState.queue);
    expect(next.autoBuild).toBeNull();
  });

  it('appends daemon:lifecycle:ready to daemonActivity', () => {
    const event = makeEvent('daemon:lifecycle:ready', {
      pid: 1,
      port: 8080,
      version: '1.0.0',
      mode: 'production',
      recoveryDurationMs: 50,
    });

    const next = daemonReducer(initialDaemonState, {
      type: 'ADD_EVENT',
      event,
      eventId: 'e2',
    });

    expect(next.daemonActivity).toHaveLength(1);
    expect(next.daemonActivity[0].event.type).toBe('daemon:lifecycle:ready');
  });

  it('appends daemon:lifecycle:shutdown:start to daemonActivity', () => {
    const event = makeEvent('daemon:lifecycle:shutdown:start', {
      signal: 'SIGTERM',
      reason: 'user request',
    });

    const next = daemonReducer(initialDaemonState, {
      type: 'ADD_EVENT',
      event,
      eventId: 'e3',
    });

    expect(next.daemonActivity).toHaveLength(1);
  });

  it('appends daemon:lifecycle:shutdown:complete to daemonActivity', () => {
    const event = makeEvent('daemon:lifecycle:shutdown:complete', { durationMs: 200 });

    const next = daemonReducer(initialDaemonState, {
      type: 'ADD_EVENT',
      event,
      eventId: 'e4',
    });

    expect(next.daemonActivity).toHaveLength(1);
  });
});

describe('ADD_EVENT: daemon:scheduler events', () => {
  it('appends daemon:scheduler:dequeued to daemonActivity', () => {
    const event = makeEvent('daemon:scheduler:dequeued', {
      prdId: 'prd-1',
      queueDepth: 1,
      capacityRemaining: 1,
    });

    const next = daemonReducer(initialDaemonState, {
      type: 'ADD_EVENT',
      event,
      eventId: 'e1',
    });

    expect(next.daemonActivity).toHaveLength(1);
  });

  it('appends daemon:scheduler:capacity-blocked to daemonActivity', () => {
    const event = makeEvent('daemon:scheduler:capacity-blocked', {
      queueDepth: 3,
      runningCount: 2,
      limit: 2,
    });

    const next = daemonReducer(initialDaemonState, {
      type: 'ADD_EVENT',
      event,
      eventId: 'e2',
    });

    expect(next.daemonActivity).toHaveLength(1);
  });

  it('appends daemon:scheduler:dependency-blocked to daemonActivity', () => {
    const event = makeEvent('daemon:scheduler:dependency-blocked', {
      prdId: 'prd-2',
      blockedBy: ['prd-1'],
    });

    const next = daemonReducer(initialDaemonState, {
      type: 'ADD_EVENT',
      event,
      eventId: 'e3',
    });

    expect(next.daemonActivity).toHaveLength(1);
  });
});

describe('ADD_EVENT: daemon:auto-build extensions', () => {
  it('daemon:auto-build:enabled sets autoBuild.enabled = true and appends to activity', () => {
    const state: DaemonState = {
      ...initialDaemonState,
      autoBuild: makeAutoBuildState(false),
    };
    const event = makeEvent('daemon:auto-build:enabled', {});

    const next = daemonReducer(state, { type: 'ADD_EVENT', event, eventId: 'e1' });

    expect(next.autoBuild?.enabled).toBe(true);
    expect(next.daemonActivity).toHaveLength(1);
  });

  it('daemon:auto-build:enabled is a no-op when autoBuild is null', () => {
    const event = makeEvent('daemon:auto-build:enabled', {});
    const next = daemonReducer(initialDaemonState, { type: 'ADD_EVENT', event, eventId: 'e1' });

    expect(next.autoBuild).toBeNull();
    expect(next.daemonActivity).toHaveLength(1); // activity still appended
  });

  it('daemon:auto-build:disabled sets autoBuild.enabled = false and appends to activity', () => {
    const state: DaemonState = {
      ...initialDaemonState,
      autoBuild: makeAutoBuildState(true),
    };
    const event = makeEvent('daemon:auto-build:disabled', {});

    const next = daemonReducer(state, { type: 'ADD_EVENT', event, eventId: 'e1' });

    expect(next.autoBuild?.enabled).toBe(false);
    expect(next.daemonActivity).toHaveLength(1);
  });

  it('daemon:auto-build:disabled is a no-op when autoBuild is null', () => {
    const event = makeEvent('daemon:auto-build:disabled', {});
    const next = daemonReducer(initialDaemonState, { type: 'ADD_EVENT', event, eventId: 'e1' });

    expect(next.autoBuild).toBeNull();
    expect(next.daemonActivity).toHaveLength(1); // activity still appended
  });

  it('daemon:auto-build:resumed sets autoBuild.enabled = true and appends to activity', () => {
    const state: DaemonState = {
      ...initialDaemonState,
      autoBuild: makeAutoBuildState(false),
    };
    const event = makeEvent('daemon:auto-build:resumed', {});

    const next = daemonReducer(state, { type: 'ADD_EVENT', event, eventId: 'e1' });

    expect(next.autoBuild?.enabled).toBe(true);
    expect(next.daemonActivity).toHaveLength(1);
  });

  it('daemon:auto-build:triggered appends to activity with no autoBuild change', () => {
    const state: DaemonState = {
      ...initialDaemonState,
      autoBuild: makeAutoBuildState(true),
    };
    const event = makeEvent('daemon:auto-build:triggered', {
      trigger: 'file',
      prdsEnqueued: 1,
    });

    const next = daemonReducer(state, { type: 'ADD_EVENT', event, eventId: 'e1' });

    expect(next.autoBuild?.enabled).toBe(true); // unchanged
    expect(next.daemonActivity).toHaveLength(1);
  });

  it('daemon:auto-build:transition projects enriched FSM fields without replacing watcher detail', () => {
    const state: DaemonState = {
      ...initialDaemonState,
      autoBuild: makeAutoBuildState(false),
    };
    const event = makeEvent('daemon:auto-build:transition', {
      previousMode: 'starting',
      nextMode: 'running',
      desired: 'enabled',
      reason: 'watcher ready',
      source: 'scheduler',
    });

    const next = daemonReducer(state, { type: 'ADD_EVENT', event, eventId: 'e1' });

    expect(next.autoBuild).toMatchObject({
      enabled: true,
      desired: 'enabled',
      mode: 'running',
      watcher: state.autoBuild?.watcher,
      lastTransition: {
        at: '2024-01-15T10:00:00.000Z',
        previousMode: 'starting',
        nextMode: 'running',
        desired: 'enabled',
        reason: 'watcher ready',
        source: 'scheduler',
      },
      reason: 'watcher ready',
    });
    expect(next.daemonActivity).toHaveLength(1);
  });
});

describe('ADD_EVENT: daemon:recovery events', () => {
  it('appends daemon:recovery:start to daemonActivity', () => {
    const event = makeEvent('daemon:recovery:start', {});
    const next = daemonReducer(initialDaemonState, { type: 'ADD_EVENT', event, eventId: 'e1' });
    expect(next.daemonActivity).toHaveLength(1);
  });

  it('appends daemon:recovery:run-marked-failed to daemonActivity', () => {
    const event = makeEvent('daemon:recovery:run-marked-failed', {
      runId: 'run-1',
      planSet: 'my-set',
      reason: 'orphaned',
    });
    const next = daemonReducer(initialDaemonState, { type: 'ADD_EVENT', event, eventId: 'e2' });
    expect(next.daemonActivity).toHaveLength(1);
  });

  it('appends daemon:recovery:lock-removed to daemonActivity', () => {
    const event = makeEvent('daemon:recovery:lock-removed', {
      path: '/tmp/eforge.lock',
      pid: 999,
    });
    const next = daemonReducer(initialDaemonState, { type: 'ADD_EVENT', event, eventId: 'e3' });
    expect(next.daemonActivity).toHaveLength(1);
  });

  it('appends daemon:recovery:complete to daemonActivity', () => {
    const event = makeEvent('daemon:recovery:complete', {
      runsFailed: 1,
      locksRemoved: 1,
      durationMs: 50,
    });
    const next = daemonReducer(initialDaemonState, { type: 'ADD_EVENT', event, eventId: 'e4' });
    expect(next.daemonActivity).toHaveLength(1);
  });
});

describe('ADD_EVENT: daemon:orphan:reaped', () => {
  it('appends to daemonActivity', () => {
    const event = makeEvent('daemon:orphan:reaped', {
      runId: 'run-1',
      sessionId: 'session-99',
      planSet: 'my-set',
      pid: 1234,
    });
    const next = daemonReducer(initialDaemonState, { type: 'ADD_EVENT', event, eventId: 'e1' });
    expect(next.daemonActivity).toHaveLength(1);
    expect(next.daemonActivity[0].event.type).toBe('daemon:orphan:reaped');
  });
});

describe('ADD_EVENT: daemon:warning / daemon:error', () => {
  it('appends daemon:warning to daemonActivity', () => {
    const event = makeEvent('daemon:warning', {
      source: 'scheduler',
      message: 'high queue depth',
    });
    const next = daemonReducer(initialDaemonState, { type: 'ADD_EVENT', event, eventId: 'e1' });
    expect(next.daemonActivity).toHaveLength(1);
  });

  it('appends daemon:error to daemonActivity', () => {
    const event = makeEvent('daemon:error', {
      source: 'db',
      message: 'write failed',
      stack: 'Error: ...',
    });
    const next = daemonReducer(initialDaemonState, { type: 'ADD_EVENT', event, eventId: 'e1' });
    expect(next.daemonActivity).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// selectDaemonActivity
// ---------------------------------------------------------------------------

describe('selectDaemonActivity', () => {
  it('returns the daemonActivity array', () => {
    expect(selectDaemonActivity(initialDaemonState)).toEqual([]);

    const event = makeEvent('daemon:lifecycle:starting', {
      pid: 1,
      port: 8080,
      version: '1.0.0',
      mode: 'dev',
    });
    const next = daemonReducer(initialDaemonState, {
      type: 'ADD_EVENT',
      event,
      eventId: 'e1',
    });

    expect(selectDaemonActivity(next)).toBe(next.daemonActivity);
    expect(selectDaemonActivity(next)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// selectHeartbeatStaleness
// ---------------------------------------------------------------------------

describe('selectHeartbeatStaleness', () => {
  const now = 1_000_000;

  it('returns dead when latestHeartbeat is null', () => {
    expect(selectHeartbeatStaleness(initialDaemonState, now)).toBe('dead');
  });

  it('returns fresh for age < 15 000 ms', () => {
    const state: DaemonState = {
      ...initialDaemonState,
      latestHeartbeat: { at: now - 5_000, payload: makeHeartbeatPayload() },
    };
    expect(selectHeartbeatStaleness(state, now)).toBe('fresh');
  });

  it('returns fresh at exactly 0 ms', () => {
    const state: DaemonState = {
      ...initialDaemonState,
      latestHeartbeat: { at: now, payload: makeHeartbeatPayload() },
    };
    expect(selectHeartbeatStaleness(state, now)).toBe('fresh');
  });

  it('returns fresh at 14 999 ms', () => {
    const state: DaemonState = {
      ...initialDaemonState,
      latestHeartbeat: { at: now - 14_999, payload: makeHeartbeatPayload() },
    };
    expect(selectHeartbeatStaleness(state, now)).toBe('fresh');
  });

  it('returns stale at exactly 15 000 ms', () => {
    const state: DaemonState = {
      ...initialDaemonState,
      latestHeartbeat: { at: now - 15_000, payload: makeHeartbeatPayload() },
    };
    expect(selectHeartbeatStaleness(state, now)).toBe('stale');
  });

  it('returns stale for 15 000 – 29 999 ms', () => {
    const state: DaemonState = {
      ...initialDaemonState,
      latestHeartbeat: { at: now - 20_000, payload: makeHeartbeatPayload() },
    };
    expect(selectHeartbeatStaleness(state, now)).toBe('stale');
  });

  it('returns dead at exactly 30 000 ms', () => {
    const state: DaemonState = {
      ...initialDaemonState,
      latestHeartbeat: { at: now - 30_000, payload: makeHeartbeatPayload() },
    };
    expect(selectHeartbeatStaleness(state, now)).toBe('dead');
  });

  it('returns dead for age > 30 000 ms', () => {
    const state: DaemonState = {
      ...initialDaemonState,
      latestHeartbeat: { at: now - 60_000, payload: makeHeartbeatPayload() },
    };
    expect(selectHeartbeatStaleness(state, now)).toBe('dead');
  });

  it('uses Date.now() as default when now is omitted', () => {
    const at = Date.now() - 5_000;
    const state: DaemonState = {
      ...initialDaemonState,
      latestHeartbeat: { at, payload: makeHeartbeatPayload() },
    };
    expect(selectHeartbeatStaleness(state)).toBe('fresh');
  });
});
