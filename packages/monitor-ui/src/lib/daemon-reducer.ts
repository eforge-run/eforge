/**
 * DaemonState reducer + initial state + action types + selectors.
 *
 * Owns the daemon-wide slices: runs list, queue, session metadata, and
 * auto-build state. Fed by:
 *   1. A one-shot BATCH_SEED from parallel snapshot fetches on mount.
 *   2. ADD_EVENT actions from the /api/daemon-events SSE stream.
 *   3. SET_CONNECTION_STATUS and SET_AUTO_BUILD for targeted mutations.
 *
 * Mirrors the architecture of lib/reducer.ts but scoped to the daemon-wide
 * event subset rather than per-session build events.
 */
import type { RunInfo, QueueItem, SessionMetadata, ConnectionStatus } from '@/lib/types';
import type { EforgeEvent } from '@/lib/types';
import type { AutoBuildState } from '@/lib/api';
import { daemonHandlerRegistry } from './daemon-reducer/index';

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

export interface DaemonState {
  /** Runs sorted by startedAt DESC; runs[0] is the most-recent session. */
  runs: RunInfo[];
  /** Current queue snapshot (pending, running, failed items). */
  queue: QueueItem[];
  /** Per-session metadata keyed by sessionId. */
  sessionMetadata: Record<string, SessionMetadata>;
  /** Auto-build state; null when the daemon does not support it. */
  autoBuild: AutoBuildState | null;
  /** Connection status for the /api/daemon-events SSE stream. */
  connectionStatus: ConnectionStatus;
}

export const initialDaemonState: DaemonState = {
  runs: [],
  queue: [],
  sessionMetadata: {},
  autoBuild: null,
  connectionStatus: 'disconnected',
};

// ---------------------------------------------------------------------------
// Action types
// ---------------------------------------------------------------------------

export type DaemonAction =
  | {
      type: 'BATCH_SEED';
      runs: RunInfo[];
      queue: QueueItem[];
      sessionMetadata: Record<string, SessionMetadata>;
      autoBuild: AutoBuildState | null;
    }
  | { type: 'ADD_EVENT'; event: EforgeEvent; eventId: string }
  | { type: 'SET_CONNECTION_STATUS'; status: ConnectionStatus }
  | { type: 'SET_AUTO_BUILD'; autoBuild: AutoBuildState | null };

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function daemonReducer(state: DaemonState, action: DaemonAction): DaemonState {
  switch (action.type) {
    case 'BATCH_SEED':
      return {
        ...state,
        runs: action.runs,
        queue: action.queue,
        sessionMetadata: action.sessionMetadata,
        autoBuild: action.autoBuild,
      };

    case 'ADD_EVENT': {
      const { event } = action;
      const handler = (
        daemonHandlerRegistry as Record<
          string,
          | ((e: never, s: Readonly<DaemonState>) => Partial<DaemonState> | undefined)
          | undefined
        >
      )[event.type];
      if (!handler) return state;
      const delta = handler(event as never, state);
      if (!delta) return state;
      return { ...state, ...delta };
    }

    case 'SET_CONNECTION_STATUS':
      return { ...state, connectionStatus: action.status };

    case 'SET_AUTO_BUILD':
      return { ...state, autoBuild: action.autoBuild };

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/** The sessionId of the most recently started run, or null if no runs exist. */
export const selectLatestSessionId = (state: DaemonState): string | null =>
  state.runs[0]?.sessionId ?? null;

/** Whether auto-build is currently enabled. */
export const selectAutoBuildEnabled = (state: DaemonState): boolean =>
  state.autoBuild?.enabled ?? false;

/** Current queue items. */
export const selectQueueItems = (state: DaemonState): QueueItem[] => state.queue;

/** All runs, sorted by startedAt DESC. */
export const selectRuns = (state: DaemonState): RunInfo[] => state.runs;

/** Session metadata map. */
export const selectSessionMetadata = (
  state: DaemonState,
): Record<string, SessionMetadata> => state.sessionMetadata;
