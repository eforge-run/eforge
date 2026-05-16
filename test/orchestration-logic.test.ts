import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { propagateFailure, shouldSkipMerge, computeMaxConcurrency, executePlans, finalize } from '@eforge-build/engine/orchestrator/phases';
import type { PhaseContext } from '@eforge-build/engine/orchestrator/phases';
import type { WorktreeManager } from '@eforge-build/engine/worktree-manager';
import { initializeState, Orchestrator } from '@eforge-build/engine/orchestrator';
import type { PlanRunner } from '@eforge-build/engine/orchestrator';
import type { EforgeState, EforgeEvent, OrchestrationConfig, PlanState } from '@eforge-build/engine/events';
import type { PipelineComposition } from '@eforge-build/engine/schemas';
import { ModelTracker } from '@eforge-build/engine/model-tracker';
import type { PolicyGateKind, PolicyGateMethod, PolicyGateRegistration } from '@eforge-build/engine/extensions/types';
import { useTempDir } from './test-tmpdir.js';

// --- Helpers ---

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
    };
  }
  return {
    setName: 'test-set',
    status: 'running',
    startedAt: '2026-01-01T00:00:00Z',
    baseBranch: 'main',
    featureBranch: overrides?.featureBranch ?? 'eforge/test-set',
    worktreeBase: '/tmp/worktrees',
    plans: fullPlans,
    completedPlans: [],
    ...overrides,
  };
}

const TEST_REVIEW = { strategy: 'auto' as const, perspectives: ['code'], maxRounds: 1, evaluatorStrictness: 'standard' as const };
const TEST_BUILD = ['implement', 'review-cycle'];

// --- eforge:region plan-02-policy-gate-engine-integration ---
function makePolicyGate(
  gateKind: PolicyGateKind,
  method: PolicyGateMethod,
  value: PolicyGateRegistration['value'],
): PolicyGateRegistration {
  return {
    kind: 'policyGate',
    extensionName: 'test-policy',
    extensionPath: '/tmp/test-policy.js',
    value,
    gateKind,
    method,
    registrationIndex: 0,
  };
}
// --- eforge:endregion plan-02-policy-gate-engine-integration ---

function makePlans(
  specs: Array<{ id: string; dependsOn?: string[] }>,
): OrchestrationConfig['plans'] {
  return specs.map((s) => ({
    id: s.id,
    name: s.id,
    dependsOn: s.dependsOn ?? [],
    branch: `feature/${s.id}`,
    build: TEST_BUILD,
    review: TEST_REVIEW,
  }));
}

// --- Tests ---

describe('propagateFailure', () => {
  it('does nothing when failed plan has no dependents', () => {
    const state = makeState({
      a: { status: 'failed' },
      b: { status: 'pending' },
    });
    const plans = makePlans([
      { id: 'a' },
      { id: 'b' },
    ]);

    const events = propagateFailure(state, 'a', plans);

    expect(state.plans['b'].status).toBe('pending');
    expect(events).toHaveLength(0);
  });

  it('blocks a single direct dependent', () => {
    const state = makeState({
      a: { status: 'failed' },
      b: { status: 'pending', dependsOn: ['a'] },
    });
    const plans = makePlans([
      { id: 'a' },
      { id: 'b', dependsOn: ['a'] },
    ]);

    const events = propagateFailure(state, 'a', plans);

    expect(state.plans['b'].status).toBe('blocked');
    expect(state.plans['b'].error).toContain('a');
    // 3 events per blocked plan: plan:status:change, plan:error:set, plan:build:failed
    expect(events).toHaveLength(3);
    expect(events.some((e) => e.type === 'plan:status:change' && e.planId === 'b' && e.status === 'blocked')).toBe(true);
    expect(events.some((e) => e.type === 'plan:error:set' && e.planId === 'b')).toBe(true);
    expect(events.some((e) => e.type === 'plan:build:failed' && e.planId === 'b')).toBe(true);
  });

  it('blocks transitive chain A→B→C', () => {
    const state = makeState({
      a: { status: 'failed' },
      b: { status: 'pending', dependsOn: ['a'] },
      c: { status: 'pending', dependsOn: ['b'] },
    });
    const plans = makePlans([
      { id: 'a' },
      { id: 'b', dependsOn: ['a'] },
      { id: 'c', dependsOn: ['b'] },
    ]);

    const events = propagateFailure(state, 'a', plans);

    expect(state.plans['b'].status).toBe('blocked');
    expect(state.plans['c'].status).toBe('blocked');
    // 3 events per blocked plan (plan:status:change, plan:error:set, plan:build:failed)
    expect(events).toHaveLength(6);
  });

  it('blocks diamond A→{B,C}→D (D reached once)', () => {
    const state = makeState({
      a: { status: 'failed' },
      b: { status: 'pending', dependsOn: ['a'] },
      c: { status: 'pending', dependsOn: ['a'] },
      d: { status: 'pending', dependsOn: ['b', 'c'] },
    });
    const plans = makePlans([
      { id: 'a' },
      { id: 'b', dependsOn: ['a'] },
      { id: 'c', dependsOn: ['a'] },
      { id: 'd', dependsOn: ['b', 'c'] },
    ]);

    const events = propagateFailure(state, 'a', plans);

    expect(state.plans['b'].status).toBe('blocked');
    expect(state.plans['c'].status).toBe('blocked');
    expect(state.plans['d'].status).toBe('blocked');
    // 3 events per blocked plan: b, c, d (d only once due to visited set)
    expect(events).toHaveLength(9);
  });

  it('skips completed dependents', () => {
    const state = makeState({
      a: { status: 'failed' },
      b: { status: 'completed', dependsOn: ['a'] },
    });
    const plans = makePlans([
      { id: 'a' },
      { id: 'b', dependsOn: ['a'] },
    ]);

    const events = propagateFailure(state, 'a', plans);

    expect(state.plans['b'].status).toBe('completed');
    expect(events).toHaveLength(0);
  });

  it('skips merged dependents', () => {
    const state = makeState({
      a: { status: 'failed' },
      b: { status: 'merged', dependsOn: ['a'], merged: true },
    });
    const plans = makePlans([
      { id: 'a' },
      { id: 'b', dependsOn: ['a'] },
    ]);

    const events = propagateFailure(state, 'a', plans);

    expect(state.plans['b'].status).toBe('merged');
    expect(events).toHaveLength(0);
  });

  it('blocks multiple direct dependents and their transitive deps', () => {
    const state = makeState({
      a: { status: 'failed' },
      b: { status: 'pending', dependsOn: ['a'] },
      c: { status: 'pending', dependsOn: ['a'] },
      d: { status: 'pending', dependsOn: ['b'] },
    });
    const plans = makePlans([
      { id: 'a' },
      { id: 'b', dependsOn: ['a'] },
      { id: 'c', dependsOn: ['a'] },
      { id: 'd', dependsOn: ['b'] },
    ]);

    const events = propagateFailure(state, 'a', plans);

    expect(state.plans['b'].status).toBe('blocked');
    expect(state.plans['c'].status).toBe('blocked');
    expect(state.plans['d'].status).toBe('blocked');
    // 3 events per blocked plan: b, c, d
    expect(events).toHaveLength(9);
  });
});

describe('shouldSkipMerge', () => {
  it('returns null when no dependencies failed', () => {
    const plans = makePlans([{ id: 'a' }, { id: 'b', dependsOn: ['a'] }]);
    expect(shouldSkipMerge('b', plans, new Set())).toBeNull();
  });

  it('returns skip reason when a direct dependency failed', () => {
    const plans = makePlans([{ id: 'a' }, { id: 'b', dependsOn: ['a'] }]);
    const result = shouldSkipMerge('b', plans, new Set(['a']));
    expect(result).toBeTypeOf('string');
    expect(result).toContain('a');
  });

  it('returns null when dependencies exist but none are in the failed set', () => {
    const plans = makePlans([{ id: 'a' }, { id: 'b' }, { id: 'c', dependsOn: ['a', 'b'] }]);
    expect(shouldSkipMerge('c', plans, new Set())).toBeNull();
  });

  it('cascades through transitive dependencies via accumulated failedMerges', () => {
    const plans = makePlans([
      { id: 'a' },
      { id: 'b', dependsOn: ['a'] },
      { id: 'c', dependsOn: ['b'] },
    ]);
    const failedMerges = new Set<string>();

    // a fails to merge
    failedMerges.add('a');

    // b is skipped because a failed — caller adds b to failedMerges
    const skipB = shouldSkipMerge('b', plans, failedMerges);
    expect(skipB).toBeTypeOf('string');
    failedMerges.add('b');

    // c is skipped because b is now in failedMerges
    const skipC = shouldSkipMerge('c', plans, failedMerges);
    expect(skipC).toBeTypeOf('string');
    expect(skipC).toContain('b');
  });

  it('returns null for unknown plan ID', () => {
    const plans = makePlans([{ id: 'a' }]);
    expect(shouldSkipMerge('nonexistent', plans, new Set(['a']))).toBeNull();
  });
});

describe('computeMaxConcurrency', () => {
  it('returns 0 for empty plans', () => {
    expect(computeMaxConcurrency([])).toBe(0);
  });

  it('returns 1 for a single plan with no dependencies', () => {
    const plans = makePlans([{ id: 'a' }]);
    expect(computeMaxConcurrency(plans)).toBe(1);
  });

  it('returns 1 for a linear chain (A -> B -> C)', () => {
    const plans = makePlans([
      { id: 'a' },
      { id: 'b', dependsOn: ['a'] },
      { id: 'c', dependsOn: ['b'] },
    ]);
    expect(computeMaxConcurrency(plans)).toBe(1);
  });

  it('returns 2 for two independent plans', () => {
    const plans = makePlans([
      { id: 'a' },
      { id: 'b' },
    ]);
    expect(computeMaxConcurrency(plans)).toBe(2);
  });

  it('returns 2 for a diamond graph (A -> B, A -> C, B -> D, C -> D)', () => {
    const plans = makePlans([
      { id: 'a' },
      { id: 'b', dependsOn: ['a'] },
      { id: 'c', dependsOn: ['a'] },
      { id: 'd', dependsOn: ['b', 'c'] },
    ]);
    expect(computeMaxConcurrency(plans)).toBe(2);
  });

  it('returns 3 for three independent plans', () => {
    const plans = makePlans([
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
    ]);
    expect(computeMaxConcurrency(plans)).toBe(3);
  });

  it('returns correct max for mixed independence and deps', () => {
    // Wave 0: a, b, c (3 plans)
    // Wave 1: d (depends on a), e (depends on b) (2 plans)
    const plans = makePlans([
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
      { id: 'd', dependsOn: ['a'] },
      { id: 'e', dependsOn: ['b'] },
    ]);
    expect(computeMaxConcurrency(plans)).toBe(3);
  });
});

describe('executePlans - build:failed handling', () => {
  const makeTempDir = useTempDir();

  it('marks plan as failed and blocks dependents when build:failed is yielded', async () => {
    const config = makeConfig({
      plans: [
        { id: 'plan-a', name: 'Plan A', dependsOn: [], branch: 'feature/plan-a', build: TEST_BUILD, review: TEST_REVIEW },
        { id: 'plan-b', name: 'Plan B', dependsOn: ['plan-a'], branch: 'feature/plan-b', build: TEST_BUILD, review: TEST_REVIEW },
      ],
    });

    const state = initializeState(config, '/tmp/repo').state;

    // Stub PlanRunner: plan-a yields build:failed, plan-b yields nothing
    const planRunner: PlanRunner = async function* (planId) {
      if (planId === 'plan-a') {
        yield { type: 'plan:build:failed', planId: 'plan-a', error: 'JSON parse error', timestamp: new Date().toISOString() } as EforgeEvent;
      }
    };

    // Stub WorktreeManager
    const stubWorktreeManager = {
      acquireForPlan: async () => '/tmp/fake-worktree',
      releaseForPlan: async () => {},
      mergePlan: async () => 'abc123',
      reconcile: async () => ({ valid: [], recovered: [], orphaned: [] }),
    } as unknown as WorktreeManager;

    const ctx: PhaseContext = {
      state,
      config,
      repoRoot: '/tmp/repo',
      planRunner,
      parallelism: 1,
      postMergeCommands: [],
      validateCommands: [],
      maxValidationRetries: 0,
      minCompletionPercent: 0,
      gapClosePerformed: false,
      mergeWorktreePath: '/tmp/merge-worktree',
      featureBranch: state.featureBranch,
      worktreeManager: stubWorktreeManager,
      failedMerges: new Set(),
      recentlyMergedIds: [],
      featureBranchMerged: false,
      modelTracker: new ModelTracker(),
    };

    const events: EforgeEvent[] = [];
    for await (const event of executePlans(ctx)) {
      events.push(event);
    }
    for await (const event of finalize(ctx)) {
      events.push(event);
    }

    // plan-a should be failed
    expect(state.plans['plan-a'].status).toBe('failed');
    // plan-b should be blocked (transitive dependent of failed plan-a)
    expect(state.plans['plan-b'].status).toBe('blocked');
    // No merge events should have been emitted
    expect(events.some((e) => e.type === 'plan:merge:start')).toBe(false);
    expect(events.some((e) => e.type === 'plan:merge:complete')).toBe(false);
    // A build:failed event for plan-a should be present
    expect(events.some((e) => e.type === 'plan:build:failed' && e.planId === 'plan-a')).toBe(true);
    // Overall build status should be failed
    expect(state.status).toBe('failed');
  });

  // --- eforge:region plan-02-policy-gate-engine-integration ---
  it('blocks plan merge before mergePlan and propagates dependent failures', async () => {
    const config = makeConfig({
      plans: [
        { id: 'plan-a', name: 'Plan A', dependsOn: [], branch: 'feature/plan-a', build: TEST_BUILD, review: TEST_REVIEW },
        { id: 'plan-b', name: 'Plan B', dependsOn: ['plan-a'], branch: 'feature/plan-b', build: TEST_BUILD, review: TEST_REVIEW },
      ],
    });
    const state = initializeState(config, '/tmp/repo').state;
    let mergePlanCalls = 0;
    let getPlanDiffCalls = 0;
    let seenPolicyContext: { planId?: string; diff?: { files: Array<{ path: string; status: string }> } } | undefined;

    const planRunner: PlanRunner = async function* () {};
    const stubWorktreeManager = {
      acquireForPlan: async () => '/tmp/fake-worktree',
      releaseForPlan: async () => {},
      getPlanDiff: async () => {
        getPlanDiffCalls++;
        return { files: [{ path: 'blocked.ts', status: 'modified' as const }] };
      },
      mergePlan: async () => { mergePlanCalls++; throw new Error('mergePlan must not be called'); },
    } as unknown as WorktreeManager;

    const ctx: PhaseContext = {
      state,
      config,
      repoRoot: '/tmp/repo',
      planRunner,
      parallelism: 1,
      postMergeCommands: [],
      validateCommands: [],
      maxValidationRetries: 0,
      minCompletionPercent: 0,
      gapClosePerformed: false,
      mergeWorktreePath: '/tmp/merge-worktree',
      featureBranch: state.featureBranch,
      worktreeManager: stubWorktreeManager,
      failedMerges: new Set(),
      recentlyMergedIds: [],
      featureBranchMerged: false,
      modelTracker: new ModelTracker(),
      extensionRegistry: {
        policyGates: [makePolicyGate('plan-merge', 'beforePlanMerge', ((gateContext: unknown) => {
          seenPolicyContext = gateContext as typeof seenPolicyContext;
          return { decision: 'block', reason: 'protected paths changed' };
        }) as PolicyGateRegistration['value'])],
      },
      policyGateTimeoutMs: 5000,
      policyGateFailurePolicy: 'fail-closed',
    };

    const events: EforgeEvent[] = [];
    for await (const event of executePlans(ctx)) events.push(event);

    expect(getPlanDiffCalls).toBe(1);
    expect(seenPolicyContext).toEqual(expect.objectContaining({
      planId: 'plan-a',
      diff: { files: [{ path: 'blocked.ts', status: 'modified' }] },
    }));
    expect(mergePlanCalls).toBe(0);
    expect(ctx.failedMerges.has('plan-a')).toBe(true);
    expect(state.plans['plan-a'].status).toBe('failed');
    expect(state.plans['plan-b'].status).toBe('blocked');
    expect(events).toContainEqual(expect.objectContaining({
      type: 'extension:policy:decision',
      gateKind: 'plan-merge',
      planId: 'plan-a',
      decision: 'block',
      reason: 'protected paths changed',
    }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'plan:build:failed', planId: 'plan-a', error: expect.stringContaining('protected paths changed') }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'plan:build:failed', planId: 'plan-b', error: expect.stringContaining('plan-a') }));
  });

  it('blocks final merge before mergeToBase and marks final state failed', async () => {
    const repoRoot = makeTempDir();
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoRoot });

    const config = makeConfig({
      plans: [
        { id: 'plan-a', name: 'Plan A', dependsOn: [], branch: 'feature/plan-a', build: TEST_BUILD, review: TEST_REVIEW },
      ],
    });
    const state = initializeState(config, repoRoot).state;
    state.plans['plan-a'].status = 'merged';
    state.plans['plan-a'].merged = true;
    let mergeToBaseCalls = 0;
    let getFinalMergeDiffCalls = 0;
    let seenPolicyContext: { featureBranch?: string; baseBranch?: string; planIds?: string[]; diff?: { files: Array<{ path: string; status: string }> } } | undefined;

    const stubWorktreeManager = {
      getFinalMergeDiff: async () => {
        getFinalMergeDiffCalls++;
        return { files: [{ path: 'blocked.ts', status: 'modified' as const }] };
      },
      mergeToBase: async () => { mergeToBaseCalls++; throw new Error('mergeToBase must not be called'); },
    } as unknown as WorktreeManager;

    const ctx: PhaseContext = {
      state,
      config,
      repoRoot,
      planRunner: async function* () {},
      parallelism: 1,
      postMergeCommands: [],
      validateCommands: [],
      maxValidationRetries: 0,
      minCompletionPercent: 0,
      gapClosePerformed: false,
      mergeWorktreePath: '/tmp/merge-worktree',
      featureBranch: state.featureBranch,
      worktreeManager: stubWorktreeManager,
      failedMerges: new Set(),
      recentlyMergedIds: ['plan-a'],
      featureBranchMerged: false,
      modelTracker: new ModelTracker(),
      extensionRegistry: {
        policyGates: [makePolicyGate('final-merge', 'beforeFinalMerge', ((gateContext: unknown) => {
          seenPolicyContext = gateContext as typeof seenPolicyContext;
          return { decision: 'require-approval', reason: 'manual approval required' };
        }) as PolicyGateRegistration['value'])],
      },
      policyGateTimeoutMs: 5000,
      policyGateFailurePolicy: 'fail-closed',
    };

    const events: EforgeEvent[] = [];
    for await (const event of finalize(ctx)) events.push(event);

    expect(getFinalMergeDiffCalls).toBe(1);
    expect(seenPolicyContext).toEqual(expect.objectContaining({
      featureBranch: state.featureBranch,
      baseBranch: 'main',
      planIds: ['plan-a'],
      diff: { files: [{ path: 'blocked.ts', status: 'modified' }] },
    }));
    expect(mergeToBaseCalls).toBe(0);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'extension:policy:decision',
      gateKind: 'final-merge',
      featureBranch: state.featureBranch,
      baseBranch: 'main',
      decision: 'require-approval',
      reason: 'manual approval required',
    }));
    expect(events.filter((event) => event.type === 'merge:finalize:skipped')).toEqual([
      expect.objectContaining({ reason: expect.stringContaining('manual approval required') }),
    ]);
    expect(state.status).toBe('failed');
  });
  // --- eforge:endregion plan-02-policy-gate-engine-integration ---

  it('promotes plan failure to run-level state.status without requiring finalize', async () => {
    // Regression: after the throw->stream switch for build:failed, executePlans
    // must itself mark state.status='failed' so prdValidate/validate guards in
    // orchestrator.ts short-circuit before finalize runs.
    const config = makeConfig({
      plans: [
        { id: 'plan-a', name: 'Plan A', dependsOn: [], branch: 'feature/plan-a', build: TEST_BUILD, review: TEST_REVIEW },
      ],
    });

    const state = initializeState(config, '/tmp/repo').state;

    const planRunner: PlanRunner = async function* () {
      yield { type: 'plan:build:failed', planId: 'plan-a', error: 'max turns', timestamp: new Date().toISOString() } as EforgeEvent;
    };

    const stubWorktreeManager = {
      acquireForPlan: async () => '/tmp/fake-worktree',
      releaseForPlan: async () => {},
      mergePlan: async () => 'abc123',
      reconcile: async () => ({ valid: [], recovered: [], orphaned: [] }),
    } as unknown as WorktreeManager;

    const ctx: PhaseContext = {
      state,
      config,
      repoRoot: '/tmp/repo',
      planRunner,
      parallelism: 1,
      postMergeCommands: [],
      validateCommands: [],
      maxValidationRetries: 0,
      minCompletionPercent: 0,
      gapClosePerformed: false,
      mergeWorktreePath: '/tmp/merge-worktree',
      featureBranch: state.featureBranch,
      worktreeManager: stubWorktreeManager,
      failedMerges: new Set(),
      recentlyMergedIds: [],
      featureBranchMerged: false,
      modelTracker: new ModelTracker(),
    };

    for await (const _event of executePlans(ctx)) {
      // drain
    }

    // Without calling finalize, state.status must already be 'failed'.
    expect(state.status).toBe('failed');
    expect(state.completedAt).toBeDefined();
  });
});

// --- initializeState helpers ---

const TEST_PIPELINE: PipelineComposition = {
  scope: 'excursion',
  compile: ['planner', 'plan-review-cycle'],
  defaultBuild: ['implement', 'review-cycle'],
  defaultReview: TEST_REVIEW,
  rationale: 'test pipeline',
};

function makeConfig(
  overrides?: Partial<OrchestrationConfig>,
): OrchestrationConfig {
  return {
    name: 'test-set',
    description: 'test',
    created: '2026-01-01T00:00:00Z',
    mode: 'excursion',
    baseBranch: 'main',
    pipeline: TEST_PIPELINE,
    plans: [
      { id: 'plan-a', name: 'Plan A', dependsOn: [], branch: 'feature/plan-a', build: TEST_BUILD, review: TEST_REVIEW },
      { id: 'plan-b', name: 'Plan B', dependsOn: ['plan-a'], branch: 'feature/plan-b', build: TEST_BUILD, review: TEST_REVIEW },
    ],
    ...overrides,
  };
}

describe('initializeState', () => {
  it('creates fresh state when no existing state', () => {
    const config = makeConfig();
    const { state } = initializeState(config, '/tmp/repo');

    expect(state.status).toBe('running');
    expect(state.setName).toBe('test-set');
    expect(state.plans['plan-a'].status).toBe('pending');
    expect(state.plans['plan-b'].status).toBe('pending');
  });

  it('initializes featureBranch from config name', () => {
    const config = makeConfig({ name: 'my-feature' });
    const { state } = initializeState(config, '/tmp/repo');

    expect(state.featureBranch).toBe('eforge/my-feature');
  });

  it('always creates fresh state regardless of prior invocations', () => {
    const config = makeConfig();

    // First invocation
    const { state: state1 } = initializeState(config, '/tmp/repo');
    expect(state1.status).toBe('running');

    // Second invocation returns independent fresh state
    const { state: state2 } = initializeState(config, '/tmp/repo');
    expect(state2.status).toBe('running');

    // States are independent objects
    expect(state1).not.toBe(state2);
  });
});

describe('executePlans - ModelTracker recording', () => {
  const makeTempDir = useTempDir();

  it('records agent:start models from planRunner stream into ctx.modelTracker', async () => {
    const config = makeConfig({
      plans: [
        { id: 'plan-a', name: 'Plan A', dependsOn: [], branch: 'feature/plan-a', build: TEST_BUILD, review: TEST_REVIEW },
      ],
    });

    const state = initializeState(config, '/tmp/repo').state;

    // PlanRunner that emits three agent:start events: A, B, A (A is duplicated)
    const planRunner: PlanRunner = async function* () {
      yield { type: 'agent:start', planId: 'plan-a', agentId: 'agent-1', agent: 'builder' as const, model: 'A', backend: 'test', timestamp: new Date().toISOString() } as EforgeEvent;
      yield { type: 'agent:start', planId: 'plan-a', agentId: 'agent-2', agent: 'builder' as const, model: 'B', backend: 'test', timestamp: new Date().toISOString() } as EforgeEvent;
      yield { type: 'agent:start', planId: 'plan-a', agentId: 'agent-3', agent: 'builder' as const, model: 'A', backend: 'test', timestamp: new Date().toISOString() } as EforgeEvent;
    };

    const stubWorktreeManager = {
      acquireForPlan: async () => '/tmp/fake-worktree',
      releaseForPlan: async () => {},
      mergePlan: async () => 'abc123',
      reconcile: async () => ({ valid: [], recovered: [], orphaned: [] }),
    } as unknown as WorktreeManager;

    const modelTracker = new ModelTracker();
    const ctx: PhaseContext = {
      state,
      config,
      repoRoot: '/tmp/repo',
      planRunner,
      parallelism: 1,
      postMergeCommands: [],
      validateCommands: [],
      maxValidationRetries: 0,
      minCompletionPercent: 0,
      gapClosePerformed: false,
      mergeWorktreePath: '/tmp/merge-worktree',
      featureBranch: state.featureBranch,
      worktreeManager: stubWorktreeManager,
      failedMerges: new Set(),
      recentlyMergedIds: [],
      featureBranchMerged: false,
      modelTracker,
    };

    for await (const _event of executePlans(ctx)) {
      // drain all events
    }

    // Three agent:start events emitted: A, B, A — should deduplicate to 2 unique models
    expect(ctx.modelTracker.size).toBe(2);
    expect(ctx.modelTracker.toTrailer()).toBe('Models-Used: A, B');
  });

  it('isolates per-plan trackers across multiple plans', async () => {
    const config = makeConfig({
      plans: [
        { id: 'plan-a', name: 'Plan A', dependsOn: [], branch: 'feature/plan-a', build: TEST_BUILD, review: TEST_REVIEW },
        { id: 'plan-b', name: 'Plan B', dependsOn: ['plan-a'], branch: 'feature/plan-b', build: TEST_BUILD, review: TEST_REVIEW },
      ],
    });

    const state = initializeState(config, '/tmp/repo').state;

    // plan-a uses model X, plan-b uses model Y — each plan should have its own tracker
    const mergedPlanTrackers: Record<string, ModelTracker | undefined> = {};

    const planRunner: PlanRunner = async function* (planId) {
      const model = planId === 'plan-a' ? 'model-X' : 'model-Y';
      yield { type: 'agent:start', planId, agentId: `agent-${planId}`, agent: 'builder' as const, model, backend: 'test', timestamp: new Date().toISOString() } as EforgeEvent;
    };

    const stubWorktreeManager = {
      acquireForPlan: async () => '/tmp/fake-worktree',
      releaseForPlan: async () => {},
      mergePlan: async (planId: string, _plan: unknown, opts: { modelTracker?: ModelTracker }) => {
        mergedPlanTrackers[planId] = opts.modelTracker;
        return 'abc123';
      },
      reconcile: async () => ({ valid: [], recovered: [], orphaned: [] }),
    } as unknown as WorktreeManager;

    const modelTracker = new ModelTracker();
    const ctx: PhaseContext = {
      state,
      config,
      repoRoot: '/tmp/repo',
      planRunner,
      parallelism: 1,
      postMergeCommands: [],
      validateCommands: [],
      maxValidationRetries: 0,
      minCompletionPercent: 0,
      gapClosePerformed: false,
      mergeWorktreePath: '/tmp/merge-worktree',
      featureBranch: state.featureBranch,
      worktreeManager: stubWorktreeManager,
      failedMerges: new Set(),
      recentlyMergedIds: [],
      featureBranchMerged: false,
      modelTracker,
    };

    for await (const _event of executePlans(ctx)) {
      // drain
    }

    // Per-plan trackers should be isolated
    expect(mergedPlanTrackers['plan-a']?.size).toBe(1);
    expect(mergedPlanTrackers['plan-a']?.has('model-X')).toBe(true);
    expect(mergedPlanTrackers['plan-a']?.has('model-Y')).toBe(false);

    expect(mergedPlanTrackers['plan-b']?.size).toBe(1);
    expect(mergedPlanTrackers['plan-b']?.has('model-Y')).toBe(true);
    expect(mergedPlanTrackers['plan-b']?.has('model-X')).toBe(false);

    // Shared ctx.modelTracker should have the union
    expect(ctx.modelTracker.size).toBe(2);
    expect(ctx.modelTracker.has('model-X')).toBe(true);
    expect(ctx.modelTracker.has('model-Y')).toBe(true);
  });
});

describe('initializeState — concurrent execution isolation', () => {
  const makeTempDir = useTempDir();

  it('two concurrent plan sets produce independent in-memory state without throwing', async () => {
    const repoRoot = makeTempDir();

    const configA = makeConfig({
      name: 'set-a',
      plans: [
        { id: 'plan-a1', name: 'Plan A1', dependsOn: [], branch: 'feature/plan-a1', build: TEST_BUILD, review: TEST_REVIEW },
      ],
    });
    const configB = makeConfig({
      name: 'set-b',
      plans: [
        { id: 'plan-b1', name: 'Plan B1', dependsOn: [], branch: 'feature/plan-b1', build: TEST_BUILD, review: TEST_REVIEW },
      ],
    });

    // Both calls should succeed without throwing (no setName-mismatch error)
    const [resultA, resultB] = await Promise.all([
      Promise.resolve(initializeState(configA, repoRoot)),
      Promise.resolve(initializeState(configB, repoRoot)),
    ]);

    // Each should have its own setName
    expect(resultA.state.setName).toBe('set-a');
    expect(resultB.state.setName).toBe('set-b');

    // States are independent in-memory objects
    expect(resultA.state).not.toBe(resultB.state);
    expect(resultA.state.featureBranch).toBe('eforge/set-a');
    expect(resultB.state.featureBranch).toBe('eforge/set-b');

    // Neither singleton file should have been written to disk — both were
    // removed as part of this plan, not just state.json.
    expect(existsSync(join(repoRoot, '.eforge', 'state.json'))).toBe(false);
    expect(existsSync(join(repoRoot, '.eforge', 'event-log.jsonl'))).toBe(false);
  });

  it('two concurrent Orchestrator.execute() calls produce independent events without writing singleton files', async () => {
    const repoRoot = makeTempDir();

    // Set up a minimal git repo with the feature branches both orchestrators need
    const gitOpts = { cwd: repoRoot };
    execFileSync('git', ['init', '-b', 'main'], gitOpts);
    execFileSync('git', ['config', 'user.email', 'test@test.com'], gitOpts);
    execFileSync('git', ['config', 'user.name', 'Test'], gitOpts);
    execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], gitOpts);
    execFileSync('git', ['checkout', '-b', 'eforge/set-a'], gitOpts);
    execFileSync('git', ['checkout', 'main'], gitOpts);
    execFileSync('git', ['checkout', '-b', 'eforge/set-b'], gitOpts);
    execFileSync('git', ['checkout', 'main'], gitOpts);

    // Pre-abort the signal so validate/finalize skip git merge operations
    const ac = new AbortController();
    ac.abort();

    const stubPlanRunner: PlanRunner = async function* () {};

    // Empty plan lists so executePlans terminates immediately without worktree ops
    const configA = makeConfig({ name: 'set-a', plans: [] });
    const configB = makeConfig({ name: 'set-b', plans: [] });

    const orchA = new Orchestrator({ repoRoot, planRunner: stubPlanRunner, signal: ac.signal, mergeWorktreePath: join(repoRoot, 'merge-a') });
    const orchB = new Orchestrator({ repoRoot, planRunner: stubPlanRunner, signal: ac.signal, mergeWorktreePath: join(repoRoot, 'merge-b') });

    const eventsA: EforgeEvent[] = [];
    const eventsB: EforgeEvent[] = [];

    await Promise.all([
      (async () => { for await (const e of orchA.execute(configA)) eventsA.push(e); })(),
      (async () => { for await (const e of orchB.execute(configB)) eventsB.push(e); })(),
    ]);

    // Singleton files must not have been written — the execute() finally block
    // must not re-introduce saveState() or event-log writes
    expect(existsSync(join(repoRoot, '.eforge', 'state.json'))).toBe(false);
    expect(existsSync(join(repoRoot, '.eforge', 'event-log.jsonl'))).toBe(false);

    // Each run should have emitted its own schedule:start event
    expect(eventsA.some((e) => e.type === 'schedule:start')).toBe(true);
    expect(eventsB.some((e) => e.type === 'schedule:start')).toBe(true);
  });
});
