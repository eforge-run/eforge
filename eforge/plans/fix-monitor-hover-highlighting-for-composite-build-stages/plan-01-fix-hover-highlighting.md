---
id: plan-01-fix-hover-highlighting
name: Fix monitor hover highlighting for composite build stages
depends_on: []
branch: fix-monitor-hover-highlighting-for-composite-build-stages/fix-hover-highlighting
---

# Fix monitor hover highlighting for composite build stages

## Architecture Context

The monitor pipeline view renders breadcrumbs for build stages and colored agent bars on a timeline. Hovering either should bidirectionally highlight its counterpart. This works for simple stages like `implement` (1:1 agent-to-stage mapping) but breaks for composite stages (`review-cycle`, `test-cycle`) because:

1. `AGENT_TO_STAGE` is missing entries for `tester`, `test-writer`, `merge-conflict-resolver`, and `staleness-assessor`
2. `AGENT_COLORS` is missing the same entries plus has a `parallel-reviewer` entry that doesn't exist as an `AgentRole`
3. The static `PIPELINE_TO_BUILD_STAGE` map cannot resolve ambiguous stages like `evaluate` (which appears in both `review-cycle` and `test-cycle`) and is never used in the agent bar hover path
4. Agent bars emit raw pipeline stages (e.g. `review`) but breadcrumbs check against composite names (e.g. `review-cycle`)

## Implementation

### Overview

Replace the loosely-typed maps and static `PIPELINE_TO_BUILD_STAGE` lookup with type-safe `Record<AgentRole, ...>` maps and a dynamic `resolveBuildStage()` function that uses the plan's actual `buildStages` array to resolve raw pipeline stages to their composite parents.

### Key Decisions

1. Use `Record<AgentRole, string>` for `AGENT_TO_STAGE` so TypeScript errors when new agent roles are added to the engine but not mapped here - prevents silent regressions.
2. Use `Record<AgentRole, { bg: string; border: string }>` for `AGENT_COLORS` for the same compile-time completeness guarantee.
3. Remove `parallel-reviewer` from both maps - the engine emits `'reviewer'` as the agent role for parallel review runs (confirmed in `src/engine/agents/parallel-reviewer.ts:177`).
4. Replace `PIPELINE_TO_BUILD_STAGE` with `COMPOSITE_STAGES` lookup + `resolveBuildStage(pipelineStage, buildStages)` that resolves against the plan's actual build stage array to handle ambiguous stages like `evaluate`.

## Scope

### In Scope
- Make `AGENT_TO_STAGE` type-safe (`Record<AgentRole, string>`) and add missing entries (`tester`, `test-writer`, `merge-conflict-resolver`, `staleness-assessor`)
- Make `AGENT_COLORS` type-safe (`Record<AgentRole, { bg: string; border: string }>`) and add missing entries, remove `parallel-reviewer`
- Replace `PIPELINE_TO_BUILD_STAGE` with `COMPOSITE_STAGES` map and `resolveBuildStage()` function
- Update `getBuildStageStatuses` (lines 219, 239) to use `resolveBuildStage()`
- Update `PlanRow` agent bar hover logic (line 622) to use `resolveBuildStage()`

### Out of Scope
- Changes to engine agent role definitions
- Changes to any other monitor UI components
- Changes to the `AgentRole` type itself

## Files

### Modify
- `src/monitor/ui/src/components/pipeline/thread-pipeline.tsx` - All changes are in this single file:
  - Import `AgentRole` from `@/lib/types`
  - Replace `AGENT_COLORS` type with `Record<AgentRole, { bg: string; border: string }>`, add missing entries (`tester`, `test-writer`, `merge-conflict-resolver`, `staleness-assessor`), remove `parallel-reviewer`
  - Replace `AGENT_TO_STAGE` type with `Record<AgentRole, string>`, add missing entries (`tester` -> `test`, `test-writer` -> `test-write`, `merge-conflict-resolver` -> `merge`, `staleness-assessor` -> `staleness`), remove `parallel-reviewer`
  - Remove `PIPELINE_TO_BUILD_STAGE` constant
  - Add `COMPOSITE_STAGES` constant mapping composite stage names to their child stages
  - Add `resolveBuildStage(pipelineStage, buildStages?)` function that resolves a raw pipeline stage to its build stage name using the plan's actual build stages
  - Update `getBuildStageStatuses` failed-state branch (line 219) to use `AGENT_TO_STAGE[thread.agent as AgentRole]` + `resolveBuildStage()`
  - Update `getBuildStageStatuses` normal branch (line 239) to use `resolveBuildStage(currentStage, buildStages)`
  - Update `PlanRow` agent bar hover (line 622) to resolve through `resolveBuildStage(pipelineStage, buildStages)`

## Verification

- [ ] `pnpm type-check` passes with zero errors
- [ ] `pnpm build` completes with no errors or warnings related to these changes
- [ ] `AGENT_TO_STAGE` has type `Record<AgentRole, string>` - adding a new `AgentRole` to the engine without updating this map causes a compile error
- [ ] `AGENT_COLORS` has type `Record<AgentRole, { bg: string; border: string }>` - same compile-time completeness guarantee
- [ ] `PIPELINE_TO_BUILD_STAGE` constant is removed from the file
- [ ] `resolveBuildStage('review', [{spec for review-cycle}])` returns `'review-cycle'`
- [ ] `resolveBuildStage('test', [{spec for test-cycle}])` returns `'test-cycle'`
- [ ] `resolveBuildStage('evaluate', [{spec for review-cycle}, {spec for test-cycle}])` returns the last matching composite (handles ambiguity)
- [ ] `resolveBuildStage('implement', [...])` returns `'implement'` (direct match, no composite resolution needed)
