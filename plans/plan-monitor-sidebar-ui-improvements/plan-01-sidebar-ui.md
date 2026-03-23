---
id: plan-01-sidebar-ui
name: Monitor Sidebar UI Improvements
depends_on: []
branch: plan-monitor-sidebar-ui-improvements/sidebar-ui
---

# Monitor Sidebar UI Improvements

## Architecture Context

The monitor web dashboard has a sidebar (`src/monitor/ui/src/components/layout/sidebar.tsx`) that displays session groups fetched from `/api/runs`. Sessions currently show a "N runs" badge (compile + build) which adds no value, and completed enqueues clutter the sidebar. The plan adds a batch metadata endpoint to surface plan count and base workflow profile, and updates the sidebar to display these instead.

## Implementation

### Overview

1. Add `getSessionMetadataBatch()` to the monitor DB that queries `plan:profile` and `plan:complete` events, resolves base profile names, and returns plan counts per session.
2. Add `GET /api/session-metadata` route in the HTTP server.
3. Add `SessionMetadata` type to frontend types.
4. Update the sidebar to fetch and display profile badges (color-coded) and plan count, removing the "N runs" badge, "SESSIONS" header, and adding thin dividers.
5. Filter completed enqueues in `partitionEnqueueSessions()`.
6. Rename enqueue section header from "Recent Enqueues" to "Enqueuing".

### Key Decisions

1. **Batch endpoint over per-session queries** — A single `/api/session-metadata` call avoids N+1 queries from the frontend. The query joins `events` with `runs` on `run_id` to group by `session_id`.
2. **Base profile resolution on the server** — The `plan:profile` event carries `profileName` and `config` (which may have `extends`). Built-in names (`errand`, `excursion`, `expedition`) are the base; custom/generated profiles resolve via `config.extends`. This logic stays server-side to keep the frontend simple.
3. **Badge component reuse** — Use the existing shadcn `Badge` component with custom className overrides for profile colors rather than creating a new component.

## Scope

### In Scope
- New `SessionMetadata` type and `getSessionMetadataBatch()` method in `src/monitor/db.ts`
- New `GET /api/session-metadata` endpoint in `src/monitor/server.ts`
- New `SessionMetadata` interface in frontend types
- Sidebar: fetch metadata, show profile badge (color-coded by base profile) and plan count badge, remove "N runs" badge, remove "SESSIONS" header, add thin dividers between session items
- Filter completed enqueues from `partitionEnqueueSessions()`
- Rename enqueue section header to "Enqueuing"

### Out of Scope
- Changes to SSE event streaming
- Queue section modifications beyond enqueue filtering
- New shadcn components

## Files

### Modify
- `src/monitor/db.ts` — Add `SessionMetadata` type, `getSessionMetadataBatch()` method to `MonitorDB` interface and implementation. Adds a prepared statement querying events with type `IN ('plan:profile', 'plan:complete')` joined to runs, then groups results by `session_id` in JS.
- `src/monitor/server.ts` — Add `GET /api/session-metadata` route that calls `db.getSessionMetadataBatch()` and returns JSON.
- `src/monitor/ui/src/lib/types.ts` — Add `SessionMetadata` interface with `planCount: number | null` and `baseProfile: string | null`.
- `src/monitor/ui/src/components/layout/sidebar.tsx` — Fetch `/api/session-metadata` via `useApi`, pass metadata to `SessionItem`. Replace "N runs" badge with base profile badge (errand=green, excursion=yellow, expedition=purple) and plan count badge. Add `border-t border-border/40` divider between session items (skip first). Remove "SESSIONS" `<h2>` header.
- `src/monitor/ui/src/lib/session-utils.ts` — In `partitionEnqueueSessions()`, only include enqueue groups where `group.status === 'running'`.
- `src/monitor/ui/src/components/layout/enqueue-section.tsx` — Change header text from "Recent Enqueues" to "Enqueuing".

## Verification

- [ ] `pnpm build` completes with exit code 0
- [ ] `pnpm test` passes all existing tests
- [ ] `GET /api/session-metadata` returns a JSON object keyed by session ID, each value having `planCount` (number or null) and `baseProfile` (string or null)
- [ ] Sidebar session items display a colored badge for the base profile: green for errand, yellow for excursion, purple for expedition
- [ ] Sidebar session items display a plan count (e.g. "3 plans") where metadata is available
- [ ] The "N runs" badge no longer appears in the sidebar
- [ ] The "SESSIONS" header text is removed from the sidebar
- [ ] A `border-t` divider separates session items (not before the first item)
- [ ] Completed/failed enqueue groups are excluded from the enqueue section — only `status === 'running'` enqueues appear
- [ ] The enqueue section header reads "Enqueuing" instead of "Recent Enqueues"
- [ ] For a custom profile with `config.extends: 'excursion'`, the API returns `baseProfile: 'excursion'`
- [ ] For a built-in profile selection like `profileName: 'errand'`, the API returns `baseProfile: 'errand'`
