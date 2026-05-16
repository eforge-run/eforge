---
title: Implement Adaptive Reviewer Subset Selection
created: 2026-05-16
profile: pi-codex-5-5
---

# Implement Adaptive Reviewer Subset Selection

## Problem / Motivation

The current build-phase `review-cycle` respawns the full configured reviewer perspective set every round, even when earlier rounds show that some perspectives are irrelevant. This wastes agent work and obscures useful orchestration decisions.

This work implements the roadmap item under `docs/roadmap.md` → Orchestrator Intelligence: adaptive reviewer subset selection. The roadmap says the wire protocol and UI rendering exist, but `packages/engine/src/pipeline/stages/build-stages.ts` still respawns the full perspective set every round with `dropped: []`.

Evidence from build `23dc6b61-1a78-4b78-8aab-084a2c0b0607` confirms the current behavior:

- Round 1 and round 2 both spawned `code`, `docs`, `test`, `security`, and `verify`.
- Both `perspectives-respawned` decisions had `dropped: []`.
- Some first-round perspectives, including `code` and `verify`, found no issues, yet both were respawned in the second round.

Relevant implementation context:

- `packages/engine/src/pipeline/stages/build-stages.ts` owns `reviewCycleStage`.
  - It computes `const perspectives = ctx.review.perspectives.length > 0 ? ctx.review.perspectives : undefined` once before the loop.
  - It emits `perspectives-respawned` with `perspectives: perspectives ?? []` and `dropped: []`.
  - It calls `reviewStageInner(ctx, { strategy, perspectives })` every round.
- `packages/engine/src/agents/parallel-reviewer.ts` owns `runParallelReview`.
  - If an explicit perspective override is passed, it uses that list as-is.
  - Otherwise it infers perspectives from changed files with `determineApplicableReviewsWithRules()` and emits `perspectives-inferred`.
- `packages/client/src/events.schemas.ts` already defines the `perspectives-respawned` decision payload with `perspectives` and `dropped`, so the wire shape likely does not need to change.
- `packages/monitor-ui/src/lib/decision-format.ts` renders active perspectives but currently does not surface dropped perspectives in the details.
- Tests already cover build evaluation/reporting around review cycles in `test/build-evaluator-enforcement.test.ts`, decision schema parsing in `test/decisions.test.ts`, and monitor reducer/format behavior under `packages/monitor-ui/src/lib/**/__tests__`.

Project constraints from `AGENTS.md` that matter here:

- Event schemas are client-owned.
- All build decision emissions must use `emitBuildDecision`.
- Tests should use real code and `StubHarness`.
- Documentation/roadmap should remain future-focused after shipping.

Early assumptions / unknowns:

- Assumption: adaptive selection can be deterministic engine logic, not another LLM call.
  - Confidence: high.
  - Rationale: required signals are already available from perspective issue counts, evaluator application counts, and configured perspectives.
- Assumption: the first implementation should avoid dropping `verify` automatically because it is the subprocess/integration gate, especially for sharded builds.
  - Confidence: high.
  - Evidence: `sharded-plan-guard.ts` comments and `reviewer-verify.md` behavior.
- Unknown: the exact pruning rule should balance cost reduction against missing cross-perspective overlap.
  - A conservative rule is preferable for the first slice.

## Goal

Implement adaptive perspective selection inside build-phase `review-cycle` so round 2+ can run a smaller perspective set than round 1, while preserving relevant perspectives and safety-sensitive verification behavior.

## Approach

### Current architecture

`reviewCycleStage` in `packages/engine/src/pipeline/stages/build-stages.ts` is the orchestration point. It computes the configured perspectives once before the `for (round...)` loop and passes the same list to `reviewStageInner` every time. Its `perspectives-respawned` decision event always reports `dropped: []`.

`runParallelReview` in `packages/engine/src/agents/parallel-reviewer.ts` already supports a per-call perspective override. Adaptive selection can therefore live above it in `reviewCycleStage`; no reviewer prompt or harness changes are required.

Per-perspective issue detail is available in the event stream, but `reviewStageInner` currently only writes the merged `plan:build:review:complete` issue list into `ctx.reviewIssues`. Selection logic needs either local capture of perspective completions or a small extension to context/internal helper state.

Evaluation currently stores only `{ ran, accepted, rejected }` in `__plan02LastBuildEvaluation`. The lower-level evaluation application already has file-level summaries, `EvaluationVerdictSummary.files`, so selection can be more precise by carrying accepted/review/rejected file summaries into the review-cycle loop.

### Target architecture

Add a small pure selection layer for review-cycle perspective state.

Candidate module/function names:

- `packages/engine/src/review-cycle-perspectives.ts`
- `selectNextReviewPerspectives(input)`
- `ReviewCyclePerspectiveState`

The selection layer should receive:

- Initial/configured perspectives for the plan.
- Active perspectives from the previous round.
- Per-perspective issues from the previous review.
- Evaluation summary/files from the previous evaluation pass.
- Whether a perspective is safety-critical or special-case, especially `verify`.

It should return:

- Next active perspectives.
- Dropped perspectives.
- Rationale strings suitable for the existing decision event.

`reviewCycleStage` should own the loop state:

1. Start round 0 with the configured/inferred perspective behavior that exists today.
2. Capture actual perspective results from `reviewStageInner` / events.
3. After `review-fix` + `evaluate`, compute the next round's active perspective list before the next loop iteration.
4. Emit `perspectives-respawned` using the active list for that round and the dropped list from the previous selection decision.
5. If no perspectives remain before max rounds, terminate early with an existing `cycle-terminated` event using reason `no-issues` and a rationale that explains that no review perspectives remain relevant after evaluation.

### Design decisions

1. **Keep selection deterministic and engine-owned.**
   - Implement pruning as pure TypeScript logic in the engine rather than asking another agent which perspectives to run.
   - Rationale: the goal is cost/control-flow optimization; the engine already has enough evidence from review results and evaluation summaries. This keeps behavior testable and avoids another expensive/variable LLM turn.

2. **Use the existing `perspectives-respawned` decision event.**
   - Do not add a new event variant for the first slice.
   - Populate the existing `perspectives` and `dropped` arrays accurately.
   - Rationale: `packages/client/src/events.schemas.ts` already models the desired wire shape, and the roadmap says protocol/UI rendering are in place.

3. **Track per-perspective review results inside the review stage.**
   - Have `reviewStageInner` or a nearby helper collect `plan:build:review:parallel:perspective:complete` events into a round-local map while still yielding the events unchanged.
   - Rationale: `ctx.reviewIssues` is deduplicated/merged and loses which perspective reported what. Selection needs perspective attribution.

4. **Carry evaluation file summaries into selection state.**
   - Extend the internal `LastBuildEvaluation` shape to include the evaluation application file summary or at least accepted/review/rejected file paths.
   - Keep wire event changes optional.
   - Rationale: pruning should account for the nature of accepted fixes. If accepted fixes touch docs, docs remains relevant; if they touch code/deps, code/security and possibly verify remain relevant.

5. **Use a conservative first-pass selection rule.**
   - For round N+1, keep a perspective if any of the following is true:
     - It reported one or more issues in round N.
     - Accepted evaluator changes touched file categories that map to that perspective through `determineApplicableReviewsWithRules()`.
     - It is `verify` and either `verify` reported a prior issue or accepted non-doc changes could affect build/test verification.
   - Drop perspectives that had zero issues and whose concern area was not touched by accepted evaluator changes.
   - Rationale: this reduces obvious waste while avoiding aggressive pruning that could miss changes introduced by the review fixer.

6. **Treat rejected/review evaluator verdicts as still-relevant concern evidence.**
   - If a perspective reported issues but the evaluator rejected or marked fixes for review, keep that perspective in the next round rather than assuming the concern is gone.
   - Rationale: rejected fixes mean the underlying concern may remain unresolved; a re-review may either restate it or confirm no action is needed after engine cleanup.

7. **Special-case `verify` cautiously.**
   - Do not permanently pin `verify` every round.
   - Drop it after a clean round only when no accepted non-doc/non-generated changes were applied.
   - Keep it after prior verification failures or accepted code/test/dependency/config fixes.
   - Rationale: `verify` can be expensive but is the integration gate for sharded builds. This policy avoids the observed repeated no-op `verify` when only docs/test wording fixes are being churned, while preserving verification after changes that can break commands.

8. **Keep order stable.**
   - Preserve original configured perspective order when returning active/dropped lists.
   - Rationale: stable event output is easier to test and reason about.

9. **Document dropped perspectives in monitor formatting.**
   - Update `decisionSummary`/`decisionDetail` so `dropped` is visible, at least in detail view.
   - Rationale: the feature is explicitly about observability as well as pruning.

10. **Fallback safely.**
    - If selection cannot determine relevance because data is missing or the prior review was single-reviewer/non-parallel, keep current behavior rather than dropping.
    - Rationale: adaptive pruning should never make less-informed decisions than the existing implementation.

### Wire/UI impact

The existing `BuildDecisionSchema` already supports `perspectives` and `dropped` on `perspectives-respawned`, so a breaking schema/API bump is likely unnecessary.

Monitor formatting should show dropped perspectives in detail and, optionally, summary text.

### Testing impact

Add focused tests around the pure selector plus a review-cycle integration test using `StubHarness`.

Existing sharded verify tests will likely need to assert that `verify` is preserved when it found a prior verification failure or when accepted non-doc fixes could invalidate verification.

### Assumptions and validation

Recommended profile: **Excursion**.

Rationale: this is a focused engine/control-flow change with a clear implementation locus: `reviewCycleStage`, a pure selector helper, internal evaluation summary plumbing, and monitor formatting/tests. It is architecture-affecting, but a single cohesive plan can cover it without delegated module planning. It is not trivial enough for Errand because it touches orchestration behavior and safety-sensitive verify policy.

| Assumption | Evidence / validation performed | Confidence | Cost to validate further | Validation path | Impact if wrong |
|------------|----------------------------------|------------|--------------------------|-----------------|-----------------|
| Current engine always respawns the original perspective set. | Inspected `reviewCycleStage` in `packages/engine/src/pipeline/stages/build-stages.ts`; observed live run events with identical round 1/2 perspective starts and `dropped: []`. | high | low | Add regression test around `review-cycle` event stream. | Low; this is the defect being fixed. |
| Existing wire protocol can represent adaptive pruning without schema changes. | Inspected `BuildDecisionSchema`; `perspectives-respawned` already has `perspectives` and `dropped`. `test/decisions.test.ts` already validates a non-empty `dropped` example. | high | low | Run `pnpm test -- test/decisions.test.ts` after implementation. | Low; if more rationale detail is needed, could use existing rationale string or add optional fields. |
| `runParallelReview` can accept different perspective lists per round. | Inspected `runParallelReview`; it uses the supplied `perspectivesOverride` directly for each call. | high | low | Build-stage integration test with different round 1/round 2 active sets. | Medium; if false, changes would need to move into reviewer agent code, increasing scope. |
| Per-perspective issues can be captured from yielded events without changing event shapes. | `runParallelReview` already yields `plan:build:review:parallel:perspective:complete` with `perspective` and `issues`; `reviewStageInner` currently observes all events. | high | low | Add a local capture map and unit/integration tests. | Low; alternative is to change `runParallelReview` return structure, but event capture is simpler. |
| Evaluation summaries can expose accepted/rejected file paths to selection logic. | `applyEvaluationVerdicts` returns `EvaluationVerdictSummary.files`; `evaluateStageInner` currently stores only counts in internal `LastBuildEvaluation`. | high | low | Extend internal type and tests in `test/build-evaluator-enforcement.test.ts`. | Medium; without file paths, selection would have to be more conservative and keep more perspectives. |
| Conservative category-based relevance is good enough for a first implementation. | Existing `review-heuristics.ts` maps file categories to review perspectives and is already used for initial inference. | medium | medium | Exercise through real builds and inspect false drops/keeps. | Medium; overly aggressive rules could miss issues, overly conservative rules reduce cost savings. |
| `verify` should be special-cased rather than treated like ordinary zero-issue perspectives. | `sharded-plan-guard.ts` describes `verify` as the integration gate for sharded plans; `reviewer-verify.md` runs plan verification commands and reports critical failures. | high | low | Keep/update sharded review-cycle tests. | High; dropping verify after relevant fixes could allow broken builds through review-cycle. |
| Monitor UI only needs formatting updates, not state model changes. | `decision-format.ts` already handles `perspectives-respawned`; reducer stores generic decisions. | high | low | Add/adjust formatting tests. | Low; if display needs richer metadata, still likely contained to UI formatting. |

No low-confidence/high-impact assumption is unresolved. The highest-impact assumption is the verify policy; it is mitigated by explicitly keeping verify after verification failures and after accepted non-doc fixes.

## Scope

### In scope

- Implement adaptive perspective selection inside build-phase `review-cycle` so round 2+ can run a smaller perspective set than round 1.
- Preserve the existing `plan:build:decision` / `perspectives-respawned` wire shape, but populate `perspectives` with the active set for that round and `dropped` with perspectives intentionally omitted.
- Base pruning on deterministic engine state, not an extra LLM call:
  - Per-perspective issues emitted by `plan:build:review:parallel:perspective:complete`.
  - Accepted/rejected evaluation summary from `evaluateStageInner`.
  - File-category heuristics in `review-heuristics.ts`.
- Add unit/integration coverage proving later rounds do not respawn irrelevant zero-issue perspectives, while preserving relevant perspectives after accepted fixes.
- Update monitor decision formatting to display dropped perspectives where helpful.
- Update/remove the shipped roadmap item after implementation.

### Out of scope

- New review perspective names or planner prompt changes for selecting perspective lists.
- New event variants or breaking wire schema changes unless implementation reveals the current `perspectives-respawned` shape is insufficient.
- Changing `runParallelReview` prompt behavior or review issue schemas.
- Changing review-fixer or evaluator judgment behavior beyond exposing enough evaluation summary to selection logic.
- Adaptive planning-phase review cycles: `plan-review-cycle`, architecture/cohesion review cycles. This plan targets build-phase reviewer perspectives only.

### Roadmap relation

Directly implements the current Orchestrator Intelligence roadmap item: “Adaptive reviewer subset selection.”

## Acceptance Criteria

1. **Adaptive round spawning**
   - Given a parallel `review-cycle` with multiple perspectives and `maxRounds > 1`, round 1 starts with the configured/inferred perspective set.
   - Given a perspective reports zero issues in round 1 and no accepted evaluator changes touch its concern area, round 2 does not spawn that perspective.
   - The round 2 `perspectives-respawned` decision lists only active perspectives in `perspectives` and lists omitted perspectives in `dropped`.

2. **Relevant perspectives are preserved**
   - A perspective that reported issues in the prior round remains active in the next round unless the cycle terminates.
   - A perspective whose file-category concern area is touched by accepted evaluator changes remains active even if it had zero issues in the prior round.
   - Security remains active for accepted code/dependency changes according to existing review heuristics.

3. **Verify perspective safety**
   - `verify` is kept for a follow-up round after prior verification failures.
   - `verify` is kept after accepted code/test/dependency/config fixes that could invalidate verification commands.
   - `verify` can be dropped after a clean verify round when accepted changes are limited to docs or other categories that do not affect verification.
   - Existing sharded build tests still pass or are updated to assert this policy explicitly.

4. **No schema breakage**
   - `BuildDecisionSchema` continues to validate `perspectives-respawned` events with non-empty `dropped` arrays.
   - No daemon API version bump is required unless a new wire field is introduced.

5. **Observability**
   - Monitor decision formatting shows dropped perspectives for `perspectives-respawned` decisions.
   - Decision rationale explains why perspectives were kept/dropped at a useful high level.

6. **Tests**
   - Add pure selector tests for:
     - Zero-issue drop.
     - Issue perspective kept.
     - Category-overlap kept.
     - Rejected/review verdict keeps concern.
     - Verify safety.
     - Stable ordering.
     - Missing-data fallback.
   - Add at least one build-stage integration test using `StubHarness` where round 2 spawns fewer reviewer agents than round 1.
   - Add/update monitor formatting tests for dropped perspective display.

7. **Roadmap cleanup**
   - After implementation, remove the shipped “Adaptive reviewer subset selection” item from `docs/roadmap.md`.
