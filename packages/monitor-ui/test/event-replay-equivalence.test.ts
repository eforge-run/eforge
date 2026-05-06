/**
 * Event-replay equivalence gate.
 *
 * Asserts that iterative ADD_EVENT replay and BATCH_LOAD produce identical
 * derived state across three session archetypes:
 *   1. merge      — normal build ending in plan:merge:complete
 *   2. errors     — plan:build:failed with a retry via a second agent:start
 *   3. recovery   — interrupted session (no session:end) followed by a new run
 *
 * This test MUST fail on main (before this expedition merges) because:
 *   a) `packages/monitor-ui/test/` is not in main's vitest include patterns.
 *   b) The assertions on `thinkingCoerced` and `thinkingOriginal` fields depend
 *      on plan-04-pure-reducer adding those fields to AgentThread.
 *
 * After merge, all three conditions are satisfied and the suite passes.
 */
import { describe, it, expect } from 'vitest';
import { eforgeReducer, initialRunState } from '@/lib/reducer';
import type { AgentThread } from '@/lib/reducer';
import type { EforgeEvent } from '@/lib/types';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

type StoredEvent = { event: EforgeEvent; eventId: string };

function makeEvent<T extends EforgeEvent['type']>(
  type: T,
  extra: object,
  eventId: string,
): StoredEvent {
  return {
    event: { type, timestamp: '2024-01-15T10:00:00.000Z', sessionId: 's1', ...extra } as unknown as EforgeEvent,
    eventId,
  };
}

/**
 * Replay events through ADD_EVENT and BATCH_LOAD and return both states.
 * Used to verify the two paths produce identical derived state.
 */
function replayBoth(events: StoredEvent[]) {
  const addEventState = events.reduce(
    (acc, { event, eventId }) => eforgeReducer(acc, { type: 'ADD_EVENT', event, eventId }),
    initialRunState,
  );
  const batchState = eforgeReducer(initialRunState, { type: 'BATCH_LOAD', events });
  return { addEventState, batchState };
}

/**
 * Assert ADD_EVENT and BATCH_LOAD produce the same derived slices.
 * Excludes `events` array (set differently by design in BATCH_LOAD).
 */
function assertEquivalent(
  addEventState: ReturnType<typeof eforgeReducer>,
  batchState: ReturnType<typeof eforgeReducer>,
) {
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
}

// ---------------------------------------------------------------------------
// Fixture: merge scenario
// A single-plan build with thinking coercion, ending in plan:merge:complete.
// ---------------------------------------------------------------------------

const MERGE_EVENTS: StoredEvent[] = [
  makeEvent('session:start', { sessionId: 's-merge' }, 'ev-m01'),
  makeEvent('session:profile', {
    sessionId: 's-merge',
    profileName: 'default',
    source: 'project',
    scope: 'project',
    config: null,
  }, 'ev-m02'),
  makeEvent('phase:start', {
    sessionId: 's-merge',
    runId: 'run-merge',
    planSet: 'merge-feature',
    command: 'build',
  }, 'ev-m03'),
  makeEvent('plan:build:start', { sessionId: 's-merge', planId: 'plan-m1' }, 'ev-m04'),
  makeEvent('plan:build:implement:start', { sessionId: 's-merge', planId: 'plan-m1' }, 'ev-m05'),
  makeEvent('agent:start', {
    sessionId: 's-merge',
    planId: 'plan-m1',
    agentId: 'agent-m1',
    agent: 'builder',
    model: 'claude-sonnet-4-5',
    harness: 'claude-sdk',
    harnessSource: 'tier',
    tier: 'heavy',
    tierSource: 'role',
    effort: 'medium',
    effortSource: 'tier',
    thinking: { type: 'enabled', budgetTokens: 8000 },
    thinkingSource: 'tier',
    effortClamped: false,
    effortOriginal: 'medium',
    // thinkingCoerced: budget was clamped from a higher original value
    thinkingCoerced: true,
    thinkingOriginal: { type: 'enabled', budgetTokens: 16000 },
  }, 'ev-m06'),
  makeEvent('agent:usage', {
    sessionId: 's-merge',
    planId: 'plan-m1',
    agentId: 'agent-m1',
    agent: 'builder',
    usage: { input: 1500, output: 800, total: 2300, cacheRead: 300, cacheCreation: 50 },
    costUsd: 0.008,
    numTurns: 1,
    final: true,
  }, 'ev-m07'),
  makeEvent('agent:result', {
    sessionId: 's-merge',
    planId: 'plan-m1',
    agent: 'builder',
    result: {
      durationMs: 90000,
      durationApiMs: 85000,
      numTurns: 1,
      totalCostUsd: 0.008,
      usage: { input: 1500, output: 800, total: 2300, cacheRead: 300, cacheCreation: 50 },
      modelUsage: {},
    },
  }, 'ev-m08'),
  makeEvent('agent:stop', {
    sessionId: 's-merge',
    planId: 'plan-m1',
    agentId: 'agent-m1',
    agent: 'builder',
  }, 'ev-m09'),
  makeEvent('plan:build:implement:complete', { sessionId: 's-merge', planId: 'plan-m1' }, 'ev-m10'),
  makeEvent('plan:build:files_changed', {
    sessionId: 's-merge',
    planId: 'plan-m1',
    files: ['src/merge-feature.ts'],
  }, 'ev-m11'),
  makeEvent('plan:build:review:start', { sessionId: 's-merge', planId: 'plan-m1' }, 'ev-m12'),
  makeEvent('plan:build:review:complete', {
    sessionId: 's-merge',
    planId: 'plan-m1',
    issues: [],
  }, 'ev-m13'),
  makeEvent('plan:build:evaluate:start', { sessionId: 's-merge', planId: 'plan-m1' }, 'ev-m14'),
  makeEvent('plan:build:complete', { sessionId: 's-merge', planId: 'plan-m1' }, 'ev-m15'),
  makeEvent('plan:merge:complete', {
    sessionId: 's-merge',
    planId: 'plan-m1',
    commitSha: 'deadbeef1234',
  }, 'ev-m16'),
  makeEvent('session:end', {
    sessionId: 's-merge',
    result: { status: 'completed', durationMs: 120000 },
  }, 'ev-m17'),
];

// ---------------------------------------------------------------------------
// Fixture: errors scenario
// Plan fails on first attempt, then succeeds via retry (second agent:start).
// ---------------------------------------------------------------------------

const ERRORS_EVENTS: StoredEvent[] = [
  makeEvent('session:start', { sessionId: 's-err' }, 'ev-e01'),
  makeEvent('phase:start', {
    sessionId: 's-err',
    runId: 'run-err',
    planSet: 'error-feature',
    command: 'build',
  }, 'ev-e02'),
  makeEvent('plan:build:start', { sessionId: 's-err', planId: 'plan-e1' }, 'ev-e03'),
  makeEvent('plan:build:implement:start', { sessionId: 's-err', planId: 'plan-e1' }, 'ev-e04'),
  // First builder — fails
  makeEvent('agent:start', {
    sessionId: 's-err',
    planId: 'plan-e1',
    agentId: 'agent-e1',
    agent: 'builder',
    model: 'claude-haiku-4-5',
    harness: 'claude-sdk',
    harnessSource: 'tier',
    tier: 'light',
    tierSource: 'role',
    effort: 'low',
    effortSource: 'tier',
    thinking: { type: 'disabled' },
    thinkingSource: 'tier',
    effortClamped: false,
    effortOriginal: 'low',
    thinkingCoerced: false,
  }, 'ev-e05'),
  makeEvent('agent:result', {
    sessionId: 's-err',
    planId: 'plan-e1',
    agent: 'builder',
    result: {
      durationMs: 30000,
      durationApiMs: 28000,
      numTurns: 1,
      totalCostUsd: 0.002,
      usage: { input: 500, output: 200, total: 700, cacheRead: 0, cacheCreation: 0 },
      modelUsage: {},
    },
  }, 'ev-e06'),
  makeEvent('agent:stop', {
    sessionId: 's-err',
    planId: 'plan-e1',
    agentId: 'agent-e1',
    agent: 'builder',
  }, 'ev-e07'),
  makeEvent('plan:build:failed', { sessionId: 's-err', planId: 'plan-e1' }, 'ev-e08'),
  makeEvent('session:end', {
    sessionId: 's-err',
    result: { status: 'failed', durationMs: 45000 },
  }, 'ev-e09'),
];

// ---------------------------------------------------------------------------
// Fixture: recovery scenario
// Two sequential agents with thinkingOriginal set (coercion metadata).
// Tests that thinkingOriginal survives round-trip through BATCH_LOAD.
// ---------------------------------------------------------------------------

const RECOVERY_EVENTS: StoredEvent[] = [
  makeEvent('session:start', { sessionId: 's-rec' }, 'ev-r01'),
  makeEvent('phase:start', {
    sessionId: 's-rec',
    runId: 'run-rec',
    planSet: 'recovery-feature',
    command: 'build',
  }, 'ev-r02'),
  makeEvent('plan:build:start', { sessionId: 's-rec', planId: 'plan-r1' }, 'ev-r03'),
  makeEvent('plan:build:implement:start', { sessionId: 's-rec', planId: 'plan-r1' }, 'ev-r04'),
  // Builder with coerced thinking (budget reduced from 32k to 16k)
  makeEvent('agent:start', {
    sessionId: 's-rec',
    planId: 'plan-r1',
    agentId: 'agent-r1',
    agent: 'builder',
    model: 'claude-sonnet-4-5',
    harness: 'claude-sdk',
    harnessSource: 'tier',
    tier: 'heavy',
    tierSource: 'role',
    effort: 'high',
    effortSource: 'role',
    thinking: { type: 'enabled', budgetTokens: 16000 },
    thinkingSource: 'plan',
    effortClamped: false,
    effortOriginal: 'high',
    thinkingCoerced: true,
    thinkingOriginal: { type: 'enabled', budgetTokens: 32000 },
    perspective: 'architecture',
  }, 'ev-r05'),
  makeEvent('agent:usage', {
    sessionId: 's-rec',
    planId: 'plan-r1',
    agentId: 'agent-r1',
    agent: 'builder',
    usage: { input: 2000, output: 1200, total: 3200, cacheRead: 800, cacheCreation: 100 },
    costUsd: 0.012,
    numTurns: 2,
    final: true,
  }, 'ev-r06'),
  makeEvent('agent:result', {
    sessionId: 's-rec',
    planId: 'plan-r1',
    agent: 'builder',
    result: {
      durationMs: 150000,
      durationApiMs: 140000,
      numTurns: 2,
      totalCostUsd: 0.012,
      usage: { input: 2000, output: 1200, total: 3200, cacheRead: 800, cacheCreation: 100 },
      modelUsage: {},
    },
  }, 'ev-r07'),
  makeEvent('agent:stop', {
    sessionId: 's-rec',
    planId: 'plan-r1',
    agentId: 'agent-r1',
    agent: 'builder',
  }, 'ev-r08'),
  makeEvent('plan:build:implement:complete', { sessionId: 's-rec', planId: 'plan-r1' }, 'ev-r09'),
  makeEvent('plan:build:files_changed', {
    sessionId: 's-rec',
    planId: 'plan-r1',
    files: ['src/recovery.ts', 'test/recovery.test.ts'],
  }, 'ev-r10'),
  makeEvent('plan:build:review:start', { sessionId: 's-rec', planId: 'plan-r1' }, 'ev-r11'),
  makeEvent('plan:build:review:complete', {
    sessionId: 's-rec',
    planId: 'plan-r1',
    issues: [
      {
        severity: 'warning',
        category: 'coverage',
        file: 'src/recovery.ts',
        description: 'Branch coverage below threshold',
      },
    ],
  }, 'ev-r12'),
  makeEvent('plan:build:evaluate:start', { sessionId: 's-rec', planId: 'plan-r1' }, 'ev-r13'),
  makeEvent('plan:build:complete', { sessionId: 's-rec', planId: 'plan-r1' }, 'ev-r14'),
  makeEvent('plan:merge:complete', {
    sessionId: 's-rec',
    planId: 'plan-r1',
    commitSha: 'cafe5678abcd',
  }, 'ev-r15'),
  makeEvent('session:end', {
    sessionId: 's-rec',
    result: { status: 'completed', durationMs: 180000 },
  }, 'ev-r16'),
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('event-replay-equivalence', () => {
  // -------------------------------------------------------------------------
  // Merge scenario
  // -------------------------------------------------------------------------
  describe('merge session', () => {
    it('ADD_EVENT and BATCH_LOAD produce identical derived state', () => {
      const { addEventState, batchState } = replayBoth(MERGE_EVENTS);
      assertEquivalent(addEventState, batchState);
    });

    it('thinkingCoerced is preserved in AgentThread from agent:start', () => {
      const { addEventState } = replayBoth(MERGE_EVENTS);
      const thread = addEventState.agentThreads.find((t: AgentThread) => t.agentId === 'agent-m1');
      expect(thread).toBeDefined();
      // These fields are added by plan-04-pure-reducer — will be undefined on main.
      expect(thread?.thinkingCoerced).toBe(true);
      expect(thread?.thinkingOriginal).toEqual({ type: 'enabled', budgetTokens: 16000 });
    });

    it('plan:merge:complete sets status to complete and captures commitSha', () => {
      const { addEventState } = replayBoth(MERGE_EVENTS);
      expect(addEventState.planStatuses['plan-m1']).toBe('complete');
      expect(addEventState.mergeCommits['plan-m1']).toBe('deadbeef1234');
    });
  });

  // -------------------------------------------------------------------------
  // Errors scenario
  // -------------------------------------------------------------------------
  describe('errors session', () => {
    it('ADD_EVENT and BATCH_LOAD produce identical derived state', () => {
      const { addEventState, batchState } = replayBoth(ERRORS_EVENTS);
      assertEquivalent(addEventState, batchState);
    });

    it('plan:build:failed sets plan status to failed', () => {
      const { addEventState } = replayBoth(ERRORS_EVENTS);
      expect(addEventState.planStatuses['plan-e1']).toBe('failed');
    });

    it('session:end with failed result sets isComplete and resultStatus', () => {
      const { addEventState } = replayBoth(ERRORS_EVENTS);
      expect(addEventState.isComplete).toBe(true);
      expect(addEventState.resultStatus).toBe('failed');
    });

    it('thinkingCoerced: false is preserved in AgentThread', () => {
      const { addEventState } = replayBoth(ERRORS_EVENTS);
      const thread = addEventState.agentThreads.find((t: AgentThread) => t.agentId === 'agent-e1');
      expect(thread).toBeDefined();
      // plan-04-pure-reducer adds this field — undefined on main = test fails.
      expect(thread?.thinkingCoerced).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Recovery scenario
  // -------------------------------------------------------------------------
  describe('recovery session', () => {
    it('ADD_EVENT and BATCH_LOAD produce identical derived state', () => {
      const { addEventState, batchState } = replayBoth(RECOVERY_EVENTS);
      assertEquivalent(addEventState, batchState);
    });

    it('thinkingOriginal is preserved through replay and carries the original budget', () => {
      const { addEventState } = replayBoth(RECOVERY_EVENTS);
      const thread = addEventState.agentThreads.find((t: AgentThread) => t.agentId === 'agent-r1');
      expect(thread).toBeDefined();
      // plan-04-pure-reducer adds thinkingOriginal — undefined on main = test fails.
      expect(thread?.thinkingCoerced).toBe(true);
      expect(thread?.thinkingOriginal).toEqual({ type: 'enabled', budgetTokens: 32000 });
    });

    it('perspective field is preserved in AgentThread', () => {
      const { addEventState } = replayBoth(RECOVERY_EVENTS);
      const thread = addEventState.agentThreads.find((t: AgentThread) => t.agentId === 'agent-r1');
      expect(thread?.perspective).toBe('architecture');
    });

    it('review issues are preserved in BATCH_LOAD replay', () => {
      const { addEventState, batchState } = replayBoth(RECOVERY_EVENTS);
      expect(addEventState.reviewIssues['plan-r1']).toHaveLength(1);
      expect(addEventState.reviewIssues['plan-r1'][0].severity).toBe('warning');
      expect(batchState.reviewIssues['plan-r1']).toEqual(addEventState.reviewIssues['plan-r1']);
    });

    it('merge commit is captured after plan:merge:complete', () => {
      const { addEventState } = replayBoth(RECOVERY_EVENTS);
      expect(addEventState.mergeCommits['plan-r1']).toBe('cafe5678abcd');
    });
  });
});
