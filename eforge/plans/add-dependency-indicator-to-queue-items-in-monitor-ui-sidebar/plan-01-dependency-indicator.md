---
id: plan-01-dependency-indicator
name: Add dependency indicator to queue sidebar items
dependsOn: []
branch: add-dependency-indicator-to-queue-items-in-monitor-ui-sidebar/dependency-indicator
---

# Add dependency indicator to queue sidebar items

## Architecture Context

The monitor UI sidebar renders queue items in `queue-section.tsx`. Each item shows a status dot, title, and optional priority badge. The `QueueItem` type already includes a `dependsOn?: string[]` field populated by the API, but it is not rendered in the sidebar.

The existing codebase uses `text-[11px] text-text-dim` for dimmed metadata text (see plan-card.tsx dependency display and session item duration). The same style must be used here for consistency.

## Implementation

### Overview

Add a conditional "blocked by" line beneath the title row for pending queue items that have a non-empty `dependsOn` array. The line uses the established dimmed text style and displays the dependency names as a comma-separated list.

### Key Decisions

1. Render the dependency line as a second row inside each queue item div, indented to align with the title text (offset by the status dot width + gap). This keeps the layout compact.
2. Use `text-[11px] text-text-dim` styling - matches the plan-card dependency display and session metadata patterns already in the codebase.
3. Show "blocked by: dep1, dep2" format - concise, scannable, and helps the user correlate with other visible items in the sidebar or running builds.

## Scope

### In Scope
- Rendering `dependsOn` data for pending queue items in `queue-section.tsx`
- Using existing dimmed text styling conventions

### Out of Scope
- Backend/API changes (data is already available)
- Click-to-navigate or linking between dependent items
- Any changes outside `queue-section.tsx`

## Files

### Modify
- `src/monitor/ui/src/components/layout/queue-section.tsx` — Add a conditional "blocked by" line after the title row when `item.dependsOn` is a non-empty array. The line is left-padded with `pl-[calc(0.5rem+8px+0.5rem)]` (matching the status dot width + gap) and uses `text-[11px] text-text-dim` styling.

## Verification

- [ ] A queue item with `dependsOn: ["some-prd"]` shows "blocked by: some-prd" in dimmed text below the title
- [ ] A queue item with `dependsOn: ["a", "b"]` shows "blocked by: a, b"
- [ ] A queue item with `dependsOn: []` or no `dependsOn` field shows no extra line
- [ ] The "blocked by" text uses `text-text-dim` color, matching existing metadata styling
- [ ] The indicator text is left-aligned with the title text (offset past the status dot)
- [ ] `pnpm type-check` passes with zero errors
- [ ] `pnpm build` completes with zero errors
