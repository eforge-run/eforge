---
title: Monitor UI: stop SSE replay from clobbering snapshot state
created: 2026-05-06
depends_on: ["daemon-activity-events-monitor-ui-status-surface"]
---

# Monitor UI: stop SSE replay from clobbering snapshot state

## Problem / Motivation

Two related defects in the monitor UI trace to the same structural issue: the daemon-events SSE stream replays its full history on initial connect, and reducer handlers apply those replayed events on top of the REST snapshot, overriding correct state.

**Bug 1 — Queue section disappears after daemon restart.**
- `/api/queue` returns the pending PRD; sidebar shows no Queue section.
- `useDaemonEvents` (`packages/monitor-ui/src/hooks/use-daemon-events.ts:26-73`) does a one-shot snapshot fetch on mount. SSE reconnect (`packages/client/src/session-stream.ts:326-339`) is transparent — never re-seeds.
- Hard browser refresh fixes it because that triggers a fresh mount and snapshot fetch.
- After daemon restart, the client's stale `Last-Event-ID` is past the new daemon's max → `getDaemonEventsAfter` returns 0 → reducer keeps pre-restart state → `QueueSection` (`queue-section.tsx:169`) hides because `pendingCount === 0`.

**Bug 2 — Auto-build toggle reverts ON → OFF on every refresh.**
- Verified end-to-end: `GET /api/auto-build` returns `{enabled: true, watcher: {running: true, ...}}`. UI shows OFF after refresh.
- `monitor.db` contains historical `daemon:auto-build:paused` events at ids 145619 and 150335.
- DevTools EventStream tab shows the SSE stream replaying events past id 157624 on each fresh connect.
- `serveDaemonEventsSSE` (`packages/monitor/src/server.ts:322-358`) does `getDaemonEventsAfter(lastEventId ?? 0)` — when `Last-Event-ID` is absent (initial connect), it returns ALL events.
- `handleDaemonAutoBuildPaused` (`packages/monitor-ui/src/lib/daemon-reducer/handle-auto-build.ts:9-18`) unconditionally flips `enabled` to false on every paused event delivered.
- `POST /api/auto-build` (`server.ts:1216-1248`) writes no event when the user toggles ON, so the event log is incomplete and replaying it alone produces wrong state.

**User impact:** confusion about whether the daemon is doing what was asked. The Auto-build bug in particular looks like a broken switch — the UI and daemon visibly disagree.

**Architectural framing.** The daemon mixes two patterns inconsistently: snapshot+delta (REST is authoritative) and event-sourced (SSE replay reconstructs state). Saved as project memory `project_daemon_state_vs_event_log.md`. This work commits to snapshot+delta — REST is authoritative, SSE delivers only deltas going forward. Closing the event-log incompleteness (toggle-ON not emitting an event) is deferred unless this class of bug bites again.

**Confidence on root cause:** HIGH on both bugs. Verified by reading the code paths end-to-end and (for Bug 2) inspecting the daemon DB and DevTools EventStream payload directly.

### Reproduction Steps

**Bug 1 — Queue section disappears after daemon restart**
1. Start the eforge daemon in a project with at least one pending PRD in `eforge/queue/`.
2. Open the monitor UI in a browser. Confirm the sidebar shows the Queue section with the pending PRD.
3. Restart the daemon (e.g. via `/eforge:restart` or by killing the process and re-spawning).
4. Wait for the connection indicator to flip back to green (SSE reconnect succeeded).
5. **Observed:** Queue section is gone from the sidebar. `GET /api/queue` confirms the PRD is still pending.
6. **Expected:** Queue section continues to show the pending PRD without manual browser refresh.
7. Workaround: hard-refresh the browser tab — Queue section reappears.

**Bug 2 — Auto-build toggle reverts ON → OFF on refresh**
Prerequisite: the daemon's `monitor.db` must contain at least one historical `daemon:auto-build:paused` event. Easy to set up: enable auto-build, let one PRD fail (or kill the watcher), confirm `daemon:auto-build:paused` is in the events table.

1. With the precondition above, open the monitor UI. Note the Auto-build toggle is OFF (because of the historical pause event being replayed).
2. Click the Auto-build toggle to ON. UI shows ON. `POST /api/auto-build` returns `{enabled: true}`. `GET /api/auto-build` confirms `enabled: true`.
3. Refresh the browser tab.
4. **Observed:** Auto-build toggle is back to OFF.
5. **Expected:** Auto-build toggle remains ON (because the daemon's authoritative state is `enabled: true`).
6. Confirming: with DevTools EventStream tab open on `/api/daemon-events`, the SSE stream replays events from id 0 on every fresh connection, including the historical paused event.

### Root Cause Detail

**Bug 1 — No re-seed on SSE reconnect**

Root cause is in `packages/monitor-ui/src/hooks/use-daemon-events.ts:26-73`. The hook runs a single `useEffect` with `[]` deps:
1. Parallel snapshot fetch (`runs`, `queue`, `session-metadata`, `auto-build`) → `BATCH_SEED`.
2. `subscribeToDaemonEvents(...)` for live deltas.

The SSE subscriber (`packages/client/src/session-stream.ts:326-339`, `connectBrowser` at `:348-427`) reconnects transparently with `Last-Event-ID` and never notifies the hook.

**Bug 2 — Initial SSE connect replays history on top of snapshot**

Root cause is in `packages/monitor/src/server.ts:322-358` (`serveDaemonEventsSSE`):

```ts
const historicalEvents = db.getDaemonEventsAfter(lastEventId ?? 0);
```

When `Last-Event-ID` is absent (initial mount, post-refresh), `lastEventId ?? 0` becomes `0`, returning ALL events. The reducer's `handleDaemonAutoBuildPaused` flips `enabled` to false unconditionally on every paused event delivered. Result: after `BATCH_SEED` correctly seeds `enabled: true`, replayed paused events override it to false.

The event log is also incomplete: `POST /api/auto-build` writes no event when the user toggles ON, so reconstructing state from events alone is wrong.

## Goal

Eliminate both bugs by committing the monitor UI to a snapshot-and-delta model: REST snapshots are the authoritative source of current state, and the SSE stream delivers only deltas going forward (no historical replay on initial connect, plus an explicit re-seed on every SSE reconnect).

## Approach

**Profile recommendation: Excursion.**

Multi-package change touching daemon (`monitor`), shared client (`client`), and UI (`monitor-ui`). Two related bugs fixed via one structural change to the SSE protocol contract (`daemon:resync-marker` is a new event type). Code change is small (~50-80 lines total) but spans real packages and changes behavior visible to all SSE consumers.

- Not Errand: more than mechanical; modifies the SSE protocol.
- Not Expedition: bounded to one observability surface; no architectural restructuring; reducer/event-log incompleteness is explicitly out of scope.

The detailed design lives in `~/.claude/plans/image-1-something-seems-structured-scott.md` and is being formalized into this session plan for `/eforge:build`.

**Daemon-side changes**
- `packages/monitor/src/db.ts` — add `getMaxDaemonEventId(): number` returning the largest `id` from the events table for daemon-wide event types (matching the same filter `getDaemonEventsAfter` uses); returns 0 when no events exist.
- `packages/monitor/src/server.ts` (`serveDaemonEventsSSE`) — when `Last-Event-ID` is absent (initial connect), do NOT replay historical events. Instead write a single SSE marker `id: <maxId>\ndata: {"type":"daemon:resync-marker"}\n\n` (when `maxId > 0`), then proceed with live updates. Set `lastSeenId = maxId` so subsequent live events are not duplicated. When `Last-Event-ID` IS present, behavior is unchanged. JSDoc on the marker write site explains its purpose (resume marker for clients without `Last-Event-ID`; SSE `id:` field updates `lastEventId` on the client; the unknown event type is ignored by the reducer).

**Client / shared package**
- `packages/client/src/session-stream.ts` — add an optional `onReconnect?: () => void` to `SubscribeOptions`, fired from the post-reconnect first-event gate (existing `hasReceivedValidEvent` reset check at `:313-317`), only when `reconnectCount > 0` (initial open must not double-fire). `subscribeToDaemonEvents` and any other browser-facing exports forward `onReconnect` through to `subscribeToStream`.

**UI**
- `packages/monitor-ui/src/hooks/use-daemon-events.ts` — extract the snapshot fetch + `BATCH_SEED` dispatch into a local `seedSnapshot()` function. Call it once on mount and again from the `onReconnect` callback passed to `subscribeToDaemonEvents`.
- Reducer is unchanged. `daemon:resync-marker` is silently ignored by virtue of the existing unknown-event-type no-op behavior in `daemon-reducer.ts:74-87`.

**Documentation**
- `packages/monitor-ui/src/hooks/README.md:24-30` — document re-seed-on-reconnect.

### Files Touched (Preview)
- `packages/monitor/src/server.ts` — `serveDaemonEventsSSE`: skip history on initial connect, emit resync marker.
- `packages/monitor/src/db.ts` — add `getMaxDaemonEventId()`.
- `packages/monitor-ui/src/hooks/use-daemon-events.ts` — extract `seedSnapshot()`, call on mount and on every SSE reconnect.
- `packages/client/src/session-stream.ts` — add `onReconnect` to `SubscribeOptions`, fire from the post-reconnect first-event gate.
- `packages/monitor-ui/src/hooks/README.md` — document re-seed-on-reconnect.

## Scope

**In scope**
- Daemon SSE handler: skip history on initial connect, emit `daemon:resync-marker`.
- New `getMaxDaemonEventId()` helper in `packages/monitor/src/db.ts`.
- `onReconnect` callback wired through `packages/client/src/session-stream.ts` and forwarded by browser-facing subscriber exports.
- `useDaemonEvents` re-seeds snapshot on mount and on every SSE reconnect.
- Hooks README updated to document re-seed-on-reconnect behavior.
- End-to-end verification of both bugs and the `Last-Event-ID`-present reconnect path.

**Out of scope**
- Persisting auto-build state to disk (`.eforge/state.json`).
- Emitting events on `POST /api/auto-build` toggle-ON to close the event-log gap.
- Auditing every reducer handler for idempotency under replay.

These are tracked in project memory `project_daemon_state_vs_event_log.md` for follow-up.

## Acceptance Criteria

**Daemon side**

1. `packages/monitor/src/db.ts` exports `getMaxDaemonEventId(): number` returning the largest `id` from the events table for daemon-wide event types (matching the same filter `getDaemonEventsAfter` uses). Returns 0 when no events exist.
2. `packages/monitor/src/server.ts` `serveDaemonEventsSSE`:
   - When `Last-Event-ID` header is absent (initial connect), the handler does NOT replay historical events.
   - Instead it writes a single SSE marker `id: <maxId>\ndata: {"type":"daemon:resync-marker"}\n\n` (when `maxId > 0`), then proceeds with live updates.
   - Sets `lastSeenId = maxId` for the subscriber so subsequent live events are not duplicated.
   - When `Last-Event-ID` IS present, behavior is unchanged: replay events with id > `lastEventId`.
   - JSDoc on the marker write site explains its purpose (resume marker for clients without `Last-Event-ID`; the SSE `id:` field updates `lastEventId` on the client; the `data` payload's unknown event type is ignored by the reducer).

**UI side**

3. `packages/client/src/session-stream.ts` `SubscribeOptions` gains an optional `onReconnect?: () => void` callback. Documented to fire on each successful reconnect, gated by the existing `hasReceivedValidEvent` reset check at `:313-317`, only when `reconnectCount > 0` (so initial open does not double-fire).
4. `subscribeToDaemonEvents` and any other browser-facing exports forward `onReconnect` through to `subscribeToStream`.
5. `packages/monitor-ui/src/hooks/use-daemon-events.ts`:
   - The snapshot fetch + `BATCH_SEED` dispatch is extracted into a local `seedSnapshot()` function.
   - `seedSnapshot()` is called once on mount.
   - `seedSnapshot()` is called again from the `onReconnect` callback passed to `subscribeToDaemonEvents`.
6. The reducer is unchanged. `daemon:resync-marker` is silently ignored by virtue of the existing unknown-event-type no-op behavior in `daemon-reducer.ts:74-87`.

**Documentation**

7. `packages/monitor-ui/src/hooks/README.md:24-30` is updated to mention the re-seed-on-reconnect behavior.

**Behavioral end-to-end**

8. **Bug 1 e2e:** with a pending PRD in the queue, restart the daemon while the monitor UI is open. The Queue section reappears within ~1-3 seconds with no manual browser refresh. Repeat the daemon restart cycle a second time to confirm consistency.
9. **Bug 2 e2e:** with the daemon DB still containing historical `daemon:auto-build:paused` events, refresh the browser tab. DevTools EventStream tab on `/api/daemon-events` shows a single `daemon:resync-marker` event followed by no replays. The Auto-build toggle correctly reflects the daemon's current state and stays put.
10. **Reconnect with `Last-Event-ID`:** killing the SSE connection mid-stream and letting it auto-reconnect still replays buffered events properly (no regression in the reconnect-with-id path).
11. **No double-fetch on initial mount:** `onReconnect` does not fire on the very first successful connect (verified by network tab — only one set of snapshot fetches on mount).

**Quality gates**

12. `pnpm type-check` passes.
13. `pnpm test` passes.
14. `pnpm build` succeeds.
