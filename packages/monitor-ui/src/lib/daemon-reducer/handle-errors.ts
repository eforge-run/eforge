/**
 * Handlers for daemon error and warning events in the daemon-state reducer.
 *
 * daemon:warning — a non-fatal condition the daemon detected.
 * daemon:error   — an unexpected error in the daemon.
 *
 * No DaemonState slice changes beyond the centralised activity-append; the
 * events are visible in the drawer's activity feed. Registered in
 * daemonHandlerRegistry so the exhaustiveness check passes.
 */
import type { DaemonEventHandler } from './handler-types';

export const handleDaemonWarning: DaemonEventHandler<'daemon:warning'> = () => undefined;

export const handleDaemonError: DaemonEventHandler<'daemon:error'> = () => undefined;
