import { describe, it, expect } from 'vitest';
import { updatePlanStatus, isResumable } from '../src/engine/state.js';
import type { ForgeState } from '../src/engine/events.js';

function makeState(overrides?: Partial<ForgeState>): ForgeState {
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

describe('isResumable', () => {
  it('returns true when running with pending plans', () => {
    const state = makeState();
    expect(isResumable(state)).toBe(true);
  });

  it('returns false when all plans completed', () => {
    const state = makeState();
    state.plans['plan-a'].status = 'completed';
    state.plans['plan-b'].status = 'completed';
    expect(isResumable(state)).toBe(false);
  });

  it('returns false when status is not running', () => {
    const state = makeState({ status: 'completed' });
    expect(isResumable(state)).toBe(false);
  });

  it('returns false when status is failed', () => {
    const state = makeState({ status: 'failed' });
    expect(isResumable(state)).toBe(false);
  });

  it('returns true when some plans still pending', () => {
    const state = makeState();
    state.plans['plan-a'].status = 'completed';
    // plan-b still pending
    expect(isResumable(state)).toBe(true);
  });
});
