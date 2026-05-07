import { describe, it, expect } from 'vitest';
import { updatePlanStatus } from '@eforge-build/engine/state';
import type { EforgeState } from '@eforge-build/engine/events';

function makeState(overrides?: Partial<EforgeState>): EforgeState {
  return {
    setName: 'test-set',
    status: 'running',
    startedAt: '2026-01-01T00:00:00Z',
    baseBranch: 'main',
    worktreeBase: '/tmp/worktrees',
    plans: {
      'plan-a': {
        status: 'pending',
        branch: 'feature/a',
        dependsOn: [],
        merged: false,
      },
      'plan-b': {
        status: 'pending',
        branch: 'feature/b',
        dependsOn: ['plan-a'],
        merged: false,
      },
    },
    completedPlans: [],
    ...overrides,
  };
}

describe('updatePlanStatus', () => {
  it('sets plan status', () => {
    const state = makeState();
    updatePlanStatus(state, 'plan-a', 'running');
    expect(state.plans['plan-a'].status).toBe('running');
  });

  it('adds to completedPlans on completed', () => {
    const state = makeState();
    updatePlanStatus(state, 'plan-a', 'completed');
    expect(state.completedPlans).toContain('plan-a');
  });

  it('adds to completedPlans on merged', () => {
    const state = makeState();
    updatePlanStatus(state, 'plan-a', 'merged');
    expect(state.completedPlans).toContain('plan-a');
  });

  it('does not duplicate in completedPlans', () => {
    const state = makeState({ completedPlans: ['plan-a'] });
    state.plans['plan-a'].status = 'completed';
    updatePlanStatus(state, 'plan-a', 'merged');
    expect(state.completedPlans.filter((id) => id === 'plan-a')).toHaveLength(1);
  });

  it('throws for unknown planId', () => {
    const state = makeState();
    expect(() => updatePlanStatus(state, 'nonexistent', 'running')).toThrow(/unknown plan/i);
  });
});
