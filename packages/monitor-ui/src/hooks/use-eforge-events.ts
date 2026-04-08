import { useReducer, useEffect, useRef, useState, useCallback } from 'react';
import { eforgeReducer, initialRunState, type RunState } from '@/lib/reducer';
import type { ConnectionStatus, EforgeEvent } from '@/lib/types';

interface UseEforgeEventsResult {
  runState: RunState;
  connectionStatus: ConnectionStatus;
  shutdownCountdown: number | null;
}

interface RunStateResponse {
  status: string;
  events: Array<{ id: number; data: string }>;
}

export function useEforgeEvents(sessionId: string | null): UseEforgeEventsResult {
  const [runState, dispatch] = useReducer(eforgeReducer, initialRunState);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [shutdownCountdown, setShutdownCountdown] = useState<number | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const cacheRef = useRef<Map<string, RunState>>(new Map());
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

    // Close existing SSE connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    let cancelled = false;
    setConnectionStatus('connecting');

    // Batch-fetch all events via HTTP
    fetch(`/api/run-state/${sessionId}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<RunStateResponse>;
      })
      .then((data) => {
        if (cancelled) return;

        // Parse all events and dispatch as a single batch
        const parsed: Array<{ event: EforgeEvent; eventId: string }> = [];
        for (const ev of data.events) {
          try {
            parsed.push({ event: JSON.parse(ev.data), eventId: String(ev.id) });
          } catch { /* skip unparseable */ }
        }

        dispatch({ type: 'BATCH_LOAD', events: parsed, serverStatus: data.status });
        setConnectionStatus('connected');

        const lastEventId = data.events.length > 0 ? data.events[data.events.length - 1].id : 0;
        const hasSessionEnd = parsed.some((ev) => ev.event.type === 'session:end');
        const isServerComplete = data.status === 'completed' || data.status === 'failed';

        if (hasSessionEnd || isServerComplete) {
          // Session is done — cache it and skip SSE
          const finalState = parsed.reduce(
            (st, ev) => eforgeReducer(st, { type: 'ADD_EVENT', ...ev }),
            { ...initialRunState, fileChanges: new Map() } as RunState,
          );
          cacheRef.current.set(sessionId, finalState);
          return;
        }

        // Session is still active — open SSE for live events only
        const es = new EventSource(`/api/events/${sessionId}`);
        eventSourceRef.current = es;

        // Track which events we already have from batch load
        let maxSeenId = lastEventId;

        es.onmessage = (msg) => {
          if (cancelled) return;
          const msgId = parseInt(msg.lastEventId, 10);
          // Skip events we already have from the batch
          if (msgId <= maxSeenId) return;
          maxSeenId = msgId;
          try {
            const event: EforgeEvent = JSON.parse(msg.data);
            dispatch({ type: 'ADD_EVENT', event, eventId: msg.lastEventId });
          } catch (e) {
            console.error('Failed to parse event:', e);
          }
        };

        // Named SSE events for shutdown countdown
        es.addEventListener('monitor:shutdown-pending', (msg) => {
          if (cancelled) return;
          try {
            const data = JSON.parse(msg.data) as { countdown: number };
            startCountdownTick(data.countdown);
          } catch {}
        });
        es.addEventListener('monitor:shutdown-cancelled', () => {
          if (cancelled) return;
          cancelCountdownTick();
        });

        es.onerror = () => {
          if (!cancelled) setConnectionStatus('connecting');
        };
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('Failed to fetch run state:', err);
        setConnectionStatus('disconnected');
        // Fallback to SSE-only for backward compat
        dispatch({ type: 'RESET' });
        const es = new EventSource(`/api/events/${sessionId}`);
        eventSourceRef.current = es;
        es.onopen = () => { if (!cancelled) setConnectionStatus('connected'); };
        es.onmessage = (msg) => {
          if (cancelled) return;
          try {
            const event: EforgeEvent = JSON.parse(msg.data);
            dispatch({ type: 'ADD_EVENT', event, eventId: msg.lastEventId });
          } catch (e) {
            console.error('Failed to parse event:', e);
          }
        };
        es.addEventListener('monitor:shutdown-pending', (msg) => {
          if (cancelled) return;
          try {
            const data = JSON.parse(msg.data) as { countdown: number };
            startCountdownTick(data.countdown);
          } catch {}
        });
        es.addEventListener('monitor:shutdown-cancelled', () => {
          if (cancelled) return;
          cancelCountdownTick();
        });
        es.onerror = () => { if (!cancelled) setConnectionStatus('connecting'); };
      });

    return () => {
      cancelled = true;
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      cancelCountdownTick();
    };
  }, [sessionId, startCountdownTick, cancelCountdownTick]);

  return { runState, connectionStatus, shutdownCountdown };
}
