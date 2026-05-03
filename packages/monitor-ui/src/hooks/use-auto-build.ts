import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchAutoBuild, setAutoBuild, type AutoBuildState } from '@/lib/api';
import { subscribeToSession } from '@eforge-build/client/browser';

export function useAutoBuild(sessionId?: string | null): {
  state: AutoBuildState | null;
  toggling: boolean;
  toggle: () => void;
} {
  const [state, setState] = useState<AutoBuildState | null>(null);
  const [toggling, setToggling] = useState(false);
  // Stable ref so the SSE callback always calls the latest setState without
  // needing to be listed as an effect dependency.
  const setStateRef = useRef(setState);
  setStateRef.current = setState;

  useEffect(() => {
    const doFetch = () => {
      fetchAutoBuild()
        .then((s) => setStateRef.current(s))
        .catch(() => setStateRef.current(null));
    };
    doFetch();

    const interval = setInterval(doFetch, 5000);
    return () => clearInterval(interval);
  }, []);

  // Subscribe to daemon:auto-build:paused events on the provided session so the
  // toggle flips OFF immediately instead of waiting for the next poll cycle.
  // The 5 s polling interval above acts as fallback when sessionId is null/absent.
  useEffect(() => {
    if (!sessionId) return;
    const abort = new AbortController();

    void subscribeToSession<{ type: string }>(sessionId, {
      baseUrl: '',
      signal: abort.signal,
      onEvent: (event) => {
        if (event.type === 'daemon:auto-build:paused') {
          fetchAutoBuild()
            .then((s) => setStateRef.current(s))
            .catch(() => {});
        }
      },
    }).catch((err: unknown) => {
      if (abort.signal.aborted) return;
      // Swallow connection errors — poll fallback will catch up
    });

    return () => abort.abort();
  }, [sessionId]);

  const toggle = useCallback(() => {
    if (!state || toggling) return;
    setToggling(true);
    setAutoBuild(!state.enabled)
      .then((result) => {
        if (result) setState(result);
      })
      .catch(() => {})
      .finally(() => setToggling(false));
  }, [state, toggling]);

  return { state, toggling, toggle };
}
