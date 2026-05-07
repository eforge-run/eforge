// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useDaemonEvents } from '../use-daemon-events';
import type { RunInfo, QueueItem } from '@/lib/types';
import type { AutoBuildState } from '@/lib/api';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRun(overrides: Partial<RunInfo> = {}): RunInfo {
  return {
    id: 'run-1',
    sessionId: 'session-1',
    planSet: 'my-set',
    command: 'build',
    status: 'completed',
    startedAt: '2024-01-15T09:00:00.000Z',
    cwd: '/project',
    ...overrides,
  };
}

function makeQueue(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 'prd-1',
    title: 'Feature',
    status: 'pending',
    ...overrides,
  };
}

function makeAutoBuild(): AutoBuildState {
  return { enabled: true, watcher: { running: true, pid: 9, sessionId: null } };
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

/**
 * Stub subscribeWithSnapshot so tests can control what frames arrive.
 * The stub is an async generator that yields frames injected via `pushFrame`.
 */
type AnyFrame =
  | { kind: 'snapshot'; snapshot: unknown }
  | { kind: 'event'; event: object; eventId?: string }
  | { kind: 'named'; name: string; data: string };

let frameQueue: AnyFrame[] = [];
let frameResolver: (() => void) | null = null;
let generatorAborted = false;

function waitForFrame(): Promise<void> {
  return new Promise<void>((resolve) => {
    frameResolver = resolve;
  });
}

async function* stubGenerator(
  _url: string,
  opts?: { signal?: AbortSignal },
): AsyncGenerator<AnyFrame> {
  generatorAborted = false;
  opts?.signal?.addEventListener('abort', () => {
    generatorAborted = true;
    if (frameResolver) { const r = frameResolver; frameResolver = null; r(); }
  });

  while (!generatorAborted) {
    while (frameQueue.length > 0) {
      yield frameQueue.shift()!;
    }
    if (!generatorAborted) {
      await waitForFrame();
    }
  }
}

function pushFrame(frame: AnyFrame): void {
  frameQueue.push(frame);
  if (frameResolver) { const r = frameResolver; frameResolver = null; r(); }
}

vi.mock('@eforge-build/client/browser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@eforge-build/client/browser')>();
  return {
    ...actual,
    API_ROUTES: {
      runs: '/api/runs',
      queue: '/api/queue',
      sessionMetadata: '/api/session-metadata',
      autoBuildGet: '/api/auto-build',
      daemonEvents: '/api/daemon-events',
    },
    subscribeWithSnapshot: vi.fn(stubGenerator),
  };
});

function makeDaemonSnapshot() {
  return {
    cursor: 5,
    liveness: {
      type: 'daemon:heartbeat',
      timestamp: '2024-01-15T09:00:00.000Z',
      uptime: 60000,
      queueDepth: 0,
      runningBuilds: 0,
      autoBuild: { enabled: true, paused: false },
      subscribers: 1,
    },
    recentActivity: [] as Array<{ id: number; event: object }>,
    runs: [makeRun()],
    queue: [makeQueue()],
    sessionMetadata: { 'session-1': { planCount: 2, baseProfile: 'errand' } },
    autoBuild: makeAutoBuild(),
  };
}

beforeEach(() => {
  frameQueue = [];
  frameResolver = null;
  generatorAborted = false;
});

afterEach(() => {
  vi.clearAllMocks();
  // Drain any pending frame waiting
  if (frameResolver) { const r = frameResolver; frameResolver = null; r(); }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useDaemonEvents', () => {
  it('seeds state from snapshot frame on mount', async () => {
    const { result } = renderHook(() => useDaemonEvents());

    // Push a snapshot frame to trigger BATCH_SEED
    act(() => {
      pushFrame({ kind: 'snapshot', snapshot: makeDaemonSnapshot() });
    });

    await waitFor(() => {
      expect(result.current.connectionStatus).toBe('connected');
    });

    expect(result.current.daemonState.runs).toHaveLength(1);
    expect(result.current.daemonState.runs[0].sessionId).toBe('session-1');
    expect(result.current.daemonState.queue).toHaveLength(1);
    expect(result.current.daemonState.queue[0].id).toBe('prd-1');
    expect(result.current.daemonState.sessionMetadata).toEqual({
      'session-1': { planCount: 2, baseProfile: 'errand' },
    });
    expect(result.current.daemonState.autoBuild?.enabled).toBe(true);
  });

  it('populates latestHeartbeat from snapshot liveness field', async () => {
    const { result } = renderHook(() => useDaemonEvents());

    act(() => {
      pushFrame({ kind: 'snapshot', snapshot: makeDaemonSnapshot() });
    });

    await waitFor(() => expect(result.current.connectionStatus).toBe('connected'));

    expect(result.current.daemonState.latestHeartbeat).not.toBeNull();
    expect(result.current.daemonState.latestHeartbeat!.payload.uptime).toBe(60000);
  });

  it('processes SSE event frames via the reducer', async () => {
    const { result } = renderHook(() => useDaemonEvents());

    act(() => {
      pushFrame({ kind: 'snapshot', snapshot: makeDaemonSnapshot() });
    });
    await waitFor(() => expect(result.current.connectionStatus).toBe('connected'));

    // Simulate a new run appearing via daemon:run:upsert (the authoritative source
    // for DaemonState.runs — session:start no longer synthesizes a run row).
    act(() => {
      pushFrame({
        kind: 'event',
        event: {
          type: 'daemon:run:upsert',
          timestamp: '2024-01-15T11:00:00.000Z',
          run: {
            id: 'run-new',
            sessionId: 'new-session',
            planSet: 'some-set',
            command: 'build',
            status: 'running',
            startedAt: '2024-01-15T11:00:00.000Z',
            cwd: '/project',
          },
        },
        eventId: '100',
      });
    });

    await waitFor(() => {
      // daemon:run:upsert prepends the new run, so it becomes runs[0]
      expect(result.current.daemonState.runs[0].sessionId).toBe('new-session');
    });
  });

  it('selectLatestSessionId returns runs[0].sessionId after snapshot', async () => {
    const { result } = renderHook(() => useDaemonEvents());

    act(() => {
      pushFrame({ kind: 'snapshot', snapshot: makeDaemonSnapshot() });
    });
    await waitFor(() => expect(result.current.connectionStatus).toBe('connected'));

    expect(result.current.daemonState.runs[0]?.sessionId).toBe('session-1');
  });

  it('setDaemonAutoBuild updates autoBuild state directly', async () => {
    const { result } = renderHook(() => useDaemonEvents());

    act(() => {
      pushFrame({ kind: 'snapshot', snapshot: makeDaemonSnapshot() });
    });
    await waitFor(() => expect(result.current.connectionStatus).toBe('connected'));

    const newState: AutoBuildState = {
      enabled: false,
      watcher: { running: false, pid: null, sessionId: null },
    };

    act(() => {
      result.current.setDaemonAutoBuild(newState);
    });

    expect(result.current.daemonState.autoBuild?.enabled).toBe(false);
  });

  it('daemon:auto-build:paused event frame disables autoBuild', async () => {
    const { result } = renderHook(() => useDaemonEvents());

    act(() => {
      pushFrame({ kind: 'snapshot', snapshot: makeDaemonSnapshot() });
    });
    await waitFor(() => expect(result.current.connectionStatus).toBe('connected'));

    act(() => {
      pushFrame({
        kind: 'event',
        event: {
          type: 'daemon:auto-build:paused',
          reason: 'Build failed',
          sessionId: undefined,
          timestamp: '2024-01-15T10:05:00.000Z',
        },
        eventId: '101',
      });
    });

    await waitFor(() => {
      expect(result.current.daemonState.autoBuild?.enabled).toBe(false);
    });
  });

  it('dedupes recentActivity on re-seed', async () => {
    const { result } = renderHook(() => useDaemonEvents());

    const activity = [
      { id: 1, event: { type: 'session:start', timestamp: '2024-01-15T09:00:00.000Z', sessionId: 's1' } },
    ];
    const snapshot1 = { ...makeDaemonSnapshot(), recentActivity: activity };
    const snapshot2 = {
      ...makeDaemonSnapshot(),
      recentActivity: [
        ...activity,
        { id: 2, event: { type: 'session:end', timestamp: '2024-01-15T09:01:00.000Z', sessionId: 's1', result: { status: 'completed', summary: 'done' } } },
      ],
    };

    act(() => { pushFrame({ kind: 'snapshot', snapshot: snapshot1 }); });
    await waitFor(() => expect(result.current.connectionStatus).toBe('connected'));
    expect(result.current.daemonState.daemonActivity).toHaveLength(1);

    // Re-seed with overlapping + new activity
    act(() => { pushFrame({ kind: 'snapshot', snapshot: snapshot2 }); });
    await waitFor(() => expect(result.current.daemonState.daemonActivity).toHaveLength(2));

    // Each id appears exactly once
    const ids = result.current.daemonState.daemonActivity.map((a) => a.id);
    expect(ids).toEqual(['1', '2']);
  });
});
