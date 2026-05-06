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

// Encode an event as an SSE data line.
function toSseLine(event: object): string {
  return `id: 99\ndata: ${JSON.stringify(event)}\n\n`;
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Stub subscribeToDaemonEvents so tests control what events arrive.
let onEventCallback: ((event: object, meta: { eventId?: string }) => void) | null = null;

vi.mock('@eforge-build/client/browser', () => {
  return {
    API_ROUTES: {
      runs: '/api/runs',
      queue: '/api/queue',
      sessionMetadata: '/api/session-metadata',
      autoBuildGet: '/api/auto-build',
      daemonEvents: '/api/daemon-events',
    },
    subscribeToDaemonEvents: vi.fn(async (opts: { onEvent: (event: object, meta: { eventId?: string }) => void; signal?: AbortSignal }) => {
      onEventCallback = opts.onEvent;
      // Wait until aborted
      return new Promise<void>((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    }),
  };
});

const defaultFetchResponses: Record<string, unknown> = {
  '/api/runs': [makeRun()],
  '/api/queue': [makeQueue()],
  '/api/session-metadata': { 'session-1': { planCount: 2, baseProfile: 'errand' } },
  '/api/auto-build': makeAutoBuild(),
};

function stubFetch(responses: Record<string, unknown> = defaultFetchResponses): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => ({
      ok: true,
      json: async () => responses[url] ?? null,
    })),
  );
}

beforeEach(() => {
  onEventCallback = null;
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useDaemonEvents', () => {
  it('seeds state from snapshot fetches on mount', async () => {
    const { result } = renderHook(() => useDaemonEvents());

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

  it('processes SSE events via the reducer', async () => {
    const { result } = renderHook(() => useDaemonEvents());

    await waitFor(() => expect(result.current.connectionStatus).toBe('connected'));
    expect(onEventCallback).not.toBeNull();

    // Simulate a new session starting via SSE
    act(() => {
      onEventCallback?.(
        { type: 'session:start', sessionId: 'new-session', timestamp: '2024-01-15T11:00:00.000Z' },
        { eventId: '100' },
      );
    });

    await waitFor(() => {
      expect(result.current.daemonState.runs[0].sessionId).toBe('new-session');
    });
  });

  it('selectLatestSessionId returns runs[0].sessionId', async () => {
    const { result } = renderHook(() => useDaemonEvents());

    await waitFor(() => expect(result.current.connectionStatus).toBe('connected'));

    // After mount, runs[0] is the seeded run
    expect(result.current.daemonState.runs[0]?.sessionId).toBe('session-1');
  });

  it('setDaemonAutoBuild updates autoBuild state directly', async () => {
    const { result } = renderHook(() => useDaemonEvents());

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

  it('daemon:auto-build:paused SSE event disables autoBuild', async () => {
    const { result } = renderHook(() => useDaemonEvents());

    await waitFor(() => expect(result.current.connectionStatus).toBe('connected'));

    act(() => {
      onEventCallback?.(
        {
          type: 'daemon:auto-build:paused',
          reason: 'Build failed',
          sessionId: undefined,
          timestamp: '2024-01-15T10:05:00.000Z',
        },
        { eventId: '101' },
      );
    });

    await waitFor(() => {
      expect(result.current.daemonState.autoBuild?.enabled).toBe(false);
    });
  });
});
