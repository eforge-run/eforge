---
id: plan-02-migrate-consumers-retire-v18
name: Migrate consumers to subscribeWithSnapshot and retire v18 mechanisms
branch: replace-daemon-resync-marker-and-on-connect-heartbeat-with-a-designed-in-stream-hello-sse-handshake-primitive/plan-02-migrate-consumers-retire-v18
agents:
  builder:
    effort: high
    rationale: Spans four consumer migrations plus three coordinated removals
      (resync-marker, on-connect heartbeat, per-session historical replay) plus
      the public-export collapse. Mostly mechanical once plan-01 lands, but the
      BATCH_SEED dedupe and the `lastBatchEventId` skip-filter removal must be
      done with care so no events are dropped or duplicated across reconnect.
  reviewer:
    effort: high
    rationale: Multiple removal points across server, client public surface, and
      four consumers; reviewer must verify nothing else still depends on
      subscribeToSession/subscribeToDaemonEvents and that no test references
      daemon:resync-marker survives.
---

# Migrate consumers to subscribeWithSnapshot and retire v18 mechanisms

## Architecture Context

Plan-01 added `stream:hello` emission on the server (additive, alongside v18 mechanisms) and a new `subscribeWithSnapshot` generator + `aggregateSessionSummary` helper on the client (additive, alongside `subscribeToSession`/`subscribeToDaemonEvents`). This plan completes the replatform: every SSE consumer migrates to the generator, all v18 mechanisms are removed, the public client surface collapses to a single SSE entry point, the `DAEMON_API_VERSION` bumps once, and every test that locked in v18 behavior is rewritten in `stream:hello` terms.

This is a coordinated breaking change. The `verifyApiVersion` gate (already in `packages/client/src/api-version.ts`) ensures a daemon and clients running mismatched versions surface a clear error rather than silently misbehaving.

## Implementation

### Overview

1. **Migrate `packages/monitor-ui/src/hooks/use-daemon-events.ts`** to `subscribeWithSnapshot`. Drop the `seedSnapshot()` REST function and the `onReconnect` callback. The iterator's `kind: 'snapshot'` arm dispatches `BATCH_SEED` from the snapshot's `runs`/`queue`/`sessionMetadata`/`autoBuild` fields and from `recentActivity` (entries become `daemonActivity` ring buffer entries, deduped by id). The `kind: 'event'` arm dispatches `ADD_EVENT`. The `liveness` field of the snapshot is dispatched as a synthetic `daemon:heartbeat` event so `daemonReducer` populates `latestHeartbeat` immediately on (re)connect.

2. **Migrate `packages/monitor-ui/src/hooks/use-eforge-events.ts`** to `subscribeWithSnapshot`. Drop the mount-time `fetch(API_ROUTES.runState, ...)` REST call (lines 67–82) and the `lastBatchEventId` skip-filter (lines 99, 107–109). The iterator's `kind: 'snapshot'` arm dispatches `BATCH_LOAD` from `snapshot.events` (parsing `data` JSON) and uses `snapshot.status` to decide whether to terminate (cache + iterator drains naturally on terminal status because the server closes the connection). The `kind: 'event'` arm dispatches `ADD_EVENT`. The `kind: 'named'` arm continues to handle `monitor:shutdown-pending` / `monitor:shutdown-cancelled`.

3. **Migrate `packages/eforge/src/cli/mcp-proxy.ts`** (around line 271) to `subscribeWithSnapshot`. The CLI is per-session: snapshot is consumed (status check; if terminal, iterator completes after the snapshot frame and `aggregateSessionSummary` runs over `snapshot.events`). For non-terminal sessions, accumulate events from `kind: 'event'` frames into an array, call `eventToProgress` per event for progress notifications, and at end-of-stream call `aggregateSessionSummary(sessionId, events, monitorUrl)` to produce the `SessionSummary` returned to MCP.

4. **Migrate `packages/pi-eforge/extensions/eforge/index.ts`** (around line 318) — same shape as mcp-proxy.

5. **`daemon-reducer.ts` BATCH_SEED dedupe**: extend the `BATCH_SEED` action to carry `recentActivity?: { id: string; event: EforgeEvent }[]` and `latestHeartbeat?: { at: number; payload: HeartbeatPayload }`. The reducer case appends incoming `recentActivity` entries to `state.daemonActivity` filtering out ids already present (preserving newest-at-end order), capping at `ACTIVITY_BUFFER_CAP`. This prevents duplicates on reconnect when the snapshot's `recentActivity` overlaps already-rendered live deltas.

6. **Server retires v18**: in `packages/monitor/src/server.ts`,
   - Delete the `daemon:resync-marker` block (lines 393–410). Replace with: `lastSeenId = db.getMaxDaemonEventId();` (just track it for the subscriber).
   - Delete the on-connect heartbeat write (lines 421–425).
   - Delete the per-session historical replay loop (lines 337–346) on the no-Last-Event-ID branch. Replace with: `lastSeenId = (snapshot's max event id);`. The Last-Event-ID branch (which replays missed events with id > Last-Event-ID) stays — that is the legitimate delta-replay path.
   - For per-session, when the run is terminal (`status === 'completed' | 'failed'`), close the SSE connection after `writeHello` (call `res.end()`) — no live subscription is established. The client iterator completes naturally.

7. **Client public surface collapse**: in `packages/client/src/index.ts` and `packages/client/src/browser.ts`,
   - Remove the exports `subscribeToSession`, `subscribeToDaemonEvents`.
   - `subscribeWithSnapshot`, `aggregateSessionSummary`, and the snapshot envelope types remain (added in plan-01).
   - `parseSseChunk` stays (still used by the internal core; the `mcp-proxy` test imports it).
   - In `packages/client/src/session-stream.ts`, mark `subscribeToSession` and `subscribeToDaemonEvents` as no longer exported (delete the function definitions if no internal caller remains; keep the internal `subscribeToStream` core, the browser/node transport split, and `parseSseChunk` — those are still used by `subscribeWithSnapshot`).
   - Drop the inline `SessionSummary` aggregation from `session-stream.ts` (it's now in `aggregate-session-summary.ts`).

8. **`DAEMON_API_VERSION` bump**: in `packages/client/src/api-version.ts`, increment from `22` to `23`. Replace the `// v22: ...` comment with one citing `stream:hello` and the removal of `daemon:resync-marker` + on-connect heartbeat. Update `test/api-version-check.test.ts` to the new value (the test reads `DAEMON_API_VERSION` directly so should not need a literal update — verify).

9. **Test rewrites**:
   - Rename `packages/monitor/src/__tests__/daemon-sse-resync.test.ts` → `daemon-sse-handshake.test.ts`. Three integration cases: (a) fresh connect with non-empty daemon-event log emits `stream:hello` first with current cursor and populated `recentActivity`; no historical replay frames; no resync-marker; no on-connect heartbeat. (b) fresh connect with empty daemon-event log emits `stream:hello` with `cursor: 0` and `recentActivity: []`; `liveness` and REST projections still populated; no on-connect heartbeat. (c) reconnect with `Last-Event-ID` emits `stream:hello` first then deltas with id > Last-Event-ID.
   - New `packages/monitor/src/__tests__/session-sse-handshake.test.ts` — three cases: fresh connect to a running session emits `stream:hello` with `snapshot.events` populated, then live deltas only; fresh connect to a terminal session emits `stream:hello` with full snapshot, then closes the connection (no live subscription); reconnect with `Last-Event-ID` emits `stream:hello` then delta replay.
   - Rewrite `test/session-stream.test.ts` in `subscribeWithSnapshot` terms. Drop tests of removed APIs.
   - Rewrite or delete `packages/client/src/__tests__/subscribe-to-daemon-events.test.ts` — its subject is removed. New `subscribe-with-snapshot.test.ts` (added in plan-01) covers the replacement.
   - Update `packages/monitor-ui/src/hooks/__tests__/use-daemon-events.test.ts` and `packages/monitor-ui/src/__tests__/two-sse-subscribers.test.ts` to the new contract (no REST-on-mount; snapshot dispatched from `kind: 'snapshot'` frames).
   - `test/pi-follow-tool.test.ts` — update if it asserts `subscribeToSession` directly (it likely just exercises the tool). Verify and adjust.

10. **Acceptance grep**: after the migration, `grep -rn "daemon:resync-marker" packages/ test/` MUST return zero hits (including comments, JSDoc, test strings). Same for `subscribeToSession` and `subscribeToDaemonEvents` outside of git history.

### Key Decisions

1. **Snapshot envelopes already match REST shapes (plan-01).** So consumer migration is mechanical: replace the REST fetch with a read of the corresponding snapshot field. No shape conversion needed.

2. **`liveness` field dispatched as a synthetic `daemon:heartbeat`.** The existing reducer registry has a handler for `daemon:heartbeat` that writes to `state.latestHeartbeat`. Reusing it means the liveness pill renders within ~100 ms of (re)connect via the same code path as the periodic 10 s heartbeat — no new reducer surface required.

3. **`recentActivity` dedupe-by-id in `BATCH_SEED`.** Reconnect re-emits `stream:hello` with a fresh `recentActivity` snapshot, which would otherwise duplicate existing entries in the ring buffer. The reducer filters incoming entries against the highest id already present in `state.daemonActivity` (or the full id-set if order can shuffle), preserving newest-at-end order.

4. **Per-session terminal sessions close the SSE connection after `stream:hello`.** This eliminates the today's pattern of "REST snapshot + open SSE that immediately ends" — one round-trip total instead of two for terminal sessions. The client iterator naturally completes when the connection closes after the snapshot frame.

5. **`subscribeWithSnapshot` is the only public SSE entry point.** No `EventSource` or raw fetch helper escapes `@eforge-build/client`. Reviewer must reject any new code in `monitor-ui`/`mcp-proxy`/`pi-extension` that uses `EventSource` directly.

6. **`DAEMON_API_VERSION` bump is the wire-format gate.** A daemon running plan-02 code and a client running pre-plan-02 code (or vice versa) will fail the `verifyApiVersion` check with a clear `version-mismatch` error, prompting a daemon restart. This is the designed handoff.

7. **`mcp-proxy` and `pi-extension` use `aggregateSessionSummary`.** After the iterator completes, both call the helper over the accumulated event array. The function is sync, so the test pattern is trivial: hand-craft an `EforgeEvent[]`, assert the returned `SessionSummary`. The PRD notes this is preferred over streaming aggregation because it's testable without SSE machinery.

8. **The four REST endpoints stay**, but are no longer the bootstrap path. `/api/runs`, `/api/queue`, `/api/session-metadata`, `/api/auto-build`, and `/api/runs/:id/state` continue to respond with their existing JSON shapes (curl-debuggable, deep-linkable). The bootstrap path now goes through SSE only.

## Scope

### In Scope

- **Server (retire v18)**: in `packages/monitor/src/server.ts`,
  - Delete the `daemon:resync-marker` emission block in `serveDaemonEventsSSE()`.
  - Delete the on-connect heartbeat write in `serveDaemonEventsSSE()`.
  - Delete the per-session historical-replay loop on the no-Last-Event-ID branch in `serveSSE()`.
  - For per-session terminal sessions (run status `completed`/`failed`), close the SSE connection after `writeHello` instead of registering a live subscriber.
- **Client public surface collapse**:
  - Remove `subscribeToSession`, `subscribeToDaemonEvents` exports from `packages/client/src/index.ts` and `packages/client/src/browser.ts`.
  - Delete the function bodies of `subscribeToSession` and `subscribeToDaemonEvents` in `packages/client/src/session-stream.ts`.
  - Delete the inline `SessionSummary` aggregation in `subscribeToSession` (functionality lives in `aggregate-session-summary.ts`).
  - Keep `parseSseChunk`, `subscribeToStream` (private), and the new `subscribeWithSnapshot`, plus all type definitions.
- **DAEMON_API_VERSION bump**: from `22` to `23` in `packages/client/src/api-version.ts`. Update the version-comment to cite `stream:hello`, removal of `daemon:resync-marker`, removal of on-connect heartbeat, and the snapshot envelope addition.
- **Reducer**: in `packages/monitor-ui/src/lib/daemon-reducer.ts`,
  - Extend `BATCH_SEED` action with optional `recentActivity` and `latestHeartbeat` fields.
  - Reducer case appends `recentActivity` entries to `state.daemonActivity` filtering out ids already present, capped at `ACTIVITY_BUFFER_CAP`, newest at end.
  - Reducer case sets `state.latestHeartbeat` from the action payload when provided.
- **Consumer migrations**:
  - `packages/monitor-ui/src/hooks/use-daemon-events.ts`: replace `seedSnapshot()` + `subscribeToDaemonEvents` + `onReconnect` with a `subscribeWithSnapshot` async-iterator loop. Snapshot frames dispatch `BATCH_SEED`; event frames dispatch `ADD_EVENT`.
  - `packages/monitor-ui/src/hooks/use-eforge-events.ts`: replace the mount-time REST fetch + `lastBatchEventId` skip-filter + `subscribeToSession` with a `subscribeWithSnapshot` async-iterator loop. Snapshot frames dispatch `BATCH_LOAD`; event frames dispatch `ADD_EVENT`; named frames continue to handle shutdown countdown.
  - `packages/eforge/src/cli/mcp-proxy.ts` (line 271): replace `subscribeToSession<DaemonStreamEvent>` with `subscribeWithSnapshot<SessionStreamSnapshot, DaemonStreamEvent>`. Iterate; collect events into an array; call `eventToProgress` on each event frame for progress notification; at end-of-stream call `aggregateSessionSummary` to produce the returned `SessionSummary`.
  - `packages/pi-eforge/extensions/eforge/index.ts` (line 318): same migration as mcp-proxy.
- **Test rewrites and removals**:
  - Rename `packages/monitor/src/__tests__/daemon-sse-resync.test.ts` → `packages/monitor/src/__tests__/daemon-sse-handshake.test.ts`; rewrite the three integration cases in `stream:hello` terms.
  - New `packages/monitor/src/__tests__/session-sse-handshake.test.ts` covering the three per-session integration cases.
  - Rewrite `test/session-stream.test.ts` in `subscribeWithSnapshot` terms. Drop the `subscribeToSession`-specific cases.
  - Delete or rewrite `packages/client/src/__tests__/subscribe-to-daemon-events.test.ts` — its subject is removed; coverage moves to `subscribe-with-snapshot.test.ts` (added in plan-01).
  - Update `packages/monitor-ui/src/hooks/__tests__/use-daemon-events.test.ts` to the new contract.
  - Update `packages/monitor-ui/src/__tests__/two-sse-subscribers.test.ts` to the new contract.
  - Update `test/api-version-check.test.ts` if it has a hard-coded version literal (the file imports `DAEMON_API_VERSION` directly, so likely no change needed — verify).
  - Update `test/daemon-events-stream.test.ts` if it relies on the v18 wire format (it tests delta replay, which is unchanged — verify it still passes; rewrite assertions if needed for the `stream:hello` first-frame).
  - Update `test/pi-follow-tool.test.ts` if it asserts `subscribeToSession` behavior directly.
- **Verification grep**: after the migration, `grep -rn "daemon:resync-marker" packages/ test/` returns zero hits, and `grep -rn "subscribeToSession\|subscribeToDaemonEvents" packages/` returns zero hits.

### Out of Scope

- Changes to which events daemon-events vs per-session SSE subscribe to.
- Changes to the four REST endpoints (`/api/runs`, `/api/queue`, `/api/session-metadata`, `/api/auto-build`) or `/api/runs/:id/state` — they continue to serve their existing shapes.
- Persisting `daemon:heartbeat` to the DB (the F5 "symmetry gap" half — explicitly out of scope per PRD).
- Folding the per-session REST snapshot into `stream:hello` further than already done in plan-01 (already in scope: per-session snapshot already carries `events` and `status`).
- WebSockets, SSE replacement, or any other transport change.
- Updates to the spine's event registry, Zod boundaries, or reducer surface beyond the targeted `BATCH_SEED` extension.
- Removing the `parseSseChunk` export (still useful for tests and is not part of the v18 mechanism being retired).

## Files

### Modify

- `packages/monitor/src/server.ts` — delete `daemon:resync-marker` block; delete on-connect heartbeat block; delete per-session historical replay loop on no-Last-Event-ID branch; close the connection after `writeHello` for terminal per-session connects.
- `packages/client/src/api-version.ts` — bump `DAEMON_API_VERSION` from `22` to `23` and update the version comment.
- `packages/client/src/session-stream.ts` — delete `subscribeToSession` and `subscribeToDaemonEvents` function bodies and their inline aggregation. Keep `subscribeToStream` (private), `parseSseChunk`, `subscribeWithSnapshot`, and all type definitions. Update module JSDoc to reflect that `subscribeWithSnapshot` is the only public entry point.
- `packages/client/src/index.ts` — remove `subscribeToSession` and `subscribeToDaemonEvents` from the re-export block (line 161). Keep `parseSseChunk`, `subscribeWithSnapshot`, type re-exports, etc.
- `packages/client/src/browser.ts` — same removals as `index.ts` (line 90).
- `packages/monitor-ui/src/lib/daemon-reducer.ts` — extend `BATCH_SEED` action with optional `recentActivity` and `latestHeartbeat`; reducer case dedupes activity by id, sets `latestHeartbeat`.
- `packages/monitor-ui/src/hooks/use-daemon-events.ts` — full rewrite of the effect body: replace `seedSnapshot` + `subscribeToDaemonEvents` + `onReconnect` with a `for await (const frame of subscribeWithSnapshot(...))` loop. Snapshot frames dispatch `BATCH_SEED`; event frames dispatch `ADD_EVENT`.
- `packages/monitor-ui/src/hooks/use-eforge-events.ts` — full rewrite of the effect body: drop the REST `runState` fetch, drop `lastBatchEventId` skip-filter, replace `subscribeToSession` with `subscribeWithSnapshot`. Snapshot frames dispatch `BATCH_LOAD`; event frames dispatch `ADD_EVENT`; named frames continue to handle shutdown countdown.
- `packages/eforge/src/cli/mcp-proxy.ts` — replace the `subscribeToSession` call (around line 271) with a `subscribeWithSnapshot` async-iterator loop; collect events; call `eventToProgress` on each; call `aggregateSessionSummary` at end-of-stream.
- `packages/pi-eforge/extensions/eforge/index.ts` — same migration as mcp-proxy (around line 318).
- `packages/monitor/src/__tests__/daemon-sse-resync.test.ts` → renamed to `packages/monitor/src/__tests__/daemon-sse-handshake.test.ts`; rewrite the three integration cases.
- `test/session-stream.test.ts` — rewrite in `subscribeWithSnapshot` terms.
- `packages/client/src/__tests__/subscribe-to-daemon-events.test.ts` — delete (subject is gone) or rewrite as a thin adapter test if any internal coverage is missing from `subscribe-with-snapshot.test.ts`.
- `packages/monitor-ui/src/hooks/__tests__/use-daemon-events.test.ts` — update to the new no-REST-on-mount contract.
- `packages/monitor-ui/src/__tests__/two-sse-subscribers.test.ts` — update to the new contract.
- `test/daemon-events-stream.test.ts` — verify and update if it relies on v18 wire format.
- `test/pi-follow-tool.test.ts` — verify and update if it asserts `subscribeToSession` directly.
- `test/api-version-check.test.ts` — verify it imports `DAEMON_API_VERSION` rather than hard-coding the value; update if hard-coded.

### Create

- `packages/monitor/src/__tests__/session-sse-handshake.test.ts` — three per-session integration cases (fresh-connect-running, fresh-connect-terminal, reconnect-with-last-event-id).

## Verification

- [ ] `pnpm type-check` passes with zero errors across all workspace packages.
- [ ] `pnpm test` passes — every rewritten test green; no orphaned tests of removed APIs.
- [ ] `pnpm build` succeeds for every workspace package.
- [ ] `grep -rn "daemon:resync-marker" packages/ test/ eforge-plugin/` returns zero hits (including comments, JSDoc, and test strings).
- [ ] `grep -rn "subscribeToSession\|subscribeToDaemonEvents" packages/ test/ eforge-plugin/` returns zero hits.
- [ ] `curl -N http://127.0.0.1:<port>/api/daemon-events` against a daemon running plan-02 emits exactly one `stream:hello` named frame on fresh connect, then 10-second-interval `daemon:heartbeat` frames; no `daemon:resync-marker` is ever emitted; no immediate on-connect heartbeat is emitted.
- [ ] `curl -N http://127.0.0.1:<port>/api/events/<runningSessionId>` emits exactly one `stream:hello` named frame on fresh connect with `snapshot.events` populated, then live delta frames only — no historical replay frames after `stream:hello`.
- [ ] `curl -N http://127.0.0.1:<port>/api/events/<terminalSessionId>` emits exactly one `stream:hello` frame and the connection closes — the client never sees a live subscription.
- [ ] Reconnecting (Last-Event-ID present) on either stream emits `stream:hello` first, then replay deltas with id > Last-Event-ID.
- [ ] A daemon at v22 paired with a v23 client (or vice versa) returns a `version-mismatch` error from `verifyApiVersion`, with an actionable error message.
- [ ] `DAEMON_API_VERSION` equals `23` in `packages/client/src/api-version.ts`; the version comment cites `stream:hello`, removal of `daemon:resync-marker`, removal of on-connect heartbeat, and the snapshot envelope addition.
- [ ] Loading the monitor UI in a browser shows the daemon liveness pill green within 100 ms of page load (no 0–10 s flap), driven by the snapshot's `liveness` field dispatched as a synthetic `daemon:heartbeat`.
- [ ] The Daemon Activity panel populates immediately on first load with `recentActivity` from the snapshot; no `daemon:resync-marker` row is ever shown.
- [ ] Reducer test: dispatching `BATCH_SEED` twice with overlapping `recentActivity` ids leaves `state.daemonActivity` containing each id exactly once, newest at end, capped at `ACTIVITY_BUFFER_CAP`.
- [ ] `aggregateSessionSummary(sessionId, events, monitorUrl)` is called by both `mcp-proxy.ts` and `pi-eforge/extensions/eforge/index.ts` after their iterator completes, and produces the `SessionSummary` returned to MCP / Pi.
- [ ] Restarting the daemon during a build causes the SSE connection to reconnect, the snapshot frame re-seeds via `BATCH_SEED`, and no duplicate event rows appear in the per-session detail view (BATCH_SEED dedupe verified).