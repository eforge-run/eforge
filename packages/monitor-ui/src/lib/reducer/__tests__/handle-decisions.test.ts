import { describe, it, expect } from 'vitest';
import { handlePlanBuildDecision } from '../handle-decisions';
import { initialRunState } from '../../reducer';
import type { EforgeEvent } from '../../types';
import type { BuildDecision } from '@eforge-build/client/browser';

function makeDecisionEvent(
  planId: string,
  decision: BuildDecision,
): Extract<EforgeEvent, { type: 'plan:build:decision' }> {
  return {
    type: 'plan:build:decision',
    timestamp: '2024-01-15T10:00:00.000Z',
    planId,
    decision,
  };
}

const reviewStrategyDecision: BuildDecision = {
  kind: 'review-strategy',
  rationale: 'Config specified single strategy',
  strategy: 'single',
  source: 'config',
};

const cycleTerminatedDecision: BuildDecision = {
  kind: 'cycle-terminated',
  rationale: 'No issues found',
  round: 1,
  reason: 'no-issues',
  issuesRemaining: 0,
};

const PLAN_A = 'plan-01';
const PLAN_B = 'plan-02';

describe('handlePlanBuildDecision', () => {
  it('appends the decision payload to decisions[planId]', () => {
    const event = makeDecisionEvent(PLAN_A, reviewStrategyDecision);
    const delta = handlePlanBuildDecision(event, initialRunState);

    expect(delta).toBeDefined();
    expect(delta!.decisions).toBeDefined();
    expect(delta!.decisions![PLAN_A]).toHaveLength(1);
    expect(delta!.decisions![PLAN_A][0]).toEqual(reviewStrategyDecision);
  });

  it('preserves existing decisions for the same planId', () => {
    const stateWithExisting = {
      ...initialRunState,
      decisions: { [PLAN_A]: [reviewStrategyDecision] },
    };
    const event = makeDecisionEvent(PLAN_A, cycleTerminatedDecision);
    const delta = handlePlanBuildDecision(event, stateWithExisting);

    expect(delta!.decisions![PLAN_A]).toHaveLength(2);
    expect(delta!.decisions![PLAN_A][0]).toEqual(reviewStrategyDecision);
    expect(delta!.decisions![PLAN_A][1]).toEqual(cycleTerminatedDecision);
  });

  it('keys multiple plans independently — plan-A decisions do not appear under plan-B', () => {
    const stateWithA = {
      ...initialRunState,
      decisions: { [PLAN_A]: [reviewStrategyDecision] },
    };
    const event = makeDecisionEvent(PLAN_B, cycleTerminatedDecision);
    const delta = handlePlanBuildDecision(event, stateWithA);

    // Plan B gets its decision
    expect(delta!.decisions![PLAN_B]).toHaveLength(1);
    expect(delta!.decisions![PLAN_B][0]).toEqual(cycleTerminatedDecision);

    // Plan A's decisions are preserved and not modified
    expect(delta!.decisions![PLAN_A]).toHaveLength(1);
    expect(delta!.decisions![PLAN_A][0]).toEqual(reviewStrategyDecision);
  });

  it('returns a partial state slice that the reducer can shallow-merge', () => {
    const event = makeDecisionEvent(PLAN_A, reviewStrategyDecision);
    const delta = handlePlanBuildDecision(event, initialRunState);

    // Should only contain the decisions slice, not the full state
    expect(delta).toHaveProperty('decisions');
    // Should not contain unrelated state fields in the delta itself
    const deltaKeys = Object.keys(delta!);
    expect(deltaKeys).toEqual(['decisions']);
  });
});
