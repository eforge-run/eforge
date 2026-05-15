---
id: plan-03-compile-evaluator-parity
name: Compile Evaluator Parity
branch: harden-review-evaluation-cycles/plan-03-compile-evaluator-parity
agents:
  builder:
    effort: high
    rationale: Compile review cycles share retry machinery with build evaluation and
      need coordinated updates across runner, agents, prompts, and tests.
  reviewer:
    effort: high
    rationale: Review must confirm plan, cohesion, and architecture evaluator modes
      all use the same engine-applied contract.
  tester:
    effort: high
    rationale: Plan-phase parity requires temp git repo tests for all evaluator
      modes plus continuation and non-fatal failure behavior.
---

# Compile Evaluator Parity

## Architecture Context

Plan, cohesion, and architecture evaluators currently mirror the build evaluator risk: the prompt tells the evaluator agent to apply verdicts with git commands and commit planning artifacts. After plan 02, build evaluation is engine-enforced; this plan brings compile-phase evaluators onto the same structured judgment and engine application model.

## Implementation

### Overview

Update the shared compile `runReviewCycle()` and plan-phase evaluator agent so plan/cohesion/architecture reviewers can leave unstaged fixes, evaluators submit structured verdicts through custom tools, and engine code applies and commits accepted fixes through the shared evaluation helper.

### Key Decisions

1. Extend compile review-cycle evaluator configuration to prepare an evaluation snapshot after the reviewer phase and before evaluator retry begins. Store that snapshot in evaluator retry input so max-turn continuations re-use the original candidate diff.
2. Add optional model-tracker and evaluation snapshot options to `runPlanEvaluate()`, `runCohesionEvaluate()`, and `runArchitectureEvaluate()` so compile evaluation commits include model-aware trailers.
3. Reuse the same evaluation submission custom tools and mutation-tool denylist as the build evaluator.
4. Path-guard compile evaluation candidates to the active plan-set directory under `outputDir`; verdicts outside that directory raise an engine validation error.
5. Preserve compile review non-fatal policy for agent judgment failures, but emit `planning:error` for deterministic application errors such as unknown files, unknown hunks, patch drift, or patch-apply failure.

## Scope

### In Scope

- Plan, cohesion, and architecture evaluator prompt changes removing evaluator-owned git setup, apply, cleanup, and commit instructions.
- Shared compile `runReviewCycle()` changes needed to prepare snapshots and preserve them across evaluator retries.
- Plan-phase evaluator agent changes for structured submissions, custom tools, mutation-tool denylist, XML fallback, engine application, path guards, and model-aware commits.
- Continuation prompt and retry-input updates so evaluator retry no longer depends on partially staged agent progress.
- Tests for all three compile evaluator modes.

### Out of Scope

- Build evaluator changes; plan 02 owns that path.
- Planner, plan-reviewer, cohesion-reviewer, or architecture-reviewer submission contracts.
- Expedition module planning behavior outside the evaluator apply/commit step.
- Adaptive reviewer subset selection.

## Files

### Create

- `test/compile-evaluator-enforcement.test.ts` — plan/cohesion/architecture evaluator tests using temp git repos and structured submission tool calls.

### Modify

- `packages/engine/src/agents/plan-evaluator.ts` — use evaluation tools, structured submission capture, mutation-tool denylist, XML fallback, path-guarded engine application, model-aware forge commit, and hunk-preserving verdict summaries for all evaluator modes.
- `packages/engine/src/prompts/plan-evaluator.md` — remove setup/actions/final-commit sections and instruct the evaluator to inspect captured diffs and call the submission tool once.
- `packages/engine/src/pipeline/runners.ts` — extend `ReviewCycleConfig` so compile review cycles can prepare evaluation snapshots once and pass them through retry attempts.
- `packages/engine/src/pipeline/stages/compile-stages.ts` — pass plan-set path guards, commit messages, model tracker, and snapshot preparation callbacks into plan, architecture, and cohesion evaluator cycles.
- `packages/engine/src/retry.ts` — ensure plan/cohesion/architecture evaluator continuation input preserves evaluation snapshot/options and uses read-only continuation wording.
- `test/agent-wiring.test.ts` — update plan evaluator wiring assertions for custom tools, mutation-tool denylist, structured submissions, and hunk-preserving summaries.
- `test/evaluator-continuation.test.ts` — update plan/cohesion/architecture continuation prompt expectations.
- `test/retry.test.ts` — add or update compile evaluator retry tests to assert snapshot/options survive the second attempt.
- `test/cohesion-review.test.ts` — update cohesion/architecture evaluator verdict-count expectations for structured submission fallback and hunk metadata where relevant.

## Verification

- [ ] `runPlanEvaluate()` accepts a structured submission payload and creates a forge commit whose contents include accepted plan-review fixes and exclude rejected/review fixes.
- [ ] `runCohesionEvaluate()` applies accepted module-plan fixes only inside `<outputDir>/<planSetName>/modules/` and rejects a verdict path outside that directory before commit creation.
- [ ] `runArchitectureEvaluate()` applies an accepted architecture fix and commits through `forgeCommit(composeCommitMessage(...))` with `Co-Authored-By: forged-by-eforge`.
- [ ] A compile evaluator run that references an unknown hunk emits `planning:error`, creates no evaluation commit, and leaves the compile review cycle non-fatal to the outer pipeline.
- [ ] Plan/cohesion/architecture evaluator prompts contain no `git reset`, `git add`, `git checkout`, or `git commit` instruction.
- [ ] Continuation tests for plan, cohesion, and architecture evaluators assert the prompt references re-inspecting the captured diff rather than previously staged evaluator progress.
- [ ] The existing evaluator continuation and retry tests pass after the read-only evaluator model is in place.