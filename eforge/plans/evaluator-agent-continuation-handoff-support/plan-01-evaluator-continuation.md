---
id: plan-01-evaluator-continuation
name: Evaluator Agent Continuation Support
depends_on: []
branch: evaluator-agent-continuation-handoff-support/evaluator-continuation
---

# Evaluator Agent Continuation Support

## Architecture Context

Builders and planners already have continuation loops that checkpoint progress and retry on `error_max_turns`. Evaluators lack this - they fail silently (plan-phase) or emit `build:failed` (build-phase), losing partial verdict progress. This plan adds continuation loops around all evaluator calls, following the same structural pattern but without git checkpoints since evaluator verdicts persist naturally via incremental `git add`/`git checkout --`.

## Implementation

### Overview

Add 4 new continuation event types, wire continuation context through evaluator agent options, update prompts with a `{{continuation_context}}` variable, wrap both `evaluateStageInner` and `runReviewCycle` evaluator phases in continuation loops, update CLI display for new events, and add tests.

### Key Decisions

1. **No git checkpoint for evaluators** - verdicts are applied incrementally (`git add`/`git checkout --`), so partial progress persists in the index/working tree without explicit commits. This differs from builder/planner continuations which need checkpoint commits.
2. **"No unstaged changes = success" heuristic** - if an evaluator hit `error_max_turns` but all files have been processed (no unstaged changes remain), treat it as success rather than retrying.
3. **Prompt ordering: continuation context before Setup** - the continuation context must appear before the `## Setup` section so the model sees "don't run `git reset --soft HEAD~1`" before the instruction to do so.
4. **Default 1 continuation** - evaluators have simpler tasks than builders (1 retry usually sufficient vs builder's default of 3).
5. **`builderEvaluate` re-throws `error_max_turns`** - currently all errors are caught and yielded as `build:failed`. Must selectively re-throw `error_max_turns` to enable the pipeline continuation loop, while keeping catch-and-yield for other errors.
6. **Not extracting a generic continuation helper** - the three loops (builder, planner, evaluator) share structure but differ enough in context-building, checkpointing, events, and error propagation that abstraction would add complexity without DRY benefit.

## Scope

### In Scope
- 4 new continuation event types in `EforgeEvent` union
- `evaluatorContinuationContext` field on `BuilderOptions`
- `continuationContext` field on `PlanPhaseEvaluatorOptions`
- `error_max_turns` re-throw in `builderEvaluate` (non-max-turns errors remain caught as `build:failed`)
- Continuation context text threaded into evaluator prompts via `{{continuation_context}}`
- `{{continuation_context}}` insertion in `evaluator.md` and `plan-evaluator.md` (between Context and Setup sections)
- Continuation loop in `evaluateStageInner` with unstaged-changes check
- Continuation loop in `runReviewCycle` evaluator phase with `continuationEventType` from callers
- `AGENT_MAX_CONTINUATIONS_DEFAULTS` entries for `evaluator`, `plan-evaluator`, `cohesion-evaluator`, `architecture-evaluator` (all defaulting to 1)
- CLI display cases for all 4 new continuation event types
- New test file `test/evaluator-continuation.test.ts`

### Out of Scope
- Generic continuation helper extraction
- Changes to git checkpoint behavior
- Changes to default continuation counts for builders or planners

## Files

### Create
- `test/evaluator-continuation.test.ts` - tests for evaluator continuation behavior using StubBackend

### Modify
- `src/engine/events.ts` - add 4 continuation event types to `EforgeEvent` union: `build:evaluate:continuation` (with `planId`, `attempt`, `maxContinuations`), `plan:evaluate:continuation`, `plan:architecture:evaluate:continuation`, `plan:cohesion:evaluate:continuation` (each with `attempt`, `maxContinuations`)
- `src/engine/pipeline.ts` - add `evaluator: 1`, `plan-evaluator: 1`, `cohesion-evaluator: 1`, `architecture-evaluator: 1` to `AGENT_MAX_CONTINUATIONS_DEFAULTS`; wrap `evaluateStageInner` evaluator call in continuation loop (resolve maxContinuations, loop with `error_max_turns` catch, check unstaged changes, yield `build:evaluate:continuation`); extend `ReviewCycleConfig` evaluator `run` signature to accept optional continuation context, add `continuationEventType` field; wrap `runReviewCycle` evaluator phase in continuation loop; update 3 call sites (`planReviewCycleStage`, `architectureReviewCycleStage`, `cohesionReviewCycleStage`) to pass `continuationEventType`
- `src/engine/agents/builder.ts` - add `evaluatorContinuationContext?: { attempt: number; maxContinuations: number }` to `BuilderOptions`; in `builderEvaluate`, build continuation context text when present, pass `continuation_context` to `loadPrompt`, re-throw `error_max_turns` errors while keeping catch-and-yield for others
- `src/engine/agents/plan-evaluator.ts` - add `continuationContext?: { attempt: number; maxContinuations: number }` to `PlanPhaseEvaluatorOptions`; in `runEvaluate`, build continuation context text when present, pass `continuation_context` to `loadPrompt`
- `src/engine/prompts/evaluator.md` - add `{{continuation_context}}` between Context section (after line 10) and Setup section (before line 12)
- `src/engine/prompts/plan-evaluator.md` - add `{{continuation_context}}` between Context section (after line 9) and Setup section
- `src/cli/display.ts` - add cases for `build:evaluate:continuation`, `plan:evaluate:continuation`, `plan:architecture:evaluate:continuation`, `plan:cohesion:evaluate:continuation` to update spinner text with "continuing (attempt X/Y)" pattern

## Verification

- [ ] `pnpm type-check` exits with code 0
- [ ] `pnpm test` exits with code 0, including all tests in `test/evaluator-continuation.test.ts`
- [ ] `AGENT_MAX_CONTINUATIONS_DEFAULTS` contains entries for `evaluator`, `plan-evaluator`, `cohesion-evaluator`, and `architecture-evaluator`, each defaulting to `1`
- [ ] `builderEvaluate` re-throws errors containing `error_max_turns` in the message
- [ ] `builderEvaluate` catches non-max-turns errors and yields `build:failed` event
- [ ] `builderEvaluate` passes `continuation_context` to `loadPrompt` when `evaluatorContinuationContext` is provided
- [ ] `builderEvaluate` passes empty string for `continuation_context` when `evaluatorContinuationContext` is absent
- [ ] `runEvaluate` passes `continuation_context` to `loadPrompt` when `continuationContext` is provided
- [ ] `evaluateStageInner` loops up to `maxContinuations` times on `error_max_turns`, checking `hasUnstagedChanges` before retrying
- [ ] `evaluateStageInner` yields `build:evaluate:continuation` events with `planId`, `attempt`, and `maxContinuations`
- [ ] `runReviewCycle` wraps evaluator phase in a continuation loop with the same unstaged-changes check pattern
- [ ] `planReviewCycleStage` passes `continuationEventType: 'plan:evaluate:continuation'` to `runReviewCycle`
- [ ] `architectureReviewCycleStage` passes `continuationEventType: 'plan:architecture:evaluate:continuation'` to `runReviewCycle`
- [ ] `cohesionReviewCycleStage` passes `continuationEventType: 'plan:cohesion:evaluate:continuation'` to `runReviewCycle`
- [ ] `evaluator.md` contains `{{continuation_context}}` between the Context and Setup sections
- [ ] `plan-evaluator.md` contains `{{continuation_context}}` between the Context and Setup sections
- [ ] `display.ts` handles all 4 new continuation event types with spinner text updates
