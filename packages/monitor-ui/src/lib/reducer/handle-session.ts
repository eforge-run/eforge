/**
 * Handlers for session and phase lifecycle events.
 *
 * session:start — sets startTime once (first event wins; ignored if already set).
 * session:end   — marks the session complete with result status and end time.
 * session:profile — captures the resolved profile for display.
 * phase:start   — falls back startTime when session:start was missed.
 * phase:end     — no state effect; ignored by the registry.
 */
import type { EventHandler } from './handler-types';

export const handleSessionStart: EventHandler<'session:start'> = (event, state) => {
  if (state.startTime !== null) return undefined;
  return { startTime: new Date(event.timestamp).getTime() };
};

export const handleSessionEnd: EventHandler<'session:end'> = (event, state) => {
  // EforgeResult.status can be 'skipped' but RunState.resultStatus only holds
  // 'completed' | 'failed' | null — treat 'skipped' as no change (preserve existing).
  const resultStatus: 'completed' | 'failed' | null =
    event.result?.status === 'completed' || event.result?.status === 'failed'
      ? event.result.status
      : state.resultStatus;
  return {
    isComplete: true,
    endTime: event.timestamp ? new Date(event.timestamp).getTime() : state.endTime,
    resultStatus,
  };
};

export const handleSessionProfile: EventHandler<'session:profile'> = (event, _state) => {
  return {
    profile: {
      profileName: event.profileName,
      source: event.source,
      scope: event.scope,
      config: event.config,
    },
  };
};

/** phase:start acts as a fallback startTime when session:start was missed. */
export const handlePhaseStart: EventHandler<'phase:start'> = (event, state) => {
  if (state.startTime !== null) return undefined;
  return { startTime: new Date(event.timestamp).getTime() };
};
