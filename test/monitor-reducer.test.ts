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

  it('tracks start time from eforge:start', () => {
    const event: EforgeEvent = {
      type: 'eforge:start',
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

  it('marks complete on eforge:end', () => {
    const event: EforgeEvent = {
      type: 'eforge:end',
      runId: 'run-1',
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
      event: { type: 'wave:start', wave: 1, planIds: ['a', 'b'] },
      eventId: '1',
    });
    expect(state.events).toHaveLength(1);
  });
});

describe('getSummaryStats', () => {
  it('returns defaults for empty state', () => {
    const stats = getSummaryStats(initialRunState);
    expect(stats.duration).toBe('--');
    expect(stats.eventCount).toBe(0);
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
