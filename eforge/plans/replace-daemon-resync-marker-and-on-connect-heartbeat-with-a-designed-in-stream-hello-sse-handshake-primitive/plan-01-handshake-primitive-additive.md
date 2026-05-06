---
id: plan-01-handshake-primitive-additive
name: Add stream:hello handshake primitive (additive, no removals)
branch: replace-daemon-resync-marker-and-on-connect-heartbeat-with-a-designed-in-stream-hello-sse-handshake-primitive/plan-01-handshake-primitive-additive
agents:
  builder:
    effort: xhigh
    rationale: "Novel API design: a sealed server-side helper (writeHello), a
      generator-shape public client API (subscribeWithSnapshot) sitting on top
      of an existing callback-based core via a bounded queue + promise resolver,
      plus a snapshot envelope that inlines four daemon REST projections. The
      cursor-capture rule for stream:hello must be applied inside the existing
      subscribeToStream core (not the generator) to keep Last-Event-ID semantics
      intact across reconnects. Numerous subtle ordering invariants require deep
      reasoning."
  reviewer:
    effort: high
    rationale: "API-design plan: the generator-vs-callback bridge, the
      cursor-capture rule, and the snapshot envelope shapes are easy to get
      subtly wrong (e.g. yielding events before the snapshot, double-firing
      snapshots on reconnect, leaking EventSource into public surface, loose
      typing on the three-armed iterator union)."
---

# Add stream:hello handshake primitive (additive, no removals)

## Architecture Context

The monitor's SSE wire format currently uses two ad-hoc bootstrap mechanisms on `/api/daemon-events` (`daemon:resync-marker` + on-connect heartbeat) and no skip-history mechanism at all on `/api/events/:sessionId`. Per-session bootstrap is worked around in `use-eforge-events.ts` with a manual REST `runState` snapshot fetch + `lastBatchEventId` skip-filter; daemon-events bootstrap is worked around in `use-daemon-events.ts` with parallel REST snapshot fetches plus an `onReconnect` callback to re-seed.

This plan introduces a single designed-in primitive — a `stream:hello` named SSE event carrying a cursor and an optional snapshot — that both stream types emit as their first frame. It is **strictly additive**: the existing `daemon:resync-marker` block, on-connect heartbeat write, per-session historical replay, and `subscribeToSession`/`subscribeToDaemonEvents` exports all stay in place. Plan 02 retires the v18 mechanisms once consumers have been migrated.

Key invariants preserved by an additive plan-01:
- `DAEMON_API_VERSION` does NOT bump in this plan (no breaking wire change yet) — bump deferred to plan-02.
- Old clients (`subscribeToSession` / `subscribeToDaemonEvents`) are unaffected: they receive `stream:hello` via their existing `onNamedEvent` channel and ignore it (none of the registered named-event handlers — `monitor:shutdown-pending`, `monitor:shutdown-cancelled` — match it).
- New clients (`subscribeWithSnapshot`) intercept `stream:hello` internally and surface it as `kind: 'snapshot'` from the iterator.
- Per-session SSE STILL replays history on no-Last-Event-ID; this is intentional for plan-01 (removed in plan-02 once consumers stop relying on replay).
- Daemon-events SSE STILL emits `daemon:resync-marker` and the on-connect heartbeat in plan-01; both are removed in plan-02.

## Implementation

### Overview

1. **Server**: introduce a sealed helper module `packages/monitor/src/sse-handshake.ts` exporting `writeHello(res, cursor, snapshot?)`. Both `serveSSE()` and `serveDaemonEventsSSE()` in `packages/monitor/src/server.ts` call it as the first write on every connection (before any historical replay, before the existing resync-marker / on-connect heartbeat). The helper builds the `event: stream:hello\ndata: <json>\n\n` frame; no `id:` field; named SSE event so clients route it to `onNamedEvent`.

2. **Snapshot envelopes**: built inline in `server.ts` next to each SSE handler.
   - **Daemon-events**: `{ liveness: HeartbeatPayload, recentActivity: { id, event }[] (last 20), runs, queue, sessionMetadata, autoBuild }`. `liveness` reuses the JSON shape `buildHeartbeatPayload()` produces today (parsed back into an object for the snapshot). `recentActivity` queries `db.getDaemonEventsAfter(maxId - 20)` and runs each row through the existing `parseEventRow` helper (lines 100–138 of `server.ts`). `runs`/`queue`/`sessionMetadata`/`autoBuild` match the response shapes of the four existing REST endpoints byte-for-byte.
   - **Per-session**: `{ status: 'pending' | 'running' | 'completed' | 'failed', events: { id, data }[] }`. Matches the existing `RunStateResponse` from `GET /api/runs/:id/state`.

3. **Client**: extend `packages/client/src/session-stream.ts` with a new exported `subscribeWithSnapshot<S, E>(url, opts)` returning `AsyncGenerator<{ kind: 'snapshot'; snapshot: S } | { kind: 'event'; event: E; eventId?: string } | { kind: 'named'; name: string; data: string }>`. Implementation sits on top of the existing callback-driven `subscribeToStream` core via a bounded queue + promise-resolver bridge. The generator MUST yield the `stream:hello` snapshot before any other frame on every (re)connect.

4. **Cursor-capture rule lives in `subscribeToStream`**, not the generator. Inside the existing `processDataRaw`'s peer for named events (lines 423–429 and 517–523 in `session-stream.ts`), if `block.event === 'stream:hello'`, parse `data`, write `cursor` into the closure's `lastEventId` slot, then surface the named event as a snapshot frame to the new generator (or as a normal `onNamedEvent` callback for old API consumers). This makes the new primitive's cursor authoritative for `Last-Event-ID` reconnect, while still allowing old API consumers to ignore the frame.

5. **Aggregation extracted**: new file `packages/client/src/aggregate-session-summary.ts` exports `aggregateSessionSummary(sessionId, events, monitorUrl)` — a synchronous helper that computes `eventCount`, `phaseCount`, `filesChanged`, `errorCount`, and terminal `status`/`summary` from a flat `EforgeEvent[]`. The engine event-type literals (`'phase:start'`, `'plan:build:files_changed'`, `:error`/`:failed` suffixes) live here, restoring the "no engine deps" layering `session-stream.ts` claims to honor. The existing inline aggregation inside `subscribeToSession()` (lines 591–635) is left untouched in this plan — both functions compute the same thing, but plan-02 will redirect all callers to `aggregateSessionSummary` and then drop the inline copy.

6. **Public surface (additive)**: `packages/client/src/index.ts` and `packages/client/src/browser.ts` ADD exports for `subscribeWithSnapshot`, `aggregateSessionSummary`, and the snapshot envelope types `DaemonStreamSnapshot` / `SessionStreamSnapshot`. Existing exports (`subscribeToSession`, `subscribeToDaemonEvents`, `parseSseChunk`, `SubscribeOptions`, etc.) are NOT removed in this plan.

7. **Snapshot envelope type location** (per PRD's adapt-to-current-codebase clause): `packages/client/src/events.schemas.ts` already exists with Zod conventions, so add `DaemonStreamSnapshotSchema` and `SessionStreamSnapshotSchema` there and derive the TS types via `z.infer`. Re-export the derived types from `session-stream.ts` for ergonomics.

### Key Decisions

1. **Generator on top of callback, not a rewrite.** The existing `subscribeToStream` core handles browser/node transport split, `Last-Event-ID` capture, reconnect/backoff, fetch-vs-EventSource selection, and abort propagation. Replacing it would re-introduce a class of subtle bugs that are already shaken out. The bridge is a bounded queue + promise resolver: callbacks push frames; the generator awaits a resolver and drains the queue.

2. **Cursor capture inside the core, not the generator.** The cursor in `stream:hello` is the new authoritative source for `Last-Event-ID` on reconnect. The generator never manages reconnect state; the core peeks at `stream:hello` blocks before bubbling them up and writes the cursor into its closure's `lastEventId` slot. Same mechanism works for old API consumers (their `onNamedEvent` callback fires after the cursor is captured) — so even an old client transparently benefits from cursor-correct reconnects in plan-01.

3. **Three-armed iterator union.** The `'named'` arm preserves the existing `onNamedEvent` channel for `monitor:shutdown-pending` / `monitor:shutdown-cancelled` countdown frames. `stream:hello` is intercepted by the library and surfaced via the `'snapshot'` arm — it does NOT reach the consumer as a `'named'` frame. Three arms is the honest type shape; smuggling shutdown frames into `'event'` would force consumers to filter by name.

4. **Snapshot envelopes match REST responses byte-for-byte.** `runs`, `queue`, `sessionMetadata`, `autoBuild`, and per-session `status`+`events` use the same TS types and JSON shapes as the existing REST endpoints. Plan-02 consumers can therefore feed the snapshot fields into the same reducer cases that today consume REST responses, with no shape conversion.

5. **`recentActivity` bounded at 20.** Trimmed to keep frame size sane (≤ a few KB even on a busy daemon). The PRD's frame-size discussion (Design Decision #10 in the source) accepts that 20 is a heuristic; revisit if profiling shows >500KB frames.

6. **No `DAEMON_API_VERSION` bump in this plan.** The wire format is strictly additive: every old behavior is preserved. New consumers gain a frame; old consumers see a `stream:hello` named event they ignore. Bump is deferred to plan-02 where the breaking removals land.

7. **`stream:hello` has no SSE `id:` field.** It's live-only and must never be replayed on reconnect — its purpose is to set the cursor for the *current* connection only. Reconnect emits a fresh `stream:hello` with a fresh cursor.

## Scope

### In Scope

- New file `packages/monitor/src/sse-handshake.ts` — sealed primitive exporting `writeHello(res, cursor, snapshot?)`.
- Modify `packages/monitor/src/server.ts`:
  - Both `serveSSE()` and `serveDaemonEventsSSE()` call `writeHello()` as the first write on every connection (before any other write).
  - The daemon-events handler builds a `DaemonStreamSnapshot` inline using `db.getDaemonEventsAfter(maxId - 20)` (filtered through `parseEventRow`), `db.getRuns()`, queue dir read (already in `buildHeartbeatPayload`), in-memory `sessionMetadata` and `autoBuild`, and a parsed `buildHeartbeatPayload()` payload as `liveness`.
  - The per-session handler builds a `SessionStreamSnapshot` inline using `db.getEventsBySession(sessionId)` and the run's `status`.
  - The existing `daemon:resync-marker` block (lines 393–410), on-connect heartbeat block (lines 421–425), and per-session historical replay loop (lines 337–346) all REMAIN in plan-01; they are removed in plan-02.
- Add `DaemonStreamSnapshotSchema` and `SessionStreamSnapshotSchema` to `packages/client/src/events.schemas.ts`; derive TS types via `z.infer`.
- Modify `packages/client/src/session-stream.ts`:
  - Add `subscribeWithSnapshot<S, E>` exported function returning `AsyncGenerator<{ kind: 'snapshot' | 'event' | 'named' }>`.
  - Implementation: bounded queue + promise resolver bridging the existing `subscribeToStream` callback core; intercept `stream:hello` in the named-event path and surface as `'snapshot'`; emit `'event'` from the JSON-event path; emit `'named'` for any other named event.
  - Add the cursor-capture rule inside `subscribeToStream`: when a named event with `event === 'stream:hello'` is parsed, set the closure's `lastEventId` from `JSON.parse(data).cursor` BEFORE bubbling the named event up.
  - Add a re-export type alias for `DaemonStreamSnapshot` and `SessionStreamSnapshot`.
  - Existing `subscribeToSession`, `subscribeToDaemonEvents`, and `parseSseChunk` are LEFT IN PLACE.
- New file `packages/client/src/aggregate-session-summary.ts` exporting `aggregateSessionSummary(sessionId, events, monitorUrl): SessionSummary`. The engine event-type literals (`'phase:start'`, `'plan:build:files_changed'`, `:error`/`:failed` suffix detection) live here. `SessionSummary` is re-exported from this module (or imported from `session-stream.ts` to avoid duplication — implementor's call).
- Add public exports to `packages/client/src/index.ts` and `packages/client/src/browser.ts`:
  - `subscribeWithSnapshot`
  - `aggregateSessionSummary`
  - `DaemonStreamSnapshot`, `SessionStreamSnapshot` types
- Tests:
  - New `packages/monitor/src/__tests__/sse-handshake.test.ts` — server-side unit tests for `writeHello`: cursor format, snapshot serialization, named-event field present, no `id:` field on the frame.
  - New `packages/client/src/__tests__/subscribe-with-snapshot.test.ts` — generator semantics: snapshot is the first yielded frame, snapshot re-fires on reconnect, abort propagates as iterator-thrown `AbortError`, named events route to `kind: 'named'`, `stream:hello` does NOT appear in `kind: 'named'`. Reuse the fake-SSE-server pattern from `test/session-stream.test.ts`.
  - New `packages/client/src/__tests__/aggregate-session-summary.test.ts` — counter increments and terminal status extraction over hand-crafted `EforgeEvent[]` arrays.
  - Existing `packages/monitor/src/__tests__/daemon-sse-resync.test.ts` is NOT renamed in this plan (the v18 mechanisms are still emitted; the test still passes). Plan-02 rewrites it.
  - Existing `test/session-stream.test.ts`, `test/daemon-events-stream.test.ts`, and `packages/client/src/__tests__/subscribe-to-daemon-events.test.ts` continue to pass unchanged — old API still works.

### Out of Scope

- Removing `subscribeToSession` / `subscribeToDaemonEvents` from public exports (plan-02).
- Removing the `daemon:resync-marker` emission, the on-connect heartbeat, or per-session historical replay from `server.ts` (plan-02).
- Migrating `use-eforge-events.ts`, `use-daemon-events.ts`, `mcp-proxy.ts`, or `pi-eforge/extensions/eforge/index.ts` to the new API (plan-02).
- `DAEMON_API_VERSION` bump (plan-02).
- BATCH_SEED dedupe in `daemon-reducer.ts` (plan-02 — only matters once consumers feed snapshots into the reducer).
- Renaming `daemon-sse-resync.test.ts` → `daemon-sse-handshake.test.ts` (plan-02 — when v18 emissions are removed).
- Deleting the inline aggregation in `subscribeToSession()` — plan-02 redirects callers and drops it then.

## Files

### Create

- `packages/monitor/src/sse-handshake.ts` — sealed helper module exporting `writeHello(res: ServerResponse, cursor: number, snapshot?: unknown): void`. The frame uses `event: stream:hello\ndata: {json}\n\n` (named SSE event), no `id:` field. Module exports nothing else. JSDoc declares the rule: any future SSE handler in the daemon must call `writeHello()` first or fail review.
- `packages/client/src/aggregate-session-summary.ts` — synchronous helper computing `SessionSummary` from a flat `EforgeEvent[]`. Engine-domain event-type literals live here.
- `packages/monitor/src/__tests__/sse-handshake.test.ts` — `writeHello` unit tests.
- `packages/client/src/__tests__/subscribe-with-snapshot.test.ts` — generator semantics tests using a fake SSE server.
- `packages/client/src/__tests__/aggregate-session-summary.test.ts` — aggregation tests over hand-crafted event arrays.

### Modify

- `packages/monitor/src/server.ts` — add `import { writeHello } from './sse-handshake.js'`. In `serveSSE()` (around line 321), call `writeHello(res, cursor, sessionSnapshot)` before the historical-replay loop, where `cursor` is the max event id for the session and `sessionSnapshot` is `{ status, events }`. In `serveDaemonEventsSSE()` (around line 357), call `writeHello(res, cursor, daemonSnapshot)` before the existing resync-marker / on-connect heartbeat blocks, where `cursor = db.getMaxDaemonEventId()` and `daemonSnapshot` carries `liveness` (parsed `buildHeartbeatPayload()`), `recentActivity` (last 20 daemon events through `parseEventRow`), `runs`, `queue`, `sessionMetadata`, `autoBuild`. The existing v18 emissions stay.
- `packages/client/src/session-stream.ts` — add the `subscribeWithSnapshot` generator on top of `subscribeToStream`. Add the cursor-capture rule inside `subscribeToStream` for `stream:hello` named events (browser path lines ~423–429 and node path lines ~517–523). Add type re-exports for `DaemonStreamSnapshot` and `SessionStreamSnapshot`. Keep existing exports.
- `packages/client/src/events.schemas.ts` — add `DaemonStreamSnapshotSchema` and `SessionStreamSnapshotSchema` Zod schemas; export the derived TS types via `z.infer`.
- `packages/client/src/index.ts` — add re-exports for `subscribeWithSnapshot`, `aggregateSessionSummary`, `DaemonStreamSnapshot`, `SessionStreamSnapshot`.
- `packages/client/src/browser.ts` — same additions as `index.ts`.

## Verification

- [ ] `pnpm type-check` passes across all packages.
- [ ] `pnpm test` passes — including the existing `daemon-sse-resync.test.ts`, `test/session-stream.test.ts`, `test/daemon-events-stream.test.ts`, and `packages/client/src/__tests__/subscribe-to-daemon-events.test.ts` (old API still works).
- [ ] `pnpm build` succeeds for every workspace package.
- [ ] `curl -N http://127.0.0.1:<port>/api/daemon-events` (against a daemon running plan-01 code) emits a `stream:hello` frame as the first frame, followed by the existing `daemon:resync-marker` (when daemon events exist) or skip-of-marker plus `daemon:heartbeat` (when no daemon events exist). The first frame's `data:` payload parses as JSON and contains `cursor`, `liveness`, `recentActivity`, `runs`, `queue`, `sessionMetadata`, `autoBuild`.
- [ ] `curl -N http://127.0.0.1:<port>/api/events/<sessionId>` emits a `stream:hello` frame as the first frame whose `data:` payload contains `cursor`, `status`, `events`, followed by the existing per-session historical replay frames.
- [ ] The `stream:hello` frame uses `event: stream:hello` (named SSE event) and has NO `id:` field.
- [ ] `subscribeWithSnapshot('http://...', { signal })` against a fresh connect yields `{ kind: 'snapshot' }` as the first frame, then `kind: 'event'` frames for each subsequent JSON event. After a server-initiated reconnect, a fresh `kind: 'snapshot'` frame is yielded again.
- [ ] `subscribeWithSnapshot` does NOT yield `stream:hello` as a `kind: 'named'` frame — it is intercepted and surfaced as `kind: 'snapshot'`.
- [ ] `subscribeWithSnapshot` yields `monitor:shutdown-pending` and `monitor:shutdown-cancelled` as `kind: 'named'` frames.
- [ ] `subscribeWithSnapshot` rejects (iterator throws) with an `AbortError` when the supplied `AbortSignal` fires.
- [ ] `aggregateSessionSummary(sessionId, events, monitorUrl)` returns the same `SessionSummary` shape that the inline aggregation in `subscribeToSession()` produces, for matched event arrays.
- [ ] `subscribeToSession` and `subscribeToDaemonEvents` continue to be exported from `@eforge-build/client` and `@eforge-build/client/browser`.
- [ ] `DAEMON_API_VERSION` is unchanged from its current value (no version bump in this plan).
- [ ] `grep -r "daemon:resync-marker" packages/` still returns hits in `server.ts` and `daemon-sse-resync.test.ts` (plan-02 removes them).