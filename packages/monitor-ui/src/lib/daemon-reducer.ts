/**
 * DaemonState reducer + initial state + action types + selectors.
 *
 * Owns the daemon-wide slices: runs list, queue, session metadata, auto-build
 * state, activity ring-buffer, and latest heartbeat. Fed by:
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
// Activity ring-buffer types
// ---------------------------------------------------------------------------

/** Maximum number of entries kept in the daemonActivity ring buffer. */
const ACTIVITY_BUFFER_CAP = 500;

/** A single entry in the daemon activity ring buffer. */
export interface DaemonActivityEntry {
  /** The SSE event ID (or empty string for live-only events). */
  id: string;
  /** The full EforgeEvent that was received. */
  event: EforgeEvent;
  /** Wall-clock time (Date.now()) when the event arrived in the UI. */
  receivedAt: number;
}

/** Payload shape of daemon:heartbeat events, extracted into a named type. */
export interface HeartbeatPayload {
  uptime: number;
  queueDepth: number;
  runningBuilds: number;
  autoBuild: { enabled: boolean; paused: boolean };
  subscribers: number;
}

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
  /**
   * Ring buffer of all daemon-stream events received since mount, capped at
   * ACTIVITY_BUFFER_CAP. daemon:heartbeat events are excluded (they would
   * dominate the buffer). Newest entries are at the end.
   */
  daemonActivity: DaemonActivityEntry[];
  /**
   * The most recently received daemon:heartbeat payload, or null if no
   * heartbeat has been received yet. Used to determine daemon liveness.
   */
  latestHeartbeat: { at: number; payload: HeartbeatPayload } | null;
}

export const initialDaemonState: DaemonState = {
  runs: [],
  queue: [],
  sessionMetadata: {},
  autoBuild: null,
  connectionStatus: 'disconnected',
  daemonActivity: [],
  latestHeartbeat: null,
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
      const { event, eventId } = action;
      const isHeartbeat = event.type === 'daemon:heartbeat';

      const handler = (
        daemonHandlerRegistry as Record<
          string,
          | ((e: never, s: Readonly<DaemonState>) => Partial<DaemonState> | undefined)
          | undefined
        >
      )[event.type];
      const delta = handler ? handler(event as never, state) : undefined;

      if (!isHeartbeat) {
        // Centralised activity-append: every non-heartbeat daemon-stream event
        // is recorded in the ring buffer regardless of whether it has a handler.
        const entry: DaemonActivityEntry = { id: eventId, event, receivedAt: Date.now() };
        const newActivity =
          state.daemonActivity.length < ACTIVITY_BUFFER_CAP
            ? [...state.daemonActivity, entry]
            : [...state.daemonActivity.slice(1), entry];
        return { ...state, ...delta, daemonActivity: newActivity };
      }

      // Heartbeat: only apply delta (latestHeartbeat update), no activity append.
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

/** The daemon activity ring buffer (newest entries are at the end). */
export const selectDaemonActivity = (state: DaemonState): DaemonActivityEntry[] =>
  state.daemonActivity;

/**
 * Daemon liveness based on time elapsed since the last heartbeat.
 *
 * - 'fresh'  — heartbeat received within the last 15 seconds (green).
 * - 'stale'  — between 15 and 30 seconds ago (amber).
 * - 'dead'   — more than 30 seconds ago, or no heartbeat received (red).
 *
 * @param state — current DaemonState.
 * @param now   — current timestamp in ms (defaults to Date.now()).
 */
export const selectHeartbeatStaleness = (
  state: DaemonState,
  now: number = Date.now(),
): 'fresh' | 'stale' | 'dead' => {
  if (!state.latestHeartbeat) return 'dead';
  const age = now - state.latestHeartbeat.at;
  if (age < 15_000) return 'fresh';
  if (age < 30_000) return 'stale';
  return 'dead';
};
