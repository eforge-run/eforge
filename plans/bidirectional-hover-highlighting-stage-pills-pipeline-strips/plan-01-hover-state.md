---
id: plan-01-hover-state
name: Bidirectional Hover Highlighting
depends_on: []
branch: bidirectional-hover-highlighting-stage-pills-pipeline-strips/hover-state
---

# Bidirectional Hover Highlighting: Stage Pills ↔ Pipeline Strips

## Architecture Context

The monitor's `ThreadPipeline` component in `src/monitor/ui/src/components/pipeline/thread-pipeline.tsx` renders a profile card with two visual layers: stage pills in the `ProfileHeader` → `StageOverview` section, and agent timeline strips in `PlanRow` entries below. The existing `AGENT_TO_STAGE` mapping already connects agent roles to stage names - this plan leverages that mapping to add bidirectional hover highlighting.

## Implementation

### Overview

Add a `hoveredStage` state to `ThreadPipeline` and thread it down to both `StagePill` and `PlanRow` strip divs. Hovering either element sets the shared state, causing matched elements to brighten and non-matched elements to dim.

### Key Decisions

1. Single `useState<string | null>(null)` in `ThreadPipeline` rather than a context provider - the component tree is shallow and the prop threading is straightforward through `ProfileHeader` → `StageOverview` → `StagePill` and `ThreadPipeline` → `PlanRow`.
2. Agents not in `AGENT_TO_STAGE` get `undefined` for their `stripStage`, so they naturally dim when any stage is hovered (the `hoveredStage !== null && hoveredStage !== undefined` path) - no special-casing needed.
3. Parallel stages (e.g. `[implement, doc-update]`) each get their own pill with independent hover handlers - no grouping logic required.

## Scope

### In Scope
- `hoveredStage` state and `onStageHover` callback in `ThreadPipeline`
- Prop threading through `ProfileHeader`, `StageOverview`, `StagePill`, `PlanRow`
- Mouse enter/leave handlers on `StagePill` and strip divs
- Visual states: highlighted (brightness + ring), dimmed (opacity), base (transition)

### Out of Scope
- Click interactions or persistent selection
- Changes to any file other than `thread-pipeline.tsx`

## Files

### Modify
- `src/monitor/ui/src/components/pipeline/thread-pipeline.tsx` — Add `hoveredStage` state to `ThreadPipeline`, thread hover props through `ProfileHeader`/`StageOverview`/`StagePill` and `PlanRow`, add mouse handlers and conditional styling classes on `StagePill` and strip divs

## Verification

- [ ] `pnpm build` exits with code 0 and no type errors
- [ ] `StagePill` accepts `hoveredStage: string | null` and `onStageHover: (stage: string | null) => void` props
- [ ] `StagePill` calls `onStageHover(stage)` on `onMouseEnter` and `onStageHover(null)` on `onMouseLeave`
- [ ] `StagePill` applies `ring-1 ring-foreground/40 brightness-125` when `hoveredStage === stage`
- [ ] `StagePill` applies `opacity-40` when `hoveredStage !== null && hoveredStage !== stage`
- [ ] `StagePill` has `transition-all duration-150` as base class
- [ ] `PlanRow` strip divs compute `stripStage` via `AGENT_TO_STAGE[thread.agent]`
- [ ] `PlanRow` strip divs call `onStageHover(stripStage)` on `onMouseEnter` and `onStageHover(null)` on `onMouseLeave`
- [ ] `PlanRow` strip divs apply `brightness-150 ring-1 ring-foreground/30` when `hoveredStage === stripStage`
- [ ] `PlanRow` strip divs apply `opacity-30` when `hoveredStage !== null && hoveredStage !== stripStage`
- [ ] `PlanRow` strip divs have `transition-all duration-150` as base class
- [ ] Agents without a mapping in `AGENT_TO_STAGE` dim when any stage is hovered
- [ ] Mouse leave on any element resets all pills and strips to base state (no brightness/ring/opacity overrides)
