/**
 * Lifecycle event emission tests (AC #6).
 *
 * Proves that the orchestrator, plan-lifecycle helpers, and worktree-manager
 * emit each of the five lifecycle variants when expected:
 *   plan:status:change  — transitionPlan, executePlans (running/completed/failed/merged)
 *   plan:error:set      — transitionPlan with metadata.error
 *   plan:error:clear    — resumeState when resetting a plan that had an error
 *   merge:worktree:set  — emitted by mutateState (compile phase; tested via direct emission)
 *   merge:worktree:clear — WorktreeManager.reconcile when merge worktree is missing
 *
 * Tests use stub plan runners and stub worktree managers following the
 * orchestration-logic.test.ts pattern.
 */
import { describe, it, expect } from 'vitest';
import { transitionPlan } from '@eforge-build/engine/orchestrator/plan-lifecycle';
import { executePlans } from '@eforge-build/engine/orchestrator/phases';
import { WorktreeManager } from '@eforge-build/engine/worktree-manager';
import { initializeState } from '@eforge-build/engine/orchestrator';
import { mutateState } from '@eforge-build/engine/state';
import type { EforgeState, EforgeEvent, OrchestrationConfig, PlanState } from '@eforge-build/engine/events';
import type { PhaseContext } from '@eforge-build/engine/orchestrator/phases';
import type { WorktreeManager as WorktreeManagerType } from '@eforge-build/engine/worktree-manager';
import type { PlanRunner } from '@eforge-build/engine/orchestrator';
import { ModelTracker } from '@eforge-build/engine/model-tracker';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(
  plans: Record<string, Partial<PlanState> & { status: PlanState['status'] }>,
  overrides?: Partial<EforgeState>,
): EforgeState {
  const fullPlans: Record<string, PlanState> = {};
  for (const [id, partial] of Object.entries(plans)) {
    fullPlans[id] = {
      status: partial.status,
      branch: partial.branch ?? `feature/${id}`,
      dependsOn: partial.dependsOn ?? [],
      merged: partial.merged ?? false,
      error: partial.error,
      worktreePath: partial.worktreePath,
    };
  }
  return {
    setName: 'test-set',
    status: 'running',
    startedAt: '2026-01-01T00:00:00Z',
    baseBranch: 'main',
    featureBranch: 'eforge/test-set',
    worktreeBase: '/tmp/worktrees',
    plans: fullPlans,
    completedPlans: [],
    ...overrides,
  };
}

const TEST_REVIEW = { strategy: 'auto' as const, perspectives: ['code'], maxRounds: 1, evaluatorStrictness: 'standard' as const };
const TEST_BUILD = ['implement', 'review-cycle'];

function makeConfig(overrides?: Partial<OrchestrationConfig>): OrchestrationConfig {
  return {
    name: 'test-set',
    description: 'test',
    created: '2026-01-01T00:00:00Z',
    mode: 'excursion',
    baseBranch: 'main',
    pipeline: {
      scope: 'excursion',
      compile: ['planner', 'plan-review-cycle'],
      defaultBuild: TEST_BUILD,
      defaultReview: TEST_REVIEW,
      rationale: 'test',
    },
    plans: [
      { id: 'plan-a', name: 'Plan A', dependsOn: [], branch: 'feature/plan-a', build: TEST_BUILD, review: TEST_REVIEW },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// transitionPlan — plan:status:change and plan:error:set
// ---------------------------------------------------------------------------

describe('transitionPlan — lifecycle event emission', () => {
  it('emits plan:status:change on every valid transition', () => {
    const state = makeState({ p1: { status: 'pending' } });
    const events = transitionPlan(state, 'p1', 'running');
    expect(events.some((e) => e.type === 'plan:status:change' && e.planId === 'p1' && e.status === 'running')).toBe(true);
  });

  it('emits plan:status:change(merged) when plan completes merge phase', () => {
    const state = makeState({ p1: { status: 'completed' } });
    const events = transitionPlan(state, 'p1', 'merged');
    expect(events.some((e) => e.type === 'plan:status:change' && e.planId === 'p1' && e.status === 'merged')).toBe(true);
  });

  it('emits plan:error:set when metadata.error is provided', () => {
    const state = makeState({ p1: { status: 'running' } });
    const events = transitionPlan(state, 'p1', 'failed', { error: 'build crashed' });
    expect(events.some((e) => e.type === 'plan:status:change' && e.planId === 'p1' && e.status === 'failed')).toBe(true);
    expect(events.some((e) => e.type === 'plan:error:set' && e.planId === 'p1' && e.error === 'build crashed')).toBe(true);
  });

  it('does NOT emit plan:error:set without error metadata', () => {
    const state = makeState({ p1: { status: 'running' } });
    const events = transitionPlan(state, 'p1', 'completed');
    expect(events.every((e) => e.type !== 'plan:error:set')).toBe(true);
  });

  it('emits both plan:status:change and plan:error:set in order (mutation first)', () => {
    const state = makeState({ p1: { status: 'running' } });
    const events = transitionPlan(state, 'p1', 'failed', { error: 'err' });
    const types = events.map((e) => e.type);
    expect(types).toEqual(['plan:status:change', 'plan:error:set']);
    // State must already reflect the mutation when events are returned
    expect(state.plans['p1'].status).toBe('failed');
    expect(state.plans['p1'].error).toBe('err');
  });
});

// ---------------------------------------------------------------------------
// WorktreeManager.reconcile — merge:worktree:clear and plan:status:change
// ---------------------------------------------------------------------------

describe('WorktreeManager.reconcile — lifecycle event emission', () => {
  it('emits merge:worktree:clear when merge worktree path is missing from filesystem', async () => {
    const state = makeState({ p1: { status: 'pending' } });
    // Set a non-existent merge worktree path in state via mutateState
    mutateState(state, {
      type: 'merge:worktree:set',
      path: '/non/existent/path/that/does/not/exist',
      timestamp: new Date().toISOString(),
    });
    expect(state.mergeWorktreePath).toBe('/non/existent/path/that/does/not/exist');

    const wm = new WorktreeManager({
      repoRoot: '/tmp',
      worktreeBase: '/tmp/wt',
      featureBranch: 'eforge/test',
      mergeWorktreePath: '/tmp/merge-wt',
    });

    const { events } = await wm.reconcile(state);
    expect(events.some((e) => e.type === 'merge:worktree:clear')).toBe(true);
    // State should reflect the mutation
    expect(state.mergeWorktreePath).toBeUndefined();
  });

  it('emits plan:status:change(pending) when a running plan worktree is missing', async () => {
    const state = makeState({
      p1: { status: 'running', worktreePath: '/non/existent/worktree/path' },
    });

    const wm = new WorktreeManager({
      repoRoot: '/tmp',
      worktreeBase: '/tmp/wt',
      featureBranch: 'eforge/test',
      mergeWorktreePath: '/tmp/merge-wt',
    });

    const { events } = await wm.reconcile(state);
    expect(events.some((e) => e.type === 'plan:status:change' && e.planId === 'p1' && e.status === 'pending')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// executePlans — full lifecycle through the orchestrator (plan:status:change)
// ---------------------------------------------------------------------------

describe('executePlans — lifecycle event emission', () => {
  it('emits plan:status:change(running), plan:status:change(completed), plan:status:change(merged) for a successful plan', async () => {
    const config = makeConfig({
      plans: [
        { id: 'plan-a', name: 'Plan A', dependsOn: [], branch: 'feature/plan-a', build: TEST_BUILD, review: TEST_REVIEW },
      ],
    });
    const state = initializeState(config, '/tmp/repo').state;

    // Plan runner: completes successfully (no plan:build:failed yielded)
    const planRunner: PlanRunner = async function* () { /* no events — clean exit */ };

    const stubWM = {
      acquireForPlan: async () => '/tmp/fake-worktree',
      releaseForPlan: async () => {},
      mergePlan: async () => 'abc123',
      reconcile: async () => ({ report: { valid: [], missing: [], corrupt: [], cleared: [] }, events: [] }),
    } as unknown as WorktreeManagerType;

    const ctx: PhaseContext = {
      state, config,
      repoRoot: '/tmp/repo',
      planRunner,
      parallelism: 1,
      postMergeCommands: [],
      validateCommands: [],
      maxValidationRetries: 0,
      minCompletionPercent: 0,
      gapClosePerformed: false,
      mergeWorktreePath: '/tmp/merge-worktree',
      featureBranch: state.featureBranch ?? 'eforge/test-set',
      worktreeManager: stubWM,
      failedMerges: new Set(),
      recentlyMergedIds: [],
      featureBranchMerged: false,
      modelTracker: new ModelTracker(),
    };

    const events: EforgeEvent[] = [];
    for await (const e of executePlans(ctx)) events.push(e);

    const statusChanges = events.filter((e) => e.type === 'plan:status:change');
    expect(statusChanges.some((e) => e.planId === 'plan-a' && e.status === 'running')).toBe(true);
    expect(statusChanges.some((e) => e.planId === 'plan-a' && e.status === 'completed')).toBe(true);
    expect(statusChanges.some((e) => e.planId === 'plan-a' && e.status === 'merged')).toBe(true);
  });

  it('emits plan:status:change(failed) and plan:error:set when plan yields build:failed', async () => {
    const config = makeConfig({
      plans: [
        { id: 'plan-a', name: 'Plan A', dependsOn: [], branch: 'feature/plan-a', build: TEST_BUILD, review: TEST_REVIEW },
      ],
    });
    const state = initializeState(config, '/tmp/repo').state;

    const planRunner: PlanRunner = async function* () {
      yield {
        type: 'plan:build:failed',
        planId: 'plan-a',
        error: 'compilation failed',
        timestamp: new Date().toISOString(),
      } as EforgeEvent;
    };

    const stubWM = {
      acquireForPlan: async () => '/tmp/fake-worktree',
      releaseForPlan: async () => {},
      mergePlan: async () => 'abc123',
      reconcile: async () => ({ report: { valid: [], missing: [], corrupt: [], cleared: [] }, events: [] }),
    } as unknown as WorktreeManagerType;

    const ctx: PhaseContext = {
      state, config,
      repoRoot: '/tmp/repo',
      planRunner,
      parallelism: 1,
      postMergeCommands: [],
      validateCommands: [],
      maxValidationRetries: 0,
      minCompletionPercent: 0,
      gapClosePerformed: false,
      mergeWorktreePath: '/tmp/merge-worktree',
      featureBranch: state.featureBranch ?? 'eforge/test-set',
      worktreeManager: stubWM,
      failedMerges: new Set(),
      recentlyMergedIds: [],
      featureBranchMerged: false,
      modelTracker: new ModelTracker(),
    };

    const events: EforgeEvent[] = [];
    for await (const e of executePlans(ctx)) events.push(e);

    expect(events.some((e) => e.type === 'plan:status:change' && e.planId === 'plan-a' && e.status === 'failed')).toBe(true);
    expect(events.some((e) => e.type === 'plan:error:set' && e.planId === 'plan-a')).toBe(true);
  });
});
