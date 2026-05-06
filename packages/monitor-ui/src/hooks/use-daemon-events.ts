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

    (async () => {
      dispatch({ type: 'SET_CONNECTION_STATUS', status: 'connecting' });

      // Parallel snapshot fetch to seed the reducer on mount (one-time, no refresh).
      const [runsRes, queueRes, metadataRes, autoBuildRes] = await Promise.all([
        fetch(API_ROUTES.runs, { signal: abort.signal }),
        fetch(API_ROUTES.queue, { signal: abort.signal }),
        fetch(API_ROUTES.sessionMetadata, { signal: abort.signal }),
        fetch(API_ROUTES.autoBuildGet, { signal: abort.signal }),
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
