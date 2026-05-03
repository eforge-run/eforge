/**
 * Regression test: replay the captured sample-build fixture through the new
 * reducer and assert the resulting RunState matches the expected output computed
 * from the pre-refactor reducer logic.
 *
 * This test is the binary safety gate — it converts "behavior-preserving" from
 * a vibe into a contract. Any deviation in the new handler logic (wrong stage
 * advancement, wrong token accumulation, wrong thread matching, etc.) will
 * surface here as a diff against the expected state.
 *
 * Expected state was computed by manually tracing the pre-refactor processEvent
 * logic against the sample-build.json fixture event-by-event.
 */
import { describe, it, expect } from 'vitest';
import { eforgeReducer, initialRunState } from '../../reducer';
import type { EforgeEvent } from '../../types';
import fixtureEvents from './fixtures/sample-build.json';

type FixtureEntry = { event: EforgeEvent; eventId: string };

describe('regression: new reducer matches pre-refactor behavior on sample-build fixture', () => {
  it('produces the expected final RunState for the 34-event fixture', () => {
    const state = (fixtureEvents as unknown as FixtureEntry[]).reduce(
      (acc, { event, eventId }) => eforgeReducer(acc, { type: 'ADD_EVENT', event, eventId }),
      initialRunState,
    );

    // -------------------------------------------------------------------------
    // Session lifecycle
    // -------------------------------------------------------------------------
    // startTime: session:start timestamp 2024-01-15T10:00:00.000Z
    expect(state.startTime).toBe(new Date('2024-01-15T10:00:00.000Z').getTime());
    // endTime: session:end timestamp 2024-01-15T10:11:05.000Z
    expect(state.endTime).toBe(new Date('2024-01-15T10:11:05.000Z').getTime());
    expect(state.isComplete).toBe(true);
    expect(state.resultStatus).toBe('completed');

    // -------------------------------------------------------------------------
    // Profile
    // -------------------------------------------------------------------------
    expect(state.profile).toEqual({
      profileName: 'default',
      source: 'project',
      scope: 'project',
      config: null,
    });

    // -------------------------------------------------------------------------
    // Plan statuses — both plans end at 'complete' after merge
    // -------------------------------------------------------------------------
    expect(state.planStatuses).toEqual({
      'plan-01': 'complete',
      'plan-02': 'complete',
    });

    // -------------------------------------------------------------------------
    // Token accumulators — sum of both agent:result events
    // agent-001: input=2000, output=1000, cacheRead=400, cacheCreation=100, cost=0.01
    // agent-002: input=3000, output=1500, cacheRead=600, cacheCreation=200, cost=0.015
    // -------------------------------------------------------------------------
    expect(state.tokensIn).toBe(5000);
    expect(state.tokensOut).toBe(2500);
    expect(state.cacheRead).toBe(1000);
    expect(state.cacheCreation).toBe(300);
    expect(state.totalCost).toBeCloseTo(0.025, 8);

    // -------------------------------------------------------------------------
    // File changes
    // -------------------------------------------------------------------------
    expect(state.fileChanges.get('plan-01')).toEqual([
      'src/features/a.ts',
      'src/features/b.ts',
      'test/a.test.ts',
    ]);
    expect(state.fileChanges.get('plan-02')).toEqual(['src/features/b-extension.ts']);

    // -------------------------------------------------------------------------
    // Review issues
    // -------------------------------------------------------------------------
    expect(state.reviewIssues['plan-01']).toEqual([
      {
        severity: 'warning',
        category: 'style',
        file: 'src/features/a.ts',
        description: 'Missing JSDoc on exported function',
      },
    ]);
    expect(state.reviewIssues['plan-02']).toEqual([]);

    // -------------------------------------------------------------------------
    // Merge commits
    // -------------------------------------------------------------------------
    expect(state.mergeCommits).toEqual({
      'plan-01': 'abc123def456',
      'plan-02': '789fedcba012',
    });

    // -------------------------------------------------------------------------
    // Agent threads — two finalized threads
    // -------------------------------------------------------------------------
    expect(state.agentThreads).toHaveLength(2);

    const thread1 = state.agentThreads[0];
    expect(thread1.agentId).toBe('agent-001');
    expect(thread1.agent).toBe('builder');
    expect(thread1.planId).toBe('plan-01');
    expect(thread1.startedAt).toBe('2024-01-15T10:01:10.000Z');
    expect(thread1.endedAt).toBe('2024-01-15T10:03:05.000Z');
    expect(thread1.durationMs).toBe(120000);
    // After agent:result overwrites values from final agent:usage
    expect(thread1.inputTokens).toBe(2000);
    expect(thread1.outputTokens).toBe(1000);
    expect(thread1.totalTokens).toBe(3000);
    expect(thread1.cacheRead).toBe(400);
    expect(thread1.costUsd).toBe(0.01);
    expect(thread1.numTurns).toBe(2);
    expect(thread1.model).toBe('claude-sonnet-4-5');
    expect(thread1.harness).toBe('claude-sdk');
    expect(thread1.tier).toBe('heavy');
    expect(thread1.tierSource).toBe('role');
    expect(thread1.effort).toBe('high');
    expect(thread1.effortSource).toBe('role');
    expect(thread1.thinking).toBe('enabled (10.0k tokens)');
    expect(thread1.thinkingSource).toBe('role');
    expect(thread1.effortClamped).toBe(false);
    expect(thread1.effortOriginal).toBe('high');

    const thread2 = state.agentThreads[1];
    expect(thread2.agentId).toBe('agent-002');
    expect(thread2.agent).toBe('builder');
    expect(thread2.planId).toBe('plan-02');
    expect(thread2.startedAt).toBe('2024-01-15T10:06:10.000Z');
    expect(thread2.endedAt).toBe('2024-01-15T10:08:05.000Z');
    expect(thread2.durationMs).toBe(90000);
    expect(thread2.inputTokens).toBe(3000);
    expect(thread2.outputTokens).toBe(1500);
    expect(thread2.totalTokens).toBe(4500);
    expect(thread2.cacheRead).toBe(600);
    expect(thread2.costUsd).toBe(0.015);
    expect(thread2.numTurns).toBe(3);

    // -------------------------------------------------------------------------
    // Live agent usage — empty (all agents finalized)
    // -------------------------------------------------------------------------
    expect(Object.keys(state.liveAgentUsage)).toHaveLength(0);

    // -------------------------------------------------------------------------
    // Expedition / enqueue / other fields — default values (not exercised by fixture)
    // -------------------------------------------------------------------------
    expect(state.expeditionModules).toHaveLength(0);
    expect(Object.keys(state.moduleStatuses)).toHaveLength(0);
    expect(state.earlyOrchestration).toBeNull();
    expect(state.enqueueStatus).toBeNull();
    expect(state.enqueueTitle).toBeNull();
    expect(state.enqueueSource).toBeNull();

    // -------------------------------------------------------------------------
    // Events array — all 34 fixture events stored in order
    // -------------------------------------------------------------------------
    expect(state.events).toHaveLength(34);
    expect(state.events[0].eventId).toBe('ev-001');
    expect(state.events[33].eventId).toBe('ev-034');
  });

  // ---------------------------------------------------------------------------
  // BATCH_LOAD produces same derived state as iterative ADD_EVENT
  // ---------------------------------------------------------------------------
  it('BATCH_LOAD produces identical derived state to iterative ADD_EVENT replay', () => {
    const addEventState = (fixtureEvents as unknown as FixtureEntry[]).reduce(
      (acc, { event, eventId }) => eforgeReducer(acc, { type: 'ADD_EVENT', event, eventId }),
      initialRunState,
    );

    const batchState = eforgeReducer(initialRunState, {
      type: 'BATCH_LOAD',
      events: fixtureEvents as unknown as FixtureEntry[],
    });

    // Compare all derived fields (exclude events which are set differently but equivalent)
    expect(batchState.startTime).toBe(addEventState.startTime);
    expect(batchState.endTime).toBe(addEventState.endTime);
    expect(batchState.isComplete).toBe(addEventState.isComplete);
    expect(batchState.resultStatus).toBe(addEventState.resultStatus);
    expect(batchState.planStatuses).toEqual(addEventState.planStatuses);
    expect(batchState.tokensIn).toBe(addEventState.tokensIn);
    expect(batchState.tokensOut).toBe(addEventState.tokensOut);
    expect(batchState.cacheRead).toBe(addEventState.cacheRead);
    expect(batchState.cacheCreation).toBe(addEventState.cacheCreation);
    expect(batchState.totalCost).toBeCloseTo(addEventState.totalCost, 8);
    expect(Object.fromEntries(batchState.fileChanges)).toEqual(Object.fromEntries(addEventState.fileChanges));
    expect(batchState.reviewIssues).toEqual(addEventState.reviewIssues);
    expect(batchState.mergeCommits).toEqual(addEventState.mergeCommits);
    expect(batchState.agentThreads).toEqual(addEventState.agentThreads);
    expect(batchState.liveAgentUsage).toEqual(addEventState.liveAgentUsage);
    expect(batchState.profile).toEqual(addEventState.profile);
    expect(batchState.expeditionModules).toEqual(addEventState.expeditionModules);
    expect(batchState.moduleStatuses).toEqual(addEventState.moduleStatuses);
    expect(batchState.earlyOrchestration).toEqual(addEventState.earlyOrchestration);
    // events array: BATCH_LOAD sets it from action.events directly
    expect(batchState.events).toHaveLength(addEventState.events.length);
  });
});
