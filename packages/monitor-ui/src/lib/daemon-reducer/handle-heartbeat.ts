/**
 * Handler for daemon:heartbeat in the daemon-state reducer.
 *
 * Updates the latestHeartbeat slot with the current wall-clock time and the
 * event payload. The centralised activity-append in ADD_EVENT intentionally
 * skips heartbeat events — they are LIVE-ONLY and would dominate the buffer —
 * so this handler is the sole source of state change for heartbeat events.
 */
import type { DaemonEventHandler } from './handler-types';

export const handleDaemonHeartbeat: DaemonEventHandler<'daemon:heartbeat'> = (event) => {
  return {
    latestHeartbeat: {
      at: Date.now(),
      payload: {
        uptime: event.uptime,
        queueDepth: event.queueDepth,
        runningBuilds: event.runningBuilds,
        autoBuild: event.autoBuild,
        subscribers: event.subscribers,
      },
    },
  };
};
