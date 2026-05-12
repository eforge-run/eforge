---
title: Improve monitor UI decision markers by positioning decision events on the pipeline timeline and adding clearer event timeline/console summaries
created: 2026-05-12
profile: claude-sdk-4-7
---

# Improve monitor UI decision markers by positioning decision events on the pipeline timeline and adding clearer event timeline/console summaries

## Problem / Motivation

The monitor UI recently gained decision markers for orchestrator/planner decisions, but the current UX makes them hard to interpret:

- Decision pips render as a compact flex row stacked at the left of the pipeline, not at the time the decision happened.
- The visual language is color-only circular dots, which makes them feel like detached status indicators rather than chronological decision events.
- Tooltips and click-through detail exist, but users must infer when the decision occurred relative to agents, validation, review cycles, and other timeline bars.
- The event timeline/console does not summarize `planning:decision` or `plan:build:decision` events specifically, reducing discoverability outside the pipeline visualization.

Affected users are developers watching or reviewing eforge runs in the monitor UI who want to understand why the orchestrator chose review strategies, respawned perspectives, changed strictness, or made planning-level choices.

### Context / Evidence reviewed

- `docs/roadmap.md` includes an orchestrator intelligence goal to make review-cycle decisions adaptive and observable, so improving decision observability in the monitor UI aligns with roadmap direction.
- Decision events already exist in the daemon/client event stream: `packages/client/src/events.schemas.ts` defines `planning:decision` and `plan:build:decision`; both inherit the common event envelope containing `timestamp`.
- Engine emission goes through `packages/engine/src/decisions.ts`, which attaches `timestamp: new Date().toISOString()` to both build and planning decision events.
- Monitor UI state currently stores only the inner decision payload in `packages/monitor-ui/src/lib/reducer/handle-decisions.ts`, discarding the event timestamp before rendering.
- `packages/monitor-ui/src/lib/reducer.ts` exposes `decisions: Record<string, Decision[]>`; consumers receive untimed `Decision[]` values.
- `packages/monitor-ui/src/components/pipeline/decision-timeline.tsx` renders decisions as flex-wrapped circular pips, with tooltip and sheet detail behavior, but no timeline positioning.
- `packages/monitor-ui/src/components/pipeline/plan-row.tsx` already computes time-positioned bars for agents, validation commands, and perspective errors using `sessionStart` and `totalSpan`; this is the pattern to reuse for decision markers.
- `packages/monitor-ui/src/components/pipeline/thread-pipeline.tsx` computes the shared `sessionStart`/`totalSpan` timeline window and passes decisions into plan rows. It also renders session-level `__run__` planning decisions separately above the rows.
- `packages/monitor-ui/src/components/timeline/event-card.tsx` does not currently provide custom summaries/details for `planning:decision` or `plan:build:decision`; they fall through to generic labels.
- Existing reducer tests in `packages/monitor-ui/src/lib/reducer/__tests__/handle-decisions.test.ts` assert the current untimed shape and will need to be updated.

Conclusion: no event schema or daemon API change is needed. The monitor UI can preserve the existing event timestamp in its derived state and render decision markers on the same time axis already used by the pipeline rows.

## Goal

Make orchestrator/planner decisions readable in the monitor UI by positioning decision events on the same pipeline timeline used for agents/validation/perspective errors, and by surfacing meaningful summaries for `planning:decision` and `plan:build:decision` events in the event timeline/console.

## Approach

### Design Decisions

1. **Preserve event metadata with the decision in UI state.**
   - Decision: introduce a `DecisionPoint` wrapper instead of mutating the wire decision payload.
   - Rationale: `BuildDecision` and `PlanningDecision` are client-owned wire types. The timestamp belongs to the event envelope, not the inner decision schema. A UI wrapper preserves chronology without drifting from the wire protocol.

2. **Use the existing pipeline time scale.**
   - Decision: position decision markers with `leftPercent = ((decisionTime - sessionStart) / totalSpan) * 100`, clamped to `[0, 100]`.
   - Rationale: this matches existing agent bar, validation command, and perspective error math in `plan-row.tsx`, keeping visual alignment consistent.

3. **Replace detached pips with timeline markers.**
   - Decision: render decisions as small vertical pins or diamond markers in a `relative h-4` lane, absolutely positioned by timestamp.
   - Rationale: a time-positioned marker answers "when did this decision happen?" while keeping the UI compact. Pins/diamonds are visually distinct from the current status-like circular pips.

4. **Use shadcn/ui primitives for interaction and disclosure, but keep timeline geometry custom.**
   - Decision: continue using shadcn `Tooltip` for hover summaries and shadcn `SheetContent` for click-through detail. Consider shadcn `Badge` for decision kind labels in tooltips, sheet headers, and event timeline rows.
   - Decision: do not invent custom tooltip/popover/sheet primitives. If a richer hover panel is needed later, add/use a shadcn component such as HoverCard/Popover rather than a bespoke overlay.
   - Rationale: project convention says the monitor UI uses shadcn/ui components rather than custom UI primitives. However, the absolute-positioned timeline marker itself is domain-specific geometry, not a generic UI primitive; a small custom button/marker wrapped in shadcn primitives is appropriate.

5. **Keep progressive detail disclosure.**
   - Decision: preserve tooltip-on-hover and sheet-on-click behavior.
   - Rationale: decision payloads contain rationale and kind-specific structured fields that are too verbose for inline display.

6. **Keep kind color families, but do not make color the only signal.**
   - Decision: retain existing color mapping as a secondary cue; expose `aria-label`, tooltip kind/summary, and possibly a tiny glyph or first-letter label for accessibility and scanability.
   - Rationale: current color mapping is already useful, but color alone is not sufficient.

7. **Share decision formatting between pipeline markers and event cards.**
   - Decision: extract `decisionSummary` and, if useful, `decisionDetail` into a small shared module such as `packages/monitor-ui/src/lib/decision-format.ts` or a local component helper if scope remains small.
   - Rationale: event timeline and pipeline marker tooltips should describe the same decision consistently.

8. **Event timeline/console rendering.**
   - Decision: add custom `EventCard` summaries:
     - `planning:decision`: `Planning decision: {kind} — {summary}`
     - `plan:build:decision`: `Decision: {kind} — {summary}` with plan id surfaced by existing plan-id handling.
   - Decision: add details showing `rationale` plus formatted key fields, with JSON fallback if needed.
   - Decision: use shadcn `Badge` where it improves scanability for decision kind, strategy, strictness, verdict, or source labels without crowding the row.
   - Rationale: the console should remain useful even when users are not looking at the pipeline visualization.

9. **Handle marker clustering simply in this iteration.**
   - Decision: do not build a full collision-avoidance layout. Allow close markers to overlap slightly or use a minimum width/hover target; optionally sort by timestamp and z-index hovered/selected markers.
   - Rationale: this keeps the improvement incremental. If clustering becomes problematic in real runs, a later iteration can add stacking or aggregation.

10. **Session-level planning decisions.**
    - Decision: render `__run__` decisions on the same global session timeline, near the compile/global row or in a compact global decision lane above pipeline rows.
    - Rationale: planning decisions occur before or around planner/compile activity; aligning them to the global time scale makes their order relative to planning agents visible.

### Code Impact

- `packages/monitor-ui/src/lib/reducer.ts`
  - Add a `DecisionPoint` type, likely `{ decision: Decision; timestamp: string; eventType: 'planning:decision' | 'plan:build:decision' }`.
  - Change `RunState.decisions` from `Record<string, Decision[]>` to `Record<string, DecisionPoint[]>`.
  - Update comments to note that decision points preserve event timing for pipeline rendering.

- `packages/monitor-ui/src/lib/reducer/handle-decisions.ts`
  - Store `{ decision: event.decision, timestamp: event.timestamp, eventType: event.type }` instead of only `event.decision`.
  - Preserve the existing keying behavior: build decisions by `planId`; planning decisions by `planId` or `__run__`.

- `packages/monitor-ui/src/lib/reducer/__tests__/handle-decisions.test.ts`
  - Update assertions to expect timed wrappers.
  - Add explicit assertions that timestamps and event types are preserved.

- `packages/monitor-ui/src/components/pipeline/decision-timeline.tsx`
  - Refactor from a flex pip row into a time-positioned marker lane component.
  - Accept `DecisionPoint[]`, `sessionStart`, `totalSpan`, and probably an optional display mode/label.
  - Keep existing decision color, summary, tooltip, and sheet behavior.
  - Consider exporting shared helpers such as `decisionSummary` if event-card will reuse them.

- `packages/monitor-ui/src/components/pipeline/plan-row.tsx`
  - Update prop type from `Decision[]` to `DecisionPoint[]`.
  - Pass `sessionStart` and `totalSpan` into the decision marker component.
  - Place the marker lane inside/adjacent to the same timeline container as agent bars so alignment is visually obvious.

- `packages/monitor-ui/src/components/pipeline/thread-pipeline.tsx`
  - Update prop type from `Record<string, Decision[]>` to `Record<string, DecisionPoint[]>`.
  - Render `__run__` planning decisions with timeline positioning using the existing global `sessionStart`/`totalSpan` values rather than a detached flex row.

- `packages/monitor-ui/src/app.tsx`
  - Likely only type propagation; it passes `runState.decisions` through to `ThreadPipeline`.

- `packages/monitor-ui/src/components/timeline/event-card.tsx`
  - Add `eventSummary` cases for `planning:decision` and `plan:build:decision`.
  - Add `eventDetail` cases with rationale and relevant structured fields, or a readable JSON fallback.
  - Consider extracting reusable decision summary helpers from `decision-timeline.tsx` to avoid duplicated switch logic.

- `packages/monitor-ui/src/components/timeline/__tests__/event-card.test.tsx`
  - Existing tests are narrow recovery rendering logic. Depending on current test style, add pure-helper tests if summary/detail helpers are extracted; otherwise rely on type-check plus reducer tests.

Evidence-backed non-impact:

- `packages/client/src/events.schemas.ts` already provides event timestamps through `EventEnvelopeSchema`; no schema bump is needed.
- `packages/engine/src/decisions.ts` already emits timestamps; no engine work is needed.

### Validation commands

- `pnpm type-check`
- `pnpm test -- packages/monitor-ui/src/lib/reducer/__tests__/handle-decisions.test.ts` if targeted Vitest file selection works in this workspace; otherwise `pnpm test`.

### Profile Signal

Recommended profile: **excursion**.

Rationale: this is a cohesive monitor-ui feature touching reducer state, a few React components, and tests. It requires a planner to preserve type/data-flow consistency across UI state and rendering, but it does not require delegated module planning or new system boundaries. A single cohesive plan should cover the implementation without Expedition-level architecture/module decomposition.

## Scope

### In scope

1. **Preserve decision timestamps in monitor-ui derived state.**
   - Replace the current `Decision[]` derived shape with a timed wrapper such as `DecisionPoint[]` containing `{ decision, timestamp, eventType }`.
   - Keep decisions keyed by plan id, with `__run__` for session-level planning decisions.

2. **Render decision markers relative to the existing pipeline timeline.**
   - Replace the detached flex-wrapped pip row with a timeline-positioned decision lane.
   - Use the same `sessionStart` / `totalSpan` math already used by agent bars, validation spans, and perspective error markers.
   - Render session-level planning decisions aligned to the same global timeline above or within the compile/global row.
   - Render plan-level decisions in each plan row at the decision event timestamp.

3. **Improve marker semantics.**
   - Prefer vertical pins or compact diamond markers over plain detached dots.
   - Keep the existing tooltip summary and click-to-open sheet detail behavior.
   - Preserve decision-kind coloring, but do not rely on color alone; include accessible labels and useful tooltip text.

4. **Improve the event timeline/console.**
   - Add custom `eventSummary` and `eventDetail` handling for `planning:decision` and `plan:build:decision` in `EventCard`.
   - Reuse or extract decision summary/detail helpers so pipeline markers and event cards present decisions consistently.

5. **Update tests.**
   - Update reducer tests for the timed decision shape.
   - Add or update monitor-ui tests for decision event summaries where practical.
   - Run type-check/tests relevant to monitor-ui.

### Out of scope

- No daemon event schema changes.
- No changes to engine decision emission.
- No new decision kinds.
- No monitor-wide redesign or new filtering controls.
- No changes to the MCP/CLI/Pi extension surfaces.

## Acceptance Criteria

1. **Decision state preserves timing.**
   - Reducer state stores each decision with its original event timestamp and event type.
   - Existing keying behavior remains unchanged: build decisions under their `planId`; session-level planning decisions under `__run__`; plan-scoped planning decisions under their `planId`.

2. **Pipeline decision markers are time-positioned.**
   - Plan-level decision markers render at positions derived from their event timestamp relative to `sessionStart` and `totalSpan`.
   - Session-level planning decisions render on the same global timeline scale rather than as a detached left-stacked row.
   - Markers no longer appear simply stacked at the left unless their timestamps actually fall at the beginning of the timeline.

3. **Marker UX remains useful and accessible.**
   - Each marker exposes a tooltip containing decision kind, concise summary, and rationale when present.
   - Clicking a marker opens the existing sheet detail view with the full decision payload or equivalent structured detail.
   - Markers have accessible labels that include the decision kind and summary.
   - Markers are visually distinct from generic status dots, using pins/diamonds or another timeline-event treatment.

4. **Event timeline/console is improved.**
   - `planning:decision` events show a meaningful summary instead of only the raw event type.
   - `plan:build:decision` events show a meaningful summary and plan context.
   - Decision event details include rationale and key structured fields, or a readable fallback.

5. **Tests and checks pass.**
   - Reducer tests cover timestamp/eventType preservation.
   - TypeScript compiles with the new `DecisionPoint` shape through `app.tsx`, `thread-pipeline.tsx`, `plan-row.tsx`, and `decision-timeline.tsx`.
   - Relevant Vitest tests pass; at minimum the updated reducer test passes, and `pnpm type-check` passes.

6. **No protocol churn.**
   - No changes are made to `packages/client/src/events.schemas.ts` for this UX improvement.
   - `DAEMON_API_VERSION` is not bumped because the wire API remains unchanged.

### Assumptions And Validation

| Assumption | Evidence / validation performed | Confidence | Cost to validate further | Validation path | Impact if wrong |
|------------|----------------------------------|------------|--------------------------|-----------------|-----------------|
| Decision event timestamps are already available to monitor-ui reducer handlers. | `packages/client/src/events.schemas.ts` shows `EventEnvelopeSchema` includes `timestamp`; `planning:decision` and `plan:build:decision` are event variants; `packages/engine/src/decisions.ts` emits timestamps. | high | low | Type-check handler access to `event.timestamp`; update reducer tests. | If wrong, timeline positioning would require a schema/API change, increasing scope. |
| Changing `RunState.decisions` to a `DecisionPoint[]` wrapper is local to monitor-ui. | `rg` found consumers in monitor-ui reducer tests, `app.tsx`, `thread-pipeline.tsx`, `plan-row.tsx`, and `decision-timeline.tsx`. | medium-high | low | Run `pnpm type-check` after changing the type; fix any additional consumers. | If wrong, more UI files need updates, but still likely internal to monitor-ui. |
| No daemon API version bump is needed. | Wire event shape is unchanged; only derived UI state and rendering change. Project instructions require API version bumps for breaking HTTP API surface changes, which this is not. | high | low | Confirm no changes to `packages/client/src/events.schemas.ts` or daemon routes in implementation diff. | If wrong, version skew could occur, but evidence indicates no API change. |
| A simple marker lane is sufficient for initial clustering behavior. | Current decision counts appear low in the screenshot and decision kinds are sparse per plan. This is partly based on observed UI, not exhaustive run data. | medium | medium | Test against a run with multiple review rounds/respawns; inspect whether overlapping markers remain usable. | If wrong, markers may overlap and require stacking/aggregation logic. |
| Event-card decision summaries can reuse extracted decision formatting helpers without creating circular imports. | Current summary logic lives in `decision-timeline.tsx`; extracting to `lib/decision-format.ts` avoids component-to-component coupling. | high | low | Implement extraction and run type-check. | If wrong, duplicate small switch logic in `EventCard` and `DecisionTimeline` instead. |

No low-confidence/high-impact assumptions remain unresolved. The main product assumption is marker clustering; its impact is moderate and can be validated visually after the initial implementation.
