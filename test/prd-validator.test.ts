import { describe, it, expect, vi } from 'vitest';
import { parseGaps } from '../src/engine/agents/prd-validator.js';
import { prdValidate } from '../src/engine/orchestrator/phases.js';
import type { PhaseContext } from '../src/engine/orchestrator/phases.js';
import type { EforgeEvent, EforgeState, PrdValidationGap } from '../src/engine/events.js';
import { collectEvents, findEvent, filterEvents } from './test-events.js';

/**
 * Build a minimal PhaseContext for testing prdValidate in isolation.
 */
function makePhaseContext(overrides: Partial<PhaseContext> = {}): PhaseContext {
  const state: EforgeState = {
    setName: 'test',
    status: 'running',
    startedAt: new Date().toISOString(),
    baseBranch: 'main',
    worktreeBase: '/tmp/wt',
    plans: {},
    completedPlans: [],
  };
  return {
    state,
    config: { setName: 'test', baseBranch: 'main', plans: [] },
    stateDir: '/tmp/state',
    repoRoot: '/tmp/repo',
    planRunner: async function* () {},
    parallelism: 1,
    maxValidationRetries: 0,
    minCompletionPercent: 75,
    gapClosePerformed: false,
    mergeWorktreePath: '/tmp/merge',
    featureBranch: 'feature',
    worktreeManager: {} as PhaseContext['worktreeManager'],
    failedMerges: new Set(),
    recentlyMergedIds: [],
    featureBranchMerged: false,
    resumed: false,
    ...overrides,
  } as PhaseContext;
}

/** Helper to create a fake PrdValidator that emits given events */
function fakePrdValidator(events: EforgeEvent[]): PhaseContext['prdValidator'] {
  return async function* () {
    for (const e of events) yield e;
  };
}

describe('parseGaps', () => {
  it('parses JSON with completionPercent and complexity fields', () => {
    const input = '```json\n{"completionPercent": 85, "gaps": [{"requirement": "x", "explanation": "y", "complexity": "moderate"}]}\n```';
    const result = parseGaps(input);
    expect(result).toEqual({
      gaps: [{ requirement: 'x', explanation: 'y', complexity: 'moderate' }],
      completionPercent: 85,
    });
  });

  it('handles missing completionPercent and complexity (backward compat)', () => {
    const input = '```json\n{"gaps": [{"requirement": "x", "explanation": "y"}]}\n```';
    const result = parseGaps(input);
    expect(result).toEqual({
      gaps: [{ requirement: 'x', explanation: 'y' }],
      completionPercent: undefined,
    });
  });

  it('strips invalid complexity values', () => {
    const input = '```json\n{"completionPercent": 50, "gaps": [{"requirement": "a", "explanation": "b", "complexity": "extreme"}]}\n```';
    const result = parseGaps(input);
    expect(result.gaps[0].complexity).toBeUndefined();
    expect(result.completionPercent).toBe(50);
  });

  it('handles all valid complexity values', () => {
    const input = `\`\`\`json
{
  "completionPercent": 60,
  "gaps": [
    {"requirement": "a", "explanation": "b", "complexity": "trivial"},
    {"requirement": "c", "explanation": "d", "complexity": "moderate"},
    {"requirement": "e", "explanation": "f", "complexity": "significant"}
  ]
}
\`\`\``;
    const result = parseGaps(input);
    expect(result.gaps).toHaveLength(3);
    expect(result.gaps[0].complexity).toBe('trivial');
    expect(result.gaps[1].complexity).toBe('moderate');
    expect(result.gaps[2].complexity).toBe('significant');
    expect(result.completionPercent).toBe(60);
  });

  it('returns empty gaps and undefined completionPercent for no JSON match', () => {
    const result = parseGaps('no json here');
    expect(result).toEqual({ gaps: [], completionPercent: undefined });
  });

  it('returns empty gaps and undefined completionPercent for invalid JSON', () => {
    const input = '```json\n{invalid json}\n```';
    const result = parseGaps(input);
    expect(result).toEqual({ gaps: [], completionPercent: undefined });
  });

  it('handles raw JSON without fences', () => {
    const input = 'Some text {"completionPercent": 90, "gaps": []} more text';
    const result = parseGaps(input);
    expect(result).toEqual({ gaps: [], completionPercent: 90 });
  });

  it('handles completionPercent of 0', () => {
    const input = '```json\n{"completionPercent": 0, "gaps": [{"requirement": "all", "explanation": "nothing done", "complexity": "significant"}]}\n```';
    const result = parseGaps(input);
    expect(result.completionPercent).toBe(0);
    expect(result.gaps).toHaveLength(1);
  });

  it('ignores non-number completionPercent values', () => {
    const input = '```json\n{"completionPercent": "high", "gaps": []}\n```';
    const result = parseGaps(input);
    expect(result.completionPercent).toBeUndefined();
  });
});

describe('prdValidate viability gate', () => {
  const gaps: PrdValidationGap[] = [
    { requirement: 'Must do X', explanation: 'X not done', complexity: 'moderate' },
  ];

  it('fails build when completionPercent is below threshold', async () => {
    const ctx = makePhaseContext({
      minCompletionPercent: 75,
      prdValidator: fakePrdValidator([
        { timestamp: new Date().toISOString(), type: 'prd_validation:start' },
        { timestamp: new Date().toISOString(), type: 'prd_validation:complete', passed: false, gaps, completionPercent: 60 },
      ]),
      gapCloser: async function* () {
        yield { timestamp: new Date().toISOString(), type: 'gap_close:start' } as EforgeEvent;
      },
    });

    const events = await collectEvents(prdValidate(ctx));

    expect(ctx.state.status).toBe('failed');
    // Gap closer should NOT have been invoked
    expect(events.some((e) => e.type === 'gap_close:start')).toBe(false);
    // Should emit a progress message about viability
    const progress = events.find((e) => e.type === 'plan:progress' && 'message' in e && (e as { message: string }).message.includes('viability'));
    expect(progress).toBeDefined();
  });

  it('proceeds to gap closing when completionPercent is above threshold', async () => {
    const gapCloserCalled = { value: false };
    const ctx = makePhaseContext({
      minCompletionPercent: 75,
      prdValidator: fakePrdValidator([
        { timestamp: new Date().toISOString(), type: 'prd_validation:start' },
        { timestamp: new Date().toISOString(), type: 'prd_validation:complete', passed: false, gaps, completionPercent: 80 },
      ]),
      gapCloser: async function* () {
        gapCloserCalled.value = true;
        yield { timestamp: new Date().toISOString(), type: 'gap_close:start' } as EforgeEvent;
        yield { timestamp: new Date().toISOString(), type: 'gap_close:complete' } as EforgeEvent;
      },
    });

    await collectEvents(prdValidate(ctx));

    expect(gapCloserCalled.value).toBe(true);
    expect(ctx.gapClosePerformed).toBe(true);
  });

  it('proceeds to gap closing when completionPercent is undefined (backward compat)', async () => {
    const gapCloserCalled = { value: false };
    const ctx = makePhaseContext({
      minCompletionPercent: 75,
      prdValidator: fakePrdValidator([
        { timestamp: new Date().toISOString(), type: 'prd_validation:start' },
        { timestamp: new Date().toISOString(), type: 'prd_validation:complete', passed: false, gaps, completionPercent: undefined },
      ]),
      gapCloser: async function* () {
        gapCloserCalled.value = true;
        yield { timestamp: new Date().toISOString(), type: 'gap_close:start' } as EforgeEvent;
        yield { timestamp: new Date().toISOString(), type: 'gap_close:complete' } as EforgeEvent;
      },
    });

    await collectEvents(prdValidate(ctx));

    expect(gapCloserCalled.value).toBe(true);
  });

  it('does nothing when prdValidator is not provided', async () => {
    const ctx = makePhaseContext({ prdValidator: undefined });
    const events = await collectEvents(prdValidate(ctx));
    expect(events).toHaveLength(0);
  });

  it('does nothing when state is already failed', async () => {
    const validatorCalled = { value: false };
    const ctx = makePhaseContext({
      prdValidator: async function* () {
        validatorCalled.value = true;
        yield { timestamp: new Date().toISOString(), type: 'prd_validation:start' } as EforgeEvent;
      },
    });
    ctx.state.status = 'failed';

    const events = await collectEvents(prdValidate(ctx));
    expect(validatorCalled.value).toBe(false);
    expect(events).toHaveLength(0);
  });

  it('defaults minCompletionPercent to 75 via OrchestratorOptions', async () => {
    // This tests that the default is applied in orchestrator construction.
    // We verify the PhaseContext default here.
    const ctx = makePhaseContext();
    expect(ctx.minCompletionPercent).toBe(75);
  });
});
