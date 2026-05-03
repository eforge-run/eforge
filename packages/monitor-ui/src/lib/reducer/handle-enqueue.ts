/**
 * Handlers for enqueue lifecycle events.
 *
 * enqueue:start         — mark enqueueStatus 'running', capture source.
 * enqueue:complete      — mark enqueueStatus 'complete', capture title.
 * enqueue:failed        — mark enqueueStatus 'failed'.
 * enqueue:commit-failed — no state change (preserve current no-op behavior).
 *
 * Fields are accessed directly from the discriminated union — no casts needed.
 */
import type { EventHandler } from './handler-types';

export const handleEnqueueStart: EventHandler<'enqueue:start'> = (event, _state) => ({
  enqueueStatus: 'running' as const,
  enqueueSource: event.source,
});

export const handleEnqueueComplete: EventHandler<'enqueue:complete'> = (event, _state) => ({
  enqueueStatus: 'complete' as const,
  enqueueTitle: event.title,
});

export const handleEnqueueFailed: EventHandler<'enqueue:failed'> = (_event, _state) => ({
  enqueueStatus: 'failed' as const,
});

/** enqueue:commit-failed — no state effect in the current implementation. */
export const handleEnqueueCommitFailed: EventHandler<'enqueue:commit-failed'> = (_event, _state) =>
  undefined;
