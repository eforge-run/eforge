import { describe, it, expect } from 'vitest';
import { handleSessionStart, handleSessionEnd, handleSessionProfile, handlePhaseStart } from '../handle-session';
import { initialRunState } from '../../reducer';
import type { EforgeEvent } from '../../types';

// Hand-crafted event helpers following the "cast through unknown" test pattern.
function makeEvent<T extends EforgeEvent['type']>(
  type: T,
  extra: object,
): Extract<EforgeEvent, { type: T }> {
  return { type, timestamp: '2024-01-15T10:00:00.000Z', sessionId: 's1', ...extra } as unknown as Extract<EforgeEvent, { type: T }>;
}

describe('handle-session', () => {
  // ---------------------------------------------------------------------------
  // session:start
  // ---------------------------------------------------------------------------
  describe('handleSessionStart', () => {
    it('sets startTime on first event when state.startTime is null', () => {
      const event = makeEvent('session:start', { sessionId: 's1' });
      const delta = handleSessionStart(event, initialRunState);
      expect(delta).not.toBeUndefined();
      expect(delta?.startTime).toBe(new Date('2024-01-15T10:00:00.000Z').getTime());
    });

    it('returns undefined when startTime is already set (once-only invariant)', () => {
      const state = { ...initialRunState, startTime: 1000 };
      const event = makeEvent('session:start', { sessionId: 's1' });
      const delta = handleSessionStart(event, state);
      expect(delta).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // session:end
  // ---------------------------------------------------------------------------
  describe('handleSessionEnd', () => {
    it('marks session complete with result status and end time', () => {
      const event = makeEvent('session:end', {
        sessionId: 's1',
        result: { status: 'completed', summary: 'done' },
      });
      const delta = handleSessionEnd(event, initialRunState);
      expect(delta?.isComplete).toBe(true);
      expect(delta?.resultStatus).toBe('completed');
      expect(delta?.endTime).toBe(new Date('2024-01-15T10:00:00.000Z').getTime());
    });

    it('captures failed result status', () => {
      const event = makeEvent('session:end', {
        sessionId: 's1',
        result: { status: 'failed', summary: 'error' },
      });
      const delta = handleSessionEnd(event, initialRunState);
      expect(delta?.isComplete).toBe(true);
      expect(delta?.resultStatus).toBe('failed');
    });

    it('overrides an existing resultStatus from prior events', () => {
      const state = { ...initialRunState, resultStatus: 'completed' as const };
      const event = makeEvent('session:end', {
        sessionId: 's1',
        result: { status: 'failed', summary: 'overridden' },
      });
      const delta = handleSessionEnd(event, state);
      expect(delta?.resultStatus).toBe('failed');
    });
  });

  // ---------------------------------------------------------------------------
  // session:profile
  // ---------------------------------------------------------------------------
  describe('handleSessionProfile', () => {
    it('captures profile fields from the event', () => {
      const event = makeEvent('session:profile', {
        profileName: 'default',
        source: 'project',
        scope: 'project',
        config: { theme: 'dark' },
      });
      const delta = handleSessionProfile(event, initialRunState);
      expect(delta?.profile).toEqual({
        profileName: 'default',
        source: 'project',
        scope: 'project',
        config: { theme: 'dark' },
      });
    });

    it('captures null profileName and config', () => {
      const event = makeEvent('session:profile', {
        profileName: null,
        source: 'none',
        scope: null,
        config: null,
      });
      const delta = handleSessionProfile(event, initialRunState);
      expect(delta?.profile?.profileName).toBeNull();
      expect(delta?.profile?.config).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // phase:start
  // ---------------------------------------------------------------------------
  describe('handlePhaseStart', () => {
    it('sets startTime as fallback when session:start was missed', () => {
      const event = makeEvent('phase:start', { runId: 'r1', planSet: 'my-set', command: 'build' });
      const delta = handlePhaseStart(event, initialRunState);
      expect(delta?.startTime).toBe(new Date('2024-01-15T10:00:00.000Z').getTime());
    });

    it('returns undefined when startTime is already set', () => {
      const state = { ...initialRunState, startTime: 999 };
      const event = makeEvent('phase:start', { runId: 'r1', planSet: 'my-set', command: 'build' });
      const delta = handlePhaseStart(event, state);
      expect(delta).toBeUndefined();
    });
  });
});
