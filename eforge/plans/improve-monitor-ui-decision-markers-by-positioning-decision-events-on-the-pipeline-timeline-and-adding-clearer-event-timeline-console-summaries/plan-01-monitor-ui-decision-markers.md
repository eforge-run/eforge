---
id: plan-01-monitor-ui-decision-markers
name: Position decision events on the pipeline timeline and add event-card summaries
branch: improve-monitor-ui-decision-markers-by-positioning-decision-events-on-the-pipeline-timeline-and-adding-clearer-event-timeline-console-summaries/plan-01-monitor-ui-decision-markers
---

# Position decision events on the pipeline timeline and add event-card summaries

## Architecture Context

The monitor UI already renders decision events (`planning:decision`, `plan:build:decision`) as a flex-wrapped row of small circular pips inside each plan row and as a separate row above the pipeline for session-level (`__run__`) planning decisions. The pips look like detached status indicators rather than chronological markers because they discard the event timestamp.

The daemon and engine already emit `timestamp` on every decision event:
- `packages/client/src/events.schemas.ts` — `EventEnvelopeSchema` includes `timestamp`; both `planning:decision` and `plan:build:decision` are envelope variants.
- `packages/engine/src/decisions.ts` — `emitBuildDecision` / `emitBuildDecisionForPlan` set `timestamp: new Date().toISOString()` when they yield the event.

No wire-protocol change is required. The fix lives entirely in `packages/monitor-ui/`:

1. Preserve the event timestamp in derived reducer state by wrapping each `Decision` in a `DecisionPoint`.
2. Reuse the existing `sessionStart` / `totalSpan` time scale from `thread-pipeline.tsx` and `plan-row.tsx` to position decision markers using `leftPercent = ((decisionTime - sessionStart) / totalSpan) * 100`, matching how agent bars, validation lanes, and perspective-error markers are already placed in `plan-row.tsx`.
3. Add `planning:decision` and `plan:build:decision` cases to `eventSummary` and `eventDetail` in `event-card.tsx`, sharing kind/summary formatting with the pipeline markers via a small helper module so both surfaces describe decisions consistently.

Project convention (`AGENTS.md`) says the monitor UI uses shadcn/ui components. Continue using shadcn `Tooltip` and `SheetContent`; the absolute-positioned timeline marker geometry itself is domain-specific and stays as a small `<button>` element with shadcn primitives wrapping it. Do not invent new tooltip/popover/sheet primitives.

## Implementation

### Overview

Replace `Record<string, Decision[]>` in `RunState.decisions` with `Record<string, DecisionPoint[]>` where `DecisionPoint = { decision: Decision; timestamp: string; eventType: 'planning:decision' | 'plan:build:decision' }`. Thread this shape through the three pipeline components and refactor `DecisionTimeline` from a flex pip row into a time-positioned marker lane. Add `planning:decision` and `plan:build:decision` summary/detail cases to `event-card.tsx` using shared formatting helpers extracted from the existing `decisionSummary` switch in `decision-timeline.tsx`.

### Key Decisions

1. **Wrap, don't mutate.** Introduce a `DecisionPoint` wrapper instead of monkey-patching `BuildDecision`/`PlanningDecision`. Those are client-owned wire types from `@eforge-build/client/browser`; timestamp belongs to the event envelope, not the inner decision schema.

2. **Reuse the existing time scale.** `thread-pipeline.tsx` already computes `sessionStart` (from `startTime` or fallback to `endTime ?? Date.now()`) and `totalSpan` (`Math.max(maxEnd - start, MIN_TIMELINE_WINDOW_MS)`), and passes both down to `PlanRow`. Decision markers will use the same values clamped to `[0, 100]`, matching the math at `plan-row.tsx:235-236` (agent bars), `plan-row.tsx:347-348` (validation lanes), and `plan-row.tsx:384-385` (perspective errors).

3. **Extract shared decision formatting.** Move `decisionSummary` (and the new `decisionDetail` / `decisionKindBadge` helpers) into `packages/monitor-ui/src/lib/decision-format.ts` so `event-card.tsx` and `decision-timeline.tsx` describe the same decision identically. The existing switch in `decision-timeline.tsx:42-77` covers all 12 decision kinds and is the source of truth.

4. **Markers, not pips.** Render each decision as a thin vertical pin (e.g. `w-[3px]` filled bar with a small diamond/dot cap) absolutely positioned inside a `relative h-4` lane, instead of the current `w-2.5 h-2.5 rounded-full` flex children. This makes them read as timeline events rather than status indicators while reusing the existing per-kind color families in `getPipClass`.

5. **Preserve interaction.** Keep shadcn `Tooltip` on hover (with kind, summary, rationale) and shadcn `SheetContent` on click (with the full decision payload pretty-printed). Set `aria-label` to `${kind}: ${summary}` so screen readers read the decision when color is the only visual cue.

6. **No clustering layout in this iteration.** Allow close markers to overlap. If two markers fall within a few pixels of each other, the second one's tooltip/click target may sit on top of the first; that is acceptable for the first cut. Add `z-index` bumping on hover/focus so the active marker pops above its neighbors.

7. **Session-level (`__run__`) decisions share the global axis.** In `thread-pipeline.tsx`, replace the standalone flex `DecisionTimeline` above the rows (lines 155-160) with a positioned marker lane using the same `sessionStart` / `totalSpan` already in scope, rendered as a labelled "Planning decisions" lane above the compile row. This makes their order relative to compile-phase agents visible.

8. **Event-card summaries surface decision kind + concise body.** Mirror existing patterns in `event-card.tsx` (e.g. `plan:build:review:complete` → `[${event.planId}] Review: N issue(s)`):
   - `planning:decision` → `Planning decision: ${kind} — ${decisionSummary(decision)}`
   - `plan:build:decision` → `Decision: ${kind} — ${decisionSummary(decision)}` (the existing `getEventPlanId` helper at lines 239-244 already surfaces `planId` as a clickable pill, so the plan-id chip will appear automatically since `plan:build:decision` events carry a `planId`).
   - Detail returns `decisionDetail(decision)` which formats `rationale` plus kind-specific structured fields, falling back to `JSON.stringify(decision, null, 2)` for unknown kinds.

## Scope

### In Scope
- Introduce `DecisionPoint` type alongside the existing `Decision` type in `packages/monitor-ui/src/lib/reducer.ts`.
- Change `RunState.decisions` from `Record<string, Decision[]>` to `Record<string, DecisionPoint[]>`.
- Update both decision handlers in `packages/monitor-ui/src/lib/reducer/handle-decisions.ts` to wrap the incoming decision with `{ decision, timestamp: event.timestamp, eventType: event.type }`.
- Update `packages/monitor-ui/src/lib/reducer/__tests__/handle-decisions.test.ts` to assert the wrapped shape, including that `timestamp` and `eventType` are preserved, while keeping existing keying behavior (`planId`, `__run__`) assertions intact.
- Refactor `packages/monitor-ui/src/components/pipeline/decision-timeline.tsx` from a flex pip row into a time-positioned marker lane. Accept `decisions: DecisionPoint[]`, `sessionStart: number`, `totalSpan: number`, and an optional label/mode for compact rendering. Continue using shadcn `Tooltip` and `SheetContent`.
- Extract `decisionSummary` (and a new `decisionDetail`) into `packages/monitor-ui/src/lib/decision-format.ts` so both `decision-timeline.tsx` and `event-card.tsx` can import them. Re-export from `decision-timeline.tsx` if needed to avoid breaking direct consumers, but the helper file is the source of truth.
- Update `packages/monitor-ui/src/components/pipeline/plan-row.tsx` to accept `decisions?: DecisionPoint[]` and pass `sessionStart` + `totalSpan` into `DecisionTimeline`. Place the marker lane inside the same timeline container that holds agent bars so they share the visual time axis.
- Update `packages/monitor-ui/src/components/pipeline/thread-pipeline.tsx` to type `decisions?: Record<string, DecisionPoint[]>`, replace the standalone `__run__` flex row with a time-positioned lane that uses the global `sessionStart` / `totalSpan` already computed in scope, and continue passing per-plan decisions into each `PlanRow`.
- Update `packages/monitor-ui/src/app.tsx` only for type propagation; the file passes `runState.decisions` to `ThreadPipeline` and needs no behavior change beyond the type update.
- Add `planning:decision` and `plan:build:decision` cases to `eventSummary` and `eventDetail` in `packages/monitor-ui/src/components/timeline/event-card.tsx`, importing helpers from `lib/decision-format.ts`.
- Run `pnpm type-check` and `pnpm test` to confirm no regressions across the workspace.

### Out of Scope
- Changes to `packages/client/src/events.schemas.ts` (no wire-protocol change).
- Changes to `packages/engine/src/decisions.ts` (timestamps are already emitted).
- Bumping `DAEMON_API_VERSION` in `packages/client/src/api-version.ts` (HTTP surface unchanged).
- New decision kinds, new event types, or new daemon endpoints.
- Full collision-avoidance layout for clustered markers (deferred until real-run data shows it's needed).
- Monitor-wide filtering, search, or redesign beyond decision markers and decision event cards.
- Changes to the eforge CLI, MCP, Pi extension, or any consumer-facing package outside `monitor-ui`.

## Files

### Create
- `packages/monitor-ui/src/lib/decision-format.ts` — Shared decision formatting helpers. Exports `decisionSummary(decision: Decision): string` (moved from `decision-timeline.tsx`), `decisionDetail(decision: Decision): string` (new, returns rationale + kind-specific structured fields, falling back to `JSON.stringify(decision, null, 2)`), and `decisionKindColor(kind: Decision['kind']): { bg: string; border: string }` (extracted from `getPipClass` and split into a structured return so the marker component can apply bg/border independently). Imported by `decision-timeline.tsx` and `event-card.tsx`.

### Modify
- `packages/monitor-ui/src/lib/reducer.ts` — Add and export `DecisionPoint` type: `{ decision: Decision; timestamp: string; eventType: 'planning:decision' | 'plan:build:decision' }`. Change `RunState.decisions` from `Record<string, Decision[]>` to `Record<string, DecisionPoint[]>`. Update the JSDoc above the `decisions` field to note that wrappers preserve event timing for pipeline rendering. Keep `Decision` exported so existing imports keep working; consumers that need timing will switch to `DecisionPoint`.
- `packages/monitor-ui/src/lib/reducer/handle-decisions.ts` — In both handlers, store `{ decision: event.decision, timestamp: event.timestamp, eventType: event.type }` instead of just `event.decision`. Preserve existing keying: build decisions under `planId`; planning decisions under `planId` when present, otherwise under `'__run__'`. Update inline JSDoc to describe the wrapper.
- `packages/monitor-ui/src/lib/reducer/__tests__/handle-decisions.test.ts` — Update all `expect(delta!.decisions![KEY][i]).toEqual(decisionPayload)` assertions to expect the wrapped shape `{ decision: decisionPayload, timestamp: '2024-01-15T10:00:00.000Z', eventType: 'plan:build:decision' | 'planning:decision' }`. Add at least one explicit assertion per handler that `timestamp` and `eventType` round-trip from the event into the stored wrapper. Keep all existing tests for keying behavior (`PLAN_A` vs `PLAN_B`, `__run__` sentinel, partial-delta shape) and update their expected values.
- `packages/monitor-ui/src/components/pipeline/decision-timeline.tsx` — Refactor:
  - Change prop type from `{ decisions: Decision[] }` to `{ decisions: DecisionPoint[]; sessionStart: number; totalSpan: number; label?: string }`.
  - Replace the outer `<div className="flex items-center gap-0.5 flex-wrap py-0.5">` with `<div className="relative h-4">` so markers absolutely position by timestamp.
  - For each `DecisionPoint`, compute `const decisionTime = new Date(dp.timestamp).getTime(); const leftPercent = Math.max(0, Math.min(((decisionTime - sessionStart) / totalSpan) * 100, 100));`.
  - Replace the `w-2.5 h-2.5 rounded-full` button with a pin marker: a thin vertical bar (`w-[3px]` or similar) plus a small diamond/dot cap, absolutely positioned at `left: ${leftPercent}%`, using bg/border classes from `decisionKindColor(dp.decision.kind)`.
  - Keep shadcn `Tooltip` wrapping each marker. Tooltip content: decision kind, `decisionSummary(dp.decision)`, optional rationale, optional `eventType` label (e.g. "Planning" vs "Build") so users can tell session-level vs plan-level decisions apart in mixed lanes.
  - Keep shadcn `SheetContent` click-through; pre-render the detail via `decisionDetail(dp.decision)` instead of inline `JSON.stringify`, falling back to JSON if the helper returns empty.
  - Bump `z-index` on hover/focus so the active marker sits above neighbors.
  - Set `aria-label={`${dp.decision.kind}: ${decisionSummary(dp.decision)}`}` for accessibility.
  - Import `decisionSummary` / `decisionDetail` / `decisionKindColor` from `@/lib/decision-format` and delete the local `getPipClass` / `decisionSummary` definitions.
- `packages/monitor-ui/src/components/pipeline/plan-row.tsx` — Update `PlanRowProps.decisions` from `Decision[]` to `DecisionPoint[]`. When rendering `<DecisionTimeline decisions={decisions} />`, pass `sessionStart` and `totalSpan` through (they are already in scope as `PlanRowProps`). Move the `DecisionTimeline` invocation inside (or directly adjacent to) the same `<div className="flex-1 bg-bg-tertiary rounded-sm ...">` container that holds agent bars so the marker lane visually aligns with agent bars on the same axis. Verify the marker lane appears above the agent bars (current order is: `compileStages` → `BuildStageProgress` → `DecisionTimeline` → agent bars container).
- `packages/monitor-ui/src/components/pipeline/thread-pipeline.tsx` — Update `ThreadPipelineProps.decisions` from `Record<string, Decision[]>` to `Record<string, DecisionPoint[]>`. Replace the `decisions?.['__run__']` block at lines 155-160 with a time-positioned lane that calls `<DecisionTimeline decisions={decisions['__run__']} sessionStart={sessionStart} totalSpan={totalSpan} label="Planning decisions" />` rendered above the compile row so it shares the global time axis with everything below it. Continue passing `decisions={decisions?.[planId]}` into each per-plan `PlanRow`.
- `packages/monitor-ui/src/app.tsx` — Type propagation only. The file currently passes `runState.decisions` straight into `<ThreadPipeline decisions={...} />`; with the reducer change the type is now `Record<string, DecisionPoint[]>` and should compile through without further edits. Confirm no implicit `Decision[]` typing exists anywhere on the path.
- `packages/monitor-ui/src/components/timeline/event-card.tsx` —
  - In `eventSummary`, add cases for `case 'planning:decision':` (returns `'Planning decision: ${event.decision.kind} — ${decisionSummary(event.decision)}'`) and `case 'plan:build:decision':` (returns `'Decision: ${event.decision.kind} — ${decisionSummary(event.decision)}'`). The existing `getEventPlanId` helper already surfaces `event.planId` as a clickable pill for `plan:build:decision` (which has a required `planId`), so plan context renders automatically. `planning:decision` events have an optional `planId` and will get the pill only when present.
  - In `eventDetail`, add cases for both event types that return `decisionDetail(event.decision)`, which renders rationale + kind-specific structured fields with a JSON fallback for unknown kinds.
  - Import `decisionSummary` and `decisionDetail` from `@/lib/decision-format`.
  - No change to `classifyEvent`; the existing `info` fallback color is fine for decisions (they are neither start/end nor failure-class events).

## Verification

- [ ] `pnpm type-check` exits 0 across the workspace, including `packages/monitor-ui`. No `Decision[]` typing remains on the path from `RunState.decisions` through `app.tsx` → `thread-pipeline.tsx` → `plan-row.tsx` → `decision-timeline.tsx`; every consumer uses `DecisionPoint[]` (or `Record<string, DecisionPoint[]>`).
- [ ] `pnpm test` exits 0; in particular `packages/monitor-ui/src/lib/reducer/__tests__/handle-decisions.test.ts` passes with the new wrapper shape.
- [ ] `handle-decisions.test.ts` includes at least one test per handler that asserts both `delta.decisions![key][0].timestamp === '2024-01-15T10:00:00.000Z'` and `delta.decisions![key][0].eventType === 'plan:build:decision'` (or `'planning:decision'`). The existing `__run__` keying tests and multi-plan keying tests still pass with the wrapped values.
- [ ] In the rendered UI (manual smoke check by reading the DOM produced by the component): for any plan-level decision whose `timestamp` falls strictly between `sessionStart` and `sessionStart + totalSpan`, the marker's inline `style.left` is a percentage strictly greater than `0%` and strictly less than `100%`. Decisions at the exact `sessionStart` render at `0%`; decisions clamped beyond `totalSpan` render at `100%`. (Sanity check: the math matches `plan-row.tsx:235-236` for agent bars.)
- [ ] `__run__` planning decisions render in a single time-positioned lane above the compile row in `thread-pipeline.tsx`, using the same `sessionStart` / `totalSpan` already computed for the rest of the pipeline. There is no remaining flex-wrapped pip row above the pipeline.
- [ ] Each marker exposes `aria-label` containing `${kind}: ${summary}`, hover shows a shadcn `Tooltip` with kind + `decisionSummary` + rationale (when present), and clicking opens a shadcn `SheetContent` rendering `decisionDetail` (with a JSON fallback for unknown kinds).
- [ ] Markers use a pin/diamond visual treatment (a thin vertical bar with a cap or a diamond shape), not the prior `w-2.5 h-2.5 rounded-full` pip. Per-kind color families from the original `getPipClass` are preserved via `decisionKindColor` in `lib/decision-format.ts`.
- [ ] `event-card.tsx` produces a non-default summary for both `planning:decision` (`'Planning decision: ${kind} — ${summary}'`) and `plan:build:decision` (`'Decision: ${kind} — ${summary}'`). For `plan:build:decision`, the existing plan-id pill renders next to the summary (sourced from `getEventPlanId`). For both, `details` toggles open to show the rationale + structured fields produced by `decisionDetail`, with JSON fallback for kinds that have no custom detail.
- [ ] `packages/client/src/events.schemas.ts` is unchanged in the diff. `DAEMON_API_VERSION` in `packages/client/src/api-version.ts` is unchanged. `packages/engine/src/decisions.ts` is unchanged.
- [ ] No new dependencies added to `packages/monitor-ui/package.json`; the change uses only existing shadcn `Tooltip` / `SheetContent` / `Badge` (if used) primitives and Tailwind utility classes.
- [ ] `decisionSummary` is no longer defined in `packages/monitor-ui/src/components/pipeline/decision-timeline.tsx`; both that file and `event-card.tsx` import it from `packages/monitor-ui/src/lib/decision-format.ts`.
