---
title: Embed Activity Heatmap into Pipeline Agent Bars
created: 2026-03-25
status: running
---

# Embed Activity Heatmap into Pipeline Agent Bars

## Problem / Motivation

The standalone "Activity" heatstrip row in the pipeline view is visually redundant with the pipeline bars — it shows event density over time, but the pipeline bars already communicate when agents were active. It uses 30-second buckets, making it look like chunky colored blocks that are easily confused with the agent bars themselves. Additionally, streaming events lack an `agentId` field, which prevents precise association of events with individual agent threads — a requirement for correctly rendering activity for parallel agents in expeditions.

## Goal

Embed the activity heatmap directly into each agent bar as a subtle overlay, remove the standalone Activity row, and add `agentId` to streaming events so activity can be precisely attributed to individual agent threads.

## Approach

### Step 1: Add `agentId` to streaming event types

**`src/engine/events.ts`** — Add `agentId: string` to these three event types:
- `agent:message`
- `agent:tool_use`
- `agent:tool_result`

**`src/engine/backends/claude-sdk.ts`** — Two changes:
- Add `agentId` parameter to `mapSDKMessages()` function signature
- Pass `agentId` from `ClaudeSDKBackend.run()` (where it's already generated via `crypto.randomUUID()`) into the `mapSDKMessages()` call
- Include `agentId` in every `agent:message`, `agent:tool_use`, `agent:tool_result` event yielded by the mapper

No database, recorder, or CLI changes needed — the DB stores full event JSON, so `agentId` persists automatically.

### Step 2: Add `ActivityOverlay` component

**`src/monitor/ui/src/components/pipeline/thread-pipeline.tsx`**

New internal component that renders density buckets as a semi-transparent overlay inside an agent bar:
- Accepts `events: StoredEvent[]`, `agentId: string`, `threadStart: number`, `threadEnd: number`
- Uses **5-second buckets** for fine grain within per-agent timespans
- Filters events by **`agentId` match** — events must carry an `agentId` field matching the thread's `agentId` and have a timestamp within `[threadStart, threadEnd]`
- Computes density per bucket, renders as absolutely-positioned divs
- Uses a **white overlay with varying opacity** instead of the multi-color scale (avoids clashing with agent bar colors):
  - 0 events: transparent
  - Low density: `rgba(255, 255, 255, 0.05)`
  - Medium: `rgba(255, 255, 255, 0.12)`
  - High: `rgba(255, 255, 255, 0.20)`
  - Peak: `rgba(255, 255, 255, 0.30)`
- Bucket tooltips show event count

### Step 3: Thread events into `PlanRow` and render overlay

- Add `events: StoredEvent[]` to `PlanRowProps`
- Pass `events` from `ThreadPipeline` to each `PlanRow`
- Inside the thread rendering loop, render `<ActivityOverlay>` as a child of each agent bar div (behind the text label). The bar already has `relative` positioning and `overflow-hidden`, so the overlay clips naturally.

### Step 4: Remove standalone `HeatstripRow`

- Remove the `<HeatstripRow>` call (line 362)
- Remove the `HeatstripRow` component (lines 194–256)
- Remove `BUCKET_MS` (30s constant), `DENSITY_COLORS`, `getDensityColor` — replaced by new overlay logic with different bucket size and color approach

## Scope

**In scope:**
- Adding `agentId` to `agent:message`, `agent:tool_use`, `agent:tool_result` event types in `src/engine/events.ts`
- Passing `agentId` through `mapSDKMessages()` in `src/engine/backends/claude-sdk.ts`
- New `ActivityOverlay` component in `src/monitor/ui/src/components/pipeline/thread-pipeline.tsx`
- Wiring `events` into `PlanRow` and rendering the overlay inside agent bars
- Removing the standalone `HeatstripRow` component and its associated constants (`BUCKET_MS`, `DENSITY_COLORS`, `getDensityColor`)

**Out of scope:**
- Database schema changes
- Recorder changes
- CLI changes

**Files to modify:**
- `src/engine/events.ts`
- `src/engine/backends/claude-sdk.ts`
- `src/monitor/ui/src/components/pipeline/thread-pipeline.tsx`

## Acceptance Criteria

1. `pnpm build` completes with no type errors.
2. `pnpm test` passes (existing tests pass; event type changes may affect `test/agent-wiring.test.ts` if it constructs these events).
3. The standalone "Activity" heatstrip row is no longer rendered in the pipeline view.
4. Agent bars display subtle brightness variation (white overlay with varying opacity) reflecting event density using 5-second buckets.
5. Parallel agents (if visible) show independent activity patterns based on their respective `agentId`.
6. Hovering over overlay buckets displays tooltips showing event count.
7. Streaming events (`agent:message`, `agent:tool_use`, `agent:tool_result`) include an `agentId` field that persists in the database via existing full-event JSON storage.
