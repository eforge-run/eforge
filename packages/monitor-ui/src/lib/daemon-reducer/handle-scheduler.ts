/**
 * Handlers for daemon scheduler events in the daemon-state reducer.
 *
 * daemon:scheduler:dequeued           — a PRD was picked up from the queue.
 * daemon:scheduler:capacity-blocked   — scheduler is at max concurrency.
 * daemon:scheduler:dependency-blocked — a PRD is waiting on another build.
 *
 * None of these events mutate DaemonState slices beyond what the centralised
 * activity-append already provides. They are registered in daemonHandlerRegistry
 * so the exhaustiveness check is satisfied.
 */
import type { DaemonEventHandler } from './handler-types';

export const handleDaemonSchedulerDequeued: DaemonEventHandler<'daemon:scheduler:dequeued'> =
  () => undefined;

export const handleDaemonSchedulerCapacityBlocked: DaemonEventHandler<'daemon:scheduler:capacity-blocked'> =
  () => undefined;

export const handleDaemonSchedulerDependencyBlocked: DaemonEventHandler<'daemon:scheduler:dependency-blocked'> =
  () => undefined;
