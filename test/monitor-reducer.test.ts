import { describe, it, expect } from 'vitest';
import {
  eforgeReducer,
  initialRunState,
  getSummaryStats,
  type RunState,
  type RunAction,
} from '../src/monitor/ui/src/lib/reducer';
import type { EforgeEvent } from '../src/engine/events';

function dispatch(state: RunState, events: Array<{ event: EforgeEvent; eventId: string }>): RunState {
  return events.reduce(
    (s, e) => eforgeReducer(s, { type: 'ADD_EVENT', event: e.event, eventId: e.eventId }),
    state,
  );
}

describe('eforgeReducer', () => {
  it('starts with initial state', () => {
    expect(initialRunState.events).toEqual([]);
    expect(initialRunState.startTime).toBeNull();
    expect(initialRunState.tokensIn).toBe(0);
    expect(initialRunState.tokensOut).toBe(0);
    expect(initialRunState.totalCost).toBe(0);
    expect(initialRunState.isComplete).toBe(false);
  });

  it('resets state', () => {
    const modified: RunState = {
      ...initialRunState,
      tokensIn: 100,
      events: [{ event: { type: 'plan:start', source: 'test' }, eventId: '1' }],
    };
    const result = eforgeReducer(modified, { type: 'RESET' });
    expect(result.tokensIn).toBe(0);
    expect(result.events).toEqual([]);
  });

  it('tracks start time from phase:start', () => {
    const event: EforgeEvent = {
      type: 'phase:start',
      runId: 'run-1',
      planSet: 'test',
      command: 'build',
      timestamp: '2024-01-01T00:00:00Z',
    };
    const result = eforgeReducer(initialRunState, {
      type: 'ADD_EVENT',
      event,
      eventId: '1',
    });
    expect(result.startTime).toBe(new Date('2024-01-01T00:00:00Z').getTime());
  });

  it('marks complete on session:end', () => {
    const event: EforgeEvent = {
      type: 'session:end',
      sessionId: 'session-1',
      result: { status: 'completed', summary: 'All done' },
      timestamp: '2024-01-01T00:01:00Z',
    };
    const result = eforgeReducer(initialRunState, {
      type: 'ADD_EVENT',
      event,
      eventId: '2',
    });
    expect(result.isComplete).toBe(true);
  });

  it('does not mark complete on phase:end', () => {
    const event: EforgeEvent = {
      type: 'phase:end',
      runId: 'run-1',
      result: { status: 'completed', summary: 'All done' },
      timestamp: '2024-01-01T00:01:00Z',
    };
    const result = eforgeReducer(initialRunState, {
      type: 'ADD_EVENT',
      event,
      eventId: '2',
    });
    expect(result.isComplete).toBe(false);
  });

  it('sets resultStatus from session:end result', () => {
    const event: EforgeEvent = {
      type: 'session:end',
      sessionId: 'session-1',
      result: { status: 'failed', summary: 'Build failed' },
      timestamp: '2024-01-01T00:01:00Z',
    };
    const result = eforgeReducer(initialRunState, {
      type: 'ADD_EVENT',
      event,
      eventId: '3',
    });
    expect(result.isComplete).toBe(true);
    expect(result.resultStatus).toBe('failed');
  });

  it('initializes planStatuses from plan:complete', () => {
    const event: EforgeEvent = {
      type: 'plan:complete',
      plans: [
        { id: 'plan-a', description: 'First plan', dependsOn: [] },
        { id: 'plan-b', description: 'Second plan', dependsOn: ['plan-a'] },
      ],
    };
    const result = eforgeReducer(initialRunState, {
      type: 'ADD_EVENT',
      event,
      eventId: '4',
    });
    expect(result.planStatuses).toEqual({
      'plan-a': 'plan',
      'plan-b': 'plan',
    });
  });

  it('accumulates tokens and cost from agent:result', () => {
    const events = [
      {
        event: {
          type: 'agent:result' as const,
          agent: 'builder' as const,
          result: {
            durationMs: 1000,
            durationApiMs: 800,
            numTurns: 5,
            totalCostUsd: 0.5,
            usage: { input: 1000, output: 500, total: 1500 },
            modelUsage: {},
          },
        },
        eventId: '1',
      },
      {
        event: {
          type: 'agent:result' as const,
          agent: 'reviewer' as const,
          result: {
            durationMs: 500,
            durationApiMs: 400,
            numTurns: 1,
            totalCostUsd: 0.25,
            usage: { input: 2000, output: 300, total: 2300 },
            modelUsage: {},
          },
        },
        eventId: '2',
      },
    ];

    const result = dispatch(initialRunState, events);
    expect(result.tokensIn).toBe(3000);
    expect(result.tokensOut).toBe(800);
    expect(result.totalCost).toBeCloseTo(0.75);
    expect(result.events).toHaveLength(2);
  });

  it('tracks plan statuses through build lifecycle', () => {
    const events: Array<{ event: EforgeEvent; eventId: string }> = [
      { event: { type: 'build:start', planId: 'plan-01' }, eventId: '1' },
      { event: { type: 'build:implement:start', planId: 'plan-01' }, eventId: '2' },
      { event: { type: 'build:implement:complete', planId: 'plan-01' }, eventId: '3' },
      { event: { type: 'build:review:start', planId: 'plan-01' }, eventId: '4' },
      { event: { type: 'build:review:complete', planId: 'plan-01', issues: [] }, eventId: '5' },
      { event: { type: 'build:evaluate:start', planId: 'plan-01' }, eventId: '6' },
      { event: { type: 'build:complete', planId: 'plan-01' }, eventId: '7' },
    ];

    // Check intermediate states
    let state = initialRunState;

    state = eforgeReducer(state, { type: 'ADD_EVENT', event: events[0].event, eventId: '1' });
    expect(state.planStatuses['plan-01']).toBe('implement');

    state = eforgeReducer(state, { type: 'ADD_EVENT', event: events[2].event, eventId: '3' });
    // build:implement:complete no longer advances — next stage (test or review) sets status
    expect(state.planStatuses['plan-01']).toBe('implement');

    // build:review:start advances to review
    state = eforgeReducer(state, { type: 'ADD_EVENT', event: events[3].event, eventId: '4' });
    expect(state.planStatuses['plan-01']).toBe('review');

    state = eforgeReducer(state, { type: 'ADD_EVENT', event: events[4].event, eventId: '5' });
    expect(state.planStatuses['plan-01']).toBe('evaluate');

    state = eforgeReducer(state, { type: 'ADD_EVENT', event: events[6].event, eventId: '7' });
    expect(state.planStatuses['plan-01']).toBe('complete');
  });

  it('tracks failed plan status', () => {
    const state = eforgeReducer(initialRunState, {
      type: 'ADD_EVENT',
      event: { type: 'build:failed', planId: 'plan-01', error: 'oops' },
      eventId: '1',
    });
    expect(state.planStatuses['plan-01']).toBe('failed');
  });

  it('handles events without planId (no status update)', () => {
    const state = eforgeReducer(initialRunState, {
      type: 'ADD_EVENT',
      event: { type: 'plan:start', source: 'test.md' },
      eventId: '1',
    });
    expect(Object.keys(state.planStatuses)).toHaveLength(0);
    expect(state.events).toHaveLength(1);
  });

  it('handles unknown event types gracefully', () => {
    const state = eforgeReducer(initialRunState, {
      type: 'ADD_EVENT',
      event: { type: 'totally:unknown' } as unknown as import('../src/engine/events.js').EforgeEvent,
      eventId: '1',
    });
    expect(state.events).toHaveLength(1);
  });

  it('populates fileChanges on build:files_changed', () => {
    const state = eforgeReducer(initialRunState, {
      type: 'ADD_EVENT',
      event: { type: 'build:files_changed', planId: 'plan-01', files: ['src/a.ts', 'src/b.ts'] },
      eventId: '1',
    });
    expect(state.fileChanges.get('plan-01')).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('handles multiple build:files_changed for different plans', () => {
    let state = eforgeReducer(initialRunState, {
      type: 'ADD_EVENT',
      event: { type: 'build:files_changed', planId: 'plan-01', files: ['src/a.ts'] },
      eventId: '1',
    });
    state = eforgeReducer(state, {
      type: 'ADD_EVENT',
      event: { type: 'build:files_changed', planId: 'plan-02', files: ['src/b.ts'] },
      eventId: '2',
    });
    expect(state.fileChanges.get('plan-01')).toEqual(['src/a.ts']);
    expect(state.fileChanges.get('plan-02')).toEqual(['src/b.ts']);
  });

  it('is idempotent for duplicate build:files_changed events', () => {
    let state = eforgeReducer(initialRunState, {
      type: 'ADD_EVENT',
      event: { type: 'build:files_changed', planId: 'plan-01', files: ['src/a.ts'] },
      eventId: '1',
    });
    state = eforgeReducer(state, {
      type: 'ADD_EVENT',
      event: { type: 'build:files_changed', planId: 'plan-01', files: ['src/a.ts', 'src/b.ts'] },
      eventId: '2',
    });
    // Latest event overwrites
    expect(state.fileChanges.get('plan-01')).toEqual(['src/a.ts', 'src/b.ts']);
    expect(state.fileChanges.size).toBe(1);
  });

  it('marks plan as complete on merge:complete', () => {
    let state = eforgeReducer(initialRunState, {
      type: 'ADD_EVENT',
      event: { type: 'plan:complete', plans: [{ id: 'plan-01', name: 'Plan 1', branch: 'b', dependsOn: [], body: '', filePath: '' }] },
      eventId: '1',
    });
    expect(state.planStatuses['plan-01']).toBe('plan');

    state = eforgeReducer(state, {
      type: 'ADD_EVENT',
      event: { type: 'merge:complete', planId: 'plan-01' },
      eventId: '2',
    });
    expect(state.planStatuses['plan-01']).toBe('complete');
  });
});

describe('getSummaryStats', () => {
  it('returns defaults for empty state', () => {
    const stats = getSummaryStats(initialRunState);
    expect(stats.duration).toBe('--');
    expect(stats.tokensIn).toBe(0);
    expect(stats.tokensOut).toBe(0);
    expect(stats.totalCost).toBe(0);
    expect(stats.plansTotal).toBe(0);
  });

  it('calculates plan counts correctly', () => {
    const state: RunState = {
      ...initialRunState,
      planStatuses: {
        'plan-01': 'complete',
        'plan-02': 'complete',
        'plan-03': 'failed',
        'plan-04': 'implement',
      },
    };
    const stats = getSummaryStats(state);
    expect(stats.plansTotal).toBe(4);
    expect(stats.plansCompleted).toBe(2);
    expect(stats.plansFailed).toBe(1);
  });
});
