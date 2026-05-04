---
id: plan-01-monitor-ui-pipeline-and-validation-bars
name: "Monitor UI: pipeline render-gate fix and validation-command timeline bars"
branch: fix-monitor-ui-pipeline-section-blank-on-initial-mount-and-visualize-the-validate-phase-commands-in-the-prd-compile-timeline-row/monitor-ui-pipeline-and-validation-bars
---

# Monitor UI: pipeline render-gate fix and validation-command timeline bars

## Architecture Context

The monitor UI (`packages/monitor-ui/`) is a React/SWR/Tailwind dashboard that subscribes to engine events via SSE and renders a live pipeline view. State is owned by a single reducer (`packages/monitor-ui/src/lib/reducer.ts`) with a flat handler registry keyed on `EforgeEvent['type']` (`packages/monitor-ui/src/lib/reducer/index.ts`). A compile-time `_Exhaustive` check forces every engine event variant to be either handled or explicitly listed in `IGNORED_EVENT_TYPES` — adding/removing entries on either side without rebalancing produces a TypeScript error.

The Pipeline panel is composed of a `<ThreadPipeline>` parent (`thread-pipeline.tsx`) that lays out one `<PlanRow>` per plan plus a synthetic `Compile` row for non-plan-scoped ("global") agent threads. Each `PlanRow` renders its agent threads as time-axis bars inside a single strip container (`plan-row.tsx:187-290`) using shared `sessionStart`/`totalSpan` math.

Two defects degrade the dashboard:

1. **Pipeline panel blank on initial mount.** `<ThreadPipeline>` returns `null` (line 142) when `entries.length === 0 && globalThreads.length === 0`. This is the normal early-build state because every `planning:*` event is in `IGNORED_EVENT_TYPES`, so neither `planStatuses` nor `agentThreads` is populated until the first `agent:start` lands. The parent gate in `app.tsx:304` mounts the component once any event has arrived, so the user sees a blank rectangle until F5.
2. **Multi-minute "dead air" gap on the PRD/Compile row.** The post-merge `validate()` phase (`packages/engine/src/orchestrator/phases.ts:501-537`) emits `validation:start`, `validation:command:start`, `validation:command:complete`, `validation:command:timeout`, `validation:complete` — all five are currently in `IGNORED_EVENT_TYPES` (`reducer/index.ts:190-194`). The PRD/Compile row's bars are built solely from `agentThreads`, so the validate phase is invisible by construction. A 6-minute gap between the last reviewer bar and the validation-fixer bar reads as "the system is broken or stuck."

Both fixes are confined to `packages/monitor-ui/`. Engine event shapes are already correct and complete — the gap is in how the consumer interprets them. The boundary at `packages/monitor-ui/` keeps blast radius small (no daemon, plugin, Pi, or SDK consumer impact) and avoids bumping `DAEMON_API_VERSION` or the plugin version.

## Implementation

### Overview

This plan ships two related monitor-UI fixes as one bundled unit because they share `thread-pipeline.tsx` and the same end-to-end verification path.

**Fix 1 (render gate).** Replace the silent `if (!hasThreadContent) return null;` in `thread-pipeline.tsx:142` with an unconditional render of the scaffold (`<TooltipProvider>`, the "Pipeline" header, and the row container). When `!hasThreadContent`, render a small dim-text placeholder inside the row container instead of collapsing the component.

**Fix 2 (validate-phase bars).** Introduce a new flat reducer slice `validationCommands: ValidationCommandSpan[]` populated by handlers for the five `validation:*` events. Render each span as a bar inside the existing strip on the `Compile` `<PlanRow>` only, alongside agent thread bars, using the same `sessionStart`/`totalSpan` math. Status (running / passed / failed / timeout) is communicated by an inline indicator and tooltip text on a neutral-coloured bar — not by colourising the whole bar red.

No engine changes, no event-shape changes, no new dependencies, no new shadcn primitives.

### Key Decisions

1. **Always render the pipeline scaffold; placeholder replaces null-return.** Removing the `return null` branch preserves the section's identity in the layout. `hasThreadContent` is kept as a local flag — its consequence is now "render placeholder vs. render rows," not "render or vanish." Rejected alternative: tightening the parent gate in `app.tsx:304` — same blank-state problem moves up one level.
2. **`validationCommands` as a flat span array, not nested under "phases".** `validate()` may run twice in one session (pre-prdValidate and post-gap-close); both runs append to the same array, naturally ordered by `startedAt` since they cannot overlap. Rejected alternative: a `{ phase: { commands } }` grouping — the renderer iterates a flat list anyway, with no payoff.
3. **Bars on the same row as agent threads, not a new row.** Validation command bars render inside the existing strip on the `Compile` row, alongside planner / plan-refine / validation-fixer. Rejected alternative: a separate sub-row inside the PRD row — splits the post-merge "story" across two rows and adds layout complexity for a short-lived phase.
4. **Validation-phase events leave the IGNORED list; PRD-validation and validation:fix:* events stay ignored.** `prd-validator` and `validation-fixer` agents already emit `agent:start`, which produces a thread bar via the existing handler. Adding handlers for their bracketing events would double-count.
5. **Neutral bar colour with status indicator, not red-on-failure.** A red-saturated bar over-claims — a failing command triggers a fixer retry; the build may still pass. A neutral bar with an inline status glyph plus tooltip text is the minimal viable signal.
6. **Running command bar reuses the existing `pulse-opacity 2s ease-in-out infinite` animation** from `plan-row.tsx:216`. Visual consistency with running agent bars; no new vocabulary.
7. **Ship Fix 1 + Fix 2 together.** Both touch `thread-pipeline.tsx`; their merge-conflict surface is non-zero if split. The user's `feedback_separate_plans_for_separate_issues` rule applies to *unrelated* issues — these are tightly co-located in one component family and one mental model ("the timeline tells the truth about a running build").
8. **No engine-side schema changes.** Reducer-only fix on the consumer side keeps the boundary at `packages/monitor-ui/`.

## Scope

### In Scope
- `<ThreadPipeline>` always renders its scaffold once mounted; placeholder replaces silent null-return.
- New `validationCommands: ValidationCommandSpan[]` state slice on `RunState`, initialized to `[]`, cleared on `RESET`, replayed for free under `BATCH_LOAD`.
- New `ValidationCommandSpan` type definition.
- New handler file `handle-validation.ts` with one handler per validation event (`validation:start`, `validation:command:start`, `validation:command:complete`, `validation:command:timeout`, `validation:complete`).
- Trim those five entries from `IGNORED_EVENT_TYPES`; register handlers in `handlerRegistry` (the `_Exhaustive` check enforces no event type is silently dropped).
- Render validation-command bars on the `Compile` `<PlanRow>` only, inside the existing strip container at `plan-row.tsx:187-290`, using the shared `sessionStart`/`totalSpan` time-axis math. Tooltip shows command, duration, exit status / timeout.
- Pass `runState.validationCommands` through `app.tsx:311` → `<ThreadPipeline>` → `<PlanRow planId="Compile">` only.
- Use the existing `pulse-opacity 2s ease-in-out infinite` animation for in-flight bars.
- New unit test under `packages/monitor-ui/src/lib/reducer/__tests__/handle-validation.test.ts` covering one passing command, one failing command, one timed-out command, and one still-running command across a fixture event stream (constructed inline; no mocks; cast through `unknown` if SDK type machinery requires it).

### Out of Scope
- Engine, daemon, client, scopes, input, pi-eforge, eforge-plugin changes (any modification under `packages/engine/`, `packages/monitor/`, `packages/client/`, `packages/scopes/`, `packages/input/`, `packages/pi-eforge/`, `eforge-plugin/`).
- `DAEMON_API_VERSION` bump (`packages/client/src/api-version.ts`) and plugin version bump (`eforge-plugin/.claude-plugin/plugin.json`).
- `prd_validation:start`, `prd_validation:complete`, `validation:fix:start`, `validation:fix:complete` — these stay in `IGNORED_EVENT_TYPES` because the `prd-validator` and `validation-fixer` agents already emit `agent:start` and get bars via the existing path. Removing them would double-count.
- Re-colouring the validation-fixer agent bar; surfacing fix-attempt N/M on its tooltip.
- New shadcn components or new dependencies.
- `CHANGELOG.md` edits — managed by the release flow.
- Deeper SSE / BATCH_LOAD timing investigation. If after Fix 1 the panel still flashes blank in any scenario, that becomes a separate session.

## Files

### Create
- `packages/monitor-ui/src/lib/reducer/handle-validation.ts` — five `EventHandler<'validation:...'>` functions exported for registration in `handlerRegistry`. Each returns a `Partial<RunState>` patch on `validationCommands` only. Mirrors the structure of `handle-agent.ts`. Uses `event.timestamp` for span boundaries (every `EforgeEvent` carries a `timestamp: string`, see `packages/client/src/events.ts:278`).
  - `handleValidationStart` — no-op or initialization marker (returns `undefined` to keep state ref stable, since `validation:start` only carries `commands: string[]` and the per-command `validation:command:start` event is what actually opens a span).
  - `handleValidationCommandStart` — append `{ command, startedAt: event.timestamp, endedAt: null, status: 'running', exitCode: null }` to `validationCommands`.
  - `handleValidationCommandComplete` — find the most recent open span where `command === event.command`, set `endedAt = event.timestamp`, `exitCode = event.exitCode`, and `status = exitCode === 0 ? 'passed' : 'failed'`.
  - `handleValidationCommandTimeout` — find the most recent open span where `command === event.command`, set `endedAt = event.timestamp` and `status = 'timeout'`. (The orchestrator emits `validation:command:timeout` followed by a `validation:command:complete` with `exitCode: 124` per `phases.ts:515-521`; the timeout handler runs first and stamps the status. The subsequent `complete` handler must be tolerant: if the matching span is already closed with status `timeout`, it must NOT re-open or overwrite it. Implement by reverse-walking for the *latest* span where `command === event.command && endedAt === null`; if none found, no-op.)
  - `handleValidationComplete` — no-op (returns `undefined`); the per-command events have already populated all needed state.
- `packages/monitor-ui/src/lib/reducer/__tests__/handle-validation.test.ts` — vitest suite. Drives a fixture event stream (constructed inline as objects cast through `unknown` to satisfy the discriminated union) covering: (a) one passing command (`exit 0`), (b) one failing command (`exit 1`), (c) one timed-out command (`validation:command:timeout` then `validation:command:complete` with `exitCode: 124`), (d) one still-running command (no terminal event yet). Asserts the resulting `validationCommands` array has the expected length, ordering by `startedAt`, and exact `status` / `exitCode` / `endedAt` values per span. Also covers a second `validate()` invocation after the first — both runs' commands appear in the same flat array.

### Modify
- `packages/monitor-ui/src/components/pipeline/thread-pipeline.tsx` — Fix 1: remove `if (!hasThreadContent) return null;` at line 142; render the `<TooltipProvider>`, the `<h3>` Pipeline header, and the row container unconditionally; when `!hasThreadContent`, render a single dim placeholder div with text "Waiting for agent activity…" inside the row container. Fix 2: accept a new `validationCommands?: ValidationCommandSpan[]` prop on `ThreadPipelineProps`; forward it to the `<PlanRow planId="Compile">` instance only (line 154-169). Per-plan `<PlanRow>`s do not receive it. Keep `hasThreadContent` as a local flag; do not change its inputs.
- `packages/monitor-ui/src/lib/reducer.ts` — Fix 2: add `validationCommands: ValidationCommandSpan[]` to the `RunState` interface; initialize to `[]` in `initialRunState`; explicitly reset to `[]` in the `RESET` case (currently lists every Map / object slice that needs fresh allocation — add `validationCommands: []` there). Re-export `ValidationCommandSpan` from `./types` if needed by the runtime. The `BATCH_LOAD` and `ADD_EVENT` flows handle the new slice with no further change because they spread handler deltas.
- `packages/monitor-ui/src/lib/types.ts` — Fix 2: add and export `ValidationCommandSpan` type:
  ```ts
  export type ValidationCommandStatus = 'running' | 'passed' | 'failed' | 'timeout';
  export interface ValidationCommandSpan {
    command: string;
    startedAt: string;   // ISO
    endedAt: string | null; // ISO or null while running
    status: ValidationCommandStatus;
    exitCode: number | null;
  }
  ```
- `packages/monitor-ui/src/lib/reducer/index.ts` — Fix 2: import the five new handlers from `./handle-validation`; register them in `handlerRegistry` under their respective keys (`'validation:start'`, `'validation:command:start'`, `'validation:command:complete'`, `'validation:command:timeout'`, `'validation:complete'`); remove those same five strings from the `IGNORED_EVENT_TYPES` const array (lines 190-194). The compile-time `_Exhaustive` check at the bottom of the file must remain green — it is the canary that confirms no event type is silently dropped during the rebalance.
- `packages/monitor-ui/src/components/pipeline/plan-row.tsx` — Fix 2: extend `PlanRowProps` with `validationCommands?: ValidationCommandSpan[]`. When provided (only on the `Compile` row), render each span as an additional bar in the existing strip container at lines 187-290, alongside `sortedThreads`. Bars use the same `left/width` percentage math (`((startedAt - sessionStart) / totalSpan) * 100` and the analogous width formula). Visual style: neutral background (e.g. `bg-zinc-500/30 border-zinc-500/50` — define the constant in `pipeline-colors.ts`, see below); inline status glyph rendered as a small unicode/text marker inside the bar (running → no marker, just the pulse animation; passed → `✓`; failed → `✗`; timeout → `⧖`); tooltip via `<Tooltip>` showing the command, the duration via `formatDuration(endedAt? - startedAt?)`, and `exit N` / `timed out` / `running…`. Running bars use `animation: 'pulse-opacity 2s ease-in-out infinite'` as `plan-row.tsx:216` does. Validation bars must NOT contribute to `AGENT_TO_STAGE` hover-link logic — they are not agents. Order them by `startedAt` independently of the agent threads (use a single sorted list by `startedAt` for *both* sources within the row, or render two passes — pick whichever keeps the JSX legible; ordering by start time is the only requirement).
- `packages/monitor-ui/src/components/pipeline/pipeline-colors.ts` — Fix 2: export a single constant `VALIDATION_BAR_COLOR = { bg: 'bg-zinc-500/30', border: 'border-zinc-500/50' }` (or the project's neutral equivalent — match an existing Tailwind token already in use in the file). Do NOT extend `AGENT_COLORS` or `getAgentColor` — validation bars are not agents and must not be addressable by `AgentRole`.
- `packages/monitor-ui/src/app.tsx` — Fix 2: destructure `runState.validationCommands` and pass it as a prop to `<ThreadPipeline>` at line 311. One-line addition.

### Out-of-scope guardrail (verify with `git diff` at end of build)
No edits under `packages/engine/`, `packages/monitor/`, `packages/client/`, `packages/scopes/`, `packages/input/`, `packages/pi-eforge/`, `eforge-plugin/`, or `CHANGELOG.md`. No new deps in `packages/monitor-ui/package.json`. `packages/client/src/api-version.ts` and `eforge-plugin/.claude-plugin/plugin.json` unchanged.

## Patterns to follow

- **Handler-per-file** layout under `packages/monitor-ui/src/lib/reducer/handle-*.ts`. Each handler is a typed `EventHandler<'event:type'>` from `./handler-types`. See `handle-agent.ts` for the canonical structure.
- **Test-per-handler** layout under `packages/monitor-ui/src/lib/reducer/__tests__/handle-*.test.ts`. See `handle-agent.test.ts`, `handle-enqueue.test.ts`, etc. for the canonical structure (vitest, inline event constructors, `Extract<EforgeEvent, { type: T }>` casts through `unknown`).
- **Immutable updates.** Each handler returns a `Partial<RunState>` patch. No in-place mutation of arrays or objects. For the "close most recent open span by command name" pattern, mirror the `updateThread` reverse-walk helper at the top of `handle-agent.ts` — extract a small `closeSpan(spans, predicate, patch)` helper inside `handle-validation.ts`.
- **No mocks in tests.** Construct event objects inline. SDK types may require casting through `unknown`. See `packages/monitor-ui/src/lib/reducer/__tests__/handle-agent.test.ts` and the project-level `test/agent-wiring.test.ts` for the project pattern.
- **shadcn/ui only** for new primitives — but this change adds none. Reuse `Tooltip` / `TooltipTrigger` / `TooltipContent` already imported by `plan-row.tsx`.
- **Don't break the `_Exhaustive` check.** The five handler registrations and the five ignore-list removals must land together in the same edit pass. The `_exhaustiveCheck` const assignment in `reducer/index.ts` will fail the type-check until both halves match.

## Verification

All criteria below must be observable on the working tree before the build is considered complete. Avoid vague descriptors — every line below either runs as a command or names a specific file/line.

- [ ] `pnpm --filter @eforge-build/monitor-ui type-check` exits 0.
- [ ] `pnpm type-check` (workspace root) exits 0.
- [ ] `pnpm --filter @eforge-build/monitor-ui test` exits 0, including the new `handle-validation.test.ts`.
- [ ] `pnpm test` at the workspace root exits 0.
- [ ] `pnpm --filter @eforge-build/monitor-ui build` exits 0.
- [ ] `pnpm build` at the workspace root exits 0.
- [ ] `packages/monitor-ui/src/components/pipeline/thread-pipeline.tsx` no longer contains the literal string `if (!hasThreadContent) return null;`. Grep: `grep -n 'if (!hasThreadContent) return null' packages/monitor-ui/src/components/pipeline/thread-pipeline.tsx` returns no matches.
- [ ] `packages/monitor-ui/src/components/pipeline/thread-pipeline.tsx` contains a placeholder string (e.g. `Waiting for agent activity`) rendered when `!hasThreadContent`. Grep: `grep -n 'Waiting for agent activity' packages/monitor-ui/src/components/pipeline/thread-pipeline.tsx` returns at least one match.
- [ ] `packages/monitor-ui/src/lib/reducer/index.ts` no longer lists `'validation:start'`, `'validation:command:start'`, `'validation:command:complete'`, `'validation:command:timeout'`, or `'validation:complete'` inside `IGNORED_EVENT_TYPES`. Grep each literal under that constant block — zero matches inside the array. The same five strings appear as keys in `handlerRegistry`.
- [ ] `packages/monitor-ui/src/lib/reducer/index.ts` still ends with `const _exhaustiveCheck: _Exhaustive = true;` and `pnpm type-check` is green — confirms every `EforgeEvent['type']` is either handled or ignored.
- [ ] `packages/monitor-ui/src/lib/reducer/handle-validation.ts` exists and exports `handleValidationStart`, `handleValidationCommandStart`, `handleValidationCommandComplete`, `handleValidationCommandTimeout`, `handleValidationComplete`.
- [ ] `packages/monitor-ui/src/lib/types.ts` exports `ValidationCommandSpan` and `ValidationCommandStatus`.
- [ ] `packages/monitor-ui/src/lib/reducer.ts` adds `validationCommands: ValidationCommandSpan[]` to `RunState`, initializes it to `[]` in `initialRunState`, and resets it to `[]` in the `RESET` case.
- [ ] `packages/monitor-ui/src/app.tsx` passes `validationCommands={runState.validationCommands}` to `<ThreadPipeline>` at line 311 (or the equivalent line after edits).
- [ ] `packages/monitor-ui/src/components/pipeline/plan-row.tsx` accepts a `validationCommands` prop and renders bars inside the strip container at the existing `sortedThreads.map` block, ordered by `startedAt`, using `((startedAt - sessionStart) / totalSpan) * 100` for `leftPercent`. Running bars set `animation: 'pulse-opacity 2s ease-in-out infinite'` on the inline style.
- [ ] `packages/monitor-ui/src/components/pipeline/pipeline-colors.ts` exports a `VALIDATION_BAR_COLOR` (or equivalently named) constant. `AGENT_COLORS` and `getAgentColor` are NOT extended to cover validation bars.
- [ ] `packages/monitor-ui/src/lib/reducer/__tests__/handle-validation.test.ts` contains assertions for: one span ending with `status: 'passed'` and `exitCode: 0`; one span ending with `status: 'failed'` and `exitCode` set to a non-zero number; one span ending with `status: 'timeout'`; one span still open with `endedAt: null`, `status: 'running'`, `exitCode: null`. The test also asserts the timeout handler runs before the trailing `validation:command:complete` with `exitCode: 124` and that the trailing complete does not overwrite `status: 'timeout'`. The test exercises both `ADD_EVENT` (single-event dispatch) and `BATCH_LOAD` (full replay) code paths to cover live and cached-session hydration.
- [ ] `git diff --name-only` produces NO file paths under `packages/engine/`, `packages/monitor/`, `packages/client/`, `packages/scopes/`, `packages/input/`, `packages/pi-eforge/`, `eforge-plugin/`, or `CHANGELOG.md` (compared against the plan's base branch).
- [ ] `packages/client/src/api-version.ts` is unmodified.
- [ ] `eforge-plugin/.claude-plugin/plugin.json` is unmodified.
- [ ] `packages/monitor-ui/package.json` `dependencies` and `devDependencies` are unchanged.
- [ ] No emoji introduced in modified or new files. Status glyphs are restricted to plain Unicode text symbols (`✓`, `✗`, `⧖`) or Lucide icons via the existing `lucide-react` import — no emoji codepoints in the `\x{1F300}-\x{1FAFF}` range.
