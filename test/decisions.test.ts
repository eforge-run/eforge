import { describe, it, expect } from 'vitest';
import { BuildDecisionSchema, PlanningDecisionSchema, parseWithSchema } from '@eforge-build/client';
import type { BuildDecision, PlanningDecision } from '@eforge-build/client';
import { emitBuildDecision, emitBuildDecisionForPlan, emitPlanningDecision } from '@eforge-build/engine/decisions';
import type { BuildStageContext } from '@eforge-build/engine/pipeline';

// ---------------------------------------------------------------------------
// Minimal stub context — cast through unknown per AGENTS.md test conventions.
// ---------------------------------------------------------------------------

function makeCtx(planId: string): BuildStageContext {
  return { planId } as unknown as BuildStageContext;
}

// ---------------------------------------------------------------------------
// Schema parse: every kind must succeed with required fields
// ---------------------------------------------------------------------------

describe('BuildDecisionSchema — valid kinds', () => {
  it('parses review-strategy (config source)', () => {
    const result = parseWithSchema(BuildDecisionSchema,{
      kind: 'review-strategy',
      rationale: 'Config specified single strategy',
      strategy: 'single',
      source: 'config',
    });
    expect(result.kind).toBe('review-strategy');
    expect(result.strategy).toBe('single');
  });

  it('parses review-strategy (auto-threshold source with auto data)', () => {
    const result = parseWithSchema(BuildDecisionSchema,{
      kind: 'review-strategy',
      rationale: 'File count exceeds threshold',
      strategy: 'parallel',
      source: 'auto-threshold',
      auto: { files: 15, lines: 800, threshold: { files: 10, lines: 500 } },
    });
    expect(result.kind).toBe('review-strategy');
    expect(result.source).toBe('auto-threshold');
    expect(result.auto?.files).toBe(15);
  });

  it('parses perspectives-inferred', () => {
    const result = parseWithSchema(BuildDecisionSchema,{
      kind: 'perspectives-inferred',
      rationale: 'Security and API changes detected',
      perspectives: ['security', 'api'],
      categories: ['auth', 'rest'],
      rules: ['rule-a'],
    });
    expect(result.kind).toBe('perspectives-inferred');
    expect(result.perspectives).toEqual(['security', 'api']);
  });

  it('parses cycle-terminated (no-issues)', () => {
    const result = parseWithSchema(BuildDecisionSchema,{
      kind: 'cycle-terminated',
      rationale: 'No issues found in round 1',
      round: 1,
      reason: 'no-issues',
      issuesRemaining: 0,
    });
    expect(result.kind).toBe('cycle-terminated');
    expect(result.reason).toBe('no-issues');
  });

  it('parses cycle-terminated (max-rounds)', () => {
    const result = parseWithSchema(BuildDecisionSchema,{
      kind: 'cycle-terminated',
      rationale: 'Reached max rounds limit',
      round: 3,
      reason: 'max-rounds',
      issuesRemaining: 2,
    });
    expect(result.kind).toBe('cycle-terminated');
    expect(result.reason).toBe('max-rounds');
  });

  it('parses perspectives-respawned', () => {
    const result = parseWithSchema(BuildDecisionSchema,{
      kind: 'perspectives-respawned',
      rationale: 'Respawning code and security for round 2',
      round: 2,
      perspectives: ['code', 'security'],
      dropped: ['api'],
    });
    expect(result.kind).toBe('perspectives-respawned');
    expect(result.dropped).toEqual(['api']);
  });

  it('parses evaluator-strictness (config source)', () => {
    const result = parseWithSchema(BuildDecisionSchema,{
      kind: 'evaluator-strictness',
      rationale: 'Config specifies strict mode',
      strictness: 'strict',
      source: 'config',
    });
    expect(result.kind).toBe('evaluator-strictness');
    expect(result.strictness).toBe('strict');
  });

  it('parses evaluator-strictness (default source)', () => {
    const result = parseWithSchema(BuildDecisionSchema,{
      kind: 'evaluator-strictness',
      rationale: 'Using default strictness',
      strictness: 'standard',
      source: 'default',
    });
    expect(result.kind).toBe('evaluator-strictness');
    expect(result.source).toBe('default');
  });

  it('parses recovery-verdict (retry)', () => {
    const result = parseWithSchema(BuildDecisionSchema,{
      kind: 'recovery-verdict',
      rationale: 'Build failed but recoverable via retry',
      verdict: 'retry',
    });
    expect(result.kind).toBe('recovery-verdict');
    expect(result.verdict).toBe('retry');
  });

  it('parses recovery-verdict (split with successorPrdId)', () => {
    const result = parseWithSchema(BuildDecisionSchema,{
      kind: 'recovery-verdict',
      rationale: 'Split into smaller PRD',
      verdict: 'split',
      successorPrdId: 'prd-02-follow-up.md',
    });
    expect(result.kind).toBe('recovery-verdict');
    expect(result.successorPrdId).toBe('prd-02-follow-up.md');
  });

  it('parses merge-conflict-resolution', () => {
    const result = parseWithSchema(BuildDecisionSchema,{
      kind: 'merge-conflict-resolution',
      rationale: 'Ours strategy chosen for generated files',
      strategy: 'ours',
      files: ['src/generated/api.ts', 'src/generated/types.ts'],
    });
    expect(result.kind).toBe('merge-conflict-resolution');
    expect(result.files).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Schema parse: invalid inputs must throw
// ---------------------------------------------------------------------------

describe('BuildDecisionSchema — invalid inputs', () => {
  it('throws on unknown kind', () => {
    expect(() =>
      parseWithSchema(BuildDecisionSchema,{ kind: 'unknown-kind', rationale: 'test' }),
    ).toThrow();
  });

  it('throws on missing rationale for review-strategy', () => {
    expect(() =>
      parseWithSchema(BuildDecisionSchema,{ kind: 'review-strategy', strategy: 'single', source: 'config' }),
    ).toThrow();
  });

  it('throws on missing required kind-specific field (round missing for cycle-terminated)', () => {
    expect(() =>
      parseWithSchema(BuildDecisionSchema,{
        kind: 'cycle-terminated',
        rationale: 'test',
        reason: 'no-issues',
        issuesRemaining: 0,
        // round is missing
      }),
    ).toThrow();
  });

  it('throws on invalid enum value for strategy', () => {
    expect(() =>
      parseWithSchema(BuildDecisionSchema,{
        kind: 'review-strategy',
        rationale: 'test',
        strategy: 'sequential', // invalid
        source: 'config',
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// PlanningDecisionSchema — valid kinds
// ---------------------------------------------------------------------------

describe('PlanningDecisionSchema — valid kinds', () => {
  it('parses scope-selected (pipeline-composer source)', () => {
    const result = parseWithSchema(PlanningDecisionSchema,{
      kind: 'scope-selected',
      rationale: 'Three independent subsystems each requiring dedicated exploration',
      scope: 'expedition',
      source: 'pipeline-composer',
    });
    expect(result.kind).toBe('scope-selected');
    expect(result.scope).toBe('expedition');
    expect(result.source).toBe('pipeline-composer');
  });

  it('parses scope-selected (planner source)', () => {
    const result = parseWithSchema(PlanningDecisionSchema,{
      kind: 'scope-selected',
      rationale: 'Simple single-file typo fix',
      scope: 'errand',
      source: 'planner',
    });
    expect(result.kind).toBe('scope-selected');
    expect(result.scope).toBe('errand');
  });

  it('parses build-pipeline-chosen', () => {
    const result = parseWithSchema(PlanningDecisionSchema,{
      kind: 'build-pipeline-chosen',
      rationale: 'Standard implementation with review cycle for this excursion',
      defaultBuild: ['implement', 'review-cycle'],
    });
    expect(result.kind).toBe('build-pipeline-chosen');
    expect(result.defaultBuild).toEqual(['implement', 'review-cycle']);
  });

  it('parses build-pipeline-chosen with parallel stages', () => {
    const result = parseWithSchema(PlanningDecisionSchema,{
      kind: 'build-pipeline-chosen',
      rationale: 'Parallel doc-author with implement for faster iteration',
      defaultBuild: [['implement', 'doc-author'], 'review-cycle'],
    });
    expect(result.kind).toBe('build-pipeline-chosen');
    expect(result.defaultBuild[0]).toEqual(['implement', 'doc-author']);
  });

  it('parses review-profile-chosen', () => {
    const result = parseWithSchema(PlanningDecisionSchema,{
      kind: 'review-profile-chosen',
      rationale: 'Security changes warrant parallel code+security review',
      strategy: 'parallel',
      perspectives: ['code', 'security'],
      maxRounds: 2,
      evaluatorStrictness: 'strict',
    });
    expect(result.kind).toBe('review-profile-chosen');
    expect(result.strategy).toBe('parallel');
    expect(result.perspectives).toEqual(['code', 'security']);
    expect(result.maxRounds).toBe(2);
    expect(result.evaluatorStrictness).toBe('strict');
  });

  it('parses plan-set-shape', () => {
    const result = parseWithSchema(PlanningDecisionSchema,{
      kind: 'plan-set-shape',
      rationale: 'Schema migration must land before builder can reference new columns',
      planCount: 2,
      planIds: ['plan-01-schema', 'plan-02-delivery'],
    });
    expect(result.kind).toBe('plan-set-shape');
    expect(result.planCount).toBe(2);
    expect(result.planIds).toEqual(['plan-01-schema', 'plan-02-delivery']);
  });
});

// ---------------------------------------------------------------------------
// PlanningDecisionSchema — invalid inputs
// ---------------------------------------------------------------------------

describe('PlanningDecisionSchema — invalid inputs', () => {
  it('throws on unknown kind', () => {
    expect(() =>
      parseWithSchema(PlanningDecisionSchema,{ kind: 'unknown-planning-kind', rationale: 'test' }),
    ).toThrow();
  });

  it('throws on missing rationale', () => {
    expect(() =>
      parseWithSchema(PlanningDecisionSchema,{ kind: 'scope-selected', scope: 'excursion', source: 'planner' }),
    ).toThrow();
  });

  it('throws on invalid scope value', () => {
    expect(() =>
      parseWithSchema(PlanningDecisionSchema,{ kind: 'scope-selected', rationale: 'test', scope: 'invalid', source: 'planner' }),
    ).toThrow();
  });

  it('throws on invalid evaluatorStrictness for review-profile-chosen', () => {
    expect(() =>
      parseWithSchema(PlanningDecisionSchema,{
        kind: 'review-profile-chosen',
        rationale: 'test',
        strategy: 'single',
        perspectives: ['code'],
        maxRounds: 1,
        evaluatorStrictness: 'ultra-strict',
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// emitPlanningDecision helper
// ---------------------------------------------------------------------------

describe('emitPlanningDecision', () => {
  const validDecision: PlanningDecision = {
    kind: 'scope-selected',
    rationale: 'Multiple independent subsystems',
    scope: 'excursion',
    source: 'pipeline-composer',
  };

  it('returns an event with type === planning:decision', () => {
    const event = emitPlanningDecision(validDecision);
    expect(event.type).toBe('planning:decision');
  });

  it('omits planId when not provided', () => {
    const event = emitPlanningDecision(validDecision);
    expect('planId' in event).toBe(false);
  });

  it('attaches planId when provided', () => {
    const event = emitPlanningDecision(validDecision, 'plan-01');
    expect(event.planId).toBe('plan-01');
  });

  it('attaches an ISO 8601 timestamp string', () => {
    const event = emitPlanningDecision(validDecision);
    expect(typeof event.timestamp).toBe('string');
    const parsed = new Date(event.timestamp);
    expect(Number.isFinite(parsed.getTime())).toBe(true);
    expect(parsed.toISOString()).toBe(event.timestamp);
  });

  it('decision round-trips through PlanningDecisionSchema.parse', () => {
    const event = emitPlanningDecision(validDecision);
    const parsed = parseWithSchema(PlanningDecisionSchema,event.decision);
    expect(parsed.kind).toBe(validDecision.kind);
  });

  it('throws when called with a malformed decision', () => {
    const malformed = { kind: 'scope-selected', scope: 'excursion', source: 'planner' } as unknown as PlanningDecision;
    // missing rationale
    expect(() => emitPlanningDecision(malformed)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// emitBuildDecision helper
// ---------------------------------------------------------------------------

describe('emitBuildDecision', () => {
  const validDecision: BuildDecision = {
    kind: 'review-strategy',
    rationale: 'Config specified single',
    strategy: 'single',
    source: 'config',
  };

  it('returns an event with type === plan:build:decision', () => {
    const event = emitBuildDecision(makeCtx('plan-01'), validDecision);
    expect(event.type).toBe('plan:build:decision');
  });

  it('attaches planId from context', () => {
    const event = emitBuildDecision(makeCtx('plan-42'), validDecision);
    expect(event.planId).toBe('plan-42');
  });

  it('attaches an ISO 8601 timestamp string', () => {
    const event = emitBuildDecision(makeCtx('plan-01'), validDecision);
    expect(typeof event.timestamp).toBe('string');
    // Must round-trip through Date — guards against empty strings or non-ISO formats
    const parsed = new Date(event.timestamp);
    expect(Number.isFinite(parsed.getTime())).toBe(true);
    expect(parsed.toISOString()).toBe(event.timestamp);
  });

  it('decision round-trips through BuildDecisionSchema.parse', () => {
    const event = emitBuildDecision(makeCtx('plan-01'), validDecision);
    const parsed = parseWithSchema(BuildDecisionSchema,event.decision);
    expect(parsed.kind).toBe(validDecision.kind);
  });

  it('throws when called with a malformed decision', () => {
    const malformed = { kind: 'review-strategy', strategy: 'single', source: 'config' } as unknown as BuildDecision;
    // missing rationale
    expect(() => emitBuildDecision(makeCtx('plan-01'), malformed)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// emitBuildDecisionForPlan helper
// ---------------------------------------------------------------------------

describe('emitBuildDecisionForPlan', () => {
  const validDecision: BuildDecision = {
    kind: 'recovery-verdict',
    rationale: 'Retry approved',
    verdict: 'retry',
  };

  it('returns an event with type === plan:build:decision', () => {
    const event = emitBuildDecisionForPlan('plan-01', validDecision);
    expect(event.type).toBe('plan:build:decision');
  });

  it('attaches planId from the bare string argument', () => {
    const event = emitBuildDecisionForPlan('plan-99', validDecision);
    expect(event.planId).toBe('plan-99');
  });

  it('attaches an ISO 8601 timestamp string', () => {
    const event = emitBuildDecisionForPlan('plan-01', validDecision);
    expect(typeof event.timestamp).toBe('string');
    // Must round-trip through Date — guards against empty strings or non-ISO formats
    const parsed = new Date(event.timestamp);
    expect(Number.isFinite(parsed.getTime())).toBe(true);
    expect(parsed.toISOString()).toBe(event.timestamp);
  });

  it('decision round-trips through BuildDecisionSchema.parse', () => {
    const event = emitBuildDecisionForPlan('plan-01', validDecision);
    const parsed = parseWithSchema(BuildDecisionSchema,event.decision);
    expect(parsed.kind).toBe(validDecision.kind);
  });

  it('throws when called with a malformed decision', () => {
    const malformed = { kind: 'recovery-verdict', verdict: 'retry' } as unknown as BuildDecision;
    // missing rationale
    expect(() => emitBuildDecisionForPlan('plan-01', malformed)).toThrow();
  });

  it('produces the same event shape as emitBuildDecision for the same inputs', () => {
    const a = emitBuildDecision(makeCtx('plan-01'), validDecision);
    const b = emitBuildDecisionForPlan('plan-01', validDecision);
    // timestamps differ (Date.now), so compare structural fields only
    expect(b.type).toBe(a.type);
    expect(b.planId).toBe(a.planId);
    expect(b.decision).toEqual(a.decision);
  });
});
