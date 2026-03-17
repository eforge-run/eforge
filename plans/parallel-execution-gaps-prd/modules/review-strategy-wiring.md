# Review Strategy Wiring

## Architecture Reference

This module implements [Between review-strategy-wiring and pipeline stages] from the architecture.

Key constraints from architecture:
- `PipelineContext.profile.review` is the single source of truth for review behavior
- Default config values match current hardcoded behavior - existing profiles produce identical results
- The review-fix-evaluate loop wraps existing stages rather than modifying their internals

## Scope

### In Scope
- Wire `strategy` field into the `review` build stage to override `shouldParallelizeReview()` heuristic
- Wire `perspectives` field into `runParallelReview()` to override `determineApplicableReviews()`
- Implement multi-round review loop controlled by `maxRounds`
- Filter issues by `autoAcceptBelow` severity before passing to review-fixer
- Add `{{strictness}}` template variable to evaluator prompt with `strict`/`standard`/`lenient` variants
- Pass `evaluatorStrictness` from profile config through to evaluator prompt rendering

### Out of Scope
- Dynamic profile generation (module 4)
- Changes to compile-phase review cycles (`plan-review-cycle`, `cohesion-review-cycle`) - those use `runReviewCycle()` which is a different code path
- New event types (existing events are sufficient)
- Changes to `ReviewProfileConfig` type definition (already complete in `config.ts`)

## Implementation Approach

### Overview

Thread `ctx.profile.review` fields through the three build stages that participate in the review cycle: `review`, `review-fix`, and `evaluate`. The `review` and `review-fix` stages read config directly. For multi-round support, replace the current linear `review → review-fix → evaluate` sequence with a `review-cycle` meta-stage that loops. The evaluator prompt gains a `{{strictness}}` template variable for behavioral variation.

### Key Decisions

1. **New `review-cycle` build stage replaces three individual stages in profile build lists.** The architecture specifies a `reviewCycleStage` wrapper. Rather than making the loop implicit in `runBuildPipeline`, register a new `review-cycle` build stage that internally runs the review → review-fix → evaluate sequence in a loop. Default profiles keep the existing `['implement', 'review', 'review-fix', 'evaluate']` stages for backward compatibility - `maxRounds: 1` is the default and the existing linear sequence is equivalent. Profiles that want multi-round review use `['implement', 'review-cycle']` instead.

   *Rejected alternative*: Modifying `runBuildPipeline` to detect adjacent review stages and loop them. Too implicit and fragile.

2. **Pass `perspectives` and `strategy` as new options to `runParallelReview()`.** The parallel reviewer already accepts an options object. Add optional `strategy` and `perspectives` fields. When `strategy` is `'single'`, skip the parallel path entirely. When `'parallel'`, skip the `shouldParallelizeReview()` heuristic. When `'auto'` (or omitted), keep current behavior. When `perspectives` is provided, use it instead of `determineApplicableReviews()`.

3. **Filter `autoAcceptBelow` issues in the review-fix stage, not in the reviewer.** The reviewer reports all issues it finds. The review-fix stage filters out issues at or below the `autoAcceptBelow` threshold before passing them to the fixer agent. Filtered issues still appear in the `build:review:complete` event.

4. **Evaluator strictness via template variable, not separate prompts.** The evaluator prompt (`evaluator.md`) gains a `{{strictness}}` variable. The `builderEvaluate` function accepts an optional `strictness` parameter and passes it to `loadPrompt`. Three short text blocks are defined in the code (not in the prompt file) and injected based on the value.

## Files

### Create
- `test/review-strategy-wiring.test.ts` — Unit tests for strategy/perspectives threading, issue filtering, multi-round loop, and strictness injection

### Modify
- `src/engine/agents/parallel-reviewer.ts` — Add optional `strategy` and `perspectives` fields to `ParallelReviewerOptions`. When `strategy === 'single'`, always use `runReview()`. When `strategy === 'parallel'`, always use the parallel path. When `perspectives` is provided and the parallel path is taken, use it instead of calling `determineApplicableReviews()`.

- `src/engine/agents/builder.ts` — Add optional `strictness` parameter to `BuilderOptions`. Pass it to `loadPrompt('evaluator', ...)` as the `strictness` template variable in `builderEvaluate()`. Define the three strictness text blocks as constants: `STRICTNESS_STRICT`, `STRICTNESS_STANDARD`, `STRICTNESS_LENIENT`.

- `src/engine/prompts/evaluator.md` — Add `{{strictness}}` placeholder after the "Fix Evaluation Policy" heading. The injected text modifies the accept/reject threshold for the evaluator.

- `src/engine/pipeline.ts` — Three changes:
  1. **`reviewStage`**: Read `ctx.profile.review.strategy` and `ctx.profile.review.perspectives`, pass them to `runParallelReview()` options.
  2. **`reviewFixStage`**: Read `ctx.profile.review.autoAcceptBelow`. If set, filter `ctx.reviewIssues` to exclude issues at or below that severity before passing to `runReviewFixer()`. Yield an informational event (`build:review:fix:start`) with the filtered count. Store filtered issues back into `ctx.reviewIssues` so the evaluate stage sees only what was fixed.
  3. **New `review-cycle` build stage**: Register a new build stage that loops: run review → filter issues → run review-fix → run evaluate, repeating up to `ctx.profile.review.maxRounds` times. Exit early if no issues remain above the auto-accept threshold. Pass `ctx.profile.review.evaluatorStrictness` to the evaluator.
  4. **`evaluateStage`**: Pass `ctx.profile.review.evaluatorStrictness` to `builderEvaluate()` via options.

- `src/engine/review-heuristics.ts` — No changes needed. The `shouldParallelizeReview()` and `determineApplicableReviews()` functions remain as-is; the parallel reviewer just conditionally skips them.

## Detailed Implementation

### 1. `ParallelReviewerOptions` additions

```typescript
export interface ParallelReviewerOptions {
  // ... existing fields ...
  /** Override review strategy. 'auto' = existing heuristic, 'single' = always single, 'parallel' = always parallel */
  strategy?: 'auto' | 'single' | 'parallel';
  /** Override which review perspectives to use (only applies when parallel path is taken) */
  perspectives?: string[];
}
```

In `runParallelReview()`:
- If `strategy === 'single'`, immediately delegate to `runReview()` and return.
- If `strategy === 'parallel'`, skip the `shouldParallelizeReview()` check.
- If `perspectives` option is provided and we're on the parallel path, use it (cast to `ReviewPerspective[]`) instead of calling `determineApplicableReviews()`.

### 2. Evaluator strictness blocks

```typescript
const STRICTNESS_BLOCKS: Record<string, string> = {
  strict: `\n### Strictness: Strict\n\nApply a high bar for acceptance. Only accept fixes that are unambiguously correct — fixing a clear bug, crash, or security vulnerability. When in doubt, reject. Treat "review" verdicts as rejects.\n`,
  standard: '', // Default behavior, no additional text needed
  lenient: `\n### Strictness: Lenient\n\nApply a low bar for acceptance. Accept fixes unless they clearly damage the implementation's intent or remove functionality. When in doubt, accept. Treat "review" verdicts as accepts.\n`,
};
```

### 3. Issue severity filtering

```typescript
const SEVERITY_ORDER: Record<ReviewIssue['severity'], number> = {
  critical: 0,
  warning: 1,
  suggestion: 2,
};

function filterIssuesBySeverity(
  issues: ReviewIssue[],
  autoAcceptBelow?: 'suggestion' | 'warning',
): { filtered: ReviewIssue[]; autoAccepted: ReviewIssue[] } {
  if (!autoAcceptBelow) return { filtered: issues, autoAccepted: [] };
  const threshold = SEVERITY_ORDER[autoAcceptBelow];
  const filtered = issues.filter(i => SEVERITY_ORDER[i.severity] < threshold);
  const autoAccepted = issues.filter(i => SEVERITY_ORDER[i.severity] >= threshold);
  return { filtered, autoAccepted };
}
```

`autoAcceptBelow: 'warning'` means issues at `warning` severity and below (`warning`, `suggestion`) are auto-accepted. Only `critical` issues reach the fixer.
`autoAcceptBelow: 'suggestion'` means only `suggestion` severity issues are auto-accepted. `critical` and `warning` reach the fixer.

### 4. `review-cycle` build stage

```typescript
registerBuildStage('review-cycle', async function* reviewCycleStage(ctx) {
  const maxRounds = ctx.profile.review.maxRounds;
  const strategy = ctx.profile.review.strategy;
  const perspectives = ctx.profile.review.perspectives;
  const autoAcceptBelow = ctx.profile.review.autoAcceptBelow;
  const strictness = ctx.profile.review.evaluatorStrictness;

  for (let round = 0; round < maxRounds; round++) {
    // 1. Review
    yield* reviewStageInner(ctx, { strategy, perspectives });

    // 2. Filter issues
    const { filtered, autoAccepted } = filterIssuesBySeverity(ctx.reviewIssues, autoAcceptBelow);
    ctx.reviewIssues = filtered;

    if (filtered.length === 0) break; // No actionable issues

    // 3. Review-fix
    yield* reviewFixStageInner(ctx);

    // 4. Evaluate
    yield* evaluateStageInner(ctx, { strictness });
  }
});
```

The `*Inner` functions extract the core logic from the existing registered stages so both the standalone stages and the `review-cycle` stage can reuse them.

## Testing Strategy

### Unit Tests (`test/review-strategy-wiring.test.ts`)

**Strategy override in parallel reviewer:**
- `runParallelReview` with `strategy: 'single'` yields `build:review:start` and `build:review:complete` without parallel events, regardless of changeset size — verified by checking absence of `build:review:parallel:start` events. Uses `StubBackend`.
- `runParallelReview` with `strategy: 'parallel'` yields `build:review:parallel:start` even for small changesets (below the 10-file/500-line threshold). Uses `StubBackend`.

**Perspectives override:**
- `runParallelReview` with `perspectives: ['code', 'security']` yields a `build:review:parallel:start` event whose `perspectives` array matches `['code', 'security']`, ignoring file categories. Uses `StubBackend`.

**Issue severity filtering:**
- `filterIssuesBySeverity` with `autoAcceptBelow: 'suggestion'` removes `suggestion`-severity issues and returns them in `autoAccepted`.
- `filterIssuesBySeverity` with `autoAcceptBelow: 'warning'` removes both `warning` and `suggestion` issues.
- `filterIssuesBySeverity` with `undefined` returns all issues unmodified.

**Evaluator strictness injection:**
- `STRICTNESS_BLOCKS['strict']` contains "high bar" text.
- `STRICTNESS_BLOCKS['lenient']` contains "low bar" text.
- `STRICTNESS_BLOCKS['standard']` is empty string (no additional text).

**Review-cycle stage (pipeline-level):**
- Register `review-cycle` stage with a profile that sets `maxRounds: 2`. Mock the inner stages to yield events. Verify the review stage runs twice when issues persist after round 1.
- Register `review-cycle` with `maxRounds: 3` but have round 1 produce zero issues after filtering. Verify only 1 round of review runs (early exit).

**Backward compatibility:**
- Default profile (`maxRounds: 1`, `strategy: 'auto'`, `perspectives: ['code']`, `evaluatorStrictness: 'standard'`) produces identical behavior to the current hardcoded path.

## Verification

- [ ] `pnpm type-check` passes with zero errors
- [ ] `pnpm test` passes — all existing tests remain green, new tests in `test/review-strategy-wiring.test.ts` pass
- [ ] Setting `review.strategy: 'single'` in a profile causes `runParallelReview()` to always delegate to `runReview()` (no `build:review:parallel:start` event emitted)
- [ ] Setting `review.strategy: 'parallel'` causes `runParallelReview()` to skip the `shouldParallelizeReview()` heuristic and always fan out
- [ ] Setting `review.perspectives: ['code', 'security']` causes only those two perspective reviewers to run, regardless of file categories
- [ ] Setting `review.autoAcceptBelow: 'suggestion'` causes `suggestion`-severity issues to bypass the review-fixer — `build:review:fix:start` event shows reduced `issueCount`
- [ ] Setting `review.autoAcceptBelow: 'warning'` causes both `warning` and `suggestion` issues to bypass the review-fixer
- [ ] Setting `review.evaluatorStrictness: 'strict'` causes the evaluator prompt to contain "high bar" text; `'lenient'` causes "low bar" text; `'standard'` adds no extra text
- [ ] Setting `review.maxRounds: 2` causes the review-cycle stage to run up to 2 review passes
- [ ] The `review-cycle` build stage exits early when no issues remain above the `autoAcceptBelow` threshold
- [ ] Default profile (`BUILTIN_PROFILES['excursion']`) with `strategy: 'auto'`, `maxRounds: 1`, `perspectives: ['code']`, `evaluatorStrictness: 'standard'` produces identical event sequences to the current implementation
