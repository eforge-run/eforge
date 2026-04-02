---
id: plan-01-fix-evaluator-reset-target
name: Fix Evaluator Reset Target
depends_on: []
branch: fix-duplicate-feat-commits-created-by-evaluator-agent/fix-evaluator-reset-target
---

# Fix Evaluator Reset Target

## Architecture Context

The evaluator agent runs after test-cycle or review-cycle stages. It uses `git reset --soft HEAD~1` to separate staged (builder's implementation) from unstaged (reviewer/tester fixes) changes. When intermediate commits exist between the builder's commit and the evaluator (e.g., tester `test(...)` commits), `HEAD~1` only resets the last intermediate commit, leaving the builder's original `feat(...)` commit intact. The evaluator then creates a duplicate `feat(...)` commit on top.

The fix captures the commit SHA before the implement stage runs and threads it to the evaluator prompt so it resets to the exact pre-builder commit instead of a hardcoded `HEAD~1`.

## Implementation

### Overview

Add a `preImplementCommit` field to `BuildStageContext`, capture `git rev-parse HEAD` at the top of `implementStage`, pass the SHA through `evaluateStageInner` to `builderEvaluate`, and update the evaluator prompt to use `{{reset_target}}` instead of `HEAD~1`.

### Key Decisions

1. Use optional field (`preImplementCommit?: string`) with `HEAD~1` fallback so the system degrades gracefully when no prior commits exist (e.g., fresh repo).
2. Thread the value through the existing `BuilderOptions` interface rather than adding a new options type, keeping the API surface minimal.

## Scope

### In Scope
- Adding `preImplementCommit` optional field to `BuildStageContext`
- Capturing `git rev-parse HEAD` at the start of `implementStage`
- Passing `preImplementCommit` through `evaluateStageInner` to `builderEvaluate`
- Adding `preImplementCommit` to `BuilderOptions`
- Passing `reset_target` template variable to `loadPrompt('evaluator', ...)`
- Updating `evaluator.md` to use `{{reset_target}}` instead of hardcoded `HEAD~1`
- Updating the continuation context string to reference the actual reset target

### Out of Scope
- Changes to review-cycle flow (already works correctly since reviewer/fixer don't commit)
- Changes to builder, tester, or reviewer agents
- Any test changes (mechanical threading, existing tests cover the pipeline)

## Files

### Modify
- `src/engine/pipeline.ts` - Add `preImplementCommit?: string` to `BuildStageContext` (line ~95); capture `git rev-parse HEAD` at top of `implementStage` (line ~1314); pass `preImplementCommit` from `ctx` to `builderEvaluate` in `evaluateStageInner` (line ~1516)
- `src/engine/agents/builder.ts` - Add `preImplementCommit?: string` to `BuilderOptions` (line ~40); pass `reset_target: options.preImplementCommit ?? 'HEAD~1'` in `loadPrompt` call (line ~183); update continuation context string to use `options.preImplementCommit ?? 'HEAD~1'` instead of hardcoded `HEAD~1` (line ~175)
- `src/engine/prompts/evaluator.md` - Replace `git reset --soft HEAD~1` with `git reset --soft {{reset_target}}` (line ~19)

## Verification

- [ ] `pnpm type-check` exits with code 0
- [ ] `pnpm build` exits with code 0
- [ ] `pnpm test` exits with code 0 with all tests passing
- [ ] `BuildStageContext` interface contains `preImplementCommit?: string`
- [ ] `implementStage` runs `git rev-parse HEAD` before calling `builderImplement`
- [ ] `evaluateStageInner` passes `ctx.preImplementCommit` to `builderEvaluate`
- [ ] `BuilderOptions` contains `preImplementCommit?: string`
- [ ] `builderEvaluate` passes `reset_target` variable to `loadPrompt`
- [ ] `evaluator.md` contains `git reset --soft {{reset_target}}` and does not contain `git reset --soft HEAD~1`
- [ ] Continuation context string references `options.preImplementCommit ?? 'HEAD~1'` instead of hardcoded `HEAD~1`
