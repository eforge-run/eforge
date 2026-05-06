/**
 * Flat handler registry keyed by daemon-wide event type.
 *
 * DAEMON_IGNORED_EVENT_TYPES lists daemon-stream variants that produce no
 * DaemonState change. The _Exhaustive type check at the bottom verifies at
 * compile time that every daemon-wide event type (those emitted by
 * /api/daemon-events) is either registered or explicitly ignored.
 *
 * Dispatch in daemon-reducer.ts uses:
 *   const handler = (daemonHandlerRegistry as Record<string, ...>)[event.type];
 *   const delta = handler ? handler(event as never, state) : undefined;
 */
import type { EforgeEvent } from '@/lib/types';

import { handleSessionStart, handleSessionEnd } from './handle-runs';
import {
  handleQueuePrdDiscovered,
  handleQueuePrdStart,
  handleQueuePrdComplete,
  handleQueuePrdSkip,
  handleQueueComplete,
} from './handle-queue';
import {
  handleEnqueueStart,
  handleEnqueueComplete,
  handleEnqueueFailed,
} from './handle-enqueue';
import {
  handleDaemonAutoBuildPaused,
  handleDaemonAutoBuildEnabled,
  handleDaemonAutoBuildResumed,
  handleDaemonAutoBuildTriggered,
} from './handle-auto-build';
import {
  handleDaemonLifecycleStarting,
  handleDaemonLifecycleReady,
  handleDaemonLifecycleShutdownStart,
  handleDaemonLifecycleShutdownComplete,
} from './handle-lifecycle';
import { handleDaemonHeartbeat } from './handle-heartbeat';
import {
  handleDaemonSchedulerDequeued,
  handleDaemonSchedulerCapacityBlocked,
  handleDaemonSchedulerDependencyBlocked,
} from './handle-scheduler';
import {
  handleDaemonRecoveryStart,
  handleDaemonRecoveryRunMarkedFailed,
  handleDaemonRecoveryLockRemoved,
  handleDaemonRecoveryComplete,
} from './handle-recovery';
import { handleDaemonOrphanReaped } from './handle-orphan';
import { handleDaemonWarning, handleDaemonError } from './handle-errors';

// ---------------------------------------------------------------------------
// Handler registry
// ---------------------------------------------------------------------------

export const daemonHandlerRegistry = {
  // Session lifecycle
  'session:start': handleSessionStart,
  'session:end': handleSessionEnd,

  // Queue lifecycle
  'queue:prd:discovered': handleQueuePrdDiscovered,
  'queue:prd:start': handleQueuePrdStart,
  'queue:prd:complete': handleQueuePrdComplete,
  'queue:prd:skip': handleQueuePrdSkip,
  'queue:complete': handleQueueComplete,

  // Enqueue lifecycle
  'enqueue:start': handleEnqueueStart,
  'enqueue:complete': handleEnqueueComplete,
  'enqueue:failed': handleEnqueueFailed,

  // Daemon internal — auto-build
  'daemon:auto-build:paused': handleDaemonAutoBuildPaused,
  'daemon:auto-build:enabled': handleDaemonAutoBuildEnabled,
  'daemon:auto-build:resumed': handleDaemonAutoBuildResumed,
  'daemon:auto-build:triggered': handleDaemonAutoBuildTriggered,

  // Daemon lifecycle
  'daemon:lifecycle:starting': handleDaemonLifecycleStarting,
  'daemon:lifecycle:ready': handleDaemonLifecycleReady,
  'daemon:lifecycle:shutdown:start': handleDaemonLifecycleShutdownStart,
  'daemon:lifecycle:shutdown:complete': handleDaemonLifecycleShutdownComplete,

  // Daemon heartbeat
  'daemon:heartbeat': handleDaemonHeartbeat,

  // Daemon scheduler
  'daemon:scheduler:dequeued': handleDaemonSchedulerDequeued,
  'daemon:scheduler:capacity-blocked': handleDaemonSchedulerCapacityBlocked,
  'daemon:scheduler:dependency-blocked': handleDaemonSchedulerDependencyBlocked,

  // Daemon recovery (startup reconciliation)
  'daemon:recovery:start': handleDaemonRecoveryStart,
  'daemon:recovery:run-marked-failed': handleDaemonRecoveryRunMarkedFailed,
  'daemon:recovery:lock-removed': handleDaemonRecoveryLockRemoved,
  'daemon:recovery:complete': handleDaemonRecoveryComplete,

  // Daemon orphan reaping
  'daemon:orphan:reaped': handleDaemonOrphanReaped,

  // Daemon errors and warnings
  'daemon:warning': handleDaemonWarning,
  'daemon:error': handleDaemonError,
};

// ---------------------------------------------------------------------------
// Events intentionally ignored (no DaemonState effect)
// ---------------------------------------------------------------------------

/**
 * Daemon-stream event types the reducer deliberately does not react to.
 * These variants carry no state-relevant data for the monitor UI's daemon slice.
 *
 * Maintaining this explicit list ensures new daemon-stream variants are not
 * silently dropped — the _Exhaustive check below forces a compiler error until
 * a new type is either handled or explicitly ignored.
 */
export const DAEMON_IGNORED_EVENT_TYPES = [
  'queue:start',             // batch start metadata, no DaemonState change needed
  'queue:prd:stale',         // staleness verdict, no queue item mutation needed
  'queue:prd:commit-failed', // error info, queue item status unchanged
  'enqueue:commit-failed',   // no state effect
] as const;

// ---------------------------------------------------------------------------
// Compile-time exhaustiveness check (scoped to daemon-wide event subset)
// ---------------------------------------------------------------------------

/**
 * The daemon-events stream emits a documented subset of EforgeEvent variants.
 * Enumerating them here lets the _Exhaustive check verify our registry handles
 * or explicitly ignores every one.
 *
 * Source: DAEMON_EVENT_TYPES in packages/monitor/src/db.ts plus daemon:heartbeat
 * which is LIVE-ONLY (not persisted, not in that list, but still streamed).
 */
type DaemonEventSubset =
  // Session lifecycle
  | 'session:start'
  | 'session:end'
  // Queue lifecycle
  | 'queue:start'
  | 'queue:prd:discovered'
  | 'queue:prd:stale'
  | 'queue:prd:skip'
  | 'queue:prd:commit-failed'
  | 'queue:prd:start'
  | 'queue:prd:complete'
  | 'queue:complete'
  // Enqueue lifecycle
  | 'enqueue:start'
  | 'enqueue:complete'
  | 'enqueue:failed'
  | 'enqueue:commit-failed'
  // Daemon internal — auto-build (pre-existing)
  | 'daemon:auto-build:paused'
  // --- eforge:region plan-01-types-and-daemon-emission ---
  // Daemon lifecycle
  | 'daemon:lifecycle:starting'
  | 'daemon:lifecycle:ready'
  | 'daemon:lifecycle:shutdown:start'
  | 'daemon:lifecycle:shutdown:complete'
  // Daemon heartbeat (LIVE-ONLY: not persisted, but arrives via SSE)
  | 'daemon:heartbeat'
  // Daemon scheduler
  | 'daemon:scheduler:dequeued'
  | 'daemon:scheduler:capacity-blocked'
  | 'daemon:scheduler:dependency-blocked'
  // Daemon auto-build extensions
  | 'daemon:auto-build:enabled'
  | 'daemon:auto-build:resumed'
  | 'daemon:auto-build:triggered'
  // Daemon recovery
  | 'daemon:recovery:start'
  | 'daemon:recovery:run-marked-failed'
  | 'daemon:recovery:lock-removed'
  | 'daemon:recovery:complete'
  // Daemon orphan reaping
  | 'daemon:orphan:reaped'
  // Daemon errors and warnings
  | 'daemon:warning'
  | 'daemon:error';
  // --- eforge:endregion plan-01-types-and-daemon-emission ---

// Verify all members of DaemonEventSubset are valid EforgeEvent types.
type _InvalidDaemonTypes = Exclude<DaemonEventSubset, EforgeEvent['type']>;
type _AllDaemonTypesValid = [_InvalidDaemonTypes] extends [never]
  ? true
  : { error: 'DaemonEventSubset contains types not in EforgeEvent'; invalid: _InvalidDaemonTypes };
const _validCheck: _AllDaemonTypesValid = true;
void _validCheck;

type _MissingTypes = Exclude<
  DaemonEventSubset,
  keyof typeof daemonHandlerRegistry | (typeof DAEMON_IGNORED_EVENT_TYPES)[number]
>;

type _Exhaustive = [_MissingTypes] extends [never]
  ? true
  : { error: 'Not all daemon-wide event types are handled or ignored'; missing: _MissingTypes };

// If this line produces a type error, a daemon-wide event type needs to be
// added to daemonHandlerRegistry or DAEMON_IGNORED_EVENT_TYPES.
const _exhaustiveCheck: _Exhaustive = true;
void _exhaustiveCheck;
