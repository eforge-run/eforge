import { useState, useCallback } from 'react';
import { setAutoBuild, type AutoBuildState } from '@/lib/api';

/**
 * Writer-only hook for the auto-build toggle.
 *
 * The reader path — the current enabled/disabled state — is now owned by
 * `useDaemonEvents().daemonState.autoBuild`. This hook only fires the HTTP
 * mutation and tracks in-flight state to prevent double-clicks.
 *
 * After a successful toggle the caller's `onUpdate` is invoked with the new
 * state returned by the server, so the daemon-state slice can be updated
 * immediately without waiting for the next SSE event.
 */
export function useAutoBuild(
  autoBuildState: AutoBuildState | null,
  onUpdate: (state: AutoBuildState | null) => void,
): {
  toggling: boolean;
  toggle: () => void;
} {
  const [toggling, setToggling] = useState(false);

  const toggle = useCallback(() => {
    if (!autoBuildState || toggling) return;
    setToggling(true);
    setAutoBuild(!autoBuildState.enabled)
      .then((newState) => {
        if (newState) {
          onUpdate(newState);
        }
      })
      .catch(() => {
        // Server error — the daemon state will reflect reality on the next
        // snapshot or SSE event; no local rollback needed.
      })
      .finally(() => setToggling(false));
  }, [autoBuildState, toggling, onUpdate]);

  return { toggling, toggle };
}
