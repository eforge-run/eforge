---
title: Pipeline Label Redesign
created: 2026-04-01
---

# Pipeline Label Redesign

## Problem / Motivation

The monitor UI currently shows plan doc pills (`Build PRD`, `Plan 01`, `Plan 02`) as a separate `ArtifactsStrip` row below the pipeline swimlanes, duplicating the left-side text labels (`Compile`, `plan-01-event-types...`). The compile stage breadcrumb (`planner > plan-review-cycle`) floats above the entire pipeline in `ProfileHeader` instead of being aligned with the Compile row's bars. This wastes vertical space and creates visual clutter with redundant labels.

## Goal

Consolidate artifact pills into the pipeline left column, align the compile stage overview with the Compile row's bars, and tighten the overall layout.

## Approach

### 1. Replace PlanRow left-side labels with pills

**File**: `src/monitor/ui/src/components/pipeline/thread-pipeline.tsx`

Current: `w-[140px]` monospace text span showing `planId` (e.g., "plan-01-event-types...")

New:
- **Compile row**: Yellow pill labeled `PRD`, clickable to open PRD content preview
- **Plan rows**: Cyan pill labeled `Plan 01`, `Plan 02`, etc., clickable to open plan content preview
- **Fallback** (before `plan:complete` events arrive): Keep monospace text label as today
- Shrink left column from `w-[140px]` to `w-[100px]` (pills are more compact)

Tooltip content:
- PRD pill: PRD label (e.g., "Build PRD")
- Plan pills: full plan name (e.g., "plan-01-event-types-and-schemas") + dependency info if any ("Depends on: Plan 00")

### 2. Add dependency indentation

**File**: `src/monitor/ui/src/components/pipeline/thread-pipeline.tsx`

Plans with `dependsOn` entries get `pl-4` (1rem) left padding on the pill container. Single level only - no recursive nesting. Dependency info also shown in tooltip.

Data source: `orchestration.plans[].dependsOn` (already available via `orchestration` prop).

### 3. Move compile StageOverview into Compile row

**File**: `src/monitor/ui/src/components/pipeline/thread-pipeline.tsx`

Currently `ProfileHeader` renders both the profile badge AND `StageOverview` (`planner > plan-review-cycle`). The `StageOverview` should move into the Compile `PlanRow`'s right column, rendered above the thread bars - same position as `BuildStageProgress` in plan rows.

Changes:
- Remove `StageOverview` from `ProfileHeader` (line 190)
- Add new props to `PlanRowProps`: `compileStages?: string[]`, `activeStages?`, `completedStages?`
- In `PlanRow`, when `compileStages` is provided, render `StageOverview` in the right column above the thread bars (same spot where `BuildStageProgress` renders for plan rows)
- Pass compile stage data from `ThreadPipeline` to the Compile `PlanRow`

### 4. Pass plan artifact data to ThreadPipeline

**File**: `src/monitor/ui/src/app.tsx`

Add two new props to `ThreadPipeline`:
- `prdSource?: { label: string; content: string } | null` (already computed in `app.tsx`)
- `planArtifacts?: Array<{ id: string; name: string; body: string }>` (already computed in `app.tsx`)

### 5. Wire data through ThreadPipeline to PlanRow

**File**: `src/monitor/ui/src/components/pipeline/thread-pipeline.tsx`

New props on `ThreadPipelineProps`:
```ts
prdSource?: { label: string; content: string } | null
planArtifacts?: Array<{ id: string; name: string; body: string }>
```

New memos inside `ThreadPipeline`:
- `planArtifactMap`: `Map<string, { name: string; body: string }>` keyed by plan ID
- `dependsByPlan`: `Map<string, string[]>` keyed by plan ID (from `orchestration.plans`)

New props on `PlanRowProps`:
```ts
prdSource?: { label: string; content: string } | null
planArtifact?: { name: string; body: string }
dependsOn?: string[]
compileStages?: string[]
activeStages?: Set<string>
completedStages?: Set<string>
```

### 6. Remove ArtifactsStrip

- **`src/monitor/ui/src/app.tsx`**: Remove `<ArtifactsStrip>` usage (line 328) and its import
- **`src/monitor/ui/src/components/common/artifacts-strip.tsx`**: Delete this file

### 7. Move shared utilities

Copy `abbreviatePlanId()` from `artifacts-strip.tsx` into `thread-pipeline.tsx` (or `src/monitor/ui/src/lib/format.ts`). Update to produce "Plan 01" labels. Also copy pill CSS class constants.

### Terminology

- **PRD** - the input spec document
- **Plan** - an implementation/execution plan (plan-01, plan-02, etc.)

## Scope

### In scope

| File | Change |
|---|---|
| `src/monitor/ui/src/components/pipeline/thread-pipeline.tsx` | Main changes: pill labels, dependency indent, compile stages in row, new props |
| `src/monitor/ui/src/app.tsx` | Pass `prdSource` + `planArtifacts` to `ThreadPipeline`, remove `ArtifactsStrip` |
| `src/monitor/ui/src/components/common/artifacts-strip.tsx` | Delete |

### Out of scope

- Recursive/multi-level dependency nesting (single level only)

## Acceptance Criteria

1. `pnpm build` type check passes
2. Running a build with the monitor (`eforge build --monitor`) shows:
   - PRD pill in the compile row; clickable; tooltip shows the PRD label
   - Plan pills for each plan row; clickable; tooltips show full plan name + dependency info
   - Compile stage breadcrumb (`planner > plan-review-cycle`) aligned above the compile row's bars (not floating above the entire pipeline)
   - Dependent plans are indented (`pl-4`)
   - Left column is narrower (`w-[100px]`)
   - `ArtifactsStrip` row is gone
   - Before `plan:complete` events arrive, fallback monospace labels still render correctly
3. Expedition builds (if available) correctly show dependency indentation
