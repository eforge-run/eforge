---
id: plan-01-snapshot-and-delta-sse
name: Daemon SSE skip-history + UI re-seed on reconnect
branch: monitor-ui-stop-sse-replay-from-clobbering-snapshot-state/plan-01-snapshot-and-delta-sse
agents:
  builder:
    effort: high
    rationale: Cross-package wire-protocol change (daemon SSE handler, shared client
      subscription core, UI hook) where small edits must stay coordinated. The
      change introduces a new SSE event type (`daemon:resync-marker`) and a new
      optional callback (`onReconnect`) — both must be wired end-to-end without
      regressing the existing `Last-Event-ID` reconnect path.
  reviewer:
    effort: high
    rationale: Reviewing a wire-level contract change and a reducer-replay
      invariant. Requires checking all three packages and the existing tests
      that cover `getDaemonEventsAfter`, the SSE handler, and the
      reconnect/backoff state machine.
---

# Daemon SSE skip-history + UI re-seed on reconnect

## Architecture Context

The monitor UI currently mixes two patterns inconsistently for daemon-wide state:

- **Snapshot+delta** — the UI fetches REST snapshots (`/api/runs`, `/api/queue`, `/api/session-metadata`, `/api/auto-build`) once on mount and dispatches a `BATCH_SEED` to the daemon reducer.
- **Event-sourced replay** — the SSE stream `GET /api/daemon-events` replays the full historical event log on every initial connect (i.e. whenever `Last-Event-ID` is absent), and the reducer applies those replayed events on top of the snapshot.

This collision causes two visible defects (fully analyzed in the source PRD):

1. **Queue section disappears after daemon restart** — SSE reconnect after daemon restart is transparent (the client keeps a stale `Last-Event-ID` past the new daemon's max → `getDaemonEventsAfter` returns 0 events → no re-seed → `pendingCount` stays 0).
2. **Auto-build toggle reverts ON → OFF on every refresh** — initial mount replays a historical `daemon:auto-build:paused` event on top of the correct snapshot (`enabled: true`), and `handleDaemonAutoBuildPaused` unconditionally flips `enabled` to false.

This plan commits the system to **snapshot+delta**: REST snapshots are authoritative; the daemon-events SSE stream only delivers deltas going forward; and the UI re-seeds the snapshot on every SSE reconnect (so a daemon restart heals automatically without a browser refresh).

Closing the event-log incompleteness (e.g. `POST /api/auto-build` toggle-ON does not emit an event) is explicitly **out of scope** — it is tracked in `project_daemon_state_vs_event_log.md`.

## Implementation

### Overview

1. **Daemon (monitor package)** — `serveDaemonEventsSSE` no longer replays historical events when `Last-Event-ID` is absent. Instead it emits a single SSE marker (`id: <maxId>` + `data: {"type":"daemon:resync-marker"}`) so the client's `lastEventId` advances past the historical tail, and registers the subscriber with `lastSeenId = maxId` for live deltas. The `Last-Event-ID`-present branch is unchanged.
2. **DB (monitor package)** — add `getMaxDaemonEventId(): number` with the same daemon-wide event-type filter that `getDaemonEventsAfter` uses, so the marker id reflects the latest persisted daemon-wide event id (returning 0 when the daemon-event log is empty).
3. **Client (shared package)** — add an optional `onReconnect?: () => void` to `SubscribeOptions`. Fire it from inside `subscribeToStream`'s post-reconnect first-event gate, **only** when `reconnectCount > 0` so the initial open does not double-fire. Forward the callback through `subscribeToSession` and `subscribeToDaemonEvents`.
4. **UI (monitor-ui package)** — extract the snapshot fetch + `BATCH_SEED` dispatch in `useDaemonEvents` into a local `seedSnapshot()` function. Call it once on mount and again from the `onReconnect` callback passed to `subscribeToDaemonEvents`.
5. **Docs** — update `packages/monitor-ui/src/hooks/README.md` to document the re-seed-on-reconnect behavior.

The daemon reducer requires no changes: `daemon:resync-marker` is silently ignored by the existing unknown-event-type no-op behavior in `daemonReducer`.

### Key Decisions

1. **Add `getMaxDaemonEventId()` rather than reusing `getMaxEventId()`.** Verified during exploration: `getMaxEventId()` (db.ts:258, db.ts:424) queries `SELECT COALESCE(MAX(id), 0) FROM events` with no event-type filter, while `getDaemonEventsAfter` filters on the `DAEMON_EVENT_TYPES` allowlist. Using global max would technically work (daemon events are a subset, so `lastSeenId = global_max` cannot miss any future daemon delta), but it is semantically misleading — the marker's purpose is "the latest daemon-wide event id the client has implicitly seen" — and would tie us to the events table's global id space rather than the daemon-events stream's. Add a focused helper that mirrors the filter exactly.
2. **Marker uses an unknown event type (`daemon:resync-marker`) instead of a registered one.** The reducer's dispatch path is `const handler = registry[event.type]; if (handler) ...` — unknown types are no-ops without warnings. This avoids modifying the reducer's exhaustive-type table and keeps the marker purely a transport-layer concern. JSDoc on the marker write site documents this contract.
3. **Skip the marker write when `maxId === 0`.** When the daemon-events log is empty (fresh DB), there is no need to advance `lastEventId` on the client; emit no historical/marker payload and proceed to live updates. Live events on this connection will still set `lastEventId` via their `id:` fields.
4. **Preserve the `Last-Event-ID`-present branch unchanged.** SSE auto-reconnect mid-stream still calls `getDaemonEventsAfter(lastEventId)` and replays buffered events past the cutoff. This is the only path now that ever replays history, and it is correct (the client genuinely missed those events).
5. **Fire `onReconnect` only when `reconnectCount > 0`.** The first successful open must not invoke the reconnect hook (otherwise `useDaemonEvents` would fetch the snapshot twice on every initial mount). The first-event gate in `processDataRaw` (`if (!hasReceivedValidEvent) { ... reconnectCount = 0 ... }`) is the natural place: capture the pre-reset `reconnectCount` and only fire the callback if it was non-zero.
6. **Single plan, not split.** The daemon, client, and UI changes form one tightly-coupled wire-protocol change. Splitting (e.g. landing the daemon change before the UI change) would either (a) leave `lastEventId` un-advanced on initial connect for in-flight UIs, breaking reconnect-with-id, or (b) leave the UI re-seed wired to a callback that never fires. Land them together.

## Scope

### In Scope
- Daemon SSE handler skips history on initial connect and emits a `daemon:resync-marker` (gated on `maxId > 0`).
- New `getMaxDaemonEventId(): number` in `packages/monitor/src/db.ts` using the daemon-wide event-type filter.
- `onReconnect?: () => void` added to `SubscribeOptions` in `packages/client/src/session-stream.ts`, fired from the post-reconnect first-event gate when `reconnectCount > 0` only. Forwarded through `subscribeToSession` and `subscribeToDaemonEvents`.
- `useDaemonEvents` extracts `seedSnapshot()` and calls it on mount and on every SSE reconnect.
- `packages/monitor-ui/src/hooks/README.md` updated to document re-seed-on-reconnect.
- Tests: a new monitor-side test exercises `getMaxDaemonEventId()` semantics, and the existing `serveDaemonEventsSSE`-adjacent tests / a new test cover the skip-history + marker behavior. A client-side test verifies `onReconnect` does not fire on the initial open.

### Out of Scope
- Persisting auto-build state to disk (`.eforge/state.json`).
- Emitting events on `POST /api/auto-build` toggle-ON to close the event-log gap.
- Auditing every reducer handler for idempotency under replay (the broader event-log incompleteness audit).
- Changes to per-session event stream (`/api/events/{sessionId}`) replay semantics — out of PRD scope.

## Files

### Create
- `packages/monitor/src/__tests__/daemon-sse-resync.test.ts` — covers (a) `getMaxDaemonEventId()` matches `getDaemonEventsAfter`'s filter and returns 0 on empty, (b) `serveDaemonEventsSSE` initial connect (no `Last-Event-ID`) writes a single `daemon:resync-marker` with `id: <maxDaemonId>` and replays no other events, (c) `Last-Event-ID`-present branch still replays events with id > the header value, (d) marker is omitted when no daemon events exist.

### Modify
- `packages/monitor/src/db.ts` — add `getMaxDaemonEventId(): number` to the `Db` interface and the implementation. Prepared statement filters by `DAEMON_EVENT_TYPES` and returns `COALESCE(MAX(id), 0)`. Add a JSDoc explaining the filter parity with `getDaemonEventsAfter`.
- `packages/monitor/src/server.ts` — `serveDaemonEventsSSE`: when `lastEventId` is undefined, skip the existing `getDaemonEventsAfter(0)` historical replay; instead read `maxId = db.getMaxDaemonEventId()` and, if `maxId > 0`, write a single `id: <maxId>\ndata: {"type":"daemon:resync-marker"}\n\n` block. Set `lastSeenId = maxId` for the registered subscriber. When `lastEventId` is defined, behavior is unchanged (replay events with id > `lastEventId`). JSDoc on the new write site explains: (i) marker is a resume hint for clients without `Last-Event-ID`, (ii) the SSE `id:` field updates the client's `lastEventId`, (iii) the unknown event type is ignored by the reducer.
- `packages/client/src/session-stream.ts` — add optional `onReconnect?: () => void` to `SubscribeOptions` (with TSDoc). In `subscribeToStream`, inside `processDataRaw`'s `!hasReceivedValidEvent` branch, capture the pre-reset `reconnectCount`; after resetting it to 0, invoke `opts.onReconnect?.()` only when the captured value was `> 0`. Wrap the call in try/catch so callback exceptions do not disrupt the stream (mirroring the existing pattern around `onParsedEvent` and `onNamedEvent`). Forward `onReconnect` through `subscribeToSession` (via the options destructure passed to `subscribeToStream`'s opts) and `subscribeToDaemonEvents` (same).
- `packages/monitor-ui/src/hooks/use-daemon-events.ts` — extract the existing parallel snapshot fetch + `BATCH_SEED`/`SET_CONNECTION_STATUS` dispatches into a local `seedSnapshot(signal: AbortSignal)` function. Call it once at the start of the existing `useEffect`. Pass `onReconnect: () => { void seedSnapshot(abort.signal); }` to `subscribeToDaemonEvents`. Preserve current error/abort handling: a `seedSnapshot` invocation aborted by `abort.signal` must not log or set `disconnected`.
- `packages/monitor-ui/src/hooks/README.md` — under "`useDaemonEvents()`", add a bullet/sentence stating: "On every SSE reconnect, `seedSnapshot()` is invoked again so REST snapshot state (runs, queue, session metadata, auto-build) is re-fetched and re-seeded into the reducer. This makes the UI heal automatically across daemon restarts without a manual browser refresh." Also update the "Transport details" section to mention the `daemon:resync-marker` SSE event and `onReconnect` callback at a high level.

## Verification

- [ ] `Db.getMaxDaemonEventId()` exists, returns `COALESCE(MAX(id), 0)` filtered by `DAEMON_EVENT_TYPES`, and returns `0` when the events table is empty (covered by a unit test in `daemon-sse-resync.test.ts`).
- [ ] `Db.getMaxDaemonEventId()` returns the same id that `getDaemonEventsAfter(0)` would surface as the largest `id` (covered by a unit test asserting the two functions agree on the daemon-event-type subset).
- [ ] `serveDaemonEventsSSE` initial connect (no `Last-Event-ID` header) writes exactly one SSE block whose `id:` matches `getMaxDaemonEventId()` and whose `data:` is the JSON `{"type":"daemon:resync-marker"}`. No historical events are replayed in the response body before that marker.
- [ ] When `getMaxDaemonEventId()` returns 0, `serveDaemonEventsSSE` initial connect writes zero historical/marker bytes; the response only carries live deltas pushed after subscription.
- [ ] `serveDaemonEventsSSE` with a `Last-Event-ID: N` header replays events with id > N (unchanged behavior verified by an integration test asserting two events with ids N+1, N+2 are delivered when both exist post-N).
- [ ] After initial connect with no `Last-Event-ID`, the server's registered `DaemonSSESubscriber` has `lastSeenId === maxId`, so a subsequent live event with id `maxId + 1` is forwarded exactly once (no duplicate-delivery regression).
- [ ] `SubscribeOptions.onReconnect` exists in `packages/client/src/session-stream.ts` typings and is exported via `packages/client/src/browser.ts`'s existing `SubscribeOptions` re-export.
- [ ] `onReconnect` does NOT fire on the initial successful open (verified by a unit test that subscribes and receives one event without dropping the underlying transport — the callback must be observed zero times).
- [ ] `onReconnect` fires exactly once after one disconnect/reconnect cycle that produces at least one valid event, and again on each subsequent reconnect that produces at least one valid event.
- [ ] `subscribeToSession` and `subscribeToDaemonEvents` both forward `onReconnect` to `subscribeToStream` (call-site grep + a unit test passing the callback through one of the two helpers).
- [ ] `packages/monitor-ui/src/hooks/use-daemon-events.ts` exposes a local `seedSnapshot()` (or equivalent name) that performs the parallel fetches and dispatches `BATCH_SEED`. The function is called once on mount and from the `onReconnect` callback passed to `subscribeToDaemonEvents`.
- [ ] `daemonReducer` continues to silently ignore the `daemon:resync-marker` event type (no warning, no state change). Verified by reading `packages/monitor-ui/src/lib/daemon-reducer/index.ts`'s registry/IGNORED list — no entry for `daemon:resync-marker` is added; the dispatch fallthrough is the contract.
- [ ] `packages/monitor-ui/src/hooks/README.md` documents the re-seed-on-reconnect behavior under `useDaemonEvents()` and references `daemon:resync-marker` + `onReconnect` under "Transport details".
- [ ] `pnpm type-check` exits 0 across all workspace packages.
- [ ] `pnpm test` exits 0 (existing tests in `packages/monitor/src/__tests__/db.test.ts` and `packages/monitor/src/__tests__/recovery-emit.test.ts` continue to pass; new `daemon-sse-resync.test.ts` passes).
- [ ] `pnpm build` exits 0.
