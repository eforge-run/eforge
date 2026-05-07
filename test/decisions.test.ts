import { describe, it, expect } from 'vitest';
import { BuildDecisionSchema } from '@eforge-build/client';
import type { BuildDecision } from '@eforge-build/client';
import { emitBuildDecision } from '@eforge-build/engine/decisions';
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
    const result = BuildDecisionSchema.parse({
      kind: 'review-strategy',
      rationale: 'Config specified single strategy',
      strategy: 'single',
      source: 'config',
    });
    expect(result.kind).toBe('review-strategy');
    expect(result.strategy).toBe('single');
  });

  it('parses review-strategy (auto-threshold source with auto data)', () => {
    const result = BuildDecisionSchema.parse({
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
    const result = BuildDecisionSchema.parse({
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
    const result = BuildDecisionSchema.parse({
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
    const result = BuildDecisionSchema.parse({
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
    const result = BuildDecisionSchema.parse({
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
    const result = BuildDecisionSchema.parse({
      kind: 'evaluator-strictness',
      rationale: 'Config specifies strict mode',
      strictness: 'strict',
      source: 'config',
    });
    expect(result.kind).toBe('evaluator-strictness');
    expect(result.strictness).toBe('strict');
  });

  it('parses evaluator-strictness (default source)', () => {
    const result = BuildDecisionSchema.parse({
      kind: 'evaluator-strictness',
      rationale: 'Using default strictness',
      strictness: 'standard',
      source: 'default',
    });
    expect(result.kind).toBe('evaluator-strictness');
    expect(result.source).toBe('default');
  });

  it('parses recovery-verdict (retry)', () => {
    const result = BuildDecisionSchema.parse({
      kind: 'recovery-verdict',
      rationale: 'Build failed but recoverable via retry',
      verdict: 'retry',
    });
    expect(result.kind).toBe('recovery-verdict');
    expect(result.verdict).toBe('retry');
  });

  it('parses recovery-verdict (split with successorPrdId)', () => {
    const result = BuildDecisionSchema.parse({
      kind: 'recovery-verdict',
      rationale: 'Split into smaller PRD',
      verdict: 'split',
      successorPrdId: 'prd-02-follow-up.md',
    });
    expect(result.kind).toBe('recovery-verdict');
    expect(result.successorPrdId).toBe('prd-02-follow-up.md');
  });

  it('parses merge-conflict-resolution', () => {
    const result = BuildDecisionSchema.parse({
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
      BuildDecisionSchema.parse({ kind: 'unknown-kind', rationale: 'test' }),
    ).toThrow();
  });

  it('throws on missing rationale for review-strategy', () => {
    expect(() =>
      BuildDecisionSchema.parse({ kind: 'review-strategy', strategy: 'single', source: 'config' }),
    ).toThrow();
  });

  it('throws on missing required kind-specific field (round missing for cycle-terminated)', () => {
    expect(() =>
      BuildDecisionSchema.parse({
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
      BuildDecisionSchema.parse({
        kind: 'review-strategy',
        rationale: 'test',
        strategy: 'sequential', // invalid
        source: 'config',
      }),
    ).toThrow();
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

  it('attaches a timestamp string', () => {
    const event = emitBuildDecision(makeCtx('plan-01'), validDecision);
    expect(typeof event.timestamp).toBe('string');
    expect(event.timestamp.length).toBeGreaterThan(0);
  });

  it('decision round-trips through BuildDecisionSchema.parse', () => {
    const event = emitBuildDecision(makeCtx('plan-01'), validDecision);
    const parsed = BuildDecisionSchema.parse(event.decision);
    expect(parsed.kind).toBe(validDecision.kind);
  });

  it('throws ZodError when called with a malformed decision', () => {
    const malformed = { kind: 'review-strategy', strategy: 'single', source: 'config' } as unknown as BuildDecision;
    // missing rationale
    expect(() => emitBuildDecision(makeCtx('plan-01'), malformed)).toThrow();
  });
});
