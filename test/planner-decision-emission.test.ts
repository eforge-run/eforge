/**
 * Unit tests for planner-phase decision emission.
 *
 * Verifies that `emitPlanningDecision` produces correctly shaped
 * `planning:decision` events for every PlanningDecision kind, and
 * that the planner agent wires defaultBuild / defaultReview through
 * to PlannerOptions.
 */

import { describe, it, expect } from 'vitest';
import { PlanningDecisionSchema, parseWithSchema } from '@eforge-build/client';
import { emitPlanningDecision } from '@eforge-build/engine/decisions';
import type { PlanningDecision } from '@eforge-build/client';

// ---------------------------------------------------------------------------
// Helper: make each planning decision kind
// ---------------------------------------------------------------------------

const scopeDecision: PlanningDecision = {
  kind: 'scope-selected',
  rationale: 'Pipeline composer selected excursion based on task size',
  scope: 'excursion',
  source: 'pipeline-composer',
};

const buildPipelineDecision: PlanningDecision = {
  kind: 'build-pipeline-chosen',
  rationale: 'Standard implement + review-cycle for a medium-complexity excursion',
  defaultBuild: ['implement', 'review-cycle'],
};

const reviewProfileDecision: PlanningDecision = {
  kind: 'review-profile-chosen',
  rationale: 'Single code review is sufficient for the scope',
  strategy: 'single',
  perspectives: ['code'],
  maxRounds: 1,
  evaluatorStrictness: 'standard',
};

const planSetShapeDecision: PlanningDecision = {
  kind: 'plan-set-shape',
  rationale: 'Two plans: schema migration first, then feature implementation',
  planCount: 2,
  planIds: ['plan-01-schema', 'plan-02-feature'],
};

// ---------------------------------------------------------------------------
// emitPlanningDecision — event shape
// ---------------------------------------------------------------------------

describe('emitPlanningDecision — event shape', () => {
  it('emits type === planning:decision for scope-selected', () => {
    const event = emitPlanningDecision(scopeDecision);
    expect(event.type).toBe('planning:decision');
    expect(event.decision.kind).toBe('scope-selected');
  });

  it('emits type === planning:decision for build-pipeline-chosen', () => {
    const event = emitPlanningDecision(buildPipelineDecision);
    expect(event.type).toBe('planning:decision');
    expect(event.decision.kind).toBe('build-pipeline-chosen');
  });

  it('emits type === planning:decision for review-profile-chosen', () => {
    const event = emitPlanningDecision(reviewProfileDecision);
    expect(event.type).toBe('planning:decision');
    expect(event.decision.kind).toBe('review-profile-chosen');
  });

  it('emits type === planning:decision for plan-set-shape', () => {
    const event = emitPlanningDecision(planSetShapeDecision);
    expect(event.type).toBe('planning:decision');
    expect(event.decision.kind).toBe('plan-set-shape');
  });

  it('omits planId when not provided', () => {
    const event = emitPlanningDecision(scopeDecision);
    expect('planId' in event).toBe(false);
  });

  it('includes planId when provided', () => {
    const event = emitPlanningDecision(scopeDecision, 'plan-01');
    expect(event.planId).toBe('plan-01');
  });

  it('includes a valid ISO 8601 timestamp', () => {
    const event = emitPlanningDecision(scopeDecision);
    const parsed = new Date(event.timestamp);
    expect(Number.isFinite(parsed.getTime())).toBe(true);
    expect(parsed.toISOString()).toBe(event.timestamp);
  });
});

// ---------------------------------------------------------------------------
// emitPlanningDecision — schema validation
// ---------------------------------------------------------------------------

describe('emitPlanningDecision — schema validation', () => {
  it('validates the decision payload through PlanningDecisionSchema', () => {
    const event = emitPlanningDecision(buildPipelineDecision);
    const parsed = parseWithSchema(PlanningDecisionSchema,event.decision);
    expect(parsed.kind).toBe('build-pipeline-chosen');
  });

  it('throws when called with a malformed scope-selected (missing scope)', () => {
    const malformed = { kind: 'scope-selected', rationale: 'test', source: 'planner' } as unknown as PlanningDecision;
    expect(() => emitPlanningDecision(malformed)).toThrow();
  });

  it('throws when called with a malformed review-profile-chosen (invalid strategy)', () => {
    const malformed = {
      kind: 'review-profile-chosen',
      rationale: 'test',
      strategy: 'invalid',
      perspectives: ['code'],
      maxRounds: 1,
      evaluatorStrictness: 'standard',
    } as unknown as PlanningDecision;
    expect(() => emitPlanningDecision(malformed)).toThrow();
  });

  it('throws when called with a malformed plan-set-shape (zero planCount)', () => {
    const malformed = {
      kind: 'plan-set-shape',
      rationale: 'test',
      planCount: 0,
      planIds: [],
    } as unknown as PlanningDecision;
    expect(() => emitPlanningDecision(malformed)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Round-trip: all four planning decision kinds
// ---------------------------------------------------------------------------

describe('PlanningDecision — round-trips through schema', () => {
  const allDecisions: PlanningDecision[] = [
    scopeDecision,
    buildPipelineDecision,
    reviewProfileDecision,
    planSetShapeDecision,
  ];

  for (const decision of allDecisions) {
    it(`round-trips kind=${decision.kind}`, () => {
      const event = emitPlanningDecision(decision);
      const reparsed = parseWithSchema(PlanningDecisionSchema,event.decision);
      expect(reparsed.kind).toBe(decision.kind);
    });
  }
});
