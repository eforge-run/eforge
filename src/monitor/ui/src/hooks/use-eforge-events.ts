import { useReducer, useEffect, useRef, useState, useCallback } from 'react';
import { eforgeReducer, initialRunState, type RunState } from '@/lib/reducer';
import type { ConnectionStatus, EforgeEvent } from '@/lib/types';

interface UseEforgeEventsResult {
  runState: RunState;
  connectionStatus: ConnectionStatus;
  resetState: () => void;
}

export function useEforgeEvents(runId: string | null): UseEforgeEventsResult {
  const [runState, dispatch] = useReducer(eforgeReducer, initialRunState);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const eventSourceRef = useRef<EventSource | null>(null);

  const resetState = useCallback(() => {
    dispatch({ type: 'RESET' });
  }, []);

  useEffect(() => {
    if (!runId) {
      setConnectionStatus('disconnected');
      return;
    }

    // Close existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    // Reset state for new run
    dispatch({ type: 'RESET' });

    setConnectionStatus('connecting');
    const es = new EventSource(`/api/events/${runId}`);
    eventSourceRef.current = es;

    es.onopen = () => {
      setConnectionStatus('connected');
    };

    es.onmessage = (msg) => {
      try {
        const event: EforgeEvent = JSON.parse(msg.data);
        dispatch({ type: 'ADD_EVENT', event, eventId: msg.lastEventId });
      } catch (e) {
        console.error('Failed to parse event:', e);
      }
    };

    es.onerror = () => {
      setConnectionStatus('connecting');
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [runId]);

  return { runState, connectionStatus, resetState };
}
