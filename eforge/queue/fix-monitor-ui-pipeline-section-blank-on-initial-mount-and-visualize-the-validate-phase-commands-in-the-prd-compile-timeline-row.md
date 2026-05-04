---
title: Fix monitor UI: pipeline section blank on initial mount, and visualize the validate() phase commands in the PRD/Compile timeline row
created: 2026-05-04
---

# Fix monitor UI: pipeline section blank on initial mount, and visualize the validate() phase commands in the PRD/Compile timeline row

## Problem / Motivation

Two related defects in the eforge monitor UI degrade trust in the live build view; both reproduce in any project that uses eforge.

**Symptom 1 — Pipeline panel is blank on initial mount.** When a user opens the dashboard while a build is already in flight (as happens any time the user comes back to a long-running build), the entire upper "Pipeline" panel stays empty. The build is healthy and the daemon is streaming events, but nothing renders. A manual browser refresh (F5) fixes it; afterwards the panel updates live via SSE as expected. The user has to know to refresh — the dashboard does not look obviously broken, just empty, which is worse.

**Symptom 2 — Multi-minute "dead air" gap on the PRD/Compile timeline row.** The PRD/Compile row of the timeline shows planner → plan-refine bars at the start, validation-fixer bar(s) at the end (when validation fails), and an unexplained gap between them. In the reported build, the gap was 6 minutes, exactly the duration of `sbt flex-server/test` plus the `sbt flex-client/fastLinkJS` timeout. The user looking at the timeline cannot tell what the system was doing during that window — they assumed something was broken or stuck. There is no visual representation of the post-merge `validate()` phase, even though it consumes real wall-clock time on every successful build and is a primary failure mode.

**Why it matters now.** Both symptoms degrade the monitor UI's main job: giving the user accurate, glanceable insight into a running build. Bug 1 is a recent regression (post SWR migration on May 3, less than a day ago) and is the most user-visible breakage in the dashboard right now. Bug 2 is a longer-standing visualization gap that the user just noticed because the new dashboard architecture made everything else more legible — making the missing piece more conspicuous.

**Affected users.** Anyone using `eforge` with the monitor UI: the project itself, the eforge plugin (Claude Code), the pi-eforge extension. Both bugs are in shared monitor-UI code, not gated by integration.

### Context

Two independent bugs were observed during a long flex-project build, with a screenshot to corroborate. Both reproduce in any project — they are monitor UI bugs, not project-specific.

**Bug 1: blank pipeline panel on initial mount.** When the dashboard is opened while a build is already running, the upper "Pipeline" panel stays empty. After F5 it renders and continues to update via SSE. Likely a regression from the recent SWR migration (`826aa60`, May 3) and SSE consolidation (`5055aa0`).

**Bug 2: visible gap between the last reviewer bar and the validation-fixer bar.** The screenshot shows ~6 minutes of empty time on the PRD row of the timeline. Investigation in `packages/engine/src/orchestrator.ts:179-183` shows the orchestrator runs `executePlans → validate → prdValidate → (validate again if gap-closed) → finalize`. In this build, `validate()` ran `sbt flex-server/test` (1m) and then `sbt flex-client/fastLinkJS` (timed out at 5m), failing validation; the visible gap matches that 6 minutes exactly. The user suspected the prd-validator wasn't drawing — actually prd-validator never ran because validation failed first. The gap is the **validate()** phase running shell commands, which currently emit no timeline bars.

### Root-cause evidence

**Bug 1.** `packages/monitor-ui/src/components/pipeline/thread-pipeline.tsx:142` does `if (!hasThreadContent) return null;` where `hasThreadContent = entries.length > 0 || hasGlobalThreads`. Both inputs are empty during the early planning phase: planning events (`planning:start`, `planning:progress`, `planning:pipeline`) are all in `IGNORED_EVENT_TYPES` (`packages/monitor-ui/src/lib/reducer/index.ts:137-219`) and so update neither `planStatuses` nor `agentThreads`. The outer parent gate (`app.tsx:304`) only checks `runState.events.length > 0`, so it mounts `<ThreadPipeline>` while `<ThreadPipeline>` itself silently returns `null`. Manual refresh "fixes" it only because by then the snapshot fetch lands after at least one `agent:start` is in the DB.

**Bug 2.** `validate()` in `packages/engine/src/orchestrator/phases.ts:465-562` yields `validation:start`, `validation:command:start`, `validation:command:complete`, `validation:command:timeout`, `validation:complete` — none are agent events. All five are listed in `IGNORED_EVENT_TYPES` (`reducer/index.ts:190-194`), so they have no state effect. The PRD/Compile row's bars are built solely from `agentThreads` in `plan-row.tsx:188-289`, which only grow on `agent:start` (`handle-agent.ts:51-78`). So the validate phase is invisible by construction.

`prd_validation:start`/`prd_validation:complete` are also ignored, but the prd-validator agent itself emits `agent:start` via the harness (`packages/engine/src/agents/prd-validator.ts:35`), so its bar would appear automatically when prdValidate runs — no extra work needed for that case.

### Reusable building blocks

- `getAgentColor` / `pipeline-colors` for an additional non-agent palette entry.
- `formatDuration` from `packages/monitor-ui/src/lib/format.ts` for tooltips.
- The existing `sessionStart`/`totalSpan` math in `plan-row.tsx:188-194` already computes left/width percentages on a shared time axis — new bar types reuse it.
- `BATCH_LOAD` in `reducer.ts:134-160` rebuilds state from `initialRunState` and replays every handler — adding a new state slice is automatically populated for completed/cached sessions on hydration.

### Existing approved planning artifact

`/Users/markschaake/.claude/plans/image-1-we-recently-breezy-pinwheel.md` (already approved in plan mode this session) contains the same investigation and the proposed implementation. This eforge session plan supersedes it as the source of truth for /eforge:build.

## Goal

Restore the monitor UI's "the timeline tells the truth about a running build" promise by (1) making the Pipeline panel render its scaffold immediately on mount with an in-place placeholder instead of silently collapsing to nothing, and (2) visualizing the post-merge `validate()` phase as labelled command bars on the existing PRD/Compile timeline row so the previously-invisible multi-minute window is fully accounted for.

## Approach

All changes are confined to `packages/monitor-ui/`. No engine, daemon, client, or plugin changes.

### Fix 1 — pipeline render gate

Make `<ThreadPipeline>` always render its scaffold (header + timeline area) once the parent has decided to mount it; replace the silent `if (!hasThreadContent) return null` with an in-place placeholder when no rows exist yet.

**D1 — Always render the pipeline scaffold; replace the early null-return with an in-place placeholder.**

- **Choice.** Remove `if (!hasThreadContent) return null;` at `thread-pipeline.tsx:142`. Render the `<TooltipProvider>`, the "Pipeline" header, and the row container unconditionally. When `!hasThreadContent`, render a small dim-text placeholder ("Waiting for agent activity…") inside the row container instead of returning null.
- **Why.** The current behavior collapses the whole component to nothing in a state that is normal early in every build (planning events have arrived but no `agent:start` yet). The user cannot distinguish "system not started" from "system broken." Rendering the scaffold immediately is a better default — it tells the user the dashboard is connected and waiting, and the transition to populated rows happens in place without a visual flash.
- **Trade-off considered and rejected.** Tightening the parent gate in `app.tsx:304` to also require `agentThreads.length > 0` would just push the same blank-state problem one level up. Forcing planning events to populate `planStatuses` early was rejected — it conflates planning progress with build progress and would distort `BuildStageProgress`.

### Fix 2 — visualize the `validate()` phase as bars on the PRD/Compile timeline row

Promote the five `validation:*` events out of `IGNORED_EVENT_TYPES` to a new reducer slice that tracks command spans, then render those spans as bars in the existing PRD/Compile row using the existing time-axis math.

**D2 — `validationCommands` as a flat span array, not nested under "phases".**

- **Choice.** Add `validationCommands: ValidationCommandSpan[]` directly to `RunState`. Each span is `{ command: string; startedAt: string; endedAt: string | null; status: 'running' | 'passed' | 'failed' | 'timeout'; exitCode: number | null }`. No outer "phase" wrapper — the orchestrator may run `validate()` twice (once before prdValidate, once after gap-close); both runs append to the same flat array, and they're naturally ordered by `startedAt` since they cannot overlap.
- **Why.** The render code at `plan-row.tsx:188-289` already iterates a flat list of `sortedThreads` and computes `left/width` from each item's start/end. A flat span array drops directly into that pattern. A nested `{ phase: { commands } }` shape would require flattening at render time anyway, with no payoff.
- **Trade-off considered.** A grouped shape would let us draw a "phase" outer envelope. We don't need that visual — the user reads adjacent same-row bars as the phase, and the gap that's left between the last command and the validation-fixer (if any) is meaningful (it's the orchestrator's transition + agent spin-up time, typically sub-second).

**D3 — Bars on the same row as agent threads, not a new row.**

- **Choice.** Render validation command bars inside the existing strip at `plan-row.tsx:187-290` alongside agent thread bars on the PRD/Compile row only. A separate row is rejected.
- **Why.** The user's mental model from the screenshot is "this row shows what the build is doing right now over time." Splitting validation onto a separate row would (a) increase visual complexity for a rare, short-lived phase, and (b) split the "story" of the post-merge phase across two rows, defeating the purpose of closing the gap. The PRD row already mixes planner / plan-refine / validation-fixer bars; adding validation commands fits the same conceptual slot.
- **Trade-off considered.** A separate sub-row inside the PRD row could disambiguate "agent" vs "shell command." Rejected — the colour distinction (D5) carries that signal, and the tooltip carries the precise command text.

**D4 — Validation events leave the IGNORED list; PRD-validation events stay ignored.**

- **Choice.** Remove `validation:start`, `validation:command:start`, `validation:command:complete`, `validation:command:timeout`, `validation:complete` from `IGNORED_EVENT_TYPES`. Leave `prd_validation:start`, `prd_validation:complete`, and `validation:fix:start`/`validation:fix:complete` alone.
- **Why.**
  - `validation:fix:start` / `validation:fix:complete` are bracketing events around the validation-fixer agent's work; the fixer itself emits `agent:start` / `agent:result` which already produces a thread bar. Removing the brackets from the ignore list would cause double-counting.
  - `prd_validation:start` / `prd_validation:complete` similarly bracket the prd-validator, which emits its own `agent:start`. The terminal `prd_validation:complete` does carry useful payload (passed/gaps/completionPercent) but that's consumed elsewhere (failure banner, gap-close handler) and not needed for the timeline.
- **Trade-off.** We could also surface `validation:fix:*` as enclosing brackets around the fixer's bar to show "this is the n-th fix attempt." Deferred — the existing fixer bar carries the `n / max` info via the `validation:fix:start` event payload (`Fix attempt 1/2`) and surfacing it on the bar tooltip is a larger UX change.

**D5 — Bar colour: distinct neutral palette, not red/green-coded by exit status.**

- **Choice.** Use a single neutral colour (e.g. slate / zinc) for validation command bars, with status communicated by a small inline indicator inside the bar (a checkmark / x / clock dot) and by tooltip text. Failed and timed-out bars do **not** turn the whole bar red.
- **Why.** The agent palette already uses warm vs cool hues to differentiate roles. A red-saturated bar in the timeline reads as "the entire build failed at this point," which over-claims — a failing command triggers a fixer retry, the build may still pass. A subtle status indicator inside a neutral bar conveys "this command failed" without misleading the eye.
- **Trade-off.** Some users may prefer a more eye-catching failure colour. Defer — easy to bump up later if real users miss failed commands. The fact that a bar exists at all is the bigger win over the current invisible-phase state.

**D6 — Running command bar uses the same `pulse-opacity` animation as running agents.**

- **Choice.** When `endedAt === null`, the bar pulses with the existing `pulse-opacity 2s ease-in-out infinite` style already used at `plan-row.tsx:216`. No new animation.
- **Why.** Visual consistency. The user already reads "pulsing bar = currently running"; reusing it teaches no new vocabulary.

### Fix 7 — Bundling

**D7 — Single eforge build, not two separate sessions.**

- **Choice.** Ship Fix 1 + Fix 2 as one build. The plan file is one PRD, one acceptance-criteria block, one verification path.
- **Why.** Both fixes touch `thread-pipeline.tsx`. Fix 2 also touches `plan-row.tsx` and the reducer; Fix 1 touches only `thread-pipeline.tsx`. The merge-conflict surface for splitting them is non-zero (both rewrite the early-return area / the row prop list), and the e2e verification is the same dashboard session. Splitting introduces churn for no benefit. Per the user's `feedback_separate_plans_for_separate_issues` memo, this rule applies to *unrelated* issues — these are tightly co-located in one component family and one mental model ("the timeline tells the truth about a running build"), so a single bundled session is the right call here. (Confirmed previously accepted choice in similar circumstances per `feedback_challenge_and_redesign`.)

### Fix 8 — Boundary

**D8 — No engine-side schema changes.**

- **Choice.** Do not change event names, payload shapes, or the engine emitter. The fix is reducer-only on the consumer side.
- **Why.** Engine events are already correct and complete — the gap is in how the consumer interprets them. Touching engine code would force daemon, plugin, Pi extension, and SDK consumers all to react. Holding the boundary at `packages/monitor-ui/` keeps blast radius small.

### Code Impact

#### Files modified

| File | Why | Notes |
|---|---|---|
| `packages/monitor-ui/src/components/pipeline/thread-pipeline.tsx` | Fix 1 — remove silent `return null` at line 142; render header unconditionally; show inline placeholder when `!hasThreadContent`. | Keep `hasThreadContent` as a local flag — only its consequence changes. The `<TooltipProvider>` and the row container remain. |
| `packages/monitor-ui/src/lib/reducer/index.ts` | Fix 2 — remove the five `validation:*` event types from `IGNORED_EVENT_TYPES` (`reducer/index.ts:190-194`) and add their handlers to `handlerRegistry` (`reducer/index.ts:71-123`). | The exhaustive `_Exhaustive` check at the bottom of `index.ts` will fail until both halves are done — confirms no event type is silently dropped. |
| `packages/monitor-ui/src/lib/reducer.ts` | Fix 2 — add `validationCommands: ValidationCommandSpan[]` to `RunState`; init it `[]` in `initialRunState`; ensure `RESET` clears it. | The existing `BATCH_LOAD` and `ADD_EVENT` flow handles the new slice for free since handlers receive accumulator state. |
| `packages/monitor-ui/src/lib/types.ts` | Fix 2 — define `ValidationCommandSpan` type (`{ command, startedAt, endedAt, status, exitCode }`). | Same file already houses `PipelineStage`, `AgentRole`, `ReviewIssue`. |
| `packages/monitor-ui/src/components/pipeline/plan-row.tsx` | Fix 2 — accept `validationCommands?: ValidationCommandSpan[]` prop; when provided (compile/PRD row only), render each as a bar inside the existing strip container at lines 187-290 alongside agent thread bars, ordered by `startedAt`. | Use the same `sessionStart`/`totalSpan` math at lines 188-194. New bar variant uses a distinct colour from the agent palette. |
| `packages/monitor-ui/src/components/pipeline/thread-pipeline.tsx` (again) | Fix 2 — accept `validationCommands` prop, pass to the global/Compile `<PlanRow>` only (line 154-169). | Per-plan rows do not receive it (validation is global). |
| `packages/monitor-ui/src/components/pipeline/pipeline-colors.ts` | Fix 2 — export a `validationCommandColor` (or extend `getAgentColor` with a non-agent variant) plus a `pulse-failed` / `bar-timeout` styling token if the existing `getAgentColor` palette doesn't cover red-on-grey for failed commands. | Reuse existing Tailwind tokens; no new CSS variables. |
| `packages/monitor-ui/src/app.tsx` | Fix 2 — destructure `runState.validationCommands` and pass to `<ThreadPipeline>` at line 311. | One-line addition. |

#### Files created

| File | Why |
|---|---|
| `packages/monitor-ui/src/lib/reducer/handle-validation.ts` | Fix 2 — new event handlers: `handleValidationStart`, `handleValidationCommandStart`, `handleValidationCommandComplete`, `handleValidationCommandTimeout`, `handleValidationComplete`. Mirrors the structure of `handle-agent.ts`. |
| `packages/monitor-ui/src/lib/__tests__/handle-validation.test.ts` | Tests for the new handler — drives a fixture stream and asserts state transitions. |

#### Patterns to follow

- **Handler-per-file** layout (`reducer/handle-*.ts`), each exporting `EventHandler<'event:type'>` functions registered in the central `handlerRegistry` in `reducer/index.ts`. Mirror the structure of `handle-agent.ts`.
- **Immutable updates** — return a partial `RunState` patch from each handler; the reducer spreads it. No in-place mutation.
- **No mocks in tests** — construct event objects inline, cast through `unknown` if the SDK type machinery requires it. See `test/agent-wiring.test.ts` for the project pattern.
- **shadcn/ui only** for any new primitives — but this change should not need any (we're rendering inside an existing div with Tailwind classes; no Tooltip / Button / etc. additions beyond what `plan-row.tsx` already imports).

#### Existing utilities reused

- `getAgentColor` and `pipeline-colors` for the new bar's Tailwind classes.
- `formatDuration` from `lib/format.ts` for tooltips.
- `sessionStart` / `totalSpan` math at `plan-row.tsx:188-194`.
- `Tooltip` / `TooltipTrigger` / `TooltipContent` from `@/components/ui/tooltip`, already imported in `plan-row.tsx`.

#### Dependency relationships

- `reducer/index.ts` is the single registry — both Fix 2 handlers and the ignore-list trim happen there.
- `thread-pipeline.tsx` and `plan-row.tsx` are siblings; props flow parent→child only.
- `app.tsx` is the only consumer of `useEforgeEvents().runState` — no other component reads `validationCommands`.

#### Existing test coverage

- `packages/monitor-ui/src/lib/__tests__/` already contains `lru.test.ts` and `swr-fetcher.test.ts` plus reducer regression fixtures (introduced in commit `bd75f79`). The new handler test will follow that pattern.
- `packages/monitor-ui/src/components/pipeline/` has `pipeline-helper.test.ts` (commit `ab4649a`) — render assertions for new bar types could go here if needed, but a focused reducer test plus visual verification in step (3) of the verification plan is sufficient.

### Profile Signal

**Recommended profile: Excursion.**

Why:
- Single subsystem (`packages/monitor-ui/`); no cross-package coupling.
- Touches ~7 files (3 modified core files, 1 modified app entry, 1 modified types file, 1 new handler, 1 new test); all small edits with low merge-conflict surface.
- Two reasoning units: a render-gate fix (mechanical) and a small new state slice with bar rendering (additive). Either alone could be an Errand; bundled they need a couple of hops of orchestration (reducer change → renderer wiring → app glue) and one verification cycle.
- No architectural decisions remain open; no new dependencies; well-bounded acceptance criteria.

Errand was rejected: too many files and a new state slice + reducer handler family.
Expedition was rejected: only one subsystem and no cross-cutting interface change.

## Scope

### In scope

1. **Fix 1 — pipeline render gate.** Make `<ThreadPipeline>` always render its scaffold (header + timeline area) once the parent has decided to mount it; replace the silent `if (!hasThreadContent) return null` with an in-place placeholder when no rows exist yet.
2. **Fix 2 — visualize the `validate()` phase as bars on the PRD/Compile timeline row.** Promote the five `validation:*` events out of `IGNORED_EVENT_TYPES` to a new reducer slice that tracks command spans, then render those spans as bars in the existing PRD/Compile row using the existing time-axis math.

Both fixes ship together as a single eforge build (one PR-equivalent unit) — they share the same files and the same end-to-end verification path, so splitting them adds churn with no benefit.

### Explicitly NOT in scope

- **Deeper SSE/timing investigation for Bug 1.** All evidence points to the render-gate fix being sufficient (BATCH_LOAD always rebuilds from `initialRunState` and the reducer dispatches normally). If after Fix 1 the panel still flashes blank in any scenario, that becomes a separate session.
- **Anything outside `packages/monitor-ui/`.** No engine event-shape changes, no daemon HTTP/SSE-contract changes, no event renaming, no schema migrations.
- **Plugin / Pi parity surface bumps.** `eforge-plugin/.claude-plugin/plugin.json` does **not** bump (no plugin-facing change) and `DAEMON_API_VERSION` in `packages/client/src/api-version.ts` does **not** bump (no wire-contract change).
- **PRD-validator visualization.** `prd-validator` already emits `agent:start` and gets a bar automatically when it runs — no work needed.
- **`gap-close` and `re-validate` visualization.** `gap-closer` is already an agent (`agent:start` → bar). The re-run of `validate()` after gap-closing will be visualized for free by Fix 2 — no extra work.
- **CHANGELOG.md edits** — managed by the release flow, not feature commits.

### Natural boundaries

- Frontend-only: `packages/monitor-ui/src/`. No engine, daemon, client, or plugin changes.
- Reducer surface: one new state slice (`validationCommands`), one new handler file, one ignore-list trim. The dispatch table and event-replay loop are unchanged in shape.
- Render surface: one new bar variant inside `PlanRow`'s existing strip layout — same axis, same row, no new row, no new layout primitives.
- No new dependencies, no new shadcn components.

## Acceptance Criteria

### Functional

1. **Pipeline scaffold appears immediately on mount.** When the dashboard loads against any session that has emitted at least one event, the "Pipeline" header (with its blue dot indicator) is visible immediately. If no agent threads exist yet, the rows area shows a small dim placeholder ("Waiting for agent activity…" or equivalent). The user never sees a blank rectangle where the pipeline should be.
2. **Live updates still work.** Once SSE delivers an `agent:start`, the placeholder disappears and the row appears, all without any user action and without remounting the component (verified by stable React keys / no layout flash).
3. **Validation commands render as bars on the PRD/Compile row.** During and after `validate()` execution, each command (`postMergeCommands` and planner-generated `validate` commands) appears as a labelled bar on the same row that already shows planner / plan-refine / validation-fixer. The bar's left/width matches the command's wall-clock window using the existing `sessionStart`/`totalSpan` math.
4. **Bar state distinguishes pass / fail / timeout / running.** A successful command (exit 0) reads as "completed", a non-zero exit reads as "failed", a timeout reads as "timed out", an in-flight command reads as "running" (uses the existing `pulse-opacity` animation for parity with running agent bars). Tooltip shows the command, duration, and exit status.
5. **Re-run validation after gap-close visualizes too.** When `prdValidate` triggers gap-closing and `validate()` runs a second time, those commands also produce bars (no special case in the reducer — the same handler covers both runs).
6. **PRD-validator bar still appears via the existing `agent:start` path.** No regression for the case where validation passes and prdValidate runs.
7. **Cached completed sessions show validation bars on hydration.** Opening a previously-completed session from the sidebar replays events through `BATCH_LOAD`, populating the new state slice — bars render the same as a live session.

### Non-functional

8. **No new dependencies in `packages/monitor-ui/package.json`.**
9. **`pnpm type-check` and `pnpm build` pass at the workspace root.**
10. **`pnpm test` passes**, including a new test under `packages/monitor-ui/src/lib/__tests__/` that drives the new validation handler over a fixture stream and asserts the resulting `validationCommands` slice content (one passing command, one failing, one timeout, one still-running).
11. **No reducer regressions:** existing handler tests and BATCH_LOAD fixtures continue to pass.
12. **Plugin version is unchanged** (`eforge-plugin/.claude-plugin/plugin.json` not modified).
13. **`DAEMON_API_VERSION` is unchanged** (`packages/client/src/api-version.ts` not modified).
14. **No emoji introduced into code or comments** per project convention. The placeholder text is plain.

### Out-of-scope guardrails (to verify with `git diff`)

15. No edits to `packages/engine/`, `packages/monitor/`, `packages/client/`, `packages/scopes/`, `packages/input/`, `packages/pi-eforge/`, or `eforge-plugin/`.
16. No edits to `CHANGELOG.md` (managed by the release flow).
