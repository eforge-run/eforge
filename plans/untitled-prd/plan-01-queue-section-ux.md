---
id: plan-01-queue-section-ux
name: Queue Section UX Fixes
depends_on: []
branch: untitled-prd/queue-section-ux
---

# Queue Section UX Fixes

## Architecture Context

The monitor sidebar (`src/monitor/ui/src/components/layout/queue-section.tsx`) displays a Queue section that lists queue items. The sidebar flows top-to-bottom: Enqueuing → Queue → Build. Items transition from pending → running as the daemon picks them up, at which point they appear in the Build section.

## Implementation

### Overview

Three changes to `queue-section.tsx`:

1. Filter out `status === 'running'` items before rendering — they already appear in the Build section.
2. Update `pendingCount` to count only pending (non-running) items.
3. Reverse the priority sort so highest-priority (next-to-process) items appear at the bottom, visually feeding into the Build section.
4. Hide the entire section when no pending items remain after filtering.

### Key Decisions

1. **Filter before sort** — Apply the running-item filter first, then sort the remaining pending items. This keeps the sort function simple and avoids rendering filtered items.
2. **Reverse sort via `bPri - aPri`** — Invert the priority comparison so higher-priority (lower number) items sort to the bottom of the list. Nulls remain last (bottom).
3. **Remove `STATUS_ORDER` and `statusDotClass` for running** — Since running items are filtered out, the `STATUS_ORDER` map and running case in `statusDotClass` become dead code. Keep them for defensive safety since the types allow any status string.

## Scope

### In Scope
- Filter `status === 'running'` items from queue section rendering
- Update `pendingCount` to count only non-running items
- Reverse priority sort order (descending priority, next-to-process at bottom)
- Hide Queue section when no pending items exist after filtering

### Out of Scope
- Build section changes
- Enqueuing section changes
- Backend/data model changes
- Other sidebar components

## Files

### Modify
- `src/monitor/ui/src/components/layout/queue-section.tsx` — Filter running items from rendered list, update pendingCount to exclude running, reverse priority sort order, hide section when filtered list is empty

## Verification

- [ ] Items with `status === 'running'` do not render in the Queue section
- [ ] `pendingCount` badge counts only items where `status !== 'running'`
- [ ] Queue section returns `null` when all items are running or the list is empty
- [ ] Pending items sort by descending priority (lowest priority number at bottom)
- [ ] `pnpm type-check` passes with zero errors
- [ ] `pnpm build` completes with zero errors
