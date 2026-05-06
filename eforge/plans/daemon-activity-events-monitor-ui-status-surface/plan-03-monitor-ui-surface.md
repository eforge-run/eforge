---
id: plan-03-monitor-ui-surface
name: "Monitor UI: daemon status pill and activity drawer"
branch: daemon-activity-events-monitor-ui-status-surface/monitor-ui-surface
agents:
  builder:
    effort: high
    rationale: Two new shadcn-based components, reducer extensions across multiple
      new event types, ring-buffer state management, and the compile-time
      exhaustiveness check in daemon-reducer/index.ts requires every new daemon
      variant to be either handled or explicitly ignored.
---

# Monitor UI: daemon status pill and activity drawer

## Architecture Context

The monitor UI already subscribes to `/api/daemon-events` via `use-daemon-events` and feeds events into `daemon-reducer`. The reducer at `packages/monitor-ui/src/lib/daemon-reducer.ts` dispatches via a registry pattern in `packages/monitor-ui/src/lib/daemon-reducer/index.ts`.

**Critical compile-time invariant** discovered during exploration: `daemon-reducer/index.ts` includes a `DaemonEventSubset` type and an exhaustive type-check (lines 87-124) that forces every daemon-stream event type to be either registered in `daemonHandlerRegistry` or listed in `DAEMON_IGNORED_EVENT_TYPES`. Adding the new types in plan-01 does not break this check (because they are not yet in `DaemonEventSubset`), but **this plan must update `DaemonEventSubset` and either handle or ignore every new type, or the build will fail**.

The global header is at `packages/monitor-ui/src/components/layout/header.tsx`. shadcn `Sheet` is at `packages/monitor-ui/src/components/ui/sheet.tsx`. There is no `components/daemon/` directory yet — this plan creates it.

UI placement decision (from PRD): persistent header pill (color + relative time) for at-a-glance "alive" indicator; click opens a slide-out shadcn `Sheet` for drill-down. No top-level route, no dashboard tab, no mixing into per-build Log view.

## Implementation

### Overview

Extend `DaemonState` with `daemonActivity` (ring buffer, cap 500) and `latestHeartbeat`. Register reducer handlers for every new daemon event type from plan-01 (or explicitly ignore those that have no DaemonState effect). Add selectors `selectDaemonActivity` and `selectHeartbeatStaleness`. Create `<DaemonStatusPill />` and `<DaemonDrawer />` components and render the pill in `Header`.

### Key Decisions

1. **Ring buffer for `daemonActivity`.** Cap at 500. On overflow, drop oldest. Each entry is `{ id: string; event: EforgeEvent; receivedAt: number }`. Keeps the in-memory feed bounded.
2. **`latestHeartbeat` is a single slot, not appended.** Last-write-wins. Stored as `{ at: number; payload: HeartbeatPayload } | null`. Heartbeats do **not** flow into `daemonActivity` (they would dominate the buffer).
3. **`selectHeartbeatStaleness` returns `'fresh' | 'stale' | 'dead'`** based on age vs. `now`: <15s fresh (green), 15-30s stale (amber), >30s dead (red). When `latestHeartbeat` is null, return `'dead'`.
4. **Pill click toggles drawer open state.** Use `useState` local to a wrapper, or lift to existing UI state if there's a pattern. Drawer uses shadcn `Sheet` with side `right`.
5. **Drawer filter chip** toggles between "all cross-build events" (everything in `daemonActivity`) and "daemon-only" (`event.type.startsWith('daemon:')`). Default to "daemon-only" since the at-a-glance question is about the daemon.
6. **Latest heartbeat metrics panel** in the drawer renders `latestHeartbeat.payload` fields: uptime (humanized), queue depth, running builds, auto-build state (enabled/paused), subscriber count.
7. **Reducer handler organisation.** Add a new handler file per logical group (e.g. `handle-lifecycle.ts`, `handle-heartbeat.ts`, `handle-scheduler.ts`, `handle-recovery.ts`, `handle-orphan.ts`, `handle-errors.ts`, plus extend `handle-auto-build.ts` for the new auto-build variants). Mirrors the existing per-group file split.
8. **Activity buffer write policy.** Every persisted daemon-stream event (anything reaching `ADD_EVENT`) is appended to `daemonActivity`, except `daemon:heartbeat` which only updates `latestHeartbeat`. The append happens centrally; individual handlers only need to return their slice-specific delta (heartbeat slot, etc.) and may return undefined to leave the rest of state untouched.
9. **Doc-sync stage** in the build pipeline catches any docs (e.g. README.md) that reference the monitor UI feature surface and need a one-paragraph mention added.

## Scope

### In Scope

- Extend `DaemonState` in `packages/monitor-ui/src/lib/daemon-reducer.ts` with `daemonActivity: DaemonActivityEntry[]` (cap 500) and `latestHeartbeat: { at: number; payload: HeartbeatPayload } | null`. Update `initialDaemonState`.
- Centralise the `daemonActivity` append in the `ADD_EVENT` case (filter out `daemon:heartbeat`, enforce ring-buffer cap).
- Update `DaemonEventSubset` in `packages/monitor-ui/src/lib/daemon-reducer/index.ts` to include all 17 new event types (or as many as are emitted onto the daemon-events SSE stream — verify by cross-referencing `DAEMON_EVENT_TYPES` from plan-01).
- Add new handler files for each event group (lifecycle, heartbeat, scheduler, recovery, orphan, errors) and extend `handle-auto-build.ts` for `:enabled`, `:resumed`, `:triggered`. Each new handler is registered in `daemonHandlerRegistry` or, if the event has no DaemonState effect beyond the centralised activity append, listed in `DAEMON_IGNORED_EVENT_TYPES`.
- `daemon:heartbeat` handler updates `latestHeartbeat` and is registered (it is the only handler that does not append to activity, since heartbeats are excluded centrally).
- Add selectors `selectDaemonActivity(state)` and `selectHeartbeatStaleness(state, now?)` returning `'fresh' | 'stale' | 'dead'` per the thresholds above.
- Create `packages/monitor-ui/src/components/daemon/daemon-status-pill.tsx`. Pulls staleness from `selectHeartbeatStaleness` (color: green/amber/red), shows relative time from `latestHeartbeat.at`, click handler opens the drawer. Built from existing shadcn primitives.
- Create `packages/monitor-ui/src/components/daemon/daemon-drawer.tsx` using shadcn `Sheet`. Two regions:
  - Latest heartbeat metrics panel (uptime, queue depth, running builds, auto-build state, subscriber count). Empty-state copy when `latestHeartbeat` is null.
  - Scrollable activity feed listing entries from `selectDaemonActivity` (newest first). Filter chip toggles between "all cross-build events" and "daemon-only" (default daemon-only).
- Render `<DaemonStatusPill />` in `packages/monitor-ui/src/components/layout/header.tsx`. The pill manages its own drawer-open state, or uses an existing UI state pattern if present.
- Vitest coverage in `packages/monitor-ui/src/lib/__tests__/daemon-reducer.test.ts` (extend if it exists, otherwise create):
  - For each new event type, feeding it into the reducer produces the expected state delta.
  - The ring buffer caps at 500 — pushing 501 events drops the oldest.
  - `daemon:heartbeat` events update `latestHeartbeat` but do **not** append to `daemonActivity`.
  - `selectHeartbeatStaleness` returns `'fresh'` for ages <15s, `'stale'` for 15-30s, `'dead'` for >30s and for null heartbeat.

### Out of Scope

- Engine and monitor emission — handled by plans 01 and 02.
- New top-level UI routes, dashboard tabs, log-view changes — explicitly excluded by the PRD.
- Visual regression / Playwright tests for the pill or drawer animation — manual verification per PRD's "honest test gaps" section.
- README/docs prose changes are handled by `doc-sync` stage; this plan does not pre-write documentation prose.

## Files

### Create

- `packages/monitor-ui/src/components/daemon/daemon-status-pill.tsx` — pill component using shadcn primitives (button + badge or similar). Color and relative time driven by `selectHeartbeatStaleness` and `latestHeartbeat.at`. Click opens the drawer.
- `packages/monitor-ui/src/components/daemon/daemon-drawer.tsx` — drawer component using shadcn `Sheet` (side="right"). Heartbeat metrics panel + filtered activity feed.
- `packages/monitor-ui/src/lib/daemon-reducer/handle-lifecycle.ts` — handlers for `daemon:lifecycle:starting|ready|shutdown:start|shutdown:complete`.
- `packages/monitor-ui/src/lib/daemon-reducer/handle-heartbeat.ts` — handler for `daemon:heartbeat` that updates `latestHeartbeat` and does not append to activity (activity append is centralised and skips heartbeat).
- `packages/monitor-ui/src/lib/daemon-reducer/handle-scheduler.ts` — handlers for `daemon:scheduler:dequeued|capacity-blocked|dependency-blocked`.
- `packages/monitor-ui/src/lib/daemon-reducer/handle-recovery.ts` — handlers for `daemon:recovery:start|run-marked-failed|lock-removed|complete`.
- `packages/monitor-ui/src/lib/daemon-reducer/handle-orphan.ts` — handler for `daemon:orphan:reaped`.
- `packages/monitor-ui/src/lib/daemon-reducer/handle-errors.ts` — handlers for `daemon:warning` and `daemon:error`.
- `packages/monitor-ui/src/lib/__tests__/daemon-reducer.test.ts` — vitest coverage as described above (extend if a partial file exists).

### Modify

- `packages/monitor-ui/src/lib/daemon-reducer.ts` — extend `DaemonState` with `daemonActivity` and `latestHeartbeat` slots; update `initialDaemonState`; centralise the activity-append logic in the `ADD_EVENT` case (skip `daemon:heartbeat`, enforce 500-cap ring buffer); add `selectDaemonActivity` and `selectHeartbeatStaleness` selectors.
- `packages/monitor-ui/src/lib/daemon-reducer/index.ts` — extend `DaemonEventSubset` with all new types from the daemon-events stream allowlist (cross-reference plan-01's `DAEMON_EVENT_TYPES`); register new handlers in `daemonHandlerRegistry` or list in `DAEMON_IGNORED_EVENT_TYPES`; ensure the existing exhaustiveness check at lines 112-124 still passes (this is the gating compile error if any new type is forgotten).
- `packages/monitor-ui/src/lib/daemon-reducer/handle-auto-build.ts` — extend with handlers for `daemon:auto-build:enabled`, `:resumed`, `:triggered`. Existing `:paused` handler unchanged.
- `packages/monitor-ui/src/components/layout/header.tsx` — render `<DaemonStatusPill />` in the header surface (alongside or near the existing connection-status / auto-build affordances). Wire up the drawer open state.

## Verification

- [ ] `DaemonState` has `daemonActivity: DaemonActivityEntry[]` and `latestHeartbeat: { at: number; payload: HeartbeatPayload } | null`. `initialDaemonState` initialises both.
- [ ] Feeding 501 distinct non-heartbeat events into the reducer leaves `daemonActivity.length === 500` with the oldest dropped (ring buffer cap enforced).
- [ ] Feeding a `daemon:heartbeat` event updates `latestHeartbeat.at` and `latestHeartbeat.payload` but does **not** append to `daemonActivity`.
- [ ] `selectHeartbeatStaleness(state, now)` returns `'fresh'` when `now - latestHeartbeat.at < 15_000`, `'stale'` when 15_000-30_000, and `'dead'` when `>= 30_000` or when `latestHeartbeat === null`.
- [ ] `selectDaemonActivity(state)` returns the current ring buffer.
- [ ] `DaemonEventSubset` in `daemon-reducer/index.ts` lists every new daemon-stream event type. The compile-time `_Exhaustive` check (line 117) passes — `pnpm type-check` succeeds.
- [ ] Every new event type has either a handler entry in `daemonHandlerRegistry` or an entry in `DAEMON_IGNORED_EVENT_TYPES`. No new type is silently dropped.
- [ ] The monitor UI mounted with no live heartbeat shows a red pill labeled "daemon offline" (or equivalent dead-state copy).
- [ ] When a heartbeat arrives, the pill turns green within one render cycle and shows a relative-time label like "alive 2s ago".
- [ ] At ~16s since the last heartbeat the pill is amber; at ~31s it is red.
- [ ] Clicking the pill opens a slide-out shadcn `Sheet` containing the latest heartbeat metrics panel and the activity feed.
- [ ] The drawer's filter chip toggles between "all cross-build events" and "daemon-only". Default is "daemon-only" and only renders entries where `event.type.startsWith('daemon:')`.
- [ ] After a daemon restart with at least one orphan run, the activity feed shows `daemon:recovery:start`, the per-item events, and `daemon:recovery:complete` in order.
- [ ] The per-build Log view's existing event filtering ("Show agent events") and rendering are unchanged — visual smoke test confirms no regression.
- [ ] `pnpm type-check`, `pnpm test`, and `pnpm build` all pass.
