import { useReducer, useEffect, useRef, useState, useCallback } from 'react';
import { eforgeReducer, initialRunState, type RunState } from '@/lib/reducer';
import type { ConnectionStatus, EforgeEvent } from '@/lib/types';
import { API_ROUTES, buildPath, subscribeWithSnapshot } from '@eforge-build/client/browser';
import type { SessionStreamSnapshot } from '@eforge-build/client/browser';
import { BoundedMap } from '@/lib/lru';

interface UseEforgeEventsResult {
  runState: RunState;
  connectionStatus: ConnectionStatus;
  shutdownCountdown: number | null;
}

export function useEforgeEvents(sessionId: string | null): UseEforgeEventsResult {
  const [runState, dispatch] = useReducer(eforgeReducer, initialRunState);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [shutdownCountdown, setShutdownCountdown] = useState<number | null>(null);
  const cacheRef = useRef<BoundedMap<string, RunState>>(new BoundedMap<string, RunState>(20));
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Countdown tick handler — decrements every second until 0
  const startCountdownTick = useCallback((initialSeconds: number) => {
    if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
    setShutdownCountdown(initialSeconds);
    countdownTimerRef.current = setInterval(() => {
      setShutdownCountdown((prev) => {
        if (prev === null || prev <= 1) {
          if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
          countdownTimerRef.current = null;
          return prev === null ? null : 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, []);

  const cancelCountdownTick = useCallback(() => {
    if (countdownTimerRef.current) {
      clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    setShutdownCountdown(null);
  }, []);

  useEffect(() => {
    if (!sessionId) {
      dispatch({ type: 'RESET' });
      setConnectionStatus('disconnected');
      return;
    }

    // Check client-side cache first (completed sessions only)
    const cached = cacheRef.current.get(sessionId);
    if (cached) {
      dispatch({ type: 'BATCH_LOAD', events: cached.events });
      setConnectionStatus('connected');
      return;
    }

    const abort = new AbortController();
    setConnectionStatus('connecting');
    const url = buildPath(API_ROUTES.events, { id: sessionId });

    (async () => {
      for await (const frame of subscribeWithSnapshot<SessionStreamSnapshot, EforgeEvent>(
        url,
        { signal: abort.signal },
      )) {
        if (frame.kind === 'snapshot') {
          const snapshot = frame.snapshot;
          // Parse snapshot events and dispatch as a single batch
          const parsedEvents: Array<{ event: EforgeEvent; eventId: string }> = [];
          for (const ev of snapshot.events) {
            try {
              parsedEvents.push({
                event: JSON.parse(ev.data) as EforgeEvent,
                eventId: String(ev.id),
              });
            } catch { /* skip unparseable */ }
          }
          dispatch({ type: 'BATCH_LOAD', events: parsedEvents, serverStatus: snapshot.status });
          setConnectionStatus('connected');

          if (snapshot.status === 'completed' || snapshot.status === 'failed') {
            // Cache the final state and stop the iterator — server closes the
            // connection after stream:hello for terminal sessions, so no live
            // subscription is needed.
            let finalState = parsedEvents.reduce(
              (st, ev) => eforgeReducer(st, { type: 'ADD_EVENT', ...ev }),
              { ...initialRunState, fileChanges: new Map() } as RunState,
            );
            // Mirror the serverStatus override BATCH_LOAD applies, so the cached
            // state agrees with the dispatched state when events lack a session:end.
            if (!finalState.isComplete) {
              finalState = { ...finalState, isComplete: true, resultStatus: snapshot.status };
            }
            cacheRef.current.set(sessionId, finalState);
            break;
          }
        } else if (frame.kind === 'event') {
          dispatch({ type: 'ADD_EVENT', event: frame.event, eventId: frame.eventId ?? '' });
        } else if (frame.kind === 'named') {
          if (frame.name === 'monitor:shutdown-pending') {
            try {
              const parsed = JSON.parse(frame.data) as { countdown: number };
              startCountdownTick(parsed.countdown);
            } catch { /* ignore malformed payload */ }
          } else if (frame.name === 'monitor:shutdown-cancelled') {
            cancelCountdownTick();
          }
        }
      }
    })().catch((err: unknown) => {
      if (abort.signal.aborted) return;
      console.error('subscribeWithSnapshot failed:', err);
      setConnectionStatus('disconnected');
    });

    return () => {
      abort.abort();
      cancelCountdownTick();
    };
  }, [sessionId, startCountdownTick, cancelCountdownTick]);

  return { runState, connectionStatus, shutdownCountdown };
}
