---
title: Untitled PRD
created: 2026-03-23
status: pending
---



## Problem / Motivation

The Queue section in the monitor sidebar (`src/monitor/ui/src/components/layout/queue-section.tsx`) has two UX issues:

1. **Redundant items** — Items with `status === 'running'` appear in both the Queue section and the Build section below, creating visual clutter and confusion.
2. **Wrong sort order** — The sidebar flows top-to-bottom: Enqueuing → Queue → Build. The queue currently sorts with the next-to-process item at the top, but it should be at the bottom so it visually flows into the Build section (FIFO with highest-priority / next-to-run at the bottom).

## Goal

Make the Queue section show only pending items in reverse priority order (next-to-process at the bottom), and hide the section entirely when no pending items remain.

## Approach

In `src/monitor/ui/src/components/layout/queue-section.tsx`:

1. **Filter out running items** — Before rendering, exclude items where `status === 'running'`. Update `pendingCount` to only count pending (non-running) items.
2. **Hide section when empty** — If no pending items remain after filtering, hide the entire Queue section.
3. **Reverse priority sort** — Sort pending items by descending priority (instead of ascending) so the highest-priority / next-to-run item appears at the bottom of the list.

## Scope

**In scope:**
- Filtering `status === 'running'` items from the Queue section rendering
- Updating `pendingCount` to reflect only pending items
- Hiding the Queue section when no pending items exist
- Reversing the priority sort order within pending items (descending priority so next-to-process is at bottom)

**Out of scope:**
- Changes to the Build section
- Changes to the Enqueuing section
- Backend/data model changes
- Any other sidebar sections or components

## Acceptance Criteria

- Items with `status === 'running'` do not appear in the Queue section
- `pendingCount` reflects only pending (non-running) items
- The entire Queue section is hidden when there are no pending items
- Pending items are sorted by descending priority (highest priority / next-to-run at the bottom of the list)
- The sidebar visual flow remains Enqueuing → Queue → Build, with the bottom of the Queue feeding into the top of the Build section
