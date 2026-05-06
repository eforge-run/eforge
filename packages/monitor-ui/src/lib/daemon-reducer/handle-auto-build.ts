/**
 * Handlers for daemon auto-build events in the daemon-state reducer.
 *
 * daemon:auto-build:paused   — set autoBuild.enabled = false so the Header
 *                              toggle reflects the paused state without waiting
 *                              for the next snapshot.
 * daemon:auto-build:enabled  — set autoBuild.enabled = true (explicitly turned on).
 * daemon:auto-build:resumed  — set autoBuild.enabled = true (resumed after pause).
 * daemon:auto-build:triggered — auto-build fired; no slice change beyond activity.
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

export const handleDaemonAutoBuildEnabled: DaemonEventHandler<'daemon:auto-build:enabled'> = (
  _event,
  state,
) => {
  if (!state.autoBuild) return undefined;
  if (state.autoBuild.enabled) return undefined; // already enabled
  return {
    autoBuild: { ...state.autoBuild, enabled: true },
  };
};

export const handleDaemonAutoBuildResumed: DaemonEventHandler<'daemon:auto-build:resumed'> = (
  _event,
  state,
) => {
  if (!state.autoBuild) return undefined;
  if (state.autoBuild.enabled) return undefined; // already enabled
  return {
    autoBuild: { ...state.autoBuild, enabled: true },
  };
};

export const handleDaemonAutoBuildTriggered: DaemonEventHandler<'daemon:auto-build:triggered'> =
  () => undefined;
