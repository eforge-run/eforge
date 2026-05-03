import { useState, useEffect, useCallback } from 'react';
import useSWR, { mutate } from 'swr';
import { setAutoBuild, type AutoBuildState } from '@/lib/api';
import { fetcher } from '@/lib/swr-fetcher';
import { subscribeToSession, API_ROUTES } from '@eforge-build/client/browser';

export function useAutoBuild(sessionId?: string | null): {
  state: AutoBuildState | null;
  toggling: boolean;
  toggle: () => void;
} {
  const [toggling, setToggling] = useState(false);

  const { data } = useSWR<AutoBuildState | null>(
    API_ROUTES.autoBuildGet,
    fetcher,
    { refreshInterval: 10000 },
  );
  const state = data ?? null;

  // Subscribe to daemon:auto-build:paused events on the provided session so the
  // toggle flips OFF immediately instead of waiting for the next poll cycle.
  // The 10 s SWR polling interval above acts as fallback when sessionId is null/absent.
  useEffect(() => {
    if (!sessionId) return;
    const abort = new AbortController();

    void subscribeToSession<{ type: string }>(sessionId, {
      baseUrl: '',
      signal: abort.signal,
      onEvent: (event) => {
        if (event.type === 'daemon:auto-build:paused') {
          void mutate(API_ROUTES.autoBuildGet);
        }
      },
    }).catch((err: unknown) => {
      if (abort.signal.aborted) return;
      // Swallow connection errors — SWR poll fallback will catch up
    });

    return () => abort.abort();
  }, [sessionId]);

  const toggle = useCallback(() => {
    if (!state || toggling) return;
    const optimisticState: AutoBuildState = { ...state, enabled: !state.enabled };
    void mutate(API_ROUTES.autoBuildGet, optimisticState, { revalidate: false });
    setToggling(true);
    setAutoBuild(!state.enabled)
      .then(() => {
        // SWR polling / SSE event will reconcile the actual server value
      })
      .catch(() => {
        void mutate(API_ROUTES.autoBuildGet);
      })
      .finally(() => setToggling(false));
  }, [state, toggling]);

  return { state, toggling, toggle };
}
