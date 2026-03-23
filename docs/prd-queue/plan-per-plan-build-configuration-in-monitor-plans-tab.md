---
title: Plan: Per-Plan Build Configuration in Monitor Plans Tab
created: 2026-03-23
status: pending
---

# Per-Plan Build Configuration in Monitor Plans Tab

## Problem / Motivation

The monitor's Plans tab shows plan markdown body content via expandable cards (`PlanCard` component), but it's missing each plan's **build stages** and **review configuration** from orchestration.yaml. This structured build metadata tells you *how* a plan will be built (which stages run, in what order, with what review strategy) — distinct from the plan body which describes *what* to build.

The data already exists in orchestration.yaml under each plan entry (`build: BuildStageSpec[]`, `review: ReviewProfileConfig`) but both API endpoints strip it before sending to the UI.

## Goal

Surface per-plan build pipeline stages and review configuration in the monitor's Plans tab so users can see how each plan will be built without inspecting orchestration.yaml on disk.

## Approach

### 1. Enrich `/api/plans/{id}` with build/review config

**File**: `src/monitor/server.ts` — `servePlans()` (line 284)

After constructing `allPlans`, cross-reference orchestration.yaml from disk to attach `build` and `review` per plan:

- Reuse the existing pattern from `readExpeditionFiles` (get session's compile run → resolve `plans/{planSet}/orchestration.yaml` path with traversal check)
- Parse orchestration.yaml, build a `Map<planId, { build, review }>`
- For each plan in the response, attach matching `build` and `review` (leave undefined if not found)

Update `PlanResponse` type (line 234) to include optional `build` and `review` fields.

### 2. Update UI types

**File**: `src/monitor/ui/src/lib/types.ts`

Add to `PlanData` (line 22):
```typescript
build?: BuildStageSpec[];
review?: ReviewProfileConfig;
branch?: string;
```

`BuildStageSpec` and `ReviewProfileConfig` are already defined in this file (lines 56-63).

### 3. Create `BuildConfigSection` component

**New file**: `src/monitor/ui/src/components/plans/build-config.tsx`

Two sub-sections:

**Build Pipeline** — horizontal stage flow reusing the visual pattern from `StagePill` + `Chevron` in `thread-pipeline.tsx`:
- Sequential stages: pill → chevron → pill
- Parallel groups (`string[]` entries in BuildStageSpec): render as vertically stacked pills inside a bracket/container, with chevrons connecting to the rest of the pipeline
- Static styling (no active/hover state tracking) using `bg-bg-tertiary text-text-dim/80` (the "pending" style from thread-pipeline)

```
BUILD PIPELINE
[implement] > ┌[review-cycle]┐ > [validate]
              └[doc-update]  ┘
```

**Review Config** — compact inline display:
- Strategy badge (e.g., "parallel" or "sequential")
- Perspectives as small pills
- Max rounds + evaluator strictness as text

```
REVIEW
parallel · code, security, integration · 2 rounds · standard
```

Style with existing theme classes: section headers use `text-[10px] uppercase tracking-wide text-text-dim` (matches "Files Changed" header in plan-card.tsx:120).

### 4. Integrate into PlanCard

**File**: `src/monitor/ui/src/components/plans/plan-card.tsx`

- Add `build?: BuildStageSpec[]` and `review?: ReviewProfileConfig` to `PlanCardProps`
- Render `<BuildConfigSection>` inside expanded body, above "Files Changed" section and plan body

**File**: `src/monitor/ui/src/components/plans/plan-cards.tsx`

- Pass `build={plan.build}` and `review={plan.review}` to each `<PlanCard>`

### Patterns to reuse

- `StagePill` + `Chevron` from `src/monitor/ui/src/components/pipeline/thread-pipeline.tsx` (lines 83-109) — visual stage pill pattern. Reimplement as simpler static versions (no hover/active tracking needed).
- Section header style from plan-card.tsx line 120: `text-[10px] uppercase tracking-wide text-text-dim`
- Orchestration.yaml disk read pattern from `readExpeditionFiles` in server.ts (lines 311-316)

## Scope

**In scope:**

| File | Change |
|------|--------|
| `src/monitor/server.ts` | Enrich `servePlans()` to read orchestration.yaml and attach build/review per plan |
| `src/monitor/ui/src/lib/types.ts` | Add `build`, `review`, `branch` to `PlanData` |
| `src/monitor/ui/src/components/plans/build-config.tsx` | **New** — `BuildConfigSection` component |
| `src/monitor/ui/src/components/plans/plan-card.tsx` | Accept + render build/review props |
| `src/monitor/ui/src/components/plans/plan-cards.tsx` | Pass build/review through to PlanCard |

**Out of scope:**
- N/A

## Acceptance Criteria

1. `pnpm build` completes with no type errors.
2. `pnpm test` — all existing tests pass.
3. Open monitor at `localhost:4567`, select a completed session, click Plans tab.
4. Expand a plan card — build pipeline stages and review config section appear above the plan body.
5. Test with an errand session (simple single stage) and a multi-plan session (multiple stages with parallel groups).
