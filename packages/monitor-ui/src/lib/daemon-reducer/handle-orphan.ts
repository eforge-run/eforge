/**
 * Handler for daemon orphan-reaping events in the daemon-state reducer.
 *
 * daemon:orphan:reaped — the periodic detection loop found and cleaned up
 * a build process that exited without sending session:end.
 *
 * No DaemonState slice changes beyond the centralised activity-append.
 * Registered in daemonHandlerRegistry so the exhaustiveness check passes.
 */
import type { DaemonEventHandler } from './handler-types';

export const handleDaemonOrphanReaped: DaemonEventHandler<'daemon:orphan:reaped'> =
  () => undefined;
