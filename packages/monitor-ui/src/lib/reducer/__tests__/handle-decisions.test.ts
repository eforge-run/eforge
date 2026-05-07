import { describe, it, expect } from 'vitest';
import { handlePlanBuildDecision, handlePlanningDecision } from '../handle-decisions';
import { initialRunState } from '../../reducer';
import type { EforgeEvent } from '../../types';
import type { BuildDecision, PlanningDecision } from '@eforge-build/client/browser';

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

function makePlanningDecisionEvent(
  decision: PlanningDecision,
  planId?: string,
): Extract<EforgeEvent, { type: 'planning:decision' }> {
  return {
    type: 'planning:decision',
    timestamp: '2024-01-15T10:00:00.000Z',
    ...(planId !== undefined && { planId }),
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

const scopeDecision: PlanningDecision = {
  kind: 'scope-selected',
  rationale: 'Standard excursion scope',
  scope: 'excursion',
  source: 'pipeline-composer',
};

const buildPipelineDecision: PlanningDecision = {
  kind: 'build-pipeline-chosen',
  rationale: 'Default pipeline stages for excursion',
  defaultBuild: ['implement', 'review-cycle'],
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

// ---------------------------------------------------------------------------
// handlePlanningDecision
// ---------------------------------------------------------------------------

describe('handlePlanningDecision', () => {
  it('appends the decision payload to decisions[__run__] when no planId is given', () => {
    const event = makePlanningDecisionEvent(scopeDecision);
    const delta = handlePlanningDecision(event, initialRunState);

    expect(delta).toBeDefined();
    expect(delta!.decisions).toBeDefined();
    expect(delta!.decisions!['__run__']).toHaveLength(1);
    expect(delta!.decisions!['__run__'][0]).toEqual(scopeDecision);
  });

  it('appends the decision payload to decisions[planId] when planId is given', () => {
    const event = makePlanningDecisionEvent(buildPipelineDecision, PLAN_A);
    const delta = handlePlanningDecision(event, initialRunState);

    expect(delta!.decisions![PLAN_A]).toHaveLength(1);
    expect(delta!.decisions![PLAN_A][0]).toEqual(buildPipelineDecision);
  });

  it('preserves existing decisions under __run__ when appending', () => {
    const stateWithExisting = {
      ...initialRunState,
      decisions: { '__run__': [scopeDecision] },
    };
    const event = makePlanningDecisionEvent(buildPipelineDecision);
    const delta = handlePlanningDecision(event, stateWithExisting);

    expect(delta!.decisions!['__run__']).toHaveLength(2);
    expect(delta!.decisions!['__run__'][0]).toEqual(scopeDecision);
    expect(delta!.decisions!['__run__'][1]).toEqual(buildPipelineDecision);
  });

  it('does not affect plan-keyed decisions when writing to __run__', () => {
    const stateWithPlan = {
      ...initialRunState,
      decisions: { [PLAN_A]: [reviewStrategyDecision] },
    };
    const event = makePlanningDecisionEvent(scopeDecision);
    const delta = handlePlanningDecision(event, stateWithPlan);

    // __run__ gets the planning decision
    expect(delta!.decisions!['__run__']).toHaveLength(1);
    // Plan A's decisions are preserved
    expect(delta!.decisions![PLAN_A]).toHaveLength(1);
    expect(delta!.decisions![PLAN_A][0]).toEqual(reviewStrategyDecision);
  });

  it('returns a delta containing only the decisions slice', () => {
    const event = makePlanningDecisionEvent(scopeDecision);
    const delta = handlePlanningDecision(event, initialRunState);

    expect(Object.keys(delta!)).toEqual(['decisions']);
  });
});
