import { describe, it, expect } from 'vitest';
import { propagateFailure, resumeState, shouldSkipMerge } from '../src/engine/orchestrator.js';
import type { EforgeState, OrchestrationConfig, PlanState } from '../src/engine/events.js';

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
    worktreeBase: '/tmp/worktrees',
    plans: fullPlans,
    completedPlans: [],
    ...overrides,
  };
}

function makePlans(
  specs: Array<{ id: string; dependsOn?: string[] }>,
): OrchestrationConfig['plans'] {
  return specs.map((s) => ({
    id: s.id,
    name: s.id,
    dependsOn: s.dependsOn ?? [],
    branch: `feature/${s.id}`,
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
    expect(events[0]).toMatchObject({ type: 'build:failed', planId: 'b' });
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
