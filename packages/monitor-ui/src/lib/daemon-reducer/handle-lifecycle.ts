/**
 * Handlers for daemon lifecycle events in the daemon-state reducer.
 *
 * daemon:lifecycle:starting         — daemon process is initialising.
 * daemon:lifecycle:ready            — daemon is up and accepting requests.
 * daemon:lifecycle:shutdown:start   — graceful shutdown has begun.
 * daemon:lifecycle:shutdown:complete — shutdown finished.
 *
 * None of these events mutate the DaemonState slices (runs, queue, autoBuild,
 * etc.). They are registered in daemonHandlerRegistry so the exhaustiveness
 * check acknowledges them; the centralised activity-append in ADD_EVENT records
 * them in daemonActivity automatically.
 */
import type { DaemonEventHandler } from './handler-types';

export const handleDaemonLifecycleStarting: DaemonEventHandler<'daemon:lifecycle:starting'> =
  () => undefined;

export const handleDaemonLifecycleReady: DaemonEventHandler<'daemon:lifecycle:ready'> =
  () => undefined;

export const handleDaemonLifecycleShutdownStart: DaemonEventHandler<'daemon:lifecycle:shutdown:start'> =
  () => undefined;

export const handleDaemonLifecycleShutdownComplete: DaemonEventHandler<'daemon:lifecycle:shutdown:complete'> =
  () => undefined;
