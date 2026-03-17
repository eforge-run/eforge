---
id: plan-02-consumer-updates
name: Consumer Updates for Greedy Scheduling Events
depends_on: [plan-01-greedy-scheduler-engine]
branch: greedy-dependency-scheduling/consumers
---

# Consumer Updates for Greedy Scheduling Events

## Architecture Context

Plan-01 replaces `wave:start`/`wave:complete` events with `schedule:start`/`schedule:ready` events in the engine. All consumers that render or process these events must be updated: CLI display, monitor UI (reducer, wave-utils, timeline components), and the dry-run display. The exhaustive switch in `display.ts` will produce a TypeScript compile error until updated, which is the forcing function.

## Implementation

### Overview

Update all event consumers to handle the new `schedule:start`/`schedule:ready` events instead of `wave:start`/`wave:complete`. The CLI display replaces wave banners with a simpler scheduling log. The monitor UI shifts from wave-sectioned timeline to a flat plan-centric timeline since plans no longer group into discrete waves. The dry-run display continues to show waves (from `resolveDependencyGraph`) since that's useful for understanding the dependency structure - but labels them as "dependency layers" rather than "execution waves" to avoid confusion.

### Key Decisions

1. **CLI display uses lightweight log lines instead of wave banners.** `schedule:start` prints a header with total plan count. `schedule:ready` prints a dim line showing which plan is starting and why (e.g., "dependencies met: A, B merged"). This gives visibility without the false implication that execution is wave-structured.

2. **Monitor UI replaces wave-sectioned timeline with a flat plan timeline.** Since plans no longer execute in discrete waves, the `WaveTimeline`/`WaveSection`/`WaveHeader` components are replaced with a simpler `PlanTimeline` that shows all plans in a flat list with their current stage. The dependency graph visualization is unaffected - it already renders the DAG structure directly.

3. **Monitor reducer tracks `schedule:start`/`schedule:ready` instead of `wave:start`.** The `waves` array in `RunState` is removed since it no longer reflects execution reality. Plan statuses remain the primary tracking mechanism.

4. **Dry-run still shows dependency layers.** The `renderDryRun` function still calls `resolveDependencyGraph()` and displays the resulting layers - this is useful for understanding the structure. But the label changes from "Wave N" to "Layer N" and the description notes these are dependency layers, not execution waves.

## Scope

### In Scope
- Update CLI `renderEvent()` exhaustive switch for new event types
- Update CLI `renderDryRun()` labeling
- Update monitor UI reducer to handle new events and remove wave tracking
- Update or replace monitor wave-utils, wave-timeline, wave-section, wave-header components
- Update monitor event-card for new event types
- Update monitor mock-server if it emits wave events

### Out of Scope
- Engine changes (plan-01)
- Dependency graph visualization changes (already DAG-based, unaffected)
- Monitor database schema changes (events stored as JSON, schema-agnostic)

## Files

### Modify
- `src/cli/display.ts` — Replace `wave:start`/`wave:complete` cases with `schedule:start`/`schedule:ready`. Update `renderDryRun()` to label dependency layers instead of waves.
- `src/cli/index.ts` — Update dry-run code if the `renderDryRun` signature changes (add/remove parameters).
- `src/monitor/ui/src/lib/reducer.ts` — Remove `waves` from `RunState` and `initialRunState`. Remove `wave:start` event processing. Add `schedule:start`/`schedule:ready` processing (track active plans). Remove `WaveInfo` import.
- `src/monitor/ui/src/lib/wave-utils.ts` — Remove or replace entirely. The `partitionEventsByWave` and `computeWaveStatus` functions are no longer needed. Replace with a simpler `partitionEventsByPhase` that groups events into pre-build, per-plan, and post-build sections.
- `src/monitor/ui/src/components/timeline/wave-timeline.tsx` — Replace with a flat `ScheduleTimeline` that shows plans without wave grouping. Rename file or create new file.
- `src/monitor/ui/src/components/timeline/wave-section.tsx` — Remove (no longer needed with flat timeline).
- `src/monitor/ui/src/components/timeline/wave-header.tsx` — Remove (no longer needed).
- `src/monitor/ui/src/components/timeline/timeline.tsx` — Update to use new timeline component instead of `WaveTimeline`.
- `src/monitor/ui/src/components/timeline/event-card.tsx` — Update event type rendering for `schedule:start`/`schedule:ready` instead of `wave:start`/`wave:complete`.
- `src/monitor/ui/src/app.tsx` — Update if it references wave-related state or components.
- `src/monitor/mock-server.ts` — Update mock events to emit `schedule:start`/`schedule:ready` instead of `wave:start`/`wave:complete`.
- `src/monitor/ui/src/lib/types.ts` — Update `EforgeEvent` type if the monitor has its own type definition (check if it re-exports or duplicates the engine types).
- `src/monitor/ui/src/hooks/use-eforge-events.ts` — Update if it references wave types.
- `src/monitor/ui/src/components/heatmap/use-heatmap-data.ts` — Update `computeHeatmapData()` and `useHeatmapData()` which consume `runState.waves` and `WaveInfo`. Adapt to work without wave grouping — file conflict risk analysis should use dependency layers computed locally (similar to how `use-graph-layout.ts` computes waves from plan config) rather than runtime wave events.

### Delete
- `src/monitor/ui/src/components/timeline/wave-section.tsx` — Replaced by flat plan timeline
- `src/monitor/ui/src/components/timeline/wave-header.tsx` — No longer needed

## Verification

- [ ] `pnpm type-check` passes with zero errors (exhaustive switch in display.ts compiles)
- [ ] `pnpm test` passes
- [ ] `pnpm build` succeeds (includes monitor UI build)
- [ ] CLI `renderEvent` handles `schedule:start` and `schedule:ready` event types
- [ ] CLI `renderEvent` does NOT handle `wave:start` or `wave:complete` (removed from switch)
- [ ] `renderDryRun` labels output as "Layer" instead of "Wave"
- [ ] Monitor reducer's `RunState` interface does not contain a `waves` field
- [ ] Monitor UI compiles without referencing `WaveTimeline`, `WaveSection`, or `WaveHeader` components
- [ ] The files `wave-section.tsx` and `wave-header.tsx` are deleted from the monitor UI
