import { describe, it, expect } from 'vitest';
import {
  eforgeReducer,
  initialRunState,
  getSummaryStats,
  type RunState,
  type RunAction,
} from '../src/monitor/ui/src/lib/reducer';
import type { EforgeEvent } from '../src/engine/events';
import { isAlwaysYieldedAgentEvent } from '../src/engine/events';

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

describe('enqueue events in reducer', () => {
  it('sets enqueueStatus to running on enqueue:start', () => {
    const event: EforgeEvent = {
      type: 'enqueue:start',
      source: '/tmp/my-prd.md',
    } as unknown as EforgeEvent;
    const result = eforgeReducer(initialRunState, {
      type: 'ADD_EVENT',
      event,
      eventId: 'eq-1',
    });
    expect(result.enqueueStatus).toBe('running');
    expect(result.enqueueSource).toBe('/tmp/my-prd.md');
  });

  it('sets enqueueStatus to complete and enqueueTitle on enqueue:complete', () => {
    let state = eforgeReducer(initialRunState, {
      type: 'ADD_EVENT',
      event: { type: 'enqueue:start', source: '/tmp/my-prd.md' } as unknown as EforgeEvent,
      eventId: 'eq-1',
    });
    state = eforgeReducer(state, {
      type: 'ADD_EVENT',
      event: { type: 'enqueue:complete', id: 'prd-001', filePath: '/tmp/queue/prd-001.md', title: 'My Feature' } as unknown as EforgeEvent,
      eventId: 'eq-2',
    });
    expect(state.enqueueStatus).toBe('complete');
    expect(state.enqueueTitle).toBe('My Feature');
  });

  it('sets startTime from session:start when no phase:start has arrived', () => {
    const event: EforgeEvent = {
      type: 'session:start',
      sessionId: 'session-1',
      timestamp: '2024-06-01T12:00:00Z',
    } as unknown as EforgeEvent;
    const result = eforgeReducer(initialRunState, {
      type: 'ADD_EVENT',
      event,
      eventId: 'ss-1',
    });
    expect(result.startTime).toBe(new Date('2024-06-01T12:00:00Z').getTime());
  });
});

describe('BATCH_LOAD with serverStatus', () => {
  it('sets resultStatus and isComplete from serverStatus when no session:end event', () => {
    const events = [
      {
        event: {
          type: 'phase:start' as const,
          runId: 'run-1',
          planSet: 'test',
          command: 'build' as const,
          timestamp: '2024-01-01T00:00:00Z',
        },
        eventId: '1',
      },
    ];
    const result = eforgeReducer(initialRunState, {
      type: 'BATCH_LOAD',
      events,
      serverStatus: 'completed',
    });
    expect(result.resultStatus).toBe('completed');
    expect(result.isComplete).toBe(true);
  });

  it('sets resultStatus to failed from serverStatus when no session:end event', () => {
    const events = [
      {
        event: {
          type: 'phase:start' as const,
          runId: 'run-1',
          planSet: 'test',
          command: 'build' as const,
          timestamp: '2024-01-01T00:00:00Z',
        },
        eventId: '1',
      },
    ];
    const result = eforgeReducer(initialRunState, {
      type: 'BATCH_LOAD',
      events,
      serverStatus: 'failed',
    });
    expect(result.resultStatus).toBe('failed');
    expect(result.isComplete).toBe(true);
  });

  it('preserves resultStatus from session:end when no serverStatus provided', () => {
    const events: Array<{ event: EforgeEvent; eventId: string }> = [
      {
        event: {
          type: 'session:end',
          sessionId: 'session-1',
          result: { status: 'completed', summary: 'Done' },
          timestamp: '2024-01-01T00:01:00Z',
        } as unknown as EforgeEvent,
        eventId: '1',
      },
    ];
    const result = eforgeReducer(initialRunState, {
      type: 'BATCH_LOAD',
      events,
    });
    expect(result.resultStatus).toBe('completed');
    expect(result.isComplete).toBe(true);
  });

  it('does not override session:end result with serverStatus', () => {
    const events: Array<{ event: EforgeEvent; eventId: string }> = [
      {
        event: {
          type: 'session:end',
          sessionId: 'session-1',
          result: { status: 'failed', summary: 'Build failed' },
          timestamp: '2024-01-01T00:01:00Z',
        } as unknown as EforgeEvent,
        eventId: '1',
      },
    ];
    const result = eforgeReducer(initialRunState, {
      type: 'BATCH_LOAD',
      events,
      serverStatus: 'completed',
    });
    // session:end already set isComplete, so serverStatus override is skipped
    expect(result.resultStatus).toBe('failed');
    expect(result.isComplete).toBe(true);
  });

  it('ignores serverStatus when it is "running"', () => {
    const events = [
      {
        event: {
          type: 'phase:start' as const,
          runId: 'run-1',
          planSet: 'test',
          command: 'build' as const,
          timestamp: '2024-01-01T00:00:00Z',
        },
        eventId: '1',
      },
    ];
    const result = eforgeReducer(initialRunState, {
      type: 'BATCH_LOAD',
      events,
      serverStatus: 'running',
    });
    expect(result.resultStatus).toBeNull();
    expect(result.isComplete).toBe(false);
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

  it('overlays liveAgentUsage into summary stats', () => {
    // Simulate one finalized agent result + one live agent
    const events: Array<{ event: EforgeEvent; eventId: string }> = [
      {
        event: {
          type: 'agent:start',
          agentId: 'a1',
          agent: 'builder',
          planId: 'plan-01',
          model: 'claude',
          backend: 'pi',
          timestamp: '2024-01-01T00:00:00Z',
        } as unknown as EforgeEvent,
        eventId: '1',
      },
      {
        event: {
          type: 'agent:result',
          agent: 'builder',
          planId: 'plan-01',
          result: {
            durationMs: 1000,
            durationApiMs: 800,
            numTurns: 5,
            totalCostUsd: 0.50,
            usage: { input: 1000, output: 500, total: 1500, cacheRead: 100, cacheCreation: 50 },
            modelUsage: {},
          },
        } as unknown as EforgeEvent,
        eventId: '2',
      },
      {
        event: {
          type: 'agent:start',
          agentId: 'a2',
          agent: 'reviewer',
          model: 'claude',
          backend: 'pi',
          timestamp: '2024-01-01T00:00:01Z',
        } as unknown as EforgeEvent,
        eventId: '3',
      },
      {
        event: {
          type: 'agent:usage',
          agentId: 'a2',
          agent: 'reviewer',
          usage: { input: 2000, output: 300, total: 2300, cacheRead: 200, cacheCreation: 80 },
          costUsd: 0.25,
          numTurns: 3,
        } as unknown as EforgeEvent,
        eventId: '4',
      },
    ];
    const state = dispatch(initialRunState, events);
    const stats = getSummaryStats(state);

    // Finalized: 1000 in + live: 2000 in
    expect(stats.tokensIn).toBe(3000);
    // Finalized: 500 out + live: 300 out
    expect(stats.tokensOut).toBe(800);
    // Finalized: 100 + live: 200
    expect(stats.cacheRead).toBe(300);
    // Finalized: 50 + live: 80
    expect(stats.cacheCreation).toBe(130);
    // Finalized: 0.50 + live: 0.25
    expect(stats.totalCost).toBeCloseTo(0.75);
    // Finalized turns: 5 (from agentThread) + live: 3
    expect(stats.totalTurns).toBe(8);
  });

  it('clears live overlay after agent:result so no double-counting', () => {
    const events: Array<{ event: EforgeEvent; eventId: string }> = [
      {
        event: {
          type: 'agent:start',
          agentId: 'a1',
          agent: 'builder',
          planId: 'plan-01',
          model: 'claude',
          backend: 'pi',
          timestamp: '2024-01-01T00:00:00Z',
        } as unknown as EforgeEvent,
        eventId: '1',
      },
      {
        event: {
          type: 'agent:usage',
          agentId: 'a1',
          agent: 'builder',
          planId: 'plan-01',
          usage: { input: 500, output: 200, total: 700, cacheRead: 50, cacheCreation: 10 },
          costUsd: 0.10,
          numTurns: 2,
        } as unknown as EforgeEvent,
        eventId: '2',
      },
      {
        event: {
          type: 'agent:usage',
          agentId: 'a1',
          agent: 'builder',
          planId: 'plan-01',
          usage: { input: 1000, output: 400, total: 1400, cacheRead: 100, cacheCreation: 20 },
          costUsd: 0.20,
          numTurns: 4,
        } as unknown as EforgeEvent,
        eventId: '3',
      },
      {
        event: {
          type: 'agent:result',
          agent: 'builder',
          planId: 'plan-01',
          result: {
            durationMs: 2000,
            durationApiMs: 1500,
            numTurns: 4,
            totalCostUsd: 0.20,
            usage: { input: 1000, output: 400, total: 1400, cacheRead: 100, cacheCreation: 20 },
            modelUsage: {},
          },
        } as unknown as EforgeEvent,
        eventId: '4',
      },
    ];
    const state = dispatch(initialRunState, events);

    // Live overlay should be cleared - only finalized values remain
    expect(Object.keys(state.liveAgentUsage)).toHaveLength(0);

    const stats = getSummaryStats(state);
    // Only finalized: 1000 in, 400 out (no double-count from live)
    expect(stats.tokensIn).toBe(1000);
    expect(stats.tokensOut).toBe(400);
    expect(stats.cacheRead).toBe(100);
    expect(stats.cacheCreation).toBe(20);
    expect(stats.totalCost).toBeCloseTo(0.20);
  });
});

describe('agent:usage event handling', () => {
  it('isAlwaysYieldedAgentEvent returns true for agent:usage', () => {
    const event: EforgeEvent = {
      type: 'agent:usage',
      agentId: 'a1',
      agent: 'builder',
      usage: { input: 100, output: 50, total: 150, cacheRead: 10, cacheCreation: 5 },
      costUsd: 0.01,
      numTurns: 1,
    } as unknown as EforgeEvent;
    expect(isAlwaysYieldedAgentEvent(event)).toBe(true);
  });

  it('initialRunState has empty liveAgentUsage', () => {
    expect(initialRunState.liveAgentUsage).toEqual({});
  });

  it('sets liveAgentUsage entry on agent:usage event', () => {
    const state = eforgeReducer(initialRunState, {
      type: 'ADD_EVENT',
      event: {
        type: 'agent:usage',
        agentId: 'a1',
        agent: 'builder',
        usage: { input: 500, output: 200, total: 700, cacheRead: 50, cacheCreation: 10 },
        costUsd: 0.05,
        numTurns: 2,
      } as unknown as EforgeEvent,
      eventId: '1',
    });
    expect(state.liveAgentUsage['a1']).toEqual({
      input: 500,
      output: 200,
      cacheRead: 50,
      cacheCreation: 10,
      cost: 0.05,
      turns: 2,
    });
  });

  it('overwrites liveAgentUsage on subsequent agent:usage (cumulative)', () => {
    let state = eforgeReducer(initialRunState, {
      type: 'ADD_EVENT',
      event: {
        type: 'agent:usage',
        agentId: 'a1',
        agent: 'builder',
        usage: { input: 500, output: 200, total: 700, cacheRead: 50, cacheCreation: 10 },
        costUsd: 0.05,
        numTurns: 2,
      } as unknown as EforgeEvent,
      eventId: '1',
    });
    state = eforgeReducer(state, {
      type: 'ADD_EVENT',
      event: {
        type: 'agent:usage',
        agentId: 'a1',
        agent: 'builder',
        usage: { input: 1000, output: 400, total: 1400, cacheRead: 100, cacheCreation: 20 },
        costUsd: 0.10,
        numTurns: 4,
      } as unknown as EforgeEvent,
      eventId: '2',
    });
    // Should be overwritten, not accumulated
    expect(state.liveAgentUsage['a1']).toEqual({
      input: 1000,
      output: 400,
      cacheRead: 100,
      cacheCreation: 20,
      cost: 0.10,
      turns: 4,
    });
  });

  it('deletes liveAgentUsage entry on agent:stop', () => {
    let state = eforgeReducer(initialRunState, {
      type: 'ADD_EVENT',
      event: {
        type: 'agent:usage',
        agentId: 'a1',
        agent: 'builder',
        usage: { input: 500, output: 200, total: 700, cacheRead: 50, cacheCreation: 10 },
        costUsd: 0.05,
        numTurns: 2,
      } as unknown as EforgeEvent,
      eventId: '1',
    });
    expect(state.liveAgentUsage['a1']).toBeDefined();

    state = eforgeReducer(state, {
      type: 'ADD_EVENT',
      event: {
        type: 'agent:stop',
        agentId: 'a1',
        agent: 'builder',
        timestamp: '2024-01-01T00:01:00Z',
      } as unknown as EforgeEvent,
      eventId: '2',
    });
    expect(state.liveAgentUsage['a1']).toBeUndefined();
  });

  it('updates AgentThread with live usage on agent:usage', () => {
    let state = eforgeReducer(initialRunState, {
      type: 'ADD_EVENT',
      event: {
        type: 'agent:start',
        agentId: 'a1',
        agent: 'builder',
        model: 'claude',
        backend: 'pi',
        timestamp: '2024-01-01T00:00:00Z',
      } as unknown as EforgeEvent,
      eventId: '1',
    });
    state = eforgeReducer(state, {
      type: 'ADD_EVENT',
      event: {
        type: 'agent:usage',
        agentId: 'a1',
        agent: 'builder',
        usage: { input: 500, output: 200, total: 700, cacheRead: 50, cacheCreation: 10 },
        costUsd: 0.05,
        numTurns: 2,
      } as unknown as EforgeEvent,
      eventId: '2',
    });

    const thread = state.agentThreads.find((t) => t.agentId === 'a1');
    expect(thread).toBeDefined();
    expect(thread!.inputTokens).toBe(500);
    expect(thread!.outputTokens).toBe(200);
    expect(thread!.totalTokens).toBe(700);
    expect(thread!.cacheRead).toBe(50);
    expect(thread!.costUsd).toBe(0.05);
    expect(thread!.numTurns).toBe(2);
  });

  it('full lifecycle: agent:start, agent:usage x2, agent:result produces correct totals', () => {
    const events: Array<{ event: EforgeEvent; eventId: string }> = [
      {
        event: {
          type: 'agent:start',
          agentId: 'a1',
          agent: 'builder',
          planId: 'plan-01',
          model: 'claude',
          backend: 'pi',
          timestamp: '2024-01-01T00:00:00Z',
        } as unknown as EforgeEvent,
        eventId: '1',
      },
      {
        event: {
          type: 'agent:usage',
          agentId: 'a1',
          agent: 'builder',
          planId: 'plan-01',
          usage: { input: 500, output: 200, total: 700, cacheRead: 50, cacheCreation: 10 },
          costUsd: 0.05,
          numTurns: 2,
        } as unknown as EforgeEvent,
        eventId: '2',
      },
      {
        event: {
          type: 'agent:usage',
          agentId: 'a1',
          agent: 'builder',
          planId: 'plan-01',
          usage: { input: 1200, output: 500, total: 1700, cacheRead: 120, cacheCreation: 25 },
          costUsd: 0.15,
          numTurns: 4,
        } as unknown as EforgeEvent,
        eventId: '3',
      },
      {
        event: {
          type: 'agent:result',
          agent: 'builder',
          planId: 'plan-01',
          result: {
            durationMs: 3000,
            durationApiMs: 2500,
            numTurns: 4,
            totalCostUsd: 0.15,
            usage: { input: 1200, output: 500, total: 1700, cacheRead: 120, cacheCreation: 25 },
            modelUsage: {},
          },
        } as unknown as EforgeEvent,
        eventId: '4',
      },
    ];

    const state = dispatch(initialRunState, events);

    // Live overlay cleared
    expect(Object.keys(state.liveAgentUsage)).toHaveLength(0);

    // Finalized counters from agent:result
    expect(state.tokensIn).toBe(1200);
    expect(state.tokensOut).toBe(500);
    expect(state.cacheRead).toBe(120);
    expect(state.cacheCreation).toBe(25);
    expect(state.totalCost).toBeCloseTo(0.15);

    // getSummaryStats should match finalized (no live overlay)
    const stats = getSummaryStats(state);
    expect(stats.tokensIn).toBe(1200);
    expect(stats.tokensOut).toBe(500);
    expect(stats.totalCost).toBeCloseTo(0.15);
    expect(stats.totalTurns).toBe(4);
  });

  it('BATCH_LOAD handles agent:usage events correctly', () => {
    const events: Array<{ event: EforgeEvent; eventId: string }> = [
      {
        event: {
          type: 'agent:start',
          agentId: 'a1',
          agent: 'builder',
          planId: 'plan-01',
          model: 'claude',
          backend: 'pi',
          timestamp: '2024-01-01T00:00:00Z',
        } as unknown as EforgeEvent,
        eventId: '1',
      },
      {
        event: {
          type: 'agent:usage',
          agentId: 'a1',
          agent: 'builder',
          planId: 'plan-01',
          usage: { input: 800, output: 300, total: 1100, cacheRead: 80, cacheCreation: 15 },
          costUsd: 0.08,
          numTurns: 3,
        } as unknown as EforgeEvent,
        eventId: '2',
      },
    ];

    const state = eforgeReducer(initialRunState, {
      type: 'BATCH_LOAD',
      events,
    });

    // Live overlay should be set (no agent:result to clear it)
    expect(state.liveAgentUsage['a1']).toEqual({
      input: 800,
      output: 300,
      cacheRead: 80,
      cacheCreation: 15,
      cost: 0.08,
      turns: 3,
    });

    // getSummaryStats includes live overlay
    const stats = getSummaryStats(state);
    expect(stats.tokensIn).toBe(800);
    expect(stats.tokensOut).toBe(300);
    expect(stats.totalCost).toBeCloseTo(0.08);
  });
});
