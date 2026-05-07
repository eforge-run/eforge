---
id: plan-02-decision-emission-and-ui
name: Engine emission sites, monitor-UI rendering, and integration tests
branch: orchestrator-decision-events-emit-typed-events-at-build-phase-orchestrator-decision-points-surface-in-monitor-ui/plan-02-decision-emission-and-ui
---

# Engine emission sites, monitor-UI rendering, and integration tests

## Architecture Context

Plan-01 established the typed surface: `plan:build:decision` event variant, `emitBuildDecision` helper, `RunState.decisions` slice, and a registered handler. This plan lights up the data path:

- The engine emits `plan:build:decision` events at every build-phase orchestrator decision site (seven sites total, mapped to the seven `BuildDecision.kind` values).
- The monitor UI renders decisions as a per-plan timeline track inside `plan-row.tsx`, with shadcn-tooltip hover and a click-through detail panel.
- An integration test in `test/agent-wiring.test.ts` asserts the expected sequence of decision events fires for a `StubHarness`-driven build with `auto` strategy and a synthetic changeset that crosses the parallelization threshold.
- The grep gate enforcing the `emitBuildDecision` convention (analogous to `mutateState`) is added once emission sites exist to be enforced.
- `docs/roadmap.md` is updated post-implementation: build-phase portion of the "Orchestrator decision events" bullet is removed, plan-phase portion preserved as a follow-up.

Key emission-site mechanics (verified at planning, file/line references current to commit `3e52ba4`):

- `packages/engine/src/pipeline/stages/build-stages.ts` is a generator-stage file. `reviewStageInner` (lines 125-158) yields events directly via `yield`, with strategy dispatch at line 143. `reviewCycleStage` (lines 560-572) is a `for (let round = 0; round < maxRounds; round++)` loop where the termination check is `if (ctx.reviewIssues.length === 0) break;` at line 568.
- `packages/engine/src/agents/parallel-reviewer.ts` is also a generator. `runParallelReview` at line 76 yields events at lines 160, 168, 195, 218; `shouldParallelizeReview` is at line 120 and `determineApplicableReviews` at line 142.
- `packages/engine/src/agents/merge-conflict-resolver.ts` yields `plan:merge:resolve:start` at line 23 and `plan:merge:resolve:complete` at lines 56/60. The decision event is emitted alongside resolution success (around line 60).
- `packages/engine/src/eforge.ts` yields `recovery:start` at line 1622; `recovery:apply:complete` is yielded later in the same recovery flow. The decision event is dual-emitted next to `recovery:apply:complete` (the existing event is unchanged).
- The engine's `BuildStageContext` exposes `planId` (lines 51-67 of `packages/engine/src/pipeline/types.ts`), so the helper signature `(ctx, decision) => Event` works for stage code. `parallel-reviewer.ts` and `merge-conflict-resolver.ts` operate with a `planId` parameter directly (not a full `ctx`); they construct decision events via the helper using a lightweight context.
- `eforge.ts` recovery operates on a `prdId`, but the recovery decision is attributed to the failing plan's `planId` (recovery agent has access to it through the failure record).

## Implementation

### Overview

1. Wire seven build-phase decision-emission sites in the engine. Every site calls `emitBuildDecision` from `packages/engine/src/decisions.ts`; no raw `yield { type: 'plan:build:decision', ... }` outside that file.
2. Generalize `emitBuildDecision` if needed to accept either a `BuildStageContext` or a minimal `{ planId }` object so `parallel-reviewer.ts` and `merge-conflict-resolver.ts` (which don't carry a full ctx) can call it. Prefer overloading the helper signature over context faking.
3. Add a grep-gate test (mirroring `mutateState`) at `test/decision-helper-discipline.test.ts` that fails if any source file outside `packages/engine/src/decisions.ts` contains the literal string `type: 'plan:build:decision'`.
4. Add a new monitor-UI component `packages/monitor-ui/src/components/pipeline/decision-timeline.tsx` that renders decisions as small pips, color-coded by `kind` family (review = blue, evaluator = amber, recovery = red, merge = purple). Hover surfaces `kind`, `rationale`, and one or two key fields via the existing shadcn `Tooltip`. Click opens a side panel with the full payload (`Sheet` from shadcn).
5. Wire `<DecisionTimeline decisions={runState.decisions[planId] ?? []} />` into `plan-row.tsx` and thread `runState.decisions` from `app.tsx` down to the pipeline view.
6. Extend `test/agent-wiring.test.ts` with one new scenario that drives a `StubHarness` build through `reviewStageInner` with `strategy: 'auto'` and a synthetic large changeset, asserting the expected order: `review-strategy` → `perspectives-inferred` → `perspectives-respawned` → (round-end) `cycle-terminated`.
7. Update `docs/roadmap.md`: in the "Orchestrator Intelligence" section, modify the "Orchestrator decision events" bullet to reflect that build-phase emission has shipped and only plan-phase emission remains (do not delete the bullet entirely).

### Key Decisions

1. **Emit in the file closest to the decision.** `review-strategy` is emitted in `reviewStageInner` because the dispatch happens there; the `auto` block (when `source === 'auto-threshold'`) is composed by `parallel-reviewer.ts` since it has the file/line metrics — but the actual yield site stays in `reviewStageInner`. To bridge, `runParallelReview` either returns the auto block via a side-channel (a setter on `ctx`) or accepts a callback to compose the decision payload. Simplest: `parallel-reviewer.ts` exposes a small internal utility that computes `{ files, lines, threshold }` from the changeset and `reviewStageInner` calls it directly.
2. **Always emit `review-strategy` and `evaluator-strictness`.** Per PRD Design Decision 4 and user confirmation: emit regardless of value; consumers don't need to special-case absent decisions. `source: 'config' | 'auto-threshold'` for strategy, `source: 'config' | 'default'` for strictness.
3. **Emit `perspectives-inferred` only when inference happened.** When the user supplied an explicit `review.perspectives` override, no inference ran — no decision to record. Skip the emission. This satisfies the PRD acceptance criterion "A build run with explicit `review.perspectives` does not emit `perspectives-inferred`."
4. **Emit `perspectives-respawned` every round inside `reviewCycleStage`.** Today `dropped: []` (no adaptive logic); the future "adaptive reviewer respawn" roadmap item populates it.
5. **Emit `cycle-terminated` at both exit paths.** `'no-issues'` immediately before the `break` at line 568; `'max-rounds'` once the `for` loop exhausts (i.e., after the loop, when the final round completed but issues remained).
6. **Recovery dual-emit, no reshape.** `recovery:apply:complete` is unchanged. Immediately before/after that yield, also yield `emitBuildDecision({ planId: failingPlanId }, { kind: 'recovery-verdict', verdict, successorPrdId, rationale })`.
7. **Merge-conflict-resolution emitted on resolution success.** Inside `merge-conflict-resolver.ts`, after the resolver agent yields its `plan:merge:resolve:complete` (line 60) with `resolved: true`, also emit the decision event with `strategy: 'agent-resolved'` and the conflicted file paths the resolver acted on.
8. **DecisionTimeline color families chosen for visual scanning.** Review = blue (cool), evaluator = amber (warning), recovery = red (error/recovery), merge = purple (merge step). Color is decoration only; `kind` is what the tooltip and panel render.
9. **Grep-gate enforcement now, not in plan-01.** With emission sites in place, the gate is meaningful: it prevents future drift. Plan-01 documented the convention; this plan enforces it via test.
10. **Pi extension untouched.** Confirmed at planning: `packages/pi-eforge/extensions/eforge/index.ts` only hand-discriminates on `event.type === 'session:end'` (line 466). Decision events flow through unchanged. No code change.

### Decision-helper signature consideration

`emitBuildDecision` from plan-01 takes `(ctx: BuildStageContext, decision: BuildDecision)`. Two callers don't have a full `BuildStageContext`: `runParallelReview(options)` in parallel-reviewer.ts and `merge-conflict-resolver.ts`. Options to handle this in this plan (pick the cleanest at implementation time):

- **Overload**: `emitBuildDecision(ctxOrPlanId: BuildStageContext | { planId: string }, decision)` — narrow with `'planId' in arg ? arg.planId : ctx.planId`.
- **Two helpers**: keep `emitBuildDecision(ctx, decision)` and add `emitBuildDecisionForPlan(planId, decision)` — both compose the same event shape internally.

Either is fine; pick the one that reads better given the call sites. The grep-gate test only needs to allow `decisions.ts` to be the sole place that constructs the literal `type: 'plan:build:decision'`.

## Scope

### In Scope
- Engine emission at the seven build-phase decision sites listed in PRD §Code Impact > Engine emission sites.
- Generalize `emitBuildDecision` (or add a sibling helper) to support callers without a full `BuildStageContext`.
- New `DecisionTimeline` component with shadcn `Tooltip` hover and shadcn `Sheet` (or `Dialog`) click-through panel.
- Wire the component into `plan-row.tsx` and thread state from `app.tsx`.
- Grep-gate test `test/decision-helper-discipline.test.ts` enforcing the convention.
- Extension to `test/agent-wiring.test.ts` asserting expected decision-event sequence under `StubHarness`.
- Update to `docs/roadmap.md` Orchestrator Intelligence section.

### Out of Scope
- Wire-protocol schemas, helper, reducer slice (already in plan-01).
- Plan-phase decision events (deferred follow-up roadmap item).
- The actual logic for adaptive reviewer respawn (`dropped` stays `[]` today; partner roadmap item).
- Pi extension code changes (passes through unknown events generically; verified).
- Removing configurable evaluator strictness (separate future change).
- New decision-making behavior — we instrument existing decisions only.
- CLI rendering of decisions (out of scope per PRD).

## Files

### Create
- `packages/monitor-ui/src/components/pipeline/decision-timeline.tsx` — Renders `decisions: BuildDecision[]` for one plan as a horizontal row of pips. Each pip is a small clickable button styled per `kind` family color (use Tailwind classes: `bg-blue-500` for review-* kinds, `bg-amber-500` for evaluator-strictness, `bg-red-500` for recovery-verdict, `bg-purple-500` for merge-conflict-resolution). Wrap each pip in shadcn `Tooltip` showing `<kind> — <rationale>` plus one or two key fields (e.g., for `review-strategy`: "parallel — auto-threshold (12 files, 640 lines)"). Click opens a shadcn `Sheet` (right-side panel) rendering the full `decision` payload as formatted JSON inside a `<pre>` block. Use existing imports from `@/components/ui/tooltip` and `@/components/ui/sheet`. Keep the file under ~150 lines.
- `test/decision-helper-discipline.test.ts` — Vitest test that scans all `.ts` files under `packages/` and `test/` (excluding `node_modules/` and `dist/`) for the literal substring `type: 'plan:build:decision'` and `type: "plan:build:decision"`. Asserts the only file with hits is `packages/engine/src/decisions.ts`. Mirrors the pattern of any existing discipline-enforcing tests in the repo (e.g., the `mutateState` enforcement). If no precedent exists, build it directly with `fs.readdirSync` recursion.

### Modify
- `packages/engine/src/decisions.ts` — Generalize the helper so it can be called from `parallel-reviewer.ts` (which has `planId` but not `ctx`) and from `merge-conflict-resolver.ts`. Either accept `BuildStageContext | { planId: string }` via overload, or export a sibling `emitBuildDecisionForPlan(planId, decision)`. Both must construct the same event shape (`{ timestamp, type: 'plan:build:decision', planId, decision }`) and validate via `BuildDecisionSchema.parse`.
- `packages/engine/src/pipeline/stages/build-stages.ts` — 
  - Inside `reviewStageInner` (~lines 125-158), before the strategy dispatch at line 143: compute the resolved strategy, then yield a `review-strategy` decision. When `strategy === 'auto'`, compute the changeset metrics using the same logic as `parallel-reviewer.ts` (extract a shared utility into `parallel-reviewer.ts` or a new `packages/engine/src/agents/review-threshold.ts` if needed) and populate the `auto: { files, lines, threshold }` block; set `source: 'auto-threshold'`. When the user supplied `review.strategy` directly, set `source: 'config'` with `auto` omitted.
  - Inside `reviewCycleStage` (~lines 560-572), at the top of each iteration: yield a `perspectives-respawned` decision (`round`, current `perspectives`, `dropped: []`).
  - Immediately before the `break` on line 568: yield a `cycle-terminated` decision with `reason: 'no-issues'`, `round`, `issuesRemaining: 0`.
  - After the `for` loop exits without `break` (i.e., max-rounds path): yield `cycle-terminated` with `reason: 'max-rounds'` and `issuesRemaining: ctx.reviewIssues.length`.
  - Inside `evaluateStageInner` (locate via grep — likely also in `build-stages.ts`): at the start of the function, yield an `evaluator-strictness` decision with `strictness: ctx.review.evaluatorStrictness ?? 'standard'` and `source: 'config' | 'default'` (where `'default'` means the field was unset on `ctx.review`).
- `packages/engine/src/agents/parallel-reviewer.ts` — 
  - When `strategy === 'auto'` (around line 120 where `shouldParallelizeReview` is called): expose the file/line metrics computed for the threshold check via an exported utility (e.g., `computeReviewThresholdSnapshot(changedFiles, lines)` returning `{ files, lines, threshold }`) so `reviewStageInner` can populate the `auto` block of its `review-strategy` decision. Do NOT yield the `review-strategy` event from this file (yield site stays in `reviewStageInner`).
  - When `determineApplicableReviews(categories)` runs (around line 142, only when no override was supplied): yield a `perspectives-inferred` decision with `perspectives` (the result), `categories` (input from category detection), and `rules` (the rule names that fired). If `determineApplicableReviews` doesn't currently return rule-attribution metadata, extend its return signature to do so (preferred) — or, as a fallback, recompute the rule names by re-applying the same heuristics in this file. Use the helper.
- `packages/engine/src/agents/merge-conflict-resolver.ts` — After the existing `plan:merge:resolve:complete` yield with `resolved: true` (around line 60): yield `emitBuildDecisionForPlan(planId, { kind: 'merge-conflict-resolution', strategy: 'agent-resolved', files: <conflicted paths the resolver acted on>, rationale: <short string describing the resolution> })`. The resolver already has access to the conflicted files list. Do not emit on `resolved: false` — that's a failed resolution, not a decision.
- `packages/engine/src/eforge.ts` — In the recovery flow, locate the `recovery:apply:complete` yield site (the explorer report places it around line 1662 in the recovery:complete context). Immediately before or after that yield, also yield `emitBuildDecisionForPlan(failingPlanId, { kind: 'recovery-verdict', verdict, successorPrdId, rationale })`. Do NOT modify the existing `recovery:apply:complete` event shape.
- `packages/monitor-ui/src/components/pipeline/plan-row.tsx` — Add `<DecisionTimeline decisions={decisions} />` to the per-plan row layout. Source `decisions` from props (added in this plan) or from a context the existing component already consumes. Place the timeline near the existing review-issues summary so the per-plan row renders: stages, decisions track, issues summary.
- `packages/monitor-ui/src/app.tsx` — Thread `runState.decisions` down to the pipeline components. Locate where `runState` is read and `plan-row.tsx` (or its parent) is rendered; pass the per-plan slice via props or via the existing context that already exposes `runState`.
- `test/agent-wiring.test.ts` — Add one new test case using the existing `StubHarness` setup. Drive a build through `reviewStageInner` with `review.strategy = 'auto'` and a synthetic changeset that triggers the parallel path (e.g., 12 files × 60 lines avg). Assert the emitted event sequence includes, in order: a `plan:build:decision` of `kind: 'review-strategy'` (`source: 'auto-threshold'`, `strategy: 'parallel'`), a `plan:build:decision` of `kind: 'perspectives-inferred'`, then on each round of `reviewCycleStage` a `perspectives-respawned`, and finally a `cycle-terminated` with `reason: 'no-issues'`. Build the synthetic changeset inline (no mocks beyond `StubHarness`).
- `docs/roadmap.md` — In the Orchestrator Intelligence section (lines 13-20), edit the "Orchestrator decision events" bullet to reflect shipped state: rephrase to say build-phase decision events have shipped (`plan:build:decision` event variant + `emitBuildDecision` helper), and the remaining work is plan-phase decision events tied to capturing planner-agent rationale. Do not delete the bullet entirely — the plan-phase portion remains a follow-up. Keep the "Adaptive reviewer respawn" bullet untouched.

## Verification

- [ ] All seven decision sites use `emitBuildDecision` (or `emitBuildDecisionForPlan`); the grep-gate test at `test/decision-helper-discipline.test.ts` passes (only `packages/engine/src/decisions.ts` contains the literal `type: 'plan:build:decision'`).
- [ ] A build run with `review.strategy = 'auto'` and a changeset above the threshold emits, in order: `review-strategy` (`source: 'auto-threshold'`, `strategy: 'parallel'`, populated `auto` block with `files`, `lines`, `threshold`), `perspectives-inferred` (when no override), `perspectives-respawned` per round, and `cycle-terminated` with `reason: 'no-issues'` or `'max-rounds'`. Asserted by the new `test/agent-wiring.test.ts` scenario.
- [ ] A build run with `review.strategy = 'auto'` and a changeset below threshold emits `review-strategy` with `source: 'auto-threshold'` and `strategy: 'single'`; no `perspectives-inferred` event is emitted in that scenario.
- [ ] A build run with `review.strategy = 'single'` (explicit) emits `review-strategy` with `source: 'config'` and no `auto` block; no `perspectives-inferred` event.
- [ ] A build run with explicit `review.perspectives` does not emit `perspectives-inferred`.
- [ ] An `evaluator-strictness` decision is emitted at the start of every evaluator run, regardless of value.
- [ ] A recovery flow emits both `recovery:apply:complete` (unchanged) and a `plan:build:decision` of `kind: 'recovery-verdict'` carrying the same verdict and `successorPrdId`.
- [ ] A merge that hits the resolver agent and resolves successfully emits one `merge-conflict-resolution` decision per resolution event, alongside the existing `plan:merge:resolve:start/complete`.
- [ ] `DecisionTimeline` renders one pip per decision, color-coded by `kind` family (review = blue, evaluator = amber, recovery = red, merge = purple), with shadcn `Tooltip` on hover and shadcn `Sheet` panel on click.
- [ ] `plan-row.tsx` renders `<DecisionTimeline decisions={...} />`; `app.tsx` threads `runState.decisions` to the pipeline.
- [ ] `test/agent-wiring.test.ts` includes the new auto-strategy scenario; `pnpm test` passes.
- [ ] `pnpm type-check` passes across the workspace.
- [ ] `pnpm test` passes with no regressions.
- [ ] `pnpm build` produces a clean bundle.
- [ ] `docs/roadmap.md` Orchestrator Intelligence section reflects shipped build-phase emission and preserves plan-phase as a follow-up.
- [ ] After merge, an end-to-end build of a small PRD against the daemon shows decision events in the monitor UI hover/sidebar; `event-log.jsonl` for that run contains entries with `type: 'plan:build:decision'`.
