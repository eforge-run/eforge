import { describe, it, expect } from 'vitest';
import {
  handleValidationStart,
  handleValidationCommandStart,
  handleValidationCommandComplete,
  handleValidationCommandTimeout,
  handleValidationComplete,
} from '../handle-validation';
import { initialRunState } from '../../reducer';
import type { EforgeEvent } from '../../types';

function makeEvent<T extends EforgeEvent['type']>(
  type: T,
  extra: object,
): Extract<EforgeEvent, { type: T }> {
  return { type, timestamp: '2024-01-15T10:00:00.000Z', sessionId: 's1', ...extra } as unknown as Extract<EforgeEvent, { type: T }>;
}

const stateWithValidationCommands = (commands: typeof initialRunState['validationCommands']) => ({
  ...initialRunState,
  validationCommands: commands,
});

describe('handle-validation', () => {
  // ---------------------------------------------------------------------------
  // validation:start — no-op
  // ---------------------------------------------------------------------------
  describe('handleValidationStart', () => {
    it('returns undefined (no state change)', () => {
      const event = makeEvent('validation:start', { commands: ['pnpm test'] });
      expect(handleValidationStart(event, initialRunState)).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // validation:complete — no-op
  // ---------------------------------------------------------------------------
  describe('handleValidationComplete', () => {
    it('returns undefined (no state change)', () => {
      const event = makeEvent('validation:complete', { passed: true });
      expect(handleValidationComplete(event, initialRunState)).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // validation:command:start
  // ---------------------------------------------------------------------------
  describe('handleValidationCommandStart', () => {
    it('appends a new running span to validationCommands', () => {
      const event = makeEvent('validation:command:start', { command: 'pnpm test' });
      const delta = handleValidationCommandStart(event, initialRunState);
      expect(delta?.validationCommands).toHaveLength(1);
      const span = delta?.validationCommands?.[0];
      expect(span?.command).toBe('pnpm test');
      expect(span?.status).toBe('running');
      expect(span?.endedAt).toBeNull();
      expect(span?.exitCode).toBeNull();
      expect(span?.startedAt).toBe('2024-01-15T10:00:00.000Z');
    });

    it('appends without removing existing spans', () => {
      const state = stateWithValidationCommands([
        { command: 'pnpm lint', startedAt: '2024-01-15T10:00:00.000Z', endedAt: null, status: 'running', exitCode: null },
      ]);
      const event = makeEvent('validation:command:start', { command: 'pnpm test' });
      const delta = handleValidationCommandStart(event, state);
      expect(delta?.validationCommands).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------
  // validation:command:complete — passing (exit 0)
  // ---------------------------------------------------------------------------
  describe('handleValidationCommandComplete — passing command (exit 0)', () => {
    it('sets status to "passed" and exitCode to 0', () => {
      const state = stateWithValidationCommands([
        { command: 'pnpm test', startedAt: '2024-01-15T10:00:00.000Z', endedAt: null, status: 'running', exitCode: null },
      ]);
      const event = makeEvent('validation:command:complete', {
        command: 'pnpm test',
        exitCode: 0,
        output: 'All tests passed',
        timestamp: '2024-01-15T10:00:05.000Z',
      });
      const delta = handleValidationCommandComplete(event, state);
      const span = delta?.validationCommands?.[0];
      expect(span?.status).toBe('passed');
      expect(span?.exitCode).toBe(0);
      expect(span?.endedAt).toBe('2024-01-15T10:00:05.000Z');
    });
  });

  // ---------------------------------------------------------------------------
  // validation:command:complete — failing (exit 1)
  // ---------------------------------------------------------------------------
  describe('handleValidationCommandComplete — failing command (exit 1)', () => {
    it('sets status to "failed" and exitCode to 1', () => {
      const state = stateWithValidationCommands([
        { command: 'pnpm test', startedAt: '2024-01-15T10:00:00.000Z', endedAt: null, status: 'running', exitCode: null },
      ]);
      const event = makeEvent('validation:command:complete', {
        command: 'pnpm test',
        exitCode: 1,
        output: 'Tests failed',
        timestamp: '2024-01-15T10:00:05.000Z',
      });
      const delta = handleValidationCommandComplete(event, state);
      const span = delta?.validationCommands?.[0];
      expect(span?.status).toBe('failed');
      expect(span?.exitCode).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // timeout then complete — timeout must NOT be overwritten
  // ---------------------------------------------------------------------------
  describe('handleValidationCommandComplete after timeout', () => {
    it('does not overwrite a timed-out span (endedAt already set)', () => {
      // Simulate: timeout already closed the span
      const state = stateWithValidationCommands([
        {
          command: 'pnpm test',
          startedAt: '2024-01-15T10:00:00.000Z',
          endedAt: '2024-01-15T10:00:10.000Z',
          status: 'timeout',
          exitCode: null,
        },
      ]);
      const event = makeEvent('validation:command:complete', {
        command: 'pnpm test',
        exitCode: 124,
        output: '',
        timestamp: '2024-01-15T10:00:11.000Z',
      });
      // The complete event arrives after timeout — no open span found, so no-op
      const delta = handleValidationCommandComplete(event, state);
      expect(delta).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // validation:command:timeout
  // ---------------------------------------------------------------------------
  describe('handleValidationCommandTimeout', () => {
    it('sets status to "timeout" on the matching open span', () => {
      const state = stateWithValidationCommands([
        { command: 'pnpm test', startedAt: '2024-01-15T10:00:00.000Z', endedAt: null, status: 'running', exitCode: null },
      ]);
      const event = makeEvent('validation:command:timeout', {
        command: 'pnpm test',
        timeoutMs: 10000,
        pid: 1234,
        timestamp: '2024-01-15T10:00:10.000Z',
      });
      const delta = handleValidationCommandTimeout(event, state);
      const span = delta?.validationCommands?.[0];
      expect(span?.status).toBe('timeout');
      expect(span?.endedAt).toBe('2024-01-15T10:00:10.000Z');
    });

    it('does not change exitCode (remains null after timeout)', () => {
      const state = stateWithValidationCommands([
        { command: 'pnpm test', startedAt: '2024-01-15T10:00:00.000Z', endedAt: null, status: 'running', exitCode: null },
      ]);
      const event = makeEvent('validation:command:timeout', {
        command: 'pnpm test',
        timeoutMs: 10000,
        pid: 1234,
        timestamp: '2024-01-15T10:00:10.000Z',
      });
      const delta = handleValidationCommandTimeout(event, state);
      expect(delta?.validationCommands?.[0]?.exitCode).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Still-running command
  // ---------------------------------------------------------------------------
  describe('still-running command', () => {
    it('has endedAt null, status "running", exitCode null after command:start only', () => {
      const event = makeEvent('validation:command:start', { command: 'pnpm type-check' });
      const delta = handleValidationCommandStart(event, initialRunState);
      const span = delta?.validationCommands?.[0];
      expect(span?.endedAt).toBeNull();
      expect(span?.status).toBe('running');
      expect(span?.exitCode).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Two validate() runs — both runs' commands in same flat array
  // ---------------------------------------------------------------------------
  describe('two validate() runs', () => {
    it('accumulates commands from both runs in the same flat array', () => {
      // First run: start + complete
      let state = initialRunState;

      const startEvent1 = makeEvent('validation:command:start', {
        command: 'pnpm test',
        timestamp: '2024-01-15T10:00:00.000Z',
      });
      state = { ...state, ...(handleValidationCommandStart(startEvent1, state) ?? {}) };

      const completeEvent1 = makeEvent('validation:command:complete', {
        command: 'pnpm test',
        exitCode: 1,
        output: 'fail',
        timestamp: '2024-01-15T10:00:05.000Z',
      });
      state = { ...state, ...(handleValidationCommandComplete(completeEvent1, state) ?? {}) };

      // Second run: start + complete (fix attempt)
      const startEvent2 = makeEvent('validation:command:start', {
        command: 'pnpm test',
        timestamp: '2024-01-15T10:01:00.000Z',
      });
      state = { ...state, ...(handleValidationCommandStart(startEvent2, state) ?? {}) };

      const completeEvent2 = makeEvent('validation:command:complete', {
        command: 'pnpm test',
        exitCode: 0,
        output: 'pass',
        timestamp: '2024-01-15T10:01:05.000Z',
      });
      state = { ...state, ...(handleValidationCommandComplete(completeEvent2, state) ?? {}) };

      expect(state.validationCommands).toHaveLength(2);
      expect(state.validationCommands[0]?.status).toBe('failed');
      expect(state.validationCommands[1]?.status).toBe('passed');
    });
  });

  // ---------------------------------------------------------------------------
  // BATCH_LOAD code path (replay through handlers directly)
  // ---------------------------------------------------------------------------
  describe('BATCH_LOAD code path', () => {
    it('replaying events sequentially produces correct final state', () => {
      let state = initialRunState;

      const events = [
        makeEvent('validation:command:start', { command: 'pnpm lint', timestamp: '2024-01-15T10:00:00.000Z' }),
        makeEvent('validation:command:complete', { command: 'pnpm lint', exitCode: 0, output: '', timestamp: '2024-01-15T10:00:03.000Z' }),
        makeEvent('validation:command:start', { command: 'pnpm type-check', timestamp: '2024-01-15T10:00:04.000Z' }),
        makeEvent('validation:command:timeout', { command: 'pnpm type-check', timeoutMs: 5000, pid: 999, timestamp: '2024-01-15T10:00:09.000Z' }),
      ];

      for (const event of events) {
        const type = event.type;
        if (type === 'validation:command:start') {
          state = { ...state, ...(handleValidationCommandStart(event as Extract<EforgeEvent, { type: 'validation:command:start' }>, state) ?? {}) };
        } else if (type === 'validation:command:complete') {
          state = { ...state, ...(handleValidationCommandComplete(event as Extract<EforgeEvent, { type: 'validation:command:complete' }>, state) ?? {}) };
        } else if (type === 'validation:command:timeout') {
          state = { ...state, ...(handleValidationCommandTimeout(event as Extract<EforgeEvent, { type: 'validation:command:timeout' }>, state) ?? {}) };
        }
      }

      expect(state.validationCommands).toHaveLength(2);
      expect(state.validationCommands[0]?.command).toBe('pnpm lint');
      expect(state.validationCommands[0]?.status).toBe('passed');
      expect(state.validationCommands[1]?.command).toBe('pnpm type-check');
      expect(state.validationCommands[1]?.status).toBe('timeout');
    });
  });
});
