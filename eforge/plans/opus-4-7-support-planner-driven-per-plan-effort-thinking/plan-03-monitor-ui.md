---
id: plan-03-monitor-ui
name: Monitor UI - Surface Effort/Thinking in Stage Hover
depends_on:
  - plan-02-runtime-override-events
branch: opus-4-7-support-planner-driven-per-plan-effort-thinking/monitor-ui
---

# Monitor UI - Surface Effort/Thinking in Stage Hover

## Architecture Context

Plan 2 enriched the `agent:start` event with effort, thinking, clamped, original, and source fields. This plan wires those fields into the monitor UI's state and renders them in the stage hover tooltip so operators can see runtime decisions at a glance.

## Implementation

### Overview

Two files change:
1. **Reducer**: Extend `AgentThread` interface with the new fields and populate them from the enriched `agent:start` event handler.
2. **Thread pipeline tooltip**: Render effort and thinking info below the existing model line in `PlanRow`'s `TooltipContent`, following the existing opacity-50 / text-[10px] pattern.

### Key Decisions

1. **Fields on `AgentThread` are all optional strings/booleans** - matches the event payload shape. When the event lacks these fields (e.g., events from older engine versions), the UI renders nothing extra (graceful degradation).
2. **Source badge rendered as parenthetical** - e.g., `"xhigh (planner)"` or `"high (config)"` - uses the same `opacity-50 text-[10px]` style as the model line, keeping the tooltip compact.
3. **Clamp indicator uses "clamped from" phrasing** - e.g., `"xhigh (clamped from max)"` - immediately communicates what happened and why.
4. **Thinking rendered as short phrase** - `"enabled (10k tokens)"` for budget mode, `"adaptive"` for adaptive, `"disabled"` when explicitly disabled. Not rendered when undefined (inheriting default).
5. **No new shadcn/ui components** - follows existing tooltip pattern with inline conditional rendering. Uses existing `TooltipContent` primitives already in the file.

## Scope

### In Scope
- `AgentThread` interface additions: `effort?: string`, `thinking?: string`, `effortClamped?: boolean`, `effortOriginal?: string`, `effortSource?: string`
- `agent:start` handler in reducer populating new fields from event payload
- Tooltip content in `PlanRow` rendering effort line (with source badge and clamp indicator) and thinking line

### Out of Scope
- New shadcn/ui components
- Effort/thinking filtering or sorting in the pipeline view
- Historical trend visualization

## Files

### Modify
- `packages/monitor-ui/src/lib/reducer.ts` (lines 12-26) - Add `effort?: string`, `thinking?: string`, `effortClamped?: boolean`, `effortOriginal?: string`, `effortSource?: string` to `AgentThread` interface. (lines 263-284) In the `agent:start` handler, populate these fields from the event payload using the same conditional type-guard pattern already used for `model` and `backend` (e.g., `'effort' in event ? (event as { effort?: string }).effort : undefined`).
- `packages/monitor-ui/src/components/pipeline/thread-pipeline.tsx` (lines 849-867) - In the `TooltipContent` of the thread bar tooltip, after the model line (line 851), add: (a) effort line when `thread.effort` is defined - render effort value, source badge from `thread.effortSource` (mapped: `'planner'` -> `'planner'`, `'role-config'`/`'global-config'` -> `'config'`, `'default'` -> `'default'`), and clamp indicator when `thread.effortClamped` is true showing `"(clamped from {thread.effortOriginal})"`. (b) thinking line when `thread.thinking` is defined - render the thinking value as-is. Both lines use `opacity-50 text-[10px]` style matching the model line.

## Verification

- [ ] `pnpm type-check` passes for monitor-ui package
- [ ] `pnpm build` compiles monitor-ui with no errors
- [ ] When `agent:start` event includes `effort: 'xhigh'`, `effortSource: 'planner'`, the `AgentThread` object in state has `effort === 'xhigh'` and `effortSource === 'planner'`
- [ ] When `agent:start` event includes `effortClamped: true`, `effortOriginal: 'max'`, `effort: 'xhigh'`, the tooltip renders `"xhigh (clamped from max)"`
- [ ] When `agent:start` event omits effort/thinking fields (older engine), tooltip renders no extra lines below model (no "undefined" or empty strings)
- [ ] Tooltip effort line renders source badge: `"planner"` when effortSource is `'planner'`, `"config"` when effortSource is `'role-config'` or `'global-config'`
- [ ] Tooltip thinking line renders `"adaptive"` when thinking is `{ type: 'adaptive' }` equivalent string
- [ ] No new npm dependencies added to monitor-ui