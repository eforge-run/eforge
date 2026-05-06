/**
 * Handlers for daemon startup-recovery events in the daemon-state reducer.
 *
 * daemon:recovery:start             — reconciliation pass has begun.
 * daemon:recovery:run-marked-failed — an orphaned run was marked as failed.
 * daemon:recovery:lock-removed      — a stale lock file was cleaned up.
 * daemon:recovery:complete          — reconciliation finished.
 *
 * None of these events mutate DaemonState slices beyond the centralised
 * activity-append. Registered in daemonHandlerRegistry so the exhaustiveness
 * check is satisfied.
 */
import type { DaemonEventHandler } from './handler-types';

export const handleDaemonRecoveryStart: DaemonEventHandler<'daemon:recovery:start'> =
  () => undefined;

export const handleDaemonRecoveryRunMarkedFailed: DaemonEventHandler<'daemon:recovery:run-marked-failed'> =
  () => undefined;

export const handleDaemonRecoveryLockRemoved: DaemonEventHandler<'daemon:recovery:lock-removed'> =
  () => undefined;

export const handleDaemonRecoveryComplete: DaemonEventHandler<'daemon:recovery:complete'> =
  () => undefined;
