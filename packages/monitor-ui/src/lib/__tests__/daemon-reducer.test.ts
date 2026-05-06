import { describe, it, expect } from 'vitest';
import {
  daemonReducer,
  initialDaemonState,
  selectLatestSessionId,
  selectAutoBuildEnabled,
  selectQueueItems,
  selectRuns,
  type DaemonState,
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
    watcher: { running: true, pid: 1234, sessionId: null },
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
  });

  // ---------------------------------------------------------------------------
  // session:start
  // ---------------------------------------------------------------------------
  describe('ADD_EVENT: session:start', () => {
    it('prepends a new run entry for an unknown sessionId', () => {
      const existing = makeRun({ id: 'old-run', sessionId: 'old-session' });
      const state: DaemonState = { ...initialDaemonState, runs: [existing] };
      const event = makeEvent('session:start', { sessionId: 'new-session' });

      const next = daemonReducer(state, { type: 'ADD_EVENT', event, eventId: 'e1' });

      expect(next.runs).toHaveLength(2);
      expect(next.runs[0].sessionId).toBe('new-session');
      expect(next.runs[0].status).toBe('running');
      expect(next.runs[1]).toEqual(existing);
    });

    it('updates an existing run to running', () => {
      const existing = makeRun({ status: 'completed' });
      const state: DaemonState = { ...initialDaemonState, runs: [existing] };
      const event = makeEvent('session:start', { sessionId: 'session-1' });

      const next = daemonReducer(state, { type: 'ADD_EVENT', event, eventId: 'e1' });

      expect(next.runs).toHaveLength(1);
      expect(next.runs[0].status).toBe('running');
    });
  });

  // ---------------------------------------------------------------------------
  // session:end
  // ---------------------------------------------------------------------------
  describe('ADD_EVENT: session:end', () => {
    it('marks the matching run as completed', () => {
      const state: DaemonState = { ...initialDaemonState, runs: [makeRun()] };
      const event = makeEvent('session:end', {
        sessionId: 'session-1',
        result: { status: 'completed', summary: 'done' },
      });

      const next = daemonReducer(state, { type: 'ADD_EVENT', event, eventId: 'e1' });

      expect(next.runs[0].status).toBe('completed');
      expect(next.runs[0].completedAt).toBe('2024-01-15T10:00:00.000Z');
    });

    it('marks the matching run as failed', () => {
      const state: DaemonState = { ...initialDaemonState, runs: [makeRun()] };
      const event = makeEvent('session:end', {
        sessionId: 'session-1',
        result: { status: 'failed', summary: 'error' },
      });

      const next = daemonReducer(state, { type: 'ADD_EVENT', event, eventId: 'e1' });

      expect(next.runs[0].status).toBe('failed');
    });

    it('returns state unchanged when sessionId is not found', () => {
      const state: DaemonState = { ...initialDaemonState, runs: [makeRun()] };
      const event = makeEvent('session:end', {
        sessionId: 'unknown-session',
        result: { status: 'completed', summary: '' },
      });

      const next = daemonReducer(state, { type: 'ADD_EVENT', event, eventId: 'e1' });

      expect(next).toBe(state);
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

    it('ignores duplicate prdIds', () => {
      const state: DaemonState = { ...initialDaemonState, queue: [makeQueueItem()] };
      const event = makeEvent('queue:prd:discovered', { prdId: 'prd-1', title: 'Dup' });

      const next = daemonReducer(state, { type: 'ADD_EVENT', event, eventId: 'e1' });

      expect(next).toBe(state);
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

    it('returns state unchanged when autoBuild is null', () => {
      const state: DaemonState = { ...initialDaemonState, autoBuild: null };
      const event = makeEvent('daemon:auto-build:paused', { reason: 'whatever' });

      const next = daemonReducer(state, { type: 'ADD_EVENT', event, eventId: 'e1' });

      expect(next).toBe(state);
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
