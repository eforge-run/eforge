import { useReducer, useEffect, useRef, useState, useCallback } from 'react';
import { mutate } from 'swr';
import { eforgeReducer, initialRunState, type RunState } from '@/lib/reducer';
import type { ConnectionStatus, EforgeEvent } from '@/lib/types';
import { API_ROUTES, buildPath, subscribeToSession } from '@eforge-build/client/browser';
import { BoundedMap } from '@/lib/lru';

interface UseEforgeEventsResult {
  runState: RunState;
  connectionStatus: ConnectionStatus;
  shutdownCountdown: number | null;
}

interface RunStateResponse {
  status: string;
  events: Array<{ id: number; data: string }>;
}

/** Invalidate SWR cache keys based on incoming SSE events. */
function invalidateOnEvent(event: EforgeEvent): void {
  switch (event.type) {
    case 'phase:start':
    case 'phase:end':
      void mutate(API_ROUTES.runs);
      void mutate(API_ROUTES.sessionMetadata);
      break;
    case 'session:end':
      void mutate(API_ROUTES.runs);
      void mutate(API_ROUTES.latestRun);
      break;
    case 'enqueue:complete':
    case 'plan:build:complete':
      void mutate(API_ROUTES.queue);
      break;
    case 'plan:build:failed':
      void mutate(API_ROUTES.queue);
      void mutate(['sidecar', event.planId]);
      break;
    default:
      break;
  }
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

    (async () => {
      // Initial HTTP snapshot (batch-load all events already stored by the daemon)
      const res = await fetch(buildPath(API_ROUTES.runState, { id: sessionId }), { signal: abort.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as RunStateResponse;

      // Parse all events and dispatch as a single batch
      const parsed: Array<{ event: EforgeEvent; eventId: string }> = [];
      for (const ev of data.events) {
        try {
          parsed.push({ event: JSON.parse(ev.data) as EforgeEvent, eventId: String(ev.id) });
        } catch { /* skip unparseable */ }
      }

      dispatch({ type: 'BATCH_LOAD', events: parsed, serverStatus: data.status });
      setConnectionStatus('connected');

      const isServerComplete = data.status === 'completed' || data.status === 'failed';

      if (isServerComplete) {
        // Session is done — cache it and skip SSE
        const finalState = parsed.reduce(
          (st, ev) => eforgeReducer(st, { type: 'ADD_EVENT', ...ev }),
          { ...initialRunState, fileChanges: new Map() } as RunState,
        );
        cacheRef.current.set(sessionId, finalState);
        return;
      }

      // Track the highest event id from the batch so we can skip replayed events
      // on the first SSE connection (the daemon replays historical events when no
      // Last-Event-ID header is sent).
      const lastBatchEventId = data.events.length > 0 ? data.events[data.events.length - 1].id : null;

      // Session is still active — subscribe for live events via subscribeToSession
      await subscribeToSession<EforgeEvent>(sessionId, {
        baseUrl: '',
        signal: abort.signal,
        onEvent: (event, meta) => {
          // Skip events already received via the batch load
          if (lastBatchEventId !== null && meta.eventId !== undefined) {
            if (parseInt(meta.eventId, 10) <= lastBatchEventId) return;
          }
          dispatch({ type: 'ADD_EVENT', event, eventId: meta.eventId ?? '' });
          invalidateOnEvent(event);
        },
        onNamedEvent: (name, payload) => {
          if (name === 'monitor:shutdown-pending') {
            try {
              const parsed = JSON.parse(payload) as { countdown: number };
              startCountdownTick(parsed.countdown);
            } catch { /* ignore malformed payload */ }
          } else if (name === 'monitor:shutdown-cancelled') {
            cancelCountdownTick();
          }
        },
      });
    })().catch((err: unknown) => {
      if (abort.signal.aborted) return;
      console.error('subscribeToSession failed:', err);
      setConnectionStatus('disconnected');
    });

    return () => {
      abort.abort();
      cancelCountdownTick();
    };
  }, [sessionId, startCountdownTick, cancelCountdownTick]);

  return { runState, connectionStatus, shutdownCountdown };
}
