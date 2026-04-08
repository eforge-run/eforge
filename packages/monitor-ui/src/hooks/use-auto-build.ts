import { useState, useEffect, useCallback } from 'react';
import { fetchAutoBuild, setAutoBuild, type AutoBuildState } from '@/lib/api';

export function useAutoBuild(): {
  state: AutoBuildState | null;
  toggling: boolean;
  toggle: () => void;
} {
  const [state, setState] = useState<AutoBuildState | null>(null);
  const [toggling, setToggling] = useState(false);

  useEffect(() => {
    fetchAutoBuild().then(setState).catch(() => setState(null));

    const interval = setInterval(() => {
      fetchAutoBuild().then(setState).catch(() => setState(null));
    }, 5000);

    return () => clearInterval(interval);
  }, []);

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
