import { useReducer, useEffect, useCallback } from 'react';
import {
  daemonReducer,
  initialDaemonState,
  type DaemonState,
} from '@/lib/daemon-reducer';
import type { ConnectionStatus, RunInfo, QueueItem, SessionMetadata } from '@/lib/types';
import type { AutoBuildState } from '@/lib/api';
import type { EforgeEvent } from '@/lib/types';
import { API_ROUTES, subscribeToDaemonEvents } from '@eforge-build/client/browser';

export interface UseDaemonEventsResult {
  daemonState: DaemonState;
  connectionStatus: ConnectionStatus;
  /** Update auto-build state directly (used after a manual toggle to avoid SWR poll). */
  setDaemonAutoBuild: (autoBuild: AutoBuildState | null) => void;
}

export function useDaemonEvents(): UseDaemonEventsResult {
  const [daemonState, dispatch] = useReducer(daemonReducer, initialDaemonState);

  const setDaemonAutoBuild = useCallback((autoBuild: AutoBuildState | null) => {
    dispatch({ type: 'SET_AUTO_BUILD', autoBuild });
  }, []);

  useEffect(() => {
    const abort = new AbortController();

    /**
     * Fetch REST snapshots in parallel and dispatch BATCH_SEED + SET_CONNECTION_STATUS.
     * Called once on mount and again from the onReconnect callback so the reducer
     * heals automatically across daemon restarts without a manual browser refresh.
     * A fetch aborted by `abort.signal` resolves silently (no log, no disconnected).
     */
    async function seedSnapshot(signal: AbortSignal): Promise<void> {
      const [runsRes, queueRes, metadataRes, autoBuildRes] = await Promise.all([
        fetch(API_ROUTES.runs, { signal }),
        fetch(API_ROUTES.queue, { signal }),
        fetch(API_ROUTES.sessionMetadata, { signal }),
        fetch(API_ROUTES.autoBuildGet, { signal }),
      ]);

      const runs: RunInfo[] = runsRes.ok ? ((await runsRes.json()) as RunInfo[]) : [];
      const queue: QueueItem[] = queueRes.ok ? ((await queueRes.json()) as QueueItem[]) : [];
      const sessionMetadata: Record<string, SessionMetadata> = metadataRes.ok
        ? ((await metadataRes.json()) as Record<string, SessionMetadata>)
        : {};
      const autoBuild: AutoBuildState | null = autoBuildRes.ok
        ? ((await autoBuildRes.json()) as AutoBuildState)
        : null;

      dispatch({ type: 'BATCH_SEED', runs, queue, sessionMetadata, autoBuild });
      dispatch({ type: 'SET_CONNECTION_STATUS', status: 'connected' });
    }

    (async () => {
      dispatch({ type: 'SET_CONNECTION_STATUS', status: 'connecting' });

      // Parallel snapshot fetch to seed the reducer on mount.
      await seedSnapshot(abort.signal);

      // Subscribe to the daemon-events SSE stream for live updates.
      await subscribeToDaemonEvents({
        baseUrl: '',
        signal: abort.signal,
        onEvent: (event, meta) => {
          dispatch({
            type: 'ADD_EVENT',
            event: event as EforgeEvent,
            eventId: meta.eventId ?? '',
          });
        },
        onReconnect: () => {
          // Re-seed snapshot after reconnect so REST state (runs, queue,
          // session metadata, auto-build) is refreshed. Aborted fetches
          // are silently ignored.
          void seedSnapshot(abort.signal).catch((err: unknown) => {
            if (abort.signal.aborted) return;
            console.error('useDaemonEvents: seedSnapshot on reconnect failed:', err);
          });
        },
      });
    })().catch((err: unknown) => {
      if (abort.signal.aborted) return;
      console.error('useDaemonEvents: subscribeToDaemonEvents failed:', err);
      dispatch({ type: 'SET_CONNECTION_STATUS', status: 'disconnected' });
    });

    return () => {
      abort.abort();
    };
  }, []);

  return {
    daemonState,
    connectionStatus: daemonState.connectionStatus,
    setDaemonAutoBuild,
  };
}
