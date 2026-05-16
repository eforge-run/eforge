---
id: plan-01-adaptive-review-cycle-perspectives
name: Adaptive Review-Cycle Perspective Selection
branch: implement-adaptive-reviewer-subset-selection/plan-01-adaptive-review-cycle-perspectives
agents:
  builder:
    effort: high
    rationale: Touches build-stage orchestration and the safety-sensitive verify
      perspective policy; deterministic selector behavior and event ordering
      need careful implementation.
  reviewer:
    effort: high
    rationale: Review must verify no direct decision emission bypasses, no unsafe
      verify pruning, and no schema drift.
  tester:
    effort: high
    rationale: Integration coverage needs real git/evaluation flow plus StubHarness
      agent sequencing across multiple review rounds.
---

# Adaptive Review-Cycle Perspective Selection

## Architecture Context

Build-stage review orchestration lives in `packages/engine/src/pipeline/stages/build-stages.ts`. The current `review-cycle` stage computes the configured perspective list once before the loop, emits `perspectives-respawned` with `dropped: []`, and passes the same list to `reviewStageInner` every round. `runParallelReview` already accepts a per-call perspective override, so adaptive selection belongs in the review-cycle orchestration layer rather than reviewer prompts or harness code.

Project constraints that apply here:

- Build decision events must be emitted through `emitBuildDecision` / `emitBuildDecisionForPlan`; this plan only changes the payload passed to the helper.
- Event schemas are owned by `@eforge-build/client`; the existing `perspectives-respawned` shape already has `perspectives` and `dropped`, so no wire-schema change is planned.
- Tests must use real code and `StubHarness`, not mocks.
- `verify` is the integration gate for sharded builds and needs conservative retention rules.

## Implementation

### Overview

Add a pure deterministic selector for review-cycle perspective state, wire it into `reviewCycleStage`, preserve per-perspective review data from `reviewStageInner`, extend internal evaluation summary state with file-level verdict summaries, render dropped perspectives in the monitor decision details, and remove the shipped roadmap item.

### Key Decisions

1. **Create a pure selector module.** Add `packages/engine/src/review-cycle-perspectives.ts` with exported selection types and `selectNextReviewPerspectives(input)`. The selector must not call agents or perform I/O.

2. **Use stable perspective ordering.** The selector must preserve the original configured/inferred order for both active and dropped lists. Use the previous round's actual parallel start order when the plan had no explicit configured perspectives and review inference supplied the first active set.

3. **Fallback instead of pruning when evidence is incomplete.** If the previous review was not parallel, any active perspective lacks a completion event, a perspective errored, or evaluation summary data needed for category overlap is missing, return the previous active list and `dropped: []` with a fallback rationale.

4. **Keep perspectives with prior issues.** Any perspective that reported one or more issues in the prior round must remain active for the next round. This includes issues whose proposed fixes were accepted, rejected, or marked for review by the evaluator.

5. **Keep perspectives whose concern areas were touched by evaluator verdicts.** Convert evaluation file summaries into relevant file paths and feed them through `categorizeFiles()` plus `determineApplicableReviewsWithRules()`. Accepted, rejected, and review verdicts all count as concern evidence. This keeps, for example, `security` for code/dependency files and `docs` for docs files even when that perspective had zero prior issues.

6. **Special-case `verify` conservatively.** Keep `verify` when it reported a prior issue. Keep `verify` after accepted non-doc changes, including code, API, test, dependency, config, and unknown file paths. Allow `verify` to drop after a clean verify round when accepted evaluator changes are docs-only. Rejected/review file verdicts alone do not prove a committed change that can invalidate verification commands, but a prior verify issue still pins `verify` for the follow-up round.

7. **Keep event shape unchanged.** Continue emitting `perspectives-respawned` at the start of each round. For round 1, emit the configured list or `[]` for auto-inference. For round 2+, emit the selected active list and the dropped list computed after the prior evaluation.

8. **No daemon API version bump.** Do not change `BuildDecisionSchema`, `DAEMON_API_VERSION`, or event discriminants unless implementation proves the existing shape cannot represent the behavior.

### Selector Contract

Implement a selector API along these lines:

```ts
export interface ReviewCycleEvaluationSummary {
  ran: boolean;
  accepted: number;
  rejected: number;
  review: number;
  files: Array<{
    file: string;
    mode: 'file' | 'hunks';
    action?: 'accept' | 'reject' | 'review';
    acceptedHunks: number[];
    rejectedHunks: number[];
    reviewHunks: number[];
  }>;
}

export interface SelectNextReviewPerspectivesInput {
  initialOrder: ReviewPerspective[];
  previousActive: ReviewPerspective[];
  issuesByPerspective?: Partial<Record<ReviewPerspective, ReviewIssue[]>>;
  evaluation?: ReviewCycleEvaluationSummary;
  previousReviewWasParallel: boolean;
  perspectiveErrors?: ReviewPerspective[];
}

export interface SelectNextReviewPerspectivesResult {
  perspectives: ReviewPerspective[];
  dropped: ReviewPerspective[];
  rationale: string;
  fallback: boolean;
}
```

The exact type names can differ, but the behavior above must be covered by tests.

### Build-stage Wiring

Modify `reviewStageInner` in `packages/engine/src/pipeline/stages/build-stages.ts` so it still yields the same events but returns round-local review metadata to callers:

- `parallel: boolean` derived from `plan:build:review:parallel:start`.
- `activePerspectives` from `plan:build:review:parallel:start.perspectives`.
- `issuesByPerspective` from `plan:build:review:parallel:perspective:complete` events.
- `perspectiveErrors` from `plan:build:review:parallel:perspective:error` events.
- `completeIssueCount` from `plan:build:review:complete.issues.length`.

Keep the standalone `review` stage behavior unchanged by ignoring the return value when `yield* reviewStageInner(ctx)` is called outside `reviewCycleStage`.

Extend the internal `LastBuildEvaluation` state in the same file:

- Add `review: number` and `files: EvaluationFileVerdictSummary[]` (or an equivalent internal summary type).
- In all non-run/failure paths, store `ran: false`, zero counts, and `files: []`.
- After `applyEvaluationVerdicts`, store `accepted`, `rejected`, `review`, and `files` from the returned application summary.
- Keep the emitted `plan:build:evaluate:complete` event unchanged.

Update `reviewCycleStage` loop state:

1. Initialize `initialConfiguredPerspectives` from `ctx.review.perspectives` when non-empty; otherwise leave the first round in auto-inference mode.
2. Maintain `activePerspectivesForRound` and `droppedForRound`. The first round uses the configured list or `undefined` for auto.
3. Emit `perspectives-respawned` before each review with `perspectives: activePerspectivesForRound ?? []` and the current `droppedForRound`.
4. Call `reviewStageInner(ctx, { strategy, perspectives: activePerspectivesForRound })` and capture the returned review metadata.
5. Preserve the existing no-issues termination immediately after a clean review round.
6. Run `reviewFixStageInner` and `evaluateStageInner` as today.
7. If another round remains, call `selectNextReviewPerspectives` with the previous review metadata and the latest `LastBuildEvaluation`.
8. Set the next round active/dropped/rationale values from the selector result. The next round `perspectives-respawned` rationale must include the selector rationale, not only `Starting review round N`.
9. If the selector returns an empty active list before `maxRounds`, emit `cycle-terminated` with `reason: 'no-issues'`, `issuesRemaining: 0`, and a rationale explaining that no review perspectives remain relevant after evaluation.

### Selector Rules

The selector must apply these deterministic rules in order:

1. If fallback conditions apply, return all `previousActive` perspectives and `dropped: []`.
2. For each perspective in stable order:
   - Keep it if the prior issue count for that perspective is greater than zero.
   - Keep it if evaluator file summaries map to the perspective through `determineApplicableReviewsWithRules()`.
   - For `verify`, keep it if it had prior issues or if accepted evaluator files are not docs-only.
   - Drop it otherwise.
3. Return dropped perspectives in the same stable order as the initial/previous active list.
4. Include a rationale string that mentions both retained and dropped counts, and mentions fallback when fallback was used.

### Monitor Formatting

Modify `packages/monitor-ui/src/lib/decision-format.ts`:

- In `decisionSummary`, include dropped perspectives for `perspectives-respawned` when `dropped.length > 0`.
- In `decisionDetail`, add a `Dropped:` line for `perspectives-respawned`, using `(none)` when the array is empty.

### Roadmap Cleanup

Remove the shipped `Adaptive reviewer subset selection` item from `docs/roadmap.md`. If the `Orchestrator Intelligence` section has no remaining future items after removal, remove that section and its separator so the roadmap contains only future work.

## Scope

### In Scope

- Deterministic adaptive selection for build-phase `review-cycle` rounds after round 1.
- Per-perspective review result capture from existing parallel review events.
- Internal evaluation summary plumbing needed by the selector.
- Conservative `verify` retention policy.
- Accurate `perspectives-respawned.perspectives` and `.dropped` arrays.
- Monitor decision formatting for dropped perspectives.
- Unit and integration tests for selector and review-cycle behavior.
- Roadmap cleanup for the shipped item.

### Out of Scope

- New event variants, new required event fields, or daemon API version changes.
- Reviewer prompt changes, new reviewer perspective names, or custom perspective support.
- Adaptive planning-phase review cycles such as `plan-review-cycle`, `architecture-review-cycle`, or `cohesion-review-cycle`.
- LLM-based perspective selection.
- Changes to review-fixer or evaluator judgment semantics beyond internal summary capture.

## Files

### Create

- `packages/engine/src/review-cycle-perspectives.ts` — Pure selector types and `selectNextReviewPerspectives` implementation.
- `test/review-cycle-perspectives.test.ts` — Unit tests for selector rules and ordering.
- `test/review-cycle-adaptive.test.ts` — Build-stage integration test using `StubHarness` and a real temp git repo to prove round 2 spawns fewer reviewer agents than round 1.

### Modify

- `packages/engine/src/pipeline/stages/build-stages.ts` — Capture round-local perspective results, extend internal evaluation summary, and select per-round active perspectives in `reviewCycleStage`.
- `packages/monitor-ui/src/lib/decision-format.ts` — Render dropped perspectives in summary/detail for `perspectives-respawned`.
- `packages/monitor-ui/src/lib/reducer/__tests__/handle-decisions.test.ts` — Add formatting assertions for non-empty dropped arrays.
- `test/sharded-build-via-review-cycle.test.ts` — Keep or update assertions so `verify` remains active after a prior verification failure.
- `docs/roadmap.md` — Remove the shipped roadmap item and any empty section left behind.

### No Database Migration

No database schema or persisted daemon state changes are required.

## Verification

- [ ] `pnpm type-check` exits with code 0.
- [ ] `pnpm test -- test/review-cycle-perspectives.test.ts test/review-cycle-adaptive.test.ts packages/monitor-ui/src/lib/reducer/__tests__/handle-decisions.test.ts test/sharded-build-via-review-cycle.test.ts` exits with code 0.
- [ ] Selector tests cover zero-issue drop, prior-issue retention, category-overlap retention, rejected/review verdict concern retention, `security` retention for code/dependency paths, `verify` retention after verification issues, `verify` retention after accepted code/test/dependency/config paths, `verify` drop for docs-only accepted paths, stable ordering, and fallback with missing data.
- [ ] The adaptive integration test observes a first `plan:build:review:parallel:start` with multiple perspectives and a later `plan:build:review:parallel:start` with fewer perspectives.
- [ ] The adaptive integration test observes a round 2 `perspectives-respawned` decision whose `perspectives` array omits zero-issue stale perspectives and whose `dropped` array lists those omitted perspectives.
- [ ] Monitor formatting tests assert `decisionDetail` contains `Dropped: api` for a `perspectives-respawned` decision with `dropped: ['api']`.
- [ ] `docs/roadmap.md` no longer contains the text `Adaptive reviewer subset selection`.
