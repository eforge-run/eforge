---
id: plan-04-daemon-events-server
name: Daemon-events SSE endpoint and client primitive
branch: monitor-ui-cleaner-event-consumption-architecture/daemon-events-server
agents:
  builder:
    effort: high
    rationale: Adds a new HTTP route, generalizes the SSE client primitive, and
      migrates external CLI/Pi consumers off the deleted /api/latest-run
      endpoint. Cross-package coordination needs care.
  reviewer:
    effort: high
    rationale: API surface change with external (CLI + Pi) consumers; reviewer
      should validate every consumer is updated and reconnect/Last-Event-ID
      semantics are preserved.
---

---
id: plan-04-daemon-events-server
name: Daemon-events SSE endpoint and client primitive
depends_on: [plan-03-delete-invalidate-on-event]
branch: monitor-ui-cleaner-event-consumption-architecture/daemon-events-server
---

# Daemon-events SSE endpoint and client primitive

## Architecture Context

The PRD's Step 4 introduces a new daemon-wide SSE endpoint `GET /api/daemon-events` that streams cross-session events: `daemon:auto-build:paused`, `queue:*`, `enqueue:*`, plus a thin session lifecycle stream (`session:start`, `session:end`). The existing per-session endpoint `/api/events/:sessionId` (`packages/monitor/src/server.ts:295-327` `serveSSE`) stays unchanged and remains the high-volume per-session stream.

This plan implements the daemon-side route, the shared client primitive, and migrates the two external (non-monitor-UI) consumers of `/api/latest-run` (`packages/eforge/src/cli/mcp-proxy.ts` and `packages/pi-eforge/extensions/eforge/index.ts`) to read the latest run from `GET /api/runs[0]` so the `/api/latest-run` endpoint can be deleted in plan-05 without breaking those consumers. The endpoint itself is *not* deleted in this plan — it must remain live until plan-05 ships the UI consumer that no longer needs it.

The PRD requires that `subscribeToSession`'s reconnect / Last-Event-ID behaviour is unchanged and is reused by both `useEforgeEvents` and the new `useDaemonEvents` ("one new endpoint name, same client primitive"). This means the existing logic in `packages/client/src/session-stream.ts` must be generalised: the URL builder (lines 379, 472, both hard-coded to `/api/events/{sessionId}`) and the error messages (lines 358, 391, 487 referencing `sessionId`) need to be parameterised by stream identity (per-session vs daemon-wide). The simplest refactor: extract a `subscribeToStream({ url, ... })` core that both `subscribeToSession(sessionId, opts)` and `subscribeToDaemonEvents(opts)` wrap.

### Daemon-events stream contents

The poll-based push pattern in `serveSSE` (lines 337-356) iterates a single `subscribers` set keyed by sessionId and replays events from SQLite. For daemon-events, the natural source is the same DB table filtered by *event type* rather than session_id. The simplest implementation is a parallel subscriber set + poll loop that selects events from the DB whose `type` matches the daemon-wide allowlist (`daemon:auto-build:paused`, `queue:*`, `enqueue:*`, `session:start`, `session:end`), tracking the highest event id seen per subscriber.

Add a new DB query method `getDaemonEventsAfter(eventTypes: string[], afterId: number)` in `packages/monitor/src/db.ts` that returns events of the given types with `id > afterId`. The route reuses the same `hydrateEventData` and SSE wire format as `serveSSE`.

### `daemon:auto-build:paused` already lives on the wire

`packages/monitor/src/server-main.ts:181-192` (`writeAutoBuildPausedEvent`) already inserts the event into the events table tied to the watcher session id. No changes needed on the emit side; the new daemon-events stream simply selects it by type.

## Implementation

### Overview

1. **Daemon route.** In `packages/monitor/src/server.ts`:
   - Add a `daemonSubscribers: Set<{ res: ServerResponse; lastSeenId: number }>` set alongside the existing per-session `subscribers` set.
   - Add `serveDaemonEventsSSE(req, res)` that mirrors `serveSSE`'s shape: write SSE headers, replay historical daemon-wide events (filtered by type) with `id > lastEventId` from the `last-event-id` header, register a new subscriber, and clean up on `req.on('close')`.
   - In the existing 200 ms `pollTimer` (lines 337-356), add a second loop that polls the DB for new daemon-wide events (types: `daemon:auto-build:paused`, `queue:start`, `queue:prd:start`, `queue:prd:discovered`, `queue:prd:stale`, `queue:prd:skip`, `queue:prd:commit-failed`, `queue:prd:complete`, `queue:complete`, `enqueue:start`, `enqueue:complete`, `enqueue:failed`, `enqueue:commit-failed`, `session:start`, `session:end`) and pushes them to each daemon subscriber.
   - Add a route arm `else if (url === API_ROUTES.daemonEvents) { serveDaemonEventsSSE(req, res); }` near the existing `/api/events/:runId` arm.
   - Update `subscriberCount` getter to return `subscribers.size + daemonSubscribers.size`.
   - Update `stop()` to also close all `daemonSubscribers`.
2. **DB query.** In `packages/monitor/src/db.ts`, add a prepared statement `getDaemonEventsAfter` that selects events from the events table whose `type` matches a parameterised set (use SQLite's `IN (...)` with bound parameters; or inline the type list as a constant in `db.ts` since it is small and stable). Expose it on the `MonitorDB` interface.
3. **Client route + types.** In `packages/client/src/routes.ts`, add `daemonEvents: '/api/daemon-events'` to `API_ROUTES`. Bump `DAEMON_API_VERSION` in `packages/client/src/api-version.ts` (the new route is additive and non-breaking, but version bumps document API surface changes).
4. **Client primitive.** In `packages/client/src/session-stream.ts`:
   - Extract the existing reconnect/Last-Event-ID/abort/aggregation logic into a private `subscribeToStream({ url, opts, ... })` function. Both Node and browser transport paths reference the URL twice (lines 379, 472) — replace the hard-coded `/api/events/{sessionId}` with the `url` parameter.
   - Refactor `subscribeToSession(sessionId, opts)` to compute `url = \`${baseUrl}/api/events/${encodeURIComponent(sessionId)}\`` and delegate to `subscribeToStream`.
   - Add `subscribeToDaemonEvents(opts: SubscribeOptions<DaemonStreamEvent>): Promise<void>` that computes `url = \`${baseUrl}${API_ROUTES.daemonEvents}\`` and delegates to the same core. The daemon-events stream has no session lifecycle, so it does not return a `SessionSummary` — return `Promise<void>` resolving when the subscription is cleanly terminated.
   - Export `subscribeToDaemonEvents` from `packages/client/src/index.ts` and `packages/client/src/browser.ts`.
   - Update the error messages and JSDoc to reference "stream" generically rather than "session" where appropriate (only for the new core; preserve `subscribeToSession`'s existing user-facing error strings to keep behaviour identical for that wrapper).
5. **Migrate /api/latest-run external consumers.** The PRD says `/api/latest-run` is deleted in plan-05; in this plan we move external consumers off it so plan-05 can delete the endpoint cleanly.
   - In `packages/eforge/src/cli/mcp-proxy.ts` (3 call sites at lines 86, 355, 485), replace `daemonRequest<LatestRunResponse>('GET', API_ROUTES.latestRun)` with `daemonRequest<RunInfo[]>('GET', API_ROUTES.runs)` and read `latestRun = runs[0]` (with `?? null` fallback). The shape change: `RunInfo[]` (from `apiGetRuns`) sorted by `started_at DESC` per `db.ts:171-173`, so `[0]` is the latest. Map the existing `LatestRunResponse.sessionId` consumer to `runs[0]?.sessionId ?? null` and `runId` consumer to `runs[0]?.id ?? null`. Keep the existing zero-result short-circuit ("No active eforge sessions.") intact.
   - Add a small helper `apiGetLatestRunFromRuns(opts)` in `packages/client/src/api/queue.ts` that does `apiGetRuns(opts).then(({ data }) => data[0] ?? null)` — gives mcp-proxy and pi-eforge a single typed entry point so the `[0]` convention isn't duplicated.
   - In `packages/pi-eforge/extensions/eforge/index.ts` (3 call sites at lines 99, 220, 489), apply the same migration via the new helper.
   - Update `test/profile-wiring.test.ts:603-609` (`it('fetches latest run status from /api/latest-run for ambient status')`) to assert the new code path: `expect(refreshBlock).toContain('API_ROUTES.runs')` (the helper resolves to `apiGetRuns`).
6. **Tests.**
   - Add a new test file `test/daemon-events-stream.test.ts` covering: (a) the DB `getDaemonEventsAfter` query returns events of the configured types in id order, (b) historical replay on initial connect respects `last-event-id`, (c) the poll loop pushes new daemon-wide events to every subscriber.
   - Add a unit test for `subscribeToDaemonEvents`: stub `fetch` to return one SSE chunk, assert `onEvent` is called with the parsed event.
   - Update `test/profile-wiring.test.ts` for the latest-run -> runs migration.
   - Existing `test/auto-build-pause-on-failure.test.ts` is unaffected (`maybePauseOnFailure` still writes to `db.insertEvent`; the route consumes from the same DB).

### Key Decisions

1. **Reuse the existing 200 ms poll loop, not a new ticker.** Adding a second poll on a different interval would double the DB load. The existing loop already iterates DB-backed event delivery; extending it with a second query (filtered by daemon-wide types) keeps the cost bounded.
2. **Event-type allowlist hardcoded in `db.ts`.** Keeps the daemon source of truth for what counts as "daemon-wide" co-located with the query that surfaces it. Adding a new daemon-wide event type in the future requires updating the constant — a deliberate gate that prevents per-session events from leaking into the daemon stream.
3. **`subscribeToStream` is internal; only wrappers are exported.** The two wrappers carry the type information (`SessionSummary` vs `void`, `sessionId`-aware error messages vs not), so callers should never construct a raw URL themselves — only pick the right wrapper.
4. **`apiGetLatestRunFromRuns` helper.** The two external consumers (mcp-proxy + pi-eforge) shouldn't both encode the `runs[0]` convention. A shared helper keeps the abstraction in `@eforge-build/client`. The legacy `apiGetLatestRun` / `apiGetLatestRunIfRunning` helpers stay until plan-05 deletes the underlying endpoint.
5. **`/api/latest-run` route is NOT deleted in this plan.** Deletion happens in plan-05 once the UI consumer (the `latestRun` SWR poll) is replaced. Until then, the endpoint must remain functional for backward compatibility within the same release window.

## Scope

### In Scope
- New SSE route `GET /api/daemon-events` in the daemon, with replay + poll-based push for the configured event-type allowlist.
- New DB query method `getDaemonEventsAfter` in `packages/monitor/src/db.ts`.
- Generalised `subscribeToStream` core in `packages/client/src/session-stream.ts`; new `subscribeToDaemonEvents` wrapper.
- New route constant `API_ROUTES.daemonEvents` and `DAEMON_API_VERSION` bump.
- Migrate `mcp-proxy.ts` and `pi-eforge/extensions/eforge/index.ts` off `API_ROUTES.latestRun` to `API_ROUTES.runs[0]` via a new `apiGetLatestRunFromRuns` helper.
- Update `test/profile-wiring.test.ts` for the new code path.
- New tests: daemon-events stream + subscribe primitive.

### Out of Scope
- The `useDaemonEvents` UI hook (plan-05).
- Deleting `/api/latest-run` (plan-05).
- Deleting `apiGetLatestRun` / `apiGetLatestRunIfRunning` from `@eforge-build/client` (plan-05).
- UI consumer changes in `app.tsx` / `sidebar.tsx` / `queue-section.tsx` (plan-05).
- The `swr-fetcher.test.ts` `latestRun` reference (plan-05).

## Files

### Create
- `test/daemon-events-stream.test.ts` — new vitest covering DB query + route behaviour.
- `packages/client/src/__tests__/subscribe-to-daemon-events.test.ts` — unit test for the new wrapper.

### Modify
- `packages/monitor/src/server.ts` — add `daemonSubscribers` set, `serveDaemonEventsSSE`, route arm, extend `pollTimer` to push daemon-wide events, update `subscriberCount` and `stop()`.
- `packages/monitor/src/db.ts` — add `getDaemonEventsAfter(afterId)` prepared statement and method (event-type allowlist hardcoded as a constant).
- `packages/client/src/routes.ts` — add `daemonEvents: '/api/daemon-events'` to `API_ROUTES`.
- `packages/client/src/api-version.ts` — bump `DAEMON_API_VERSION`.
- `packages/client/src/session-stream.ts` — extract `subscribeToStream` core; refactor `subscribeToSession` to wrap it; add `subscribeToDaemonEvents` wrapper.
- `packages/client/src/index.ts` — export `subscribeToDaemonEvents`.
- `packages/client/src/browser.ts` — export `subscribeToDaemonEvents`.
- `packages/client/src/api/queue.ts` — add `apiGetLatestRunFromRuns(opts)` helper.
- `packages/eforge/src/cli/mcp-proxy.ts` — replace 3 `API_ROUTES.latestRun` call sites (lines 86, 355, 485) with `apiGetLatestRunFromRuns` (or `apiGetRuns` + `[0]` if the helper is preferred not to be used there).
- `packages/pi-eforge/extensions/eforge/index.ts` — replace 3 `API_ROUTES.latestRun` call sites (lines 99, 220, 489) with `apiGetLatestRunFromRuns`.
- `test/profile-wiring.test.ts` — update the `it('fetches latest run status from /api/latest-run for ambient status')` assertion at line 603-609 to check for `API_ROUTES.runs` (or the helper name `apiGetLatestRunFromRuns`).

## Verification

- [ ] `pnpm type-check` and `pnpm test` pass.
- [ ] `curl -N http://127.0.0.1:<port>/api/daemon-events` (against a running daemon) opens an SSE connection and replays historical daemon-wide events, then receives new ones in near-real-time when a `daemon:auto-build:paused` is written.
- [ ] `grep -rn 'API_ROUTES.latestRun' packages/eforge packages/pi-eforge` returns zero matches.
- [ ] `subscribeToSession` still resolves with `SessionSummary` on `session:end` (existing tests in `packages/client/src/__tests__/session-stream.test.ts` if present, or behavioural test, must pass).
- [ ] `subscribeToDaemonEvents` calls `onEvent` with each parsed daemon-wide event, honours `Last-Event-ID` on reconnect, and respects `signal.abort()`.
- [ ] `subscribers.size` and `daemonSubscribers.size` are reported separately by `subscriberCount` (sum) — verify the daemon's idle-shutdown logic still treats both as activity.
- [ ] `/api/latest-run` continues to return its existing JSON shape; mcp-proxy and pi-eforge no longer call it but the route remains functional.
