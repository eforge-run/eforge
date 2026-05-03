---
id: plan-02-pipeline-split-and-memo
name: Split thread-pipeline god-file, apply React.memo, add pipeline-helper tests
branch: monitor-ui-tech-debt/pipeline-split-and-memo
agents:
  builder:
    effort: high
    rationale: Pixel-equivalent split of the most pixel-dense view in the app, plus
      React.memo on three hot components — moderate-to-high coordination but the
      slice boundaries are pre-declared in the plan.
  reviewer:
    effort: high
    rationale: Reviewer must verify pixel-equivalence (via attached before/after
      screenshots), confirm no inline object/array literals defeat memoization,
      and check that PlanRow's prop shape (notably eventsByAgent) supports
      default shallow comparison.
---

---
id: plan-02-pipeline-split-and-memo
name: Split thread-pipeline god-file, apply React.memo, add pipeline-helper tests
depends_on: [plan-01-reducer-decomposition]
branch: monitor-ui-tech-debt/pipeline-split-and-memo
---

# Split thread-pipeline god-file, apply React.memo, add pipeline-helper tests

## Architecture Context

`packages/monitor-ui/src/components/pipeline/thread-pipeline.tsx` is a 911-LOC god-file mixing color/style constants, agent→stage mapping, depth-graph computation, an activity-density overlay, a stage-overview header, and a ~240-LOC `<PlanRow>` sub-component. It owns the most pixel-dense view in the app — depth bars, hover-dim stage pills, composite-stage chevrons, dependency-depth plan-pill colors, activity-density buckets — so cosmetic regression risk during the split is high.

This plan depends on plan-01: with the reducer's selective allocation in place, only handler-returned slices change refs per event, so `React.memo` on the hot UI components actually fires. Without plan-01, memoization on these components is largely a no-op because every event still allocates seven new container refs upstream.

The split mirrors the source PRD's design (D1–D8): a `components/pipeline/` subfolder with `pipeline-colors.ts`, `agent-stage-map.ts`, `compute-depth-map.ts`, `activity-overlay.tsx`, `stage-overview.tsx`, `plan-row.tsx`, plus `thread-pipeline.tsx` shrunk to a thin orchestrator. `<ThreadPipeline>`, `<PlanRow>`, and `<EventCard>` (timeline rows, mapped over `events` in `timeline.tsx`) are wrapped in `React.memo` with default shallow comparison. Where prop shape currently defeats shallow comparison (`<PlanRow>` receives the full `events: StoredEvent[]` array purely to compute a per-agent activity overlay), the prop is narrowed to a pre-bucketed `eventsByAgent: Map<string, StoredEvent[]>` computed once in `<ThreadPipeline>`'s `useMemo`.

Key constraints from `AGENTS.md` and the source PRD:
- Pixel-equivalent rendering. Three states must visually match before/after: idle (no events), mid-build (multiple plans, mixed stages, at least one in-progress agent), completed-with-failure. Implementer attaches before/after screenshots to the PR.
- shadcn/ui primitives only — `Tooltip`, `Button` already imported in `thread-pipeline.tsx`; carry over into `plan-row.tsx`.
- No mocks in tests (per existing convention in `verdict-chip.test.tsx`).
- No backwards-compat shims.
- No new `/api/...` literals.

## Implementation

### Overview

1. Create `components/pipeline/pipeline-colors.ts` and move all color/style constants and helpers (`AGENT_COLORS`, `TIER_COLORS`, `DEPTH_BAR_BG`, `DEPTH_PILL_CLASS`, `pillClass`, `prdPillClass`, `planPillClass`, `planPillClassFor`, `getAgentColor`, `getTierColor`, `FALLBACK_COLOR`, `DEFAULT_TIER`, `STAGE_STATUS_STYLES`, `EMPTY_THREADS`, `EMPTY_EVENTS`, `EMPTY_SET`, `abbreviatePlanId`).
2. Create `components/pipeline/agent-stage-map.ts` and move `AGENT_TO_STAGE`, `COMPOSITE_STAGES`, `REVIEW_AGENTS`, `resolveBuildStage`, `getBuildStageStatuses`, `buildStageName`, `getStageStatus`, the `StageStatus` type, and `MIN_TIMELINE_WINDOW_MS`.
3. Create `components/pipeline/compute-depth-map.ts` and move `computeDepthMap` (with cycle guard preserved).
4. Create `components/pipeline/activity-overlay.tsx` and move `ActivityOverlay`, `ACTIVITY_BUCKET_MS`, `ACTIVITY_STREAMING_TYPES`, `getActivityOpacity`. Imports from `pipeline-colors.ts` and `agent-stage-map.ts`.
5. Create `components/pipeline/stage-overview.tsx` and move `StagePill`, `Chevron`, `StageOverview`, `BuildStageProgress`. Imports from `pipeline-colors.ts` and `agent-stage-map.ts`.
6. Create `components/pipeline/plan-row.tsx` and move `PlanRow`, `IssuesSummary`, `DepthBars`, plan-pill helpers. Wrap default export `PlanRow` in `React.memo`. Refactor its prop shape so the activity overlay receives `eventsByAgent: Map<string, StoredEvent[]>` rather than the full `events` array.
7. Reduce `thread-pipeline.tsx` to a thin orchestrator (~150 LOC, ≤200 LOC hard cap). Wrap default export `ThreadPipeline` in `React.memo`. Pre-bucket `eventsByAgent` once via `useMemo` and pass that to `<PlanRow>`. Audit the props passed to `<PlanRow>` to confirm every one is a primitive, a stable ref, or a `useMemo`-wrapped value.
8. Audit `app.tsx:337` (the `<ThreadPipeline>` call site) — confirm every prop is a primitive, a stable ref, or wrapped in `useMemo`. Wrap any inline object/array literal in `useMemo` if found.
9. Wrap `EventCard`'s default export in `React.memo` (`packages/monitor-ui/src/components/timeline/event-card.tsx`).
10. Add `compute-depth-map.test.ts` and `agent-stage-map.test.ts` covering the pure-helper logic.
11. Capture before/after screenshots of `<ThreadPipeline>` in three states using the `ui:browser-qa` agent (or equivalent local browser automation) and attach them to the PR description for reviewer pixel-equivalence verification.

### Key Decisions

1. **Default shallow comparison for `React.memo`.** No custom `areEqual` functions. Shifts cost from "render + diff" to "deep-compare every render" with high drift risk. Where prop shape currently defeats shallow comparison, narrow the prop instead. The concrete narrowing case is `<PlanRow>` receiving `events: StoredEvent[]` purely to compute a per-agent activity overlay — replace with `eventsByAgent: Map<string, StoredEvent[]>` pre-bucketed in `<ThreadPipeline>`.

2. **`React.memo` scope is exactly three components.** `<ThreadPipeline>`, `<PlanRow>`, `<EventCard>`. Broader memoization (summary cards, heatmap cells, graph nodes) is rejected — their re-renders are driven by the same data churn the reducer fix already addresses, so memoizing them adds ceremony without measurable benefit.

3. **File-size cap.** No file in `components/pipeline/` exceeds 300 LOC. `thread-pipeline.tsx` orchestrator under 200 LOC.

4. **Pixel-equivalence is a hard gate.** Implementer captures before/after screenshots in three states and attaches to the PR. Reviewer verifies. Any visual delta must be explained and approved or the split is rejected.

5. **Pure-helper tests, not component tests.** `compute-depth-map.test.ts` covers linear, branching, and cyclic dependency graphs (cycle guard). `agent-stage-map.test.ts` covers `resolveBuildStage` with composite stages (`review-cycle`, `test-cycle`), `getBuildStageStatuses` for completed/failed/in-progress, and parallel groups. Component-level rendering tests are out of scope — `event-card.test.tsx` already covers timeline rendering and stays passing as the behavioral check on `<EventCard>`'s `React.memo` wrap.

6. **Performance numbers are nice-to-have, not blocking.** The acceptance criterion is qualitative: in React DevTools Profiler, an `agent:tool_use` event for an unrelated agent re-renders zero `<PlanRow>` instances and only the new `<EventCard>` row. Implementer attaches a profiler screenshot or a brief note confirming this.

## Scope

### In Scope

- Split `thread-pipeline.tsx` into the six files declared above plus a thin orchestrator.
- `React.memo` on `<ThreadPipeline>`, `<PlanRow>`, `<EventCard>`.
- Prop-shape narrowing on `<PlanRow>` (replace `events: StoredEvent[]` with `eventsByAgent: Map<string, StoredEvent[]>`).
- `useMemo` audit at `<ThreadPipeline>`'s call site in `app.tsx` to ensure no inline object/array literals defeat memoization. Wrap any found cases.
- `compute-depth-map.test.ts` and `agent-stage-map.test.ts`.
- Before/after screenshots captured and attached to the PR.

### Out of Scope

- Reducer decomposition, selective allocation, regression fixture, reducer handler tests — all owned by plan-01.
- Polling, shared cache, SWR / React-Query (PRD B territory).
- `EforgeEvent` shape changes.
- Visual design changes; pipeline rendering must be pixel-equivalent.
- Memoization on summary cards, heatmap cells, graph nodes.
- Other monitor-UI components unrelated to the pipeline (recovery sidecar, plan-preview, console, sidebar, header, layout, summary cards).
- Monitor backend, daemon, `packages/client/`.
- Switching to Zustand/Jotai/Redux.
- Adding new dependencies to `packages/monitor-ui/package.json`.

## Files

### Create

- `packages/monitor-ui/src/components/pipeline/pipeline-colors.ts` — `AGENT_COLORS`, `TIER_COLORS`, `DEPTH_BAR_BG`, `DEPTH_PILL_CLASS`, `pillClass`, `prdPillClass`, `planPillClass`, `planPillClassFor`, `getAgentColor`, `getTierColor`, `FALLBACK_COLOR`, `DEFAULT_TIER`, `STAGE_STATUS_STYLES`, `EMPTY_THREADS`, `EMPTY_EVENTS`, `EMPTY_SET`, `abbreviatePlanId`.
- `packages/monitor-ui/src/components/pipeline/agent-stage-map.ts` — `AGENT_TO_STAGE`, `COMPOSITE_STAGES`, `REVIEW_AGENTS`, `resolveBuildStage`, `getBuildStageStatuses`, `buildStageName`, `getStageStatus`, `StageStatus` type, `MIN_TIMELINE_WINDOW_MS`.
- `packages/monitor-ui/src/components/pipeline/compute-depth-map.ts` — `computeDepthMap` with cycle guard.
- `packages/monitor-ui/src/components/pipeline/activity-overlay.tsx` — `ActivityOverlay`, `ACTIVITY_BUCKET_MS`, `ACTIVITY_STREAMING_TYPES`, `getActivityOpacity`.
- `packages/monitor-ui/src/components/pipeline/stage-overview.tsx` — `StagePill`, `Chevron`, `StageOverview`, `BuildStageProgress`.
- `packages/monitor-ui/src/components/pipeline/plan-row.tsx` — `PlanRow` (wrapped in `React.memo`), `IssuesSummary`, `DepthBars`. Receives `eventsByAgent: Map<string, StoredEvent[]>` in place of the raw events array.
- `packages/monitor-ui/src/components/pipeline/__tests__/compute-depth-map.test.ts` — covers linear chain, branching DAG, and cyclic input (cycle guard).
- `packages/monitor-ui/src/components/pipeline/__tests__/agent-stage-map.test.ts` — covers `resolveBuildStage` for `review-cycle` and `test-cycle` composites, `getBuildStageStatuses` for completed/failed/in-progress and parallel groups, `buildStageName` for the canonical stage names.

### Modify

- `packages/monitor-ui/src/components/pipeline/thread-pipeline.tsx` — shrink to a thin orchestrator (≤200 LOC). Wrap default export in `React.memo`. Compute `eventsByAgent` once via `useMemo`. Pass narrowed props to memoized children. Re-export any types still consumed externally (none expected).
- `packages/monitor-ui/src/app.tsx` — audit the `<ThreadPipeline>` call site (currently around line 337). Confirm every passed prop is a primitive, a stable ref, or `useMemo`-wrapped. Wrap any inline object/array literals in `useMemo`. Behavior is unchanged.
- `packages/monitor-ui/src/components/timeline/event-card.tsx` — wrap default export in `React.memo` with default shallow comparison. No other changes.

## Verification

- [ ] `packages/monitor-ui/src/components/pipeline/thread-pipeline.tsx` is ≤200 LOC (`wc -l` confirms).
- [ ] `packages/monitor-ui/src/components/pipeline/` contains exactly these source files: `thread-pipeline.tsx`, `pipeline-colors.ts`, `agent-stage-map.ts`, `compute-depth-map.ts`, `activity-overlay.tsx`, `stage-overview.tsx`, `plan-row.tsx`, plus the `__tests__/` subfolder.
- [ ] No file in `packages/monitor-ui/src/components/pipeline/` exceeds 300 LOC (`wc -l` confirms each).
- [ ] `<ThreadPipeline>`, `<PlanRow>`, and `<EventCard>` default exports are wrapped in `React.memo` with default shallow comparison (no custom `areEqual`).
- [ ] In React DevTools Profiler against a live build, an `agent:tool_use` event for an unrelated agent triggers zero `<PlanRow>` re-renders and only one new `<EventCard>` render (for the new event); no pre-existing `<EventCard>` rows re-render. Implementer attaches profiler evidence (screenshot or note) to the PR.
- [ ] Every prop passed to `<ThreadPipeline>` from `app.tsx`, and every prop passed to `<PlanRow>` from `<ThreadPipeline>`, is one of: a primitive, a stable ref (component-scoped constant or imported from `pipeline-colors.ts`), or a `useMemo`-wrapped value. No inline object/array/function literals at the call site.
- [ ] `<PlanRow>` receives `eventsByAgent: Map<string, StoredEvent[]>` rather than the full `events: StoredEvent[]` array.
- [ ] Before/after screenshots of `<ThreadPipeline>` in three states (idle/no-events, mid-build with multiple plans + mixed stages + at least one in-progress agent, completed-with-failure) are captured and attached to the PR. Reviewer verifies pixel-equivalence.
- [ ] `pnpm test` from the repo root passes, including the new `compute-depth-map.test.ts` and `agent-stage-map.test.ts`, plus all pre-existing tests (`api-routes-compliance.test.tsx`, `event-card.test.tsx`, `verdict-chip.test.tsx`, `queue-section-recovery.test.tsx`, and every reducer test created in plan-01).
- [ ] `compute-depth-map.test.ts` covers a linear dependency chain, a branching DAG, and a cyclic input (asserting the cycle guard does not infinite-loop).
- [ ] `agent-stage-map.test.ts` covers `resolveBuildStage` for both `review-cycle` and `test-cycle` composites, `getBuildStageStatuses` for completed/failed/in-progress states and parallel groups, and `buildStageName` returning the canonical name for each stage.
- [ ] `pnpm type-check` passes for the entire workspace.
- [ ] `pnpm build:ui` succeeds.
- [ ] No new `/api/...` literals introduced (existing `api-routes-compliance.test.tsx` continues to pass).
- [ ] `packages/monitor-ui/package.json` has no new dependencies added in this plan.
- [ ] No changes to `packages/engine/`, `packages/monitor/`, or `packages/client/`.
- [ ] No changes to polling logic in `app.tsx` (the polling `useEffect` blocks for `/latest-run`, `Sidebar`, and `queue-section` are byte-identical to their pre-plan state).
- [ ] No changes to `packages/monitor-ui/src/hooks/use-eforge-events.ts`.
