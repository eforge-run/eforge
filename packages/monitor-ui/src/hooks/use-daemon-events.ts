import { useReducer, useEffect, useCallback } from 'react';
import {
  daemonReducer,
  initialDaemonState,
  type DaemonState,
} from '@/lib/daemon-reducer';
import type { ConnectionStatus } from '@/lib/types';
import type { AutoBuildState } from '@/lib/api';
import type { EforgeEvent } from '@/lib/types';
import { API_ROUTES, subscribeWithSnapshot } from '@eforge-build/client/browser';
import type { DaemonStreamSnapshot } from '@eforge-build/client/browser';

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

      try {
        for await (const frame of subscribeWithSnapshot<DaemonStreamSnapshot, EforgeEvent>(
          API_ROUTES.daemonEvents,
          { signal: abort.signal },
        )) {
          if (frame.kind === 'snapshot') {
            const snapshot = frame.snapshot;
            // Dispatch BATCH_SEED with the snapshot fields, plus recentActivity and
            // a synthetic latestHeartbeat from the liveness field so the daemon
            // liveness pill renders green immediately on (re)connect.
            dispatch({
              type: 'BATCH_SEED',
              runs: snapshot.runs,
              queue: snapshot.queue,
              sessionMetadata: snapshot.sessionMetadata,
              autoBuild: snapshot.autoBuild,
              recentActivity: snapshot.recentActivity.map((a) => ({
                id: String(a.id),
                event: a.event as EforgeEvent,
              })),
              latestHeartbeat: {
                at: Date.now(),
                payload: {
                  uptime: snapshot.liveness.uptime,
                  queueDepth: snapshot.liveness.queueDepth,
                  runningBuilds: snapshot.liveness.runningBuilds,
                  autoBuild: snapshot.liveness.autoBuild,
                  subscribers: snapshot.liveness.subscribers,
                },
              },
            });
            dispatch({ type: 'SET_CONNECTION_STATUS', status: 'connected' });
          } else if (frame.kind === 'event') {
            dispatch({
              type: 'ADD_EVENT',
              event: frame.event,
              eventId: frame.eventId ?? '',
            });
          }
          // Named events (e.g. monitor:shutdown-pending) are not expected on the
          // daemon-events stream; ignore them.
        }
      } catch (err: unknown) {
        if (abort.signal.aborted) return;
        console.error('useDaemonEvents: subscribeWithSnapshot failed:', err);
        dispatch({ type: 'SET_CONNECTION_STATUS', status: 'disconnected' });
      }
    })();

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
