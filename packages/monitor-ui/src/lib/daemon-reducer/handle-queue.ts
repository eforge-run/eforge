/**
 * Handlers for queue lifecycle events in the daemon-state reducer.
 *
 * queue:prd:discovered — add a new QueueItem with status 'pending'.
 * queue:prd:start      — update the matching item's status to 'running'.
 * queue:prd:complete   — update or remove the item based on the terminal status.
 * queue:prd:skip       — remove the matching item from the queue.
 * queue:complete       — clean up all non-failed items once the batch finishes.
 */
import type { QueueItem } from '@/lib/types';
import type { DaemonEventHandler } from './handler-types';

export const handleQueuePrdDiscovered: DaemonEventHandler<'queue:prd:discovered'> = (
  event,
  state,
) => {
  // Avoid duplicate entries — the snapshot may already contain this item.
  if (state.queue.some((item) => item.id === event.prdId)) return undefined;
  const newItem: QueueItem = {
    id: event.prdId,
    title: event.title,
    status: 'pending',
  };
  return { queue: [...state.queue, newItem] };
};

export const handleQueuePrdStart: DaemonEventHandler<'queue:prd:start'> = (event, state) => {
  const idx = state.queue.findIndex((item) => item.id === event.prdId);
  if (idx === -1) return undefined;
  const updated = [...state.queue];
  updated[idx] = { ...updated[idx], status: 'running' };
  return { queue: updated };
};

export const handleQueuePrdComplete: DaemonEventHandler<'queue:prd:complete'> = (
  event,
  state,
) => {
  const idx = state.queue.findIndex((item) => item.id === event.prdId);
  if (idx === -1) return undefined;

  if (event.status === 'failed') {
    // Keep failed items — RecoveryRow displays them with verdict info.
    const updated = [...state.queue];
    updated[idx] = { ...updated[idx], status: 'failed' };
    return { queue: updated };
  }

  // Remove completed and skipped items so they stop appearing in the queue badge.
  return { queue: state.queue.filter((item) => item.id !== event.prdId) };
};

export const handleQueuePrdSkip: DaemonEventHandler<'queue:prd:skip'> = (event, state) => {
  // Skipped items are removed from the queue display.
  const filtered = state.queue.filter((item) => item.id !== event.prdId);
  if (filtered.length === state.queue.length) return undefined;
  return { queue: filtered };
};

/**
 * queue:complete — the entire batch finished processing.
 * Keep failed items (they need recovery UI); remove everything else.
 */
export const handleQueueComplete: DaemonEventHandler<'queue:complete'> = (_event, state) => {
  const failed = state.queue.filter((item) => item.status === 'failed');
  if (failed.length === state.queue.length) return undefined;
  return { queue: failed };
};
