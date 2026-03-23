---
id: plan-02-enqueue-monitor-ui
name: Monitor UI Enqueue Section
dependsOn:
  - plan-01-enqueue-session-fix-and-queue-first
branch: fix-enqueue-formatter-monitor-visibility-queue-first-architecture/enqueue-monitor-ui
---

# Monitor UI Enqueue Section

## Architecture Context

After plan-01 fixes `runSession()` to report enqueue operations as 'completed' (not false 'failed'), the monitor sidebar still mixes enqueue sessions into the main Sessions list. Users expect enqueue operations to appear in their own dedicated section, separate from build sessions. This plan adds a "Recent Enqueues" section to the sidebar and partitions enqueue-only sessions out of the main sessions list.

The UI follows the existing pattern established by `QueueSection` — a collapsible section with status icons, titles, and relative timestamps.

## Implementation

### Overview

1. Update `session-utils.ts` to partition enqueue-only sessions from build sessions
2. Create a new `EnqueueSection` component following the `QueueSection` pattern
3. Insert the new section in the sidebar between `QueueSection` and the Sessions list

### Key Decisions

1. **Partition by `command === 'enqueue'`** — A session is "enqueue-only" when every run in it has `command === 'enqueue'`. This is the simplest heuristic and matches the data model. Mixed sessions (if they ever exist) stay in the main Sessions list.
2. **Reuse `SessionGroup` type** — The enqueue groups use the same `SessionGroup` structure returned by `groupRunsBySessions()`. No new types needed — just filtering.
3. **Show last 20 enqueue sessions** — Cap the list to avoid clutter. Most recent first (already the sort order from `groupRunsBySessions()`).
4. **Same `onSelectSession` callback** — Clicking an enqueue session navigates to its events using the same mechanism as clicking a build session.

## Scope

### In Scope
- Add utility function to partition session groups into enqueue-only vs build sessions
- Create `EnqueueSection` collapsible component with status icons, titles, relative timestamps
- Insert `EnqueueSection` between `QueueSection` and Sessions list in sidebar
- Filter enqueue-only sessions out of the main Sessions list

### Out of Scope
- Changes to the monitor backend/API (runs API already returns all data needed)
- Changes to `runSession()` or CLI (handled in plan-01)
- Detailed enqueue event timeline view (existing event view works fine)

## Files

### Create
- `src/monitor/ui/src/components/layout/enqueue-section.tsx` — New collapsible component that renders recent enqueue operations. Receives an array of `SessionGroup` objects (filtered to enqueue-only). Each item shows: status icon (green checkmark for completed, red X for failed, spinner for running), title (from `SessionGroup.label`), relative time, and duration. Clicking an item calls `onSelectSession(group.key)`. Collapsible header shows count badge. Cap display at 20 items.

### Modify
- `src/monitor/ui/src/lib/session-utils.ts` — Add a `partitionEnqueueSessions(groups: SessionGroup[]): { enqueue: SessionGroup[]; sessions: SessionGroup[] }` function. A group is "enqueue-only" when `group.runs.every(r => r.command === 'enqueue')`. Returns two arrays: enqueue-only groups and everything else.
- `src/monitor/ui/src/components/layout/sidebar.tsx` — Import `EnqueueSection` and `partitionEnqueueSessions`. After calling `groupRunsBySessions(runs)`, call `partitionEnqueueSessions()` to split the result. Render `EnqueueSection` with the enqueue groups between `QueueSection` and the Sessions list. Pass remaining (non-enqueue) groups to the Sessions list renderer.

## Verification

- [ ] `pnpm type-check` reports zero type errors
- [ ] `pnpm build` completes with exit code 0 (includes Vite build of monitor UI)
- [ ] `partitionEnqueueSessions()` given a list containing 3 enqueue-only groups and 2 build groups returns `{ enqueue: [3 items], sessions: [2 items] }`
- [ ] `partitionEnqueueSessions()` given a group where one run has `command === 'enqueue'` and another has `command === 'build'` places that group in `sessions` (not `enqueue`)
- [ ] `EnqueueSection` renders with a collapsible header showing the count of enqueue operations
- [ ] Each enqueue item in the section displays a status icon, label, relative time, and is clickable
- [ ] The main Sessions list in the sidebar no longer contains enqueue-only sessions
- [ ] The sidebar renders sections in order: Queue, Recent Enqueues, Sessions
