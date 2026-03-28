---
id: plan-01-build-stage-breadcrumb
name: Build Stage Breadcrumb in Timeline
depends_on: []
branch: claude-plans-tender-sniffing-charm/build-stage-breadcrumb
---

# Build Stage Breadcrumb in Timeline

## Architecture Context

The monitor timeline (`ThreadPipeline`) shows agent swimlane bars per plan but lacks visibility into the build pipeline progress. The compile stage pipeline (in `ProfileHeader`) already uses `StagePill`, `Chevron`, and `getStageStatus` to render status-aware breadcrumbs. This plan reuses those patterns to add a per-plan build stage breadcrumb between the plan name label and the swimlane bars.

Orchestration data (containing per-plan `build: BuildStageSpec[]`) is already fetched and computed as `effectiveOrchestration` in `app.tsx` - it just needs to be passed through to `ThreadPipeline` and down to each `PlanRow`.

## Implementation

### Overview

Thread orchestration data from `app.tsx` to `ThreadPipeline`, add a `BuildStageProgress` component that maps `PipelineStage` values to build stage specs and renders status-aware pills, then render it inside each `PlanRow`.

### Key Decisions

1. **Reuse existing `StagePill` and `Chevron`** rather than creating new components - the compile pipeline already has the right styling, animations, and hover behavior.
2. **Map `PipelineStage` to `BuildStageSpec` names** via a lookup table. The reducer emits fine-grained stages (`implement`, `review`, `evaluate`, `test`) while orchestration.yaml uses composite names (`review-cycle`, `test-cycle`). The mapping collapses sub-stages to their composite parent.
3. **Add `failed` status style** to `STAGE_STATUS_STYLES` - currently only `pending`, `active`, `completed` exist. Failed builds need a red indicator.
4. **Parallel groups** render as vertically stacked pills in a bordered container (matching the `ParallelGroup` pattern from `build-config.tsx`) but with status coloring from `STAGE_STATUS_STYLES`.

## Scope

### In Scope
- Threading `orchestration` prop from `app.tsx` to `ThreadPipeline` to `PlanRow`
- `PIPELINE_TO_BUILD_STAGE` mapping from `PipelineStage` to build stage spec names
- `getBuildStageStatuses()` helper that computes status for each build stage given the current `PipelineStage`
- `BuildStageProgress` component rendering status-aware breadcrumb
- `failed` entry in `STAGE_STATUS_STYLES` (red, no pulse)
- Parallel group rendering with status coloring

### Out of Scope
- Changes to the reducer or event types
- Changes to the plan detail panel's existing `BuildConfigSection`
- Adding click-to-filter or interactive behavior to the breadcrumb pills
- Modifying the compile stage pipeline rendering

## Files

### Modify
- `src/monitor/ui/src/app.tsx` - Pass `orchestration={effectiveOrchestration}` to `<ThreadPipeline>` at line 279
- `src/monitor/ui/src/components/pipeline/thread-pipeline.tsx` - Add `BuildStageProgress` component, `PIPELINE_TO_BUILD_STAGE` mapping, `getBuildStageStatuses()` helper, `failed` status style, update `ThreadPipelineProps` and `PlanRowProps` to accept orchestration/build data, render breadcrumb in `PlanRow`

## Verification

- [ ] `pnpm type-check` passes with zero errors
- [ ] `pnpm build` completes with zero errors
- [ ] `ThreadPipelineProps` includes an optional `orchestration` property typed as `OrchestrationConfig | null`
- [ ] `PlanRowProps` includes optional `buildStages` (typed `BuildStageSpec[]`) and `currentStage` (typed `PipelineStage`) properties
- [ ] `STAGE_STATUS_STYLES` contains a `failed` entry with red-tinted styling and no pulse animation
- [ ] `PIPELINE_TO_BUILD_STAGE` maps `implement`, `doc-update`, `test`, `review`, and `evaluate` to their corresponding build stage spec names
- [ ] `getBuildStageStatuses` returns `completed` for stages before the current stage index, `active` for the current stage, `pending` for stages after, and all `completed` when currentStage is `complete`
- [ ] `getBuildStageStatuses` returns `failed` status on the last active stage when currentStage is `failed`
- [ ] `BuildStageProgress` renders nothing when `buildStages` is undefined or empty
- [ ] `BuildStageProgress` renders `StagePill` components separated by `Chevron` components
- [ ] Parallel stage groups (array entries in `BuildStageSpec[]`) render in a bordered container with status coloring
- [ ] The breadcrumb row appears between the plan name label and the swimlane bars in `PlanRow`
- [ ] The Compile row (global threads, `disablePreview=true`) does not render a build stage breadcrumb
