/**
 * Handlers for daemon auto-build events in the daemon-state reducer.
 *
 * daemon:auto-build:paused — set autoBuild.enabled = false so the Header
 * toggle reflects the paused state without waiting for the next snapshot.
 */
import type { DaemonEventHandler } from './handler-types';

export const handleDaemonAutoBuildPaused: DaemonEventHandler<'daemon:auto-build:paused'> = (
  _event,
  state,
) => {
  if (!state.autoBuild) return undefined;
  if (!state.autoBuild.enabled) return undefined; // already disabled
  return {
    autoBuild: { ...state.autoBuild, enabled: false },
  };
};
