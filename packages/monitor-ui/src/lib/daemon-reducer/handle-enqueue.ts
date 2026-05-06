/**
 * Handlers for enqueue lifecycle events in the daemon-state reducer.
 *
 * enqueue:start    — create a minimal RunInfo entry for the enqueue run.
 * enqueue:complete — update the run's planSet (title) and mark complete.
 * enqueue:failed   — mark the run as failed.
 */
import type { RunInfo } from '@/lib/types';
import type { DaemonEventHandler } from './handler-types';

export const handleEnqueueStart: DaemonEventHandler<'enqueue:start'> = (event, state) => {
  const runId = event.runId;
  if (!runId) return undefined;

  const existingIdx = state.runs.findIndex((r) => r.id === runId);
  if (existingIdx !== -1) {
    const updated = [...state.runs];
    updated[existingIdx] = { ...updated[existingIdx], status: 'running' };
    return { runs: updated };
  }

  const newRun: RunInfo = {
    id: runId,
    planSet: '',
    command: 'enqueue',
    status: 'running',
    startedAt: event.timestamp,
    cwd: '',
  };
  // Prepend so runs[0] is the latest.
  return { runs: [newRun, ...state.runs] };
};

export const handleEnqueueComplete: DaemonEventHandler<'enqueue:complete'> = (event, state) => {
  const runId = event.runId;
  if (!runId) return undefined;

  const idx = state.runs.findIndex((r) => r.id === runId);
  if (idx === -1) return undefined;

  const updated = [...state.runs];
  updated[idx] = {
    ...updated[idx],
    planSet: event.title,
    status: 'completed',
    completedAt: event.timestamp,
  };
  return { runs: updated };
};

export const handleEnqueueFailed: DaemonEventHandler<'enqueue:failed'> = (event, state) => {
  const runId = event.runId;
  if (!runId) return undefined;

  const idx = state.runs.findIndex((r) => r.id === runId);
  if (idx === -1) return undefined;

  const updated = [...state.runs];
  updated[idx] = {
    ...updated[idx],
    status: 'failed',
    completedAt: event.timestamp,
  };
  return { runs: updated };
};
