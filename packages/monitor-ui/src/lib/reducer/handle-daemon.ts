/**
 * Handlers for daemon-internal events.
 *
 * daemon:auto-build:paused — captures the pause reason and timestamp so
 * consumers can display why auto-build was disabled without waiting for the
 * next SWR poll cycle.
 */
import type { EventHandler } from './handler-types';

export const handleDaemonAutoBuildPaused: EventHandler<'daemon:auto-build:paused'> = (event, _state) => ({
  autoBuildPausedReason: event.reason,
  autoBuildPausedAt: event.timestamp,
});
