---
title: Orchestrator decision events: emit typed events at build-phase orchestrator decision points, surface in monitor UI
created: 2026-05-07
---

# Orchestrator decision events: emit typed events at build-phase orchestrator decision points, surface in monitor UI

## Problem / Motivation

When a build runs, the engine makes several runtime decisions that shape the pipeline (review strategy, perspective inference, parallelization threshold, cycle termination, evaluator strictness, recovery verdict, merge-conflict resolution). The user can see the *consequences* of these decisions in existing events (e.g. `plan:build:review:parallel:start` carries the chosen perspectives), but the *rationale* — what input the orchestrator looked at and why it picked what it picked — is opaque.

### Affected users

- Operators watching the monitor UI who want to understand why a build took a particular path (e.g. "why did only 2 reviewers spawn instead of 4?", "why did the cycle stop after one round?").
- Future engine developers debugging emergent behavior, especially as the partner roadmap item "adaptive reviewer respawn" lands and the choice of which perspectives to respawn becomes non-obvious.
- Anyone integrating with the daemon HTTP/SSE API who wants to drive their own dashboards or post-mortems.

### Why now

The "Orchestrator Intelligence" roadmap section is being worked top-down. The just-shipped excursion simplified the review cycle (removed severity filter, scoped per-perspective hover); the next item ("adaptive reviewer respawn") will introduce *real* runtime decision logic about which perspectives to respawn, and that change is much riskier without an observability surface to debug it on. Decision events are the observability layer adaptive respawn writes into.

### Plan-phase variant

The planner agent makes most "plan-phase decisions" (which perspectives, which build stages, strictness level) and serializes them into `orchestration.yaml` and `planning:complete.planConfigs`. The visibility gap there is *the planner's reasoning*, not an engine choice. This plan must decide whether to also surface planner reasoning as "plan-phase decision events" or to scope the work to runtime build-phase decisions only.

### Roadmap entry

From `docs/roadmap.md` "Orchestrator Intelligence":

> **Orchestrator decision events** — Emit typed events with rich context whenever the orchestrator makes a decision across any phase (plan and build): planner choices (which reviewer perspectives, parallelism, depth), build-stage choices (which reviewers to spawn, when to stop the review cycle, when to escalate), etc. Surface these in the monitor UI so users can see why the pipeline took a given path. Event name is TBD — needs to fit the existing `phase:stage:action` event taxonomy in `@eforge-build/client`.

### Baseline: prior excursion landed (verified)

The prior excursion (`2026-05-07-simplify-review-cycle.md`) merged at commit `e12532b`. Verified at planning time:

- `autoAcceptBelow` and `filterIssuesBySeverity` are completely gone (zero grep hits anywhere).
- `reviewCycleStage` is now at `packages/engine/src/pipeline/stages/build-stages.ts:560–572`. Termination check is exactly `if (ctx.reviewIssues.length === 0) break;`.
- `pipeline/misc.ts` survives (46 lines, contains only `extractPrdMetadata` and `humanizeName`); the severity-filter code is excised.
- `SEVERITY_ORDER` still lives in `packages/client/src/events.schemas.ts:1063–1067`, retained for fixer ordering and dedup.
- `reviewIssuesByPerspective: Record<string, Record<string, ReviewIssue[]>>` (keyed by planId, then perspective) lives in `packages/monitor-ui/src/lib/reducer.ts:102, 133`. `perspectiveErrors` follows a similar nested-record append pattern that the new `decisions` slice can mirror.
- `plan:build:review:parallel:perspective:complete` is handled in `packages/monitor-ui/src/lib/reducer/handle-plan-build.ts:135–146` — merges issues into `reviewIssuesByPerspective[planId][perspective]`.
- `parallel-reviewer.ts` line numbers unchanged: `runParallelReview` at line 76, `shouldParallelizeReview` call at 120, `determineApplicableReviews` call at 142.
- `IGNORED_EVENT_TYPES` is at `packages/monitor-ui/src/lib/reducer/index.ts:173–282`; `_Exhaustive` check at `300–311`. `plan:build:decision` is absent from the ignored list (no removal needed when we register).
- `packages/engine/src/decisions.ts` does not exist (no naming collision).
- `test/agent-wiring.test.ts` and `StubHarness` are intact.

### Current event taxonomy

`packages/client/src/events.schemas.ts` is the wire-protocol source of truth. ~130 discriminated event variants, named `phase:stage[:action[:detail]]`. No `*:decision` or `*:chosen` events exist yet. Decision-adjacent events today (e.g. `plan:build:review:parallel:start` carrying the perspectives array) emit the *result* of a decision, not the rationale behind it.

### Decision-site inventory

**Plan phase**: most "decisions" are planner-agent outputs serialized into `orchestration.yaml` (per-plan `build` stage list, `review.perspectives`, `review.strategy`, `review.maxRounds`, `evaluatorStrictness`). They flow through `planning:complete` (`packages/engine/src/agents/planner.ts:343`) carrying `planConfigs`. There is no runtime orchestrator deciding these — the planner agent does, then the engine reads them back. So "plan-phase decision events" really means "make the planner's reasoning visible", not "instrument an engine choice site".

**Plan-phase scope decision**: deferred to a follow-up roadmap item. Extract-only would emit decisions with synthesized rationale that just restates the choice, which is thin signal. The valuable shape requires a planner-prompt change to capture *why* the planner chose what it chose. That work is bundled into a dedicated follow-up so this excursion can focus on build-phase runtime decisions where the rationale is naturally rich (file counts, threshold values, round numbers, etc.).

**Build phase**: the orchestrator does make runtime choices. Top sites:

1. `packages/engine/src/agents/parallel-reviewer.ts:120` — `shouldParallelizeReview` threshold check (10+ files OR 500+ lines) when strategy=`auto`. Currently silent; only the *result* shows up in `plan:build:review:parallel:start`.
2. `packages/engine/src/agents/parallel-reviewer.ts:142` — `determineApplicableReviews(categories)` perspective inference when no override. Rules in `packages/engine/src/review-heuristics.ts`.
3. `packages/engine/src/pipeline/stages/build-stages.ts:128–159` — review strategy dispatch (single vs parallel path) inside `reviewStageInner`.
4. `packages/engine/src/pipeline/stages/build-stages.ts:561–576` — review cycle termination (zero issues vs maxRounds reached). Now even simpler post-excursion.
5. `packages/engine/src/pipeline/stages/build-stages.ts:569` — full-perspective respawn each round (the future "adaptive respawn" roadmap item is the partner feature; today this isn't really a decision yet, but the event is the surface for that future logic to write into).
6. Evaluator strictness application — passed through `ctx.review.evaluatorStrictness` to `evaluateStageInner`. Silent today.
7. Recovery verdict application — `recovery:apply:complete` already carries `verdict` (retry/split/abandon/manual). This is decision-event-shaped already; might subsume or align with the new variant.
8. Merge-conflict resolution path — delegated to `MergeResolver` callback; little engine-side decision logic.

### Consumer wiring

- Reducer registry: `packages/monitor-ui/src/lib/reducer/index.ts` (flat handler map keyed by `event.type`, exhaustive compile-time check). New variants need: schema in `events.schemas.ts`, handler in a `handle-*` group file, registry entry, optional `IGNORED_EVENT_TYPES` membership.
- Build-phase events live in `packages/monitor-ui/src/lib/reducer/handle-plan-build.ts`. No dedicated "decision panel" exists today — decisions would be timeline events / hover overlays / a new sidebar.
- Pi extension (`packages/pi-eforge/`) passes through unknown event types; no breaking change concern there. But the AGENTS.md sync rule means user-facing changes should still be considered.

### Key open design question

Two structural choices for the event shape — surfaces in design-decisions:

- **A. Granular per-site variants** (`plan:build:review:strategy:chosen`, `plan:build:review:cycle:terminated`, ...). Fits existing taxonomy. Each new decision site = new variant. Strong consumer typing.
- **B. One umbrella variant with inner discriminated union** (`plan:build:orchestrator:decision` carrying `decision: { kind: 'review-strategy', ... } | { kind: 'cycle-terminated', ... } | ...`). One registry entry, one handler, still typed via inner kind. Doesn't quite match the taxonomy convention.

The roadmap entry says "needs to fit the existing taxonomy" — that nudges toward A but doesn't preclude B if the umbrella name still parses as `phase:stage:action`.

## Goal

Add typed orchestrator-decision events to the wire protocol, emit them at every build-phase orchestrator decision site, render them in the monitor UI, and keep the Pi extension passing them through cleanly — so operators and developers can see *why* the pipeline took a given path, and so the partner "adaptive reviewer respawn" roadmap item has an observability surface to write into.

## Approach

### Decision 1: Event shape — umbrella with inner discriminated union (chosen)

**Choice**: One umbrella event variant `plan:build:decision` carrying an inner discriminated union of decision kinds.

Common fields on every decision: `kind` (discriminator), `rationale` (short human-readable string), plus kind-specific typed fields. No untyped metadata bag.

**Rationale**:

- Decisions are conceptually a single class of event (record-a-runtime-choice), unlike lifecycle events that vary by what's starting/completing/failing. Consumers want to render them uniformly. Umbrella → one handler, one render path, one timeline track.
- New decision sites are cheap to add: one entry in the inner union, one switch case in the handler. Granular per-site would require schema variant + registry entry + handler + ignored-list churn for every new decision — exactly the kind of friction that'd discourage instrumenting new sites later.
- Still fully typed. Closed schemas per kind. Not a metadata bag — every kind's payload is statically typed and Zod-validated.
- Existing precedent: `recovery:apply:complete` already carries a discriminated `verdict` field, showing the project tolerates inner discriminators in event payloads.
- Taxonomy fit: `plan:build:decision` parses as `phase:stage:action`, satisfying the roadmap constraint.

**What we lose by not going granular**:

- `event.type === 'plan:build:review:strategy:chosen'` is slightly easier to grep/filter than `event.type === 'plan:build:decision' && event.decision.kind === 'review-strategy'`. Acceptable cost.
- Slightly less idiomatic for Zod's discriminatedUnion at the top level (we use a nested discriminated union). Workable — Zod supports nested discriminators.

### Decision 2: Common shape of a decision payload

```
{
  kind: <discriminator>,
  rationale: string,         // short human-readable, suitable for UI hover
  ...kind-specific fields    // typed per variant
}
```

Build-phase inner union (`plan:build:decision.decision`):

| `kind` | Kind-specific fields |
|--------|---------------------|
| `review-strategy` | `strategy: 'single' \| 'parallel'`, `source: 'config' \| 'auto-threshold'`, `auto?: { files: number, lines: number, threshold: { files: number, lines: number } }` |
| `perspectives-inferred` | `perspectives: ReviewPerspective[]`, `categories: string[]`, `rules: string[]` |
| `cycle-terminated` | `round: number`, `reason: 'no-issues' \| 'max-rounds'`, `issuesRemaining: number` |
| `perspectives-respawned` | `round: number`, `perspectives: ReviewPerspective[]`, `dropped: ReviewPerspective[]` (empty today; populated when adaptive respawn lands) |
| `evaluator-strictness` | `strictness: 'strict' \| 'standard' \| 'lenient'`, `source: 'config' \| 'default'` |
| `recovery-verdict` | `verdict: 'retry' \| 'split' \| 'abandon' \| 'manual'`, `successorPlanId?: string` |
| `merge-conflict-resolution` | `strategy: string`, `files: string[]` |

### Decision 3: Recovery alignment — dual-emit, don't reshape

Keep `recovery:apply:complete` as-is (don't reshape its `verdict` field). Additionally emit a `plan:build:decision` with `kind: 'recovery-verdict'` carrying the same verdict + rationale, so observers have one consistent decision surface. Extra event volume is trivial (recoveries are rare); the duplication is intentional for consumer simplicity.

### Decision 4: Evaluator strictness — always emit, future-proofed

Emit `evaluator-strictness` at the start of every evaluator run regardless of value. Configurable evaluator strictness is expected to be removed in a near-future change (per the in-flight pattern of "remove unused config knobs"); when that happens, `source` always reports `'default'` and the `strictness` field still records what was applied. Don't overbuild around the strictness configuration in this excursion — straight emission of whatever `ctx.review.evaluatorStrictness` resolves to, no defensive branching.

### Decision 5: Engine emission helper

New helper in `packages/engine/src/decisions.ts` (new file):

```
function emitBuildDecision(
  ctx: BuildStageContext,
  decision: BuildDecision,
): EforgeEvent
```

Returns a fully-formed event. Callers `yield emitBuildDecision(ctx, { kind: 'review-strategy', ... })`. This mirrors the discipline of `forgeCommit` for git: one place to compose decision events so emission sites can't drift in shape, timestamp handling, planId attachment, etc.

A grep gate (mirroring the `mutateState` rule from AGENTS.md) enforces zero raw `type: 'plan:build:decision'` yields outside this helper.

### Decision 6: Monitor UI rendering — timeline track + hover detail

- Decisions render as small pips on a new "decisions" track inside the existing per-plan pipeline view, time-aligned with the build timeline.
- Hover surfaces the decision kind, rationale, and key fields (e.g., for `review-strategy`: "parallel — auto-threshold (12 files, 640 lines)").
- Click opens a side panel with the full payload.
- Use shadcn/ui components per AGENTS.md; introduce one new component (`DecisionTimeline` or similar) and reuse the existing tooltip primitives.

### Decision 7: Reducer wiring

- One new entry in `handlerRegistry` (`plan:build:decision`).
- New file `packages/monitor-ui/src/lib/reducer/handle-decisions.ts` — keeps decision logic out of the already-busy `handle-plan-build.ts`.
- New `RunState` slice: `decisions: Record<string, BuildDecision[]>` keyed by `planId`. No planning sentinel needed (plan-phase deferred).
- Test pattern: mirror `handle-plan-build.test.ts` — construct events inline, dispatch, assert state.

### Code Impact

#### New files

| Path | Purpose |
|------|---------|
| `packages/engine/src/decisions.ts` | `emitBuildDecision(ctx, decision)` helper; one place that composes orchestrator-decision events with consistent shape (timestamp, planId attribution, Zod-validated payload). |
| `packages/monitor-ui/src/lib/reducer/handle-decisions.ts` | Reducer handler for the new event variant. Pattern after `handle-plan-build.ts` — small functions returning a partial state slice. |
| `packages/monitor-ui/src/components/pipeline/decision-timeline.tsx` | New shadcn/ui-based component rendering decisions as pips on a per-plan track with hover tooltip and click-through to a side panel. |
| `packages/engine/test/decisions.test.ts` | Schema parsing / helper composition tests. |
| `packages/monitor-ui/src/lib/reducer/__tests__/handle-decisions.test.ts` | Reducer behavior tests (build decisions, multi-plan keying). |

#### Schema changes (`packages/client/src/`)

| File | Change |
|------|--------|
| `events.schemas.ts` | Add `BuildDecisionSchema` (Zod discriminated union over `kind`) and `PlanBuildDecisionEventSchema`, append the latter to `EforgeEventSchema` (around line 361–1020). |
| `types.ts` | Re-export `BuildDecision` inferred from the schema. No new TS-only types — derive everything from Zod. |
| `api-version.ts` | Bump `DAEMON_API_VERSION` per the AGENTS.md convention for HTTP/event-protocol changes. |

#### Engine emission sites (`packages/engine/src/`)

| File | Site | Decision emitted |
|------|------|------------------|
| `pipeline/stages/build-stages.ts` | `reviewStageInner` (~line 128–159) | `kind: 'review-strategy'` — emit inside the strategy switch, before dispatching to `runParallelReview` or `runReview`. Always emit, regardless of strategy. |
| `agents/parallel-reviewer.ts` | After `shouldParallelizeReview` (~line 120) when `strategy === 'auto'` | The `review-strategy` decision should carry the `auto: { files, lines, threshold }` block when threshold drove the choice. Emit inside `parallel-reviewer.ts` (or compose the auto-block there and let the caller emit) — keep stage code thin. |
| `agents/parallel-reviewer.ts` | `determineApplicableReviews` call (~line 142) when no override | `kind: 'perspectives-inferred'` — emit categories detected, perspectives chosen, rule names. |
| `pipeline/stages/build-stages.ts` | `reviewCycleStage` loop entry (within lines 560–572 post-merge) | `kind: 'perspectives-respawned'` — emit each round (today `dropped: []`; future adaptive-respawn populates this). |
| `pipeline/stages/build-stages.ts` | `reviewCycleStage` at the `if (ctx.reviewIssues.length === 0) break;` site | `kind: 'cycle-terminated'` — `reason: 'no-issues' \| 'max-rounds'` plus `issuesRemaining`. Now even simpler post-excursion: emit `'no-issues'` immediately before the `break`, emit `'max-rounds'` once the loop exhausts. |
| `pipeline/stages/build-stages.ts` | `evaluateStageInner` start | `kind: 'evaluator-strictness'` — always emit (see Design Decision 4). |
| `eforge.ts` (recovery section, ~line 1622+) | After `recovery-analyst` produces a verdict | `kind: 'recovery-verdict'` — alongside the existing `recovery:apply:complete`. Don't reshape the existing event. |
| `agents/merge-conflict-resolver.ts` | After conflict resolution succeeds (~line 60) | `kind: 'merge-conflict-resolution'` — `strategy` (e.g. `'agent-resolved'`, `'manual'`), `files` (conflicted paths the resolver acted on). The agent already yields `plan:merge:resolve:start/complete`; the decision event is in addition. |

#### Monitor UI consumer wiring (`packages/monitor-ui/src/`)

| File | Change |
|------|--------|
| `lib/reducer.ts` | Add `decisions: Record<string, BuildDecision[]>` to `RunState`, keyed by `planId`. Initial state, reset paths. |
| `lib/reducer/index.ts` | Register `plan:build:decision` handler in `handlerRegistry`. Remove from `IGNORED_EVENT_TYPES` if listed. Verify exhaustive `_Exhaustive` check still passes. |
| `lib/reducer/handle-decisions.ts` (new) | One handler appending to `decisions[planId]`. Mirror `handlePlanBuildReviewPerspectiveError` for the append-to-array pattern. |
| `components/pipeline/decision-timeline.tsx` (new) | Renders a track of pips. Color-coded by `kind` family (review = blue, evaluator = amber, recovery = red, merge = purple). Hover shows kind + rationale. Click opens side panel via shadcn `Sheet` or similar. |
| `components/pipeline/plan-row.tsx` | Wire `<DecisionTimeline decisions={...} />` into the per-plan row layout. |
| `app.tsx` | Thread `runState.decisions` down to the pipeline components. |

#### Pi extension (`packages/pi-eforge/`)

No code change for v1. Document in the package README that decision events flow through unchanged. If `packages/pi-eforge/` has a build-progress UI surface (verify during planning), add a minimal decision-rendering equivalent to keep parity per AGENTS.md.

#### Tests

| File | Coverage |
|------|----------|
| `packages/engine/test/decisions.test.ts` | Zod parses every `kind` correctly; helper builds the correct event shape; rejects unknown kinds at compile time. |
| `packages/monitor-ui/src/lib/reducer/__tests__/handle-decisions.test.ts` | Append-to-list behavior, multi-plan keying, reset paths. |
| `test/agent-wiring.test.ts` (extend) | Run a `StubHarness` build that triggers `auto`-strategy parallel review and assert the expected decision events fire in the expected order. |
| `packages/monitor-ui/src/components/pipeline/__tests__/decision-timeline.test.tsx` (new, optional) | Render snapshot for each decision kind. |

#### Documentation

| File | Change |
|------|--------|
| `AGENTS.md` | Add a bullet under Conventions: "Orchestrator runtime decisions emit `plan:build:decision` events. New decision sites must use the `emitBuildDecision` helper; do not yield decision events directly." |
| `docs/roadmap.md` | Once shipped, remove the build-phase portion of the "Orchestrator decision events" bullet from "Orchestrator Intelligence". Keep the plan-phase portion as a follow-up roadmap item. |
| `README.md` (if appropriate) | Mention decision events as part of the observability story. |

#### Plugin version bump

| File | Change |
|------|--------|
| `eforge-plugin/.claude-plugin/plugin.json` | Per AGENTS.md: bump version because user-facing observability changed. |

#### Search-path hygiene

Existing event-handling code uses the registry pattern; the only places that hand-list event variants are `IGNORED_EVENT_TYPES` and the exhaustive type check. Verify by grep that no consumer hand-discriminates on `event.type` strings outside the registry — if any do (e.g. CLI status renderer), update them too.

### Assumptions And Validation

#### Material assumptions

| # | Assumption | Evidence / validation performed | Confidence | Cost to validate further | Validation path | Impact if wrong |
|---|------------|----------------------------------|------------|--------------------------|-----------------|-----------------|
| 1 | The prior excursion (`2026-05-07-simplify-review-cycle.md`) landed and the `reviewCycleStage` body simplified as described. | **Validated post-merge** at commit `e12532b`: filter gone, `reviewCycleStage` at lines 560–572, termination check is `if (ctx.reviewIssues.length === 0) break;`. Reducer state and per-perspective handler all confirmed in place. | high | — | Validated. | — |
| 2 | `recovery:apply:complete` is yielded from a generator and we can dual-emit a `plan:build:decision` next to it. | **Validated during planning**: `eforge.ts:1622` yields `recovery:start` directly; recovery agent code path is generator-based. | high | — | Validated. | — |
| 3 | The merge-conflict-resolver code path supports yielding `merge-conflict-resolution` decisions. | **Validated during planning**: `merge-conflict-resolver.ts:23` yields `plan:merge:resolve:start` directly; the agent is a generator. | high | — | Validated. | — |
| 4 | Pi extension passes through unknown event types without crashing. | Explorer report; not personally read. | medium | low | Read `packages/pi-eforge/extensions/eforge/index.ts` event handler. | Low — Pi is a secondary consumer; worst case we add a no-op handler. |
| 5 | Zod's nested `discriminatedUnion` (top-level on `event.type`, inner on `decision.kind`) composes correctly and produces narrowable TS types. | Standard Zod feature; no specific verification done. | high | low | Build a tiny prototype before schema-writing or trust the type errors during implementation. | Low — workable fallbacks (regular union with refine, separate top-level variants) exist. Adds friction, doesn't block. |
| 6 | Reducer registry pattern (`handlerRegistry`, `IGNORED_EVENT_TYPES`, `_Exhaustive`) and the file split (`handle-plan-build.ts`, etc.) survive the excursion intact. | **Validated post-merge**: `IGNORED_EVENT_TYPES` at `index.ts:173–282`, `_Exhaustive` at `300–311`, `plan:build:decision` is absent from ignored list. `handle-plan-build.ts:135–146` already handles `parallel:perspective:complete` and follows the nested-record append pattern we'll mirror. | high | — | Validated. | — |
| 7 | The `event-log.jsonl` writer captures all events without a type allowlist. | Assumption based on AGENTS.md "engine emits, consumers render" principle. | medium | low | Grep the daemon's event-log writer for event-type filters. | Medium — if a writer filters, decision events won't replay; we'd need to whitelist them. |
| 8 | No CLI or daemon consumer hand-discriminates on `event.type` strings outside the registry. | Not verified. | medium | low | `grep -rn "event.type ===" packages/eforge packages/monitor`. | Medium — silent failures or noisy warnings; fixable but costly to find post-merge. |
| 9 | Always-emit `review-strategy` (regardless of strategy) and `evaluator-strictness` (regardless of strictness) is the right behavior. | **Confirmed by user during planning** (prefer consistent emission over conditional noise reduction). | high | — | Validated. | — |
| 10 | The `BuildStageContext` exposes a `planId` and the stage code yields events directly via `yield` syntax (so helper signature `(ctx, decision) → Event` is enough). | Inferred from existing stage code structure (e.g. `reviewStageInner`). | medium | low | Read any stage that yields events for the actual signature. | Low — helper signature is internal; can adjust during implementation. |
| 11 | Configurable evaluator strictness will be removed in a near-future change. | **Stated by user during planning** as planned future work. | high | — | User-stated. | Low — current plan emits the decision regardless of whether strictness is configurable; no rework needed if it's removed. |

#### What's validated already

- Roadmap entry exists and is unambiguous (read directly).
- `EforgeEventSchema` discriminated union pattern (read directly).
- `handlerRegistry`, `IGNORED_EVENT_TYPES`, `_Exhaustive` pattern at exact line numbers (post-merge verification).
- `forgeCommit` discipline as analog for decision-helper rule (read AGENTS.md).
- Severity filter removed and reducer state changes landed (post-merge verification of commit `e12532b`).
- Recovery (`eforge.ts:1622`) and merge-resolver (`merge-conflict-resolver.ts:23`) generator support (validated this session by reading code).
- `packages/engine/src/decisions.ts` does not yet exist (no naming collision).
- User has confirmed key design calls: umbrella event shape, defer plan-phase, always-emit strategy/strictness, future strictness-config removal.

#### Pre-build validation checklist (before `/eforge:build`)

- ~~Confirm in-flight excursion has landed~~ — **validated**, commit `e12532b`.
- Quick grep for `event.type ===` outside the reducer to surface assumption 8 (defer to planner agent during expedition planning).
- Confirm Pi extension passes through unknown events (assumption 4, low impact).

#### Acceptance for unresolved assumptions

The remaining unresolved assumptions (4, 5, 6, 7, 8, 10) are all medium-to-high confidence with low validation cost and low-to-medium impact. None invalidates the umbrella event shape or the decision-helper pattern. Worst-case rework is shifting one or two emission sites or adding a no-op consumer handler. Acceptable to proceed with these unresolved; the planner agent re-validates during expedition planning.

### Profile Signal

**Recommended: excursion**.

The work is multi-package (client schemas, engine emission, monitor-ui consumer, plugin version bump) and touches ~10 emission sites, but it's deeply cohesive: every emission site follows the same pattern (call `emitBuildDecision`/`emitPlanningDecision` helper, yield the returned event), and every consumer site follows the same handler pattern. There are no independent module subplans to defer — the design is a single coherent shape (umbrella event variant + helper + reducer + UI track) that one planner session can enumerate file-by-file with quality.

Reasons against errand: this is not mechanical. Real schema design (umbrella vs granular call already settled in this session, but planner-agent should validate the shape against the codebase), real test coverage, real UI work, and a public-protocol bump (`DAEMON_API_VERSION`).

Reasons against expedition: no module boundaries to delegate planning across. The emission sites span several engine files but they're all "yield this typed event" — there's no per-module plan that requires its own planner session. A shared foundation (schema + helper) plus broadly cohesive consumer changes is the canonical excursion shape.

## Scope

### In scope

Add typed orchestrator-decision events to the wire protocol, emit them at every **build-phase** orchestrator decision site, render them in the monitor UI, and keep the Pi extension passing them through cleanly.

**Build-phase decision sites covered (7 of the 8 inventory sites):**

1. Review strategy dispatch (`reviewStageInner` in `packages/engine/src/pipeline/stages/build-stages.ts:128–159`) — emit which path was taken (single vs parallel) and why (config strategy + auto-threshold result). Always emit, regardless of strategy.
2. Parallelization threshold (`shouldParallelizeReview` call in `packages/engine/src/agents/parallel-reviewer.ts:120`) — when strategy=`auto`, the `review-strategy` decision carries the input metrics (file count, line count) and which side of the threshold was hit.
3. Perspective inference (`determineApplicableReviews` in `packages/engine/src/agents/parallel-reviewer.ts:142`) — emit when no override was supplied: which file categories were detected, which perspectives were inferred, which rule fired.
4. Review cycle termination (`packages/engine/src/pipeline/stages/build-stages.ts:561–576`) — emit which round terminated and why (zero issues vs maxRounds reached). Stays simple post-excursion; severity filter is gone.
5. Per-round perspective respawn (same loop) — emit the perspective set chosen for the round. Today the set is invariant across rounds; this is the seam that the future "adaptive respawn" roadmap item writes into.
6. Evaluator strictness application — always emit at the start of every evaluator run, including which strictness was applied. **Note**: configurable evaluator strictness is expected to be removed in a near-future change (similar to the just-completed severity-filter removal). Don't overbuild around the strictness configuration; the decision event survives the simplification because there'll always be *some* applied strictness even if it stops being configurable.
7. Recovery verdict — `recovery:apply:complete` already carries `verdict`. Dual-emit a `plan:build:decision` of kind `recovery-verdict` alongside the existing event so all decisions show up in one consistent surface. Don't reshape the existing event.
8. Merge-conflict resolution path — emit when the merge resolver agent picks a resolution strategy. The merge resolver (`packages/engine/src/agents/merge-conflict-resolver.ts`) already yields events directly; the new decision event is added alongside the existing `plan:merge:resolve:start/complete`.

**Schema work** (`packages/client/src/events.schemas.ts`):
- New `BuildDecisionSchema` Zod discriminated union over `kind`.
- New `plan:build:decision` event variant in `EforgeEventSchema`.
- `DAEMON_API_VERSION` bump per AGENTS.md convention for protocol changes.

**Consumer wiring**:
- New reducer file `packages/monitor-ui/src/lib/reducer/handle-decisions.ts` and registry entry in `packages/monitor-ui/src/lib/reducer/index.ts` (must keep the exhaustive compile-time check passing).
- New `RunState.decisions` slice keyed by `planId`.
- New `DecisionTimeline` component in the per-plan pipeline view, with shadcn-based hover tooltips and a click-through detail panel.
- Pi extension (`packages/pi-eforge/`): confirm pass-through; add minimal rendering only if Pi has an existing build-progress UI surface (verify during planning).

**Engine emission**:
- New helper `emitBuildDecision(ctx, decision)` in `packages/engine/src/decisions.ts` (analogous to `forgeCommit` discipline) so emission sites can't drift in shape.
- Grep gate enforcing all `plan:build:decision` events flow through the helper, mirroring the `mutateState` rule from AGENTS.md.

**Tests**:
- Unit tests for the schema — variant parsing, payload validation per `kind`.
- Reducer tests for the new handler, patterned after `handle-plan-build.test.ts`.
- An agent-wiring or integration test that exercises a build with auto-strategy and verifies all expected decision events fire in order.

### Out of scope

- **Plan-phase decision events** — deferred to a follow-up roadmap item that will bundle planner-prompt rationale capture with `planning:decision` event emission. Adding plan-phase here would either require a thin extract-only rationale (low signal) or expand scope into planner-prompt changes (high regression risk).
- **Adaptive respawn logic itself** — the partner roadmap item. This plan delivers the *event surface* that future logic writes into, not the logic.
- **New decision-making behavior** — we are instrumenting existing decisions, not adding new ones (beyond the natural seam for adaptive respawn).
- **Backwards compatibility** — solo-user project; rip-and-replace is fine if cleaner.
- **External consumers beyond monitor UI** (CLI rendering) — CLI doesn't need decision rendering.
- **Decision events for non-orchestrator agents** (per-agent thinking traces, model fallbacks). Those are agent-internal.
- **Persistence beyond the event log** — decisions flow through the same SSE/event-log path as everything else.
- **Removing configurable evaluator strictness** — separate future change. This plan emits the decision regardless of whether strictness is configurable.

## Acceptance Criteria

### Schema and emission

- [ ] `events.schemas.ts` defines `BuildDecisionSchema` as a Zod discriminated union over `kind`, with all kinds from design-decisions: `review-strategy`, `perspectives-inferred`, `cycle-terminated`, `perspectives-respawned`, `evaluator-strictness`, `recovery-verdict`, `merge-conflict-resolution`.
- [ ] A new event variant `plan:build:decision` is part of the `EforgeEventSchema` discriminated union; `EforgeEvent` types narrow correctly via `event.type` and then via `event.decision.kind`.
- [ ] `DAEMON_API_VERSION` is bumped per the AGENTS.md HTTP/event-protocol convention.
- [ ] `packages/engine/src/decisions.ts` exports `emitBuildDecision`; it accepts typed inputs, returns Zod-valid event objects, attaches `timestamp` and `planId`, and rejects unknown kinds at compile time.
- [ ] All emission sites listed in code-impact use the helper; no raw event yields with `type: 'plan:build:decision'` exist anywhere else (enforced by grep gate, similar to the `mutateState` rule).

### Build-phase emission behavior

- [ ] A build run with `review.strategy = 'auto'` and a changeset above the parallelization threshold emits, in order: `review-strategy` (with `source: 'auto-threshold'`, populated `auto` block), `perspectives-inferred` (when no override), `perspectives-respawned` (each round), and `cycle-terminated` at termination with the correct `reason`.
- [ ] A build run with `review.strategy = 'auto'` and a changeset below threshold emits `review-strategy` with `source: 'auto-threshold'` and `strategy: 'single'`; no `perspectives-inferred` event is emitted.
- [ ] A build run with `review.strategy = 'single'` (explicit) emits `review-strategy` with `source: 'config'` and no `auto` block; no `perspectives-inferred` event is emitted.
- [ ] A build run with explicit `review.perspectives` does not emit `perspectives-inferred` (no inference happened).
- [ ] An `evaluator-strictness` decision is emitted at the start of every evaluator run, regardless of value.
- [ ] A recovery flow emits both the existing `recovery:apply:complete` AND a `plan:build:decision` of kind `recovery-verdict` carrying the same verdict.
- [ ] A merge that hits the merge-conflict-resolver agent emits one `merge-conflict-resolution` decision per resolution event, alongside the existing `plan:merge:resolve:start/complete`.

### Reducer and UI

- [ ] `packages/monitor-ui/src/lib/reducer.ts` has a `decisions: Record<string, BuildDecision[]>` slice keyed by `planId`, populated by the handler in `handle-decisions.ts`, properly reset on `run:start`/`reset`.
- [ ] The exhaustive `_Exhaustive` compile-time check on `handlerRegistry` still passes; the new event type is handled (not in `IGNORED_EVENT_TYPES`).
- [ ] `DecisionTimeline` component renders pips for each decision in the slice, color-coded by kind family, with shadcn-based tooltips on hover and a side panel on click.
- [ ] The component renders correctly for all decision kinds (verified by component test or by manual screenshot in monitor UI).

### Tests

- [ ] `packages/engine/test/decisions.test.ts` covers Zod parsing for every kind and rejects malformed payloads.
- [ ] `packages/monitor-ui/src/lib/reducer/__tests__/handle-decisions.test.ts` covers append behavior and multi-plan keying.
- [ ] `test/agent-wiring.test.ts` is extended with at least one scenario that asserts the expected decision-event sequence for a `StubHarness`-driven build.

### Documentation

- [ ] `AGENTS.md` Conventions section documents the decision-helper rule.
- [ ] `eforge-plugin/.claude-plugin/plugin.json` version is bumped.
- [ ] If `packages/pi-eforge/` has a build-progress UI surface, decision events are surfaced there (verify during planning); otherwise document the decision in the Pi extension README.
- [ ] `docs/roadmap.md` "Orchestrator Intelligence" entry is updated: build-phase portion removed, plan-phase portion preserved as a follow-up item.

### Validation runs

- [ ] After merge, run an end-to-end build of a small PRD against the daemon and observe decision events in the monitor UI hover/sidebar.
- [ ] `event-log.jsonl` for that run contains the new event type and replays cleanly.
- [ ] No regression in existing tests; `pnpm type-check` passes; `pnpm test` passes.
