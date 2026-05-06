import { describe, it, expect } from 'vitest';
import { handleDaemonAutoBuildPaused } from '../handle-daemon';
import { initialRunState, selectAutoBuild, eforgeReducer } from '../../reducer';
import type { EforgeEvent } from '../../types';

function makeEvent<T extends EforgeEvent['type']>(
  type: T,
  extra: object,
): Extract<EforgeEvent, { type: T }> {
  return { type, timestamp: '2024-01-15T10:00:00.000Z', sessionId: 's1', ...extra } as unknown as Extract<EforgeEvent, { type: T }>;
}

describe('handle-daemon', () => {
  describe('handleDaemonAutoBuildPaused', () => {
    it('returns autoBuildPausedReason from the event', () => {
      const event = makeEvent('daemon:auto-build:paused', { reason: 'Build failed: foo' });
      const delta = handleDaemonAutoBuildPaused(event, initialRunState);
      expect(delta?.autoBuildPausedReason).toBe('Build failed: foo');
    });

    it('returns a non-null autoBuildPausedAt timestamp', () => {
      const event = makeEvent('daemon:auto-build:paused', { reason: 'Build failed: foo' });
      const delta = handleDaemonAutoBuildPaused(event, initialRunState);
      expect(delta?.autoBuildPausedAt).not.toBeNull();
      expect(typeof delta?.autoBuildPausedAt).toBe('string');
    });

    it('captures the event timestamp as autoBuildPausedAt', () => {
      const event = makeEvent('daemon:auto-build:paused', { reason: 'Some reason' });
      const delta = handleDaemonAutoBuildPaused(event, initialRunState);
      expect(delta?.autoBuildPausedAt).toBe('2024-01-15T10:00:00.000Z');
    });
  });

  describe('selectAutoBuild', () => {
    it('returns paused: false and reason: null from initialRunState', () => {
      const result = selectAutoBuild(initialRunState);
      expect(result).toEqual({ paused: false, reason: null });
    });

    it('returns paused: true and the reason after applying daemon:auto-build:paused', () => {
      const event = makeEvent('daemon:auto-build:paused', { reason: 'Build failed: foo' });
      const nextState = eforgeReducer(initialRunState, {
        type: 'ADD_EVENT',
        event,
        eventId: 'evt-1',
      });
      const result = selectAutoBuild(nextState);
      expect(result).toEqual({ paused: true, reason: 'Build failed: foo' });
    });
  });
});
