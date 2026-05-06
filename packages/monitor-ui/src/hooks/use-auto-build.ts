import { useState, useCallback } from 'react';
import useSWR, { mutate } from 'swr';
import { setAutoBuild, type AutoBuildState } from '@/lib/api';
import { fetcher } from '@/lib/swr-fetcher';
import { API_ROUTES } from '@eforge-build/client/browser';

// sessionId is kept for caller compatibility but is no longer used in this hook.
// Auto-build pause notifications are now handled via the useEforgeEvents reducer.
// The SWR poll below acts as fallback for the no-session and reconnect-gap paths.
export function useAutoBuild(_sessionId?: string | null): {
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
