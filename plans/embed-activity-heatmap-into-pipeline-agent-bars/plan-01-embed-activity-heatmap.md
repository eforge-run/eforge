---
id: plan-01-embed-activity-heatmap
name: Embed Activity Heatmap into Pipeline Agent Bars
depends_on: []
branch: embed-activity-heatmap-into-pipeline-agent-bars/embed-activity-heatmap
---

# Embed Activity Heatmap into Pipeline Agent Bars

## Architecture Context

The monitor pipeline view currently renders a standalone `HeatstripRow` that shows event density across 30-second buckets. This is redundant with the agent bars and visually confusing. The streaming events (`agent:message`, `agent:tool_use`, `agent:tool_result`) lack an `agentId` field, preventing per-agent activity attribution. The `agent:start` and `agent:stop` events already carry `agentId` — this work extends that to the three streaming event types and embeds activity visualization directly into the agent bars.

## Implementation

### Overview

Three coordinated changes: (1) add `agentId` to streaming event types and propagate through the SDK backend, (2) create an `ActivityOverlay` component that renders 5-second density buckets as white opacity layers inside agent bars, (3) wire events into `PlanRow` and remove the standalone `HeatstripRow`.

### Key Decisions

1. **5-second buckets instead of 30-second** — Agent bars represent shorter timespans than the full session, so finer granularity avoids the "chunky block" problem described in the PRD.
2. **White opacity overlay instead of multi-color scale** — Avoids clashing with the existing agent bar color scheme. Uses `rgba(255, 255, 255, 0.05/0.12/0.20/0.30)` for low/medium/high/peak density.
3. **`agentId` as required field** — Since `agent:start`/`agent:stop` already carry `agentId`, making it required on streaming events maintains consistency. All construction sites (SDK backend, StubBackend) already have access to the `agentId` value.

## Scope

### In Scope
- Adding `agentId: string` to `agent:message`, `agent:tool_use`, `agent:tool_result` event types in `src/engine/events.ts`
- Passing `agentId` through `mapSDKMessages()` in `src/engine/backends/claude-sdk.ts`
- Updating `StubBackend` in `test/stub-backend.ts` to include `agentId` in emitted events
- Updating `test/sdk-mapping.test.ts` and `test/sdk-event-mapping.test.ts` to pass `agentId` to `mapSDKMessages()` and update `toEqual` assertions
- New `ActivityOverlay` component in `src/monitor/ui/src/components/pipeline/thread-pipeline.tsx`
- Adding `events` prop to `PlanRow` and passing it from `ThreadPipeline`
- Rendering `ActivityOverlay` inside each agent bar div
- Removing `HeatstripRow` component, its invocation, and associated constants (`BUCKET_MS`, `DENSITY_COLORS`, `getDensityColor`)

### Out of Scope
- Database schema changes
- Recorder changes
- CLI display changes
- Changes to `src/engine/pipeline.ts` or agent runners (they read events, don't construct them)

## Files

### Modify
- `src/engine/events.ts` — Add `agentId: string` to the `agent:message`, `agent:tool_use`, and `agent:tool_result` union members (lines 208-210)
- `src/engine/backends/claude-sdk.ts` — Add `agentId` parameter to `mapSDKMessages()` signature (line 97), pass `agentId` from `run()` call site (line 68), include `agentId` in all 5 event yields (lines 111, 114-121, 150-157, 166-173, 182)
- `test/stub-backend.ts` — Add `agentId` to the 3 event yields on lines 84, 85, and 91 (the `agentId` variable is already in scope from line 67)
- `test/sdk-mapping.test.ts` — Pass `agentId` as 4th argument to `mapSDKMessages()` calls (lines 24, 46, 67); update `toEqual` assertions (lines 26-31, 69-74) to include `agentId`
- `test/sdk-event-mapping.test.ts` — Pass `agentId` as 4th argument to `mapSDKMessages()` calls (lines 43, 81, and any others); `toMatchObject` assertions remain valid without changes
- `src/monitor/ui/src/components/pipeline/thread-pipeline.tsx` — Remove `BUCKET_MS`, `DENSITY_COLORS`, `getDensityColor` (lines 175-192); remove `HeatstripRow` component (lines 194-256); remove `<HeatstripRow>` call (line 362); add `events: StoredEvent[]` to `PlanRowProps`; pass `events` from `ThreadPipeline` to each `<PlanRow>` call (lines 364-388); add `ActivityOverlay` component; render `<ActivityOverlay>` inside the agent bar div (behind text label) in the thread rendering loop

## Implementation Details

### Event Type Changes (`src/engine/events.ts`)

Update lines 208-210 from:
```typescript
| { type: 'agent:message'; planId?: string; agent: AgentRole; content: string }
| { type: 'agent:tool_use'; planId?: string; agent: AgentRole; tool: string; toolUseId: string; input: unknown }
| { type: 'agent:tool_result'; planId?: string; agent: AgentRole; tool: string; toolUseId: string; output: string }
```
To:
```typescript
| { type: 'agent:message'; planId?: string; agentId: string; agent: AgentRole; content: string }
| { type: 'agent:tool_use'; planId?: string; agentId: string; agent: AgentRole; tool: string; toolUseId: string; input: unknown }
| { type: 'agent:tool_result'; planId?: string; agentId: string; agent: AgentRole; tool: string; toolUseId: string; output: string }
```

### Backend Propagation (`src/engine/backends/claude-sdk.ts`)

Update `mapSDKMessages` signature to accept `agentId: string` as 4th parameter. Update the call in `run()` (line 68) to pass the existing `agentId` local variable. Include `agentId` in all yielded events.

### StubBackend (`test/stub-backend.ts`)

The `agentId` variable already exists on line 67 (`const agentId = crypto.randomUUID()`). Add `agentId` to the three event yields on lines 84, 85, 91.

### Test Updates

`test/sdk-mapping.test.ts`: The `mapSDKMessages()` calls need a 4th `agentId` argument. Use a constant like `'test-agent-id'`. The `toEqual` assertions on lines 26-31 and 69-74 must include `agentId: 'test-agent-id'`. The `toMatchObject` assertion on line 48 is fine as-is.

`test/sdk-event-mapping.test.ts`: Same — add `agentId` argument to `mapSDKMessages()` calls. `toMatchObject` assertions don't need changes.

### ActivityOverlay Component

```typescript
function ActivityOverlay({ events, agentId, threadStart, threadEnd }: {
  events: StoredEvent[];
  agentId: string;
  threadStart: number;
  threadEnd: number;
}) {
  // Filter events matching this agent and timespan
  // 5-second buckets
  // Compute density per bucket
  // Render absolutely-positioned divs with white opacity overlay
  // Tooltip on each bucket showing event count
}
```

Filter logic: match events where `event.event.agentId === agentId` (checking the three streaming event types) and timestamp within `[threadStart, threadEnd]`. Use `useMemo` for bucket computation.

Opacity mapping based on ratio to max bucket count:
- 0 events: transparent (no div rendered)
- ratio < 0.25: `rgba(255, 255, 255, 0.05)`
- ratio < 0.50: `rgba(255, 255, 255, 0.12)`
- ratio < 0.75: `rgba(255, 255, 255, 0.20)`
- ratio >= 0.75: `rgba(255, 255, 255, 0.30)`

Render the overlay as a sibling div inside the agent bar (before the text `<span>`), absolutely positioned to fill the bar.

### PlanRow Wiring

Add `events: StoredEvent[]` to `PlanRowProps`. Pass from `ThreadPipeline`:
- Line 364 `<PlanRow>`: add `events={events}`
- Line 377 `<PlanRow>`: add `events={events}`

Inside the thread render loop (line 472), render `<ActivityOverlay>` inside the agent bar div:
```tsx
<div key={thread.agentId} className="relative h-4">
  <Tooltip>
    <TooltipTrigger asChild>
      <div className={`absolute inset-y-0 ...`} style={...}>
        <ActivityOverlay
          events={events}
          agentId={thread.agentId}
          threadStart={threadStart}
          threadEnd={threadEnd}
        />
        <span className="text-[9px] truncate px-1 leading-4 text-foreground/70 relative z-10">
          ...
        </span>
      </div>
    </TooltipTrigger>
    ...
  </Tooltip>
</div>
```

## Verification

- [ ] `pnpm type-check` completes with zero errors
- [ ] `pnpm test` passes with zero failures
- [ ] `pnpm build` completes with zero errors
- [ ] In `src/engine/events.ts`, the `agent:message`, `agent:tool_use`, and `agent:tool_result` union members each include `agentId: string`
- [ ] In `src/engine/backends/claude-sdk.ts`, `mapSDKMessages()` accepts `agentId` as a parameter and includes it in all yielded streaming events
- [ ] In `test/stub-backend.ts`, all `agent:message`, `agent:tool_use`, `agent:tool_result` yields include `agentId`
- [ ] In `test/sdk-mapping.test.ts`, `mapSDKMessages()` calls pass an `agentId` argument and `toEqual` assertions include `agentId`
- [ ] The `HeatstripRow` component, `BUCKET_MS`, `DENSITY_COLORS`, and `getDensityColor` no longer exist in `thread-pipeline.tsx`
- [ ] `<HeatstripRow>` is not rendered anywhere in the pipeline view
- [ ] `PlanRowProps` includes `events: StoredEvent[]` and both `<PlanRow>` call sites pass `events`
- [ ] An `ActivityOverlay` component exists that filters events by `agentId` match and renders 5-second density buckets as absolutely-positioned divs with white opacity (`rgba(255,255,255, 0.05/0.12/0.20/0.30)`)
- [ ] `ActivityOverlay` is rendered inside each agent bar div in the `PlanRow` thread loop
- [ ] Each overlay bucket div has a tooltip showing the event count for that bucket
