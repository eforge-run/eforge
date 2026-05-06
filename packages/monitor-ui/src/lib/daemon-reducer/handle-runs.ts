/**
 * Handlers for session lifecycle events in the daemon-state reducer.
 *
 * session:start — prepend a new RunInfo entry (or update existing) for the session.
 * session:end   — update the matching run's status and completedAt.
 */
import type { RunInfo } from '@/lib/types';
import type { DaemonEventHandler } from './handler-types';

export const handleSessionStart: DaemonEventHandler<'session:start'> = (event, state) => {
  const sessionId = event.sessionId;
  const existingIdx = state.runs.findIndex(
    (r) => r.sessionId === sessionId || r.id === sessionId,
  );

  if (existingIdx !== -1) {
    // Update existing run to running status
    const updated = [...state.runs];
    updated[existingIdx] = { ...updated[existingIdx], status: 'running' };
    return { runs: updated };
  }

  // Create a minimal RunInfo for the new session.
  // Full data (planSet, cwd, pid) is unavailable from the event; the snapshot
  // already contains complete entries for runs that existed at mount time.
  const newRun: RunInfo = {
    id: sessionId,
    sessionId,
    planSet: '',
    command: 'build',
    status: 'running',
    startedAt: event.timestamp,
    cwd: '',
  };
  // Prepend so runs[0] remains the most-recently-started session.
  return { runs: [newRun, ...state.runs] };
};

export const handleSessionEnd: DaemonEventHandler<'session:end'> = (event, state) => {
  const sessionId = event.sessionId;
  const idx = state.runs.findIndex(
    (r) => r.sessionId === sessionId || r.id === sessionId,
  );
  if (idx === -1) return undefined;

  const result = event.result;
  const status: string =
    result?.status === 'completed' || result?.status === 'failed'
      ? result.status
      : 'completed';

  const updated = [...state.runs];
  updated[idx] = { ...updated[idx], status, completedAt: event.timestamp };
  return { runs: updated };
};
