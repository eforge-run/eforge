---
title: Move Activity Heatstrip Into Pipeline View
created: 2026-03-25
status: pending
---



# Move Activity Heatstrip Into Pipeline View

## Problem / Motivation

The activity heatstrip currently renders as a standalone component above the pipeline, using fixed 4px-wide cells. Because it sits outside the `ThreadPipeline` component, it does not share the same layout grid (140px label column + flex-1 timeline container), causing it to be temporally misaligned with the Gantt bars in the pipeline view.

## Goal

Integrate the activity heatstrip directly into the `ThreadPipeline` component so that its time buckets align pixel-perfectly with the timeline bars, providing a unified, temporally consistent visualization.

## Approach

- Remove the standalone `ActivityHeatstrip` component from `app.tsx`.
- Pass `events` into the `ThreadPipeline` component instead.
- Render the heatstrip as a row inside `ThreadPipeline`, sharing the same layout as `PlanRow` entries: **140px label column + flex-1 timeline container**.
- Replace the fixed 4px-wide cells with percentage-based widths: `(BUCKET_MS / totalSpan) * 100%`, so each 30-second bucket aligns temporally with the Gantt bars below.
- Position the heatstrip row **above the Compile row** inside the pipeline.
- Retain existing density colors, tooltips, and pulse animation.
- The standalone `activity-heatstrip.tsx` component can be deleted.

## Scope

**In scope:**
- Removing `ActivityHeatstrip` from `app.tsx`
- Passing events into `ThreadPipeline`
- Adding an integrated heatstrip row inside `ThreadPipeline` with percentage-based bucket widths
- Preserving density colors, tooltips, and pulse animation

**Out of scope:**
- Changes to density color logic, tooltip content, or animation behavior
- Changes to other pipeline rows or layout beyond accommodating the new heatstrip row

**Files to modify:**
- `src/monitor/ui/src/app.tsx` — remove heatstrip, pass events to pipeline
- `src/monitor/ui/src/components/pipeline/thread-pipeline.tsx` — add heatstrip row
- `src/monitor/ui/src/components/common/activity-heatstrip.tsx` — delete

## Acceptance Criteria

- The standalone `ActivityHeatstrip` component no longer renders in `app.tsx`.
- `activity-heatstrip.tsx` is deleted.
- Events are passed as a prop to `ThreadPipeline`.
- A heatstrip row renders inside `ThreadPipeline`, above the Compile row.
- The heatstrip row uses the same 140px label column + flex-1 timeline container layout as `PlanRow` entries.
- Each 30-second bucket uses percentage-based width (`(BUCKET_MS / totalSpan) * 100%`) and aligns temporally with the Gantt bars.
- Density colors, tooltips, and pulse animation are preserved and functional.
