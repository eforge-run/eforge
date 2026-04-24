import { describe, it, expect } from 'vitest';
import { propagateFailure, shouldSkipMerge, computeMaxConcurrency, executePlans, finalize } from '@eforge-build/engine/orchestrator/phases';
import type { PhaseContext } from '@eforge-build/engine/orchestrator/phases';
import type { WorktreeManager } from '@eforge-build/engine/worktree-manager';
import { resumeState } from '@eforge-build/engine/orchestrator/plan-lifecycle';
import { initializeState } from '@eforge-build/engine/orchestrator';
import type { PlanRunner } from '@eforge-build/engine/orchestrator';
import { saveState } from '@eforge-build/engine/state';
import type { EforgeState, EforgeEvent, OrchestrationConfig, PlanState } from '@eforge-build/engine/events';
import type { PipelineComposition } from '@eforge-build/engine/schemas';
import { ModelTracker } from '@eforge-build/engine/model-tracker';
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
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'plan:build:failed', planId: 'b' });
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
    expect(events).toHaveLength(2);
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
    // 3 events: b, c, d (d only once due to visited set)
    expect(events).toHaveLength(3);
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
    expect(events).toHaveLength(3);
  });
});

describe('resumeState', () => {
  it('resets running plans to pending', () => {
    const state = makeState({
      a: { status: 'running' },
      b: { status: 'pending' },
    });

    resumeState(state);

    expect(state.plans['a'].status).toBe('pending');
    expect(state.plans['b'].status).toBe('pending');
  });

  it('leaves completed plans untouched', () => {
    const state = makeState({
      a: { status: 'completed' },
    });

    resumeState(state);

    expect(state.plans['a'].status).toBe('completed');
  });

  it('leaves failed plans untouched', () => {
    const state = makeState({
      a: { status: 'failed' },
    });

    resumeState(state);

    expect(state.plans['a'].status).toBe('failed');
  });

  it('unblocks plan when all deps are resolved', () => {
    const state = makeState({
      a: { status: 'completed' },
      b: { status: 'blocked', dependsOn: ['a'] },
    });

    resumeState(state);

    expect(state.plans['b'].status).toBe('pending');
  });

  it('keeps plan blocked when deps are not resolved', () => {
    const state = makeState({
      a: { status: 'failed' },
      b: { status: 'blocked', dependsOn: ['a'] },
    });

    resumeState(state);

    expect(state.plans['b'].status).toBe('blocked');
  });

  it('keeps plan blocked with partial dep resolution', () => {
    const state = makeState({
      a: { status: 'merged', merged: true },
      b: { status: 'failed' },
      c: { status: 'blocked', dependsOn: ['a', 'b'] },
    });

    resumeState(state);

    expect(state.plans['c'].status).toBe('blocked');
  });

  it('leaves completed-but-unmerged plans as completed for re-merge on resume', () => {
    const state = makeState({
      a: { status: 'merged', merged: true },
      b: { status: 'completed', dependsOn: [] },
      c: { status: 'running', dependsOn: ['a', 'b'] },
    });

    resumeState(state);

    expect(state.plans['b'].status).toBe('completed');
    expect(state.plans['c'].status).toBe('pending');
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
    const stateDir = makeTempDir();
    const config = makeConfig({
      plans: [
        { id: 'plan-a', name: 'Plan A', dependsOn: [], branch: 'feature/plan-a', build: TEST_BUILD, review: TEST_REVIEW },
        { id: 'plan-b', name: 'Plan B', dependsOn: ['plan-a'], branch: 'feature/plan-b', build: TEST_BUILD, review: TEST_REVIEW },
      ],
    });

    const state = initializeState(stateDir, config, '/tmp/repo').state;

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
      stateDir,
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
      resumed: false,
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

  it('promotes plan failure to run-level state.status without requiring finalize', async () => {
    // Regression: after the throw->stream switch for build:failed, executePlans
    // must itself mark state.status='failed' so prdValidate/validate guards in
    // orchestrator.ts short-circuit before finalize runs.
    const stateDir = makeTempDir();
    const config = makeConfig({
      plans: [
        { id: 'plan-a', name: 'Plan A', dependsOn: [], branch: 'feature/plan-a', build: TEST_BUILD, review: TEST_REVIEW },
      ],
    });

    const state = initializeState(stateDir, config, '/tmp/repo').state;

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
      stateDir,
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
      resumed: false,
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
  const makeTempDir = useTempDir();

  it('creates fresh state when no existing state', () => {
    const stateDir = makeTempDir();
    const config = makeConfig();
    const { state } = initializeState(stateDir, config, '/tmp/repo');

    expect(state.status).toBe('running');
    expect(state.setName).toBe('test-set');
    expect(state.plans['plan-a'].status).toBe('pending');
    expect(state.plans['plan-b'].status).toBe('pending');
  });

  it('initializes featureBranch from config name', () => {
    const stateDir = makeTempDir();
    const config = makeConfig({ name: 'my-feature' });
    const { state } = initializeState(stateDir, config, '/tmp/repo');

    expect(state.featureBranch).toBe('eforge/my-feature');
  });

  it('creates fresh state when existing is failed', () => {
    const stateDir = makeTempDir();
    const config = makeConfig();

    // Seed a failed state
    const failedState: EforgeState = {
      setName: 'test-set',
      status: 'failed',
      startedAt: '2026-01-01T00:00:00Z',
      baseBranch: 'main',
      worktreeBase: '/old/worktrees',
      plans: {
        'plan-a': { status: 'failed', branch: 'feature/plan-a', dependsOn: [], merged: false, error: 'boom' },
        'plan-b': { status: 'blocked', branch: 'feature/plan-b', dependsOn: ['plan-a'], merged: false },
      },
      completedPlans: [],
    };
    saveState(stateDir, failedState);

    const { state } = initializeState(stateDir, config, '/tmp/repo');

    expect(state.status).toBe('running');
    expect(state.plans['plan-a'].status).toBe('pending');
    expect(state.plans['plan-b'].status).toBe('pending');
  });

  it('creates fresh state when existing is completed', () => {
    const stateDir = makeTempDir();
    const config = makeConfig();

    // Seed a completed state
    const completedState: EforgeState = {
      setName: 'test-set',
      status: 'completed',
      startedAt: '2026-01-01T00:00:00Z',
      completedAt: '2026-01-01T01:00:00Z',
      baseBranch: 'main',
      worktreeBase: '/old/worktrees',
      plans: {
        'plan-a': { status: 'merged', branch: 'feature/plan-a', dependsOn: [], merged: true },
        'plan-b': { status: 'merged', branch: 'feature/plan-b', dependsOn: ['plan-a'], merged: true },
      },
      completedPlans: ['plan-a', 'plan-b'],
    };
    saveState(stateDir, completedState);

    const { state } = initializeState(stateDir, config, '/tmp/repo');

    expect(state.status).toBe('running');
    expect(state.plans['plan-a'].status).toBe('pending');
    expect(state.plans['plan-b'].status).toBe('pending');
  });

  it('resumes when existing state is resumable', () => {
    const stateDir = makeTempDir();
    const config = makeConfig();

    // Seed a resumable state (running with incomplete plans)
    const resumableState: EforgeState = {
      setName: 'test-set',
      status: 'running',
      startedAt: '2026-01-01T00:00:00Z',
      baseBranch: 'main',
      worktreeBase: '/old/worktrees',
      plans: {
        'plan-a': { status: 'completed', branch: 'feature/plan-a', dependsOn: [], merged: false },
        'plan-b': { status: 'pending', branch: 'feature/plan-b', dependsOn: ['plan-a'], merged: false },
      },
      completedPlans: ['plan-a'],
    };
    saveState(stateDir, resumableState);

    const { state } = initializeState(stateDir, config, '/tmp/repo');

    expect(state.status).toBe('running');
    expect(state.plans['plan-a'].status).toBe('completed');
    expect(state.plans['plan-b'].status).toBe('pending');
  });

  it('creates fresh state when setName differs', () => {
    const stateDir = makeTempDir();
    const config = makeConfig({ name: 'new-set' });

    // Seed state with different setName
    const oldState: EforgeState = {
      setName: 'old-set',
      status: 'running',
      startedAt: '2026-01-01T00:00:00Z',
      baseBranch: 'main',
      worktreeBase: '/old/worktrees',
      plans: {
        'plan-a': { status: 'completed', branch: 'feature/plan-a', dependsOn: [], merged: false },
      },
      completedPlans: ['plan-a'],
    };
    saveState(stateDir, oldState);

    const { state } = initializeState(stateDir, config, '/tmp/repo');

    expect(state.status).toBe('running');
    expect(state.setName).toBe('new-set');
    expect(state.plans['plan-a'].status).toBe('pending');
    expect(state.plans['plan-b'].status).toBe('pending');
  });
});

describe('executePlans - ModelTracker recording', () => {
  const makeTempDir = useTempDir();

  it('records agent:start models from planRunner stream into ctx.modelTracker', async () => {
    const stateDir = makeTempDir();
    const config = makeConfig({
      plans: [
        { id: 'plan-a', name: 'Plan A', dependsOn: [], branch: 'feature/plan-a', build: TEST_BUILD, review: TEST_REVIEW },
      ],
    });

    const state = initializeState(stateDir, config, '/tmp/repo').state;

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
      stateDir,
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
      resumed: false,
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
    const stateDir = makeTempDir();
    const config = makeConfig({
      plans: [
        { id: 'plan-a', name: 'Plan A', dependsOn: [], branch: 'feature/plan-a', build: TEST_BUILD, review: TEST_REVIEW },
        { id: 'plan-b', name: 'Plan B', dependsOn: ['plan-a'], branch: 'feature/plan-b', build: TEST_BUILD, review: TEST_REVIEW },
      ],
    });

    const state = initializeState(stateDir, config, '/tmp/repo').state;

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
      stateDir,
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
      resumed: false,
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
