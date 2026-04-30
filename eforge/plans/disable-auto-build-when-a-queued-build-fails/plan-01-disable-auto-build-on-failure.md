---
id: plan-01-disable-auto-build-on-failure
name: Disable auto-build on first failed queue:prd:complete
branch: disable-auto-build-when-a-queued-build-fails/disable-auto-build-on-failure
---

# Disable auto-build on first failed queue:prd:complete

## Architecture Context

The daemon (`packages/monitor/src/server-main.ts`) runs the queue watcher in-process via `engine.watchQueue()`. The engine intentionally keeps draining its queue on PRD failure — the policy decision to pause auto-build belongs to the consumer (the daemon), not the engine. This mirrors the existing user-toggle path at `packages/monitor/src/server.ts:1064-1075` (and the watcher-init / watcher-crash paths at `server-main.ts:392-394` and `server-main.ts:425-427`) which all flip `daemonState.autoBuild = false`, emit a `daemon:auto-build:paused` event via `writeAutoBuildPausedEvent`, and call `daemonState.onKillWatcher?.()` (which aborts the watcher's `AbortController`).

The gap: the drain loop at `server-main.ts:408-420` discards every event without inspection, so failed `queue:prd:complete` events never trigger a pause. After a failure, the engine's loop at `packages/engine/src/eforge.ts:1860-1862` calls `discoverNewPrds() + startReadyPrds()` and the next PRD is launched, violating the user feedback rule `feedback_dont_retry_builds.md`.

Fix: inspect events in the drain loop. On the first `queue:prd:complete` with `status === 'failed'` for the active watcher session, perform the same three-step shutdown that the user-toggle path performs.

## Implementation

### Overview

1. Replace the silent drain loop in `startWatcher()` (server-main.ts:408-420) with one that inspects each event.
2. When `event.type === 'queue:prd:complete'` and `event.status === 'failed'`, and the loop is still owned by the active controller (`watcherAbort === controller`) and `daemonState.autoBuild` is still true, set `daemonState.autoBuild = false`, write a `daemon:auto-build:paused` event with reason `"Build failed: <prdId>"`, and call `daemonState.onKillWatcher?.()` to abort the controller.
3. After abort, `engine.watchQueue()` stops yielding and the `for await` loop exits naturally (no self-deadlock — `controller.abort()` is fire-and-forget; the generator drains in the same task).
4. Add a unit test next to `test/watch-queue.test.ts` and `test/daemon-watcher-hooks.test.ts` that exercises the drain-loop policy by feeding a synthetic event stream through `wrapWatcherEvents` and asserting the policy effect.
5. Optional/recommended UX nudge: update `packages/monitor-ui/src/hooks/use-auto-build.ts` to re-fetch `/api/auto-build` whenever a `daemon:auto-build:paused` event is observed via the existing session SSE stream, so the toggle flips OFF immediately instead of after a ≤5 s poll cycle.

### Key Decisions

1. **Policy lives in the daemon, not the engine.** Matches the user-toggle path and the existing crash/init-failure paths. The engine remains a pure event source; the daemon owns the auto-build state machine.
2. **Guard with `watcherAbort === controller`.** A superseded watcher (e.g. user toggled off then on quickly) must not pause a fresh one. This mirrors the crash branch at `server-main.ts:424`.
3. **Guard with `daemonState.autoBuild`.** If the user already toggled off, don't double-pause and don't emit a redundant paused event.
4. **Reuse `writeAutoBuildPausedEvent` and `daemonState.onKillWatcher`.** Same helpers used by the existing API toggle and crash paths — no new plumbing.
5. **Kill the eslint-disable.** Renaming `_event` to `event` and inspecting it removes the unused-vars suppression that was added when the loop was a pure drain.
6. **Extract the inspection callback as a small testable helper.** The cleanest way to unit-test the policy without spinning up a real watcher is to factor the per-event policy decision into a function (e.g. `maybePauseOnFailure(event, ctx)`) that the drain loop calls inside `for await`. The helper takes a small context object (current `controller`, current `watcherAbort` ref, `daemonState`, `db`, `sessionId`) and performs steps 1-3 when the conditions match. The test wires this helper to a fake `daemonState` + real `MonitorDB` from `openDatabase` (mirroring `test/daemon-watcher-hooks.test.ts`), feeds a `queue:prd:complete` failed event, and asserts the policy effect. Keeping the helper file-local (un-exported) and exporting only the inspection function for tests is acceptable; alternatively, inline the conditional and have the test reach in via the existing `wrapWatcherEvents` export — the implementer should choose whichever is cleaner with no public-surface-area expansion.
7. **UI nudge keeps the existing 5 s poll as fallback.** If the watcher session is not the one the UI is currently subscribed to (user focused on a specific run), the poll catches up. No new daemon-side plumbing is required because the `daemon:auto-build:paused` event is already written to the watcher session row by the existing crash/init-failure paths.

## Scope

### In Scope

- Modify the drain loop in `packages/monitor/src/server-main.ts` (around lines 408-420) to inspect events and pause auto-build on the first failed `queue:prd:complete` for the active watcher session.
- Emit `daemon:auto-build:paused` event with reason `"Build failed: <prdId>"` via the existing `writeAutoBuildPausedEvent(db, sessionId, reason)` helper.
- Drop the `eslint-disable @typescript-eslint/no-unused-vars` and the `_event` rename.
- Add a unit test (new file `test/auto-build-pause-on-failure.test.ts`, or appended to `test/daemon-watcher-hooks.test.ts` if the implementer prefers grouping by logical unit per `AGENTS.md`) that drives a synthetic event stream and asserts (a) `daemonState.autoBuild === false` after the failure event, (b) a `daemon:auto-build:paused` row exists in the test DB with reason `"Build failed: <prdId>"`, (c) `daemonState.onKillWatcher` is invoked exactly once, (d) a subsequent failed `queue:prd:complete` does not re-fire the pause path (idempotency / guard correctness).
- Update `packages/monitor-ui/src/hooks/use-auto-build.ts` to subscribe to `daemon:auto-build:paused` events on the current session SSE stream and re-fetch `/api/auto-build` when one arrives. Implementation should reuse the existing `useEforgeEvents` machinery rather than opening a new EventSource. The cleanest shape: accept an optional `sessionId` argument in `useAutoBuild()` and let the caller pass `currentSessionId` from `app.tsx`; inside the hook, watch a `paused`-event signal sourced from the same SSE channel (e.g. by reading from `useEforgeEvents` on the same sessionId, or by adding a thin `usePausedEventTrigger(sessionId)` helper). Poll-only fallback is acceptable when no sessionId is selected.

### Out of Scope

- Changes to `packages/engine/src/eforge.ts`. The engine intentionally keeps draining its queue; pausing is a daemon-layer policy decision.
- Changes to `eforge.yaml` / `eforge/config.yaml`. The `prdQueue.autoBuild` config is a daemon-startup default; runtime pause is in-memory only, matching the existing crash/init-failure shape.
- New SSE channels or daemon-side push for auto-build state. The `daemon:auto-build:paused` event already flows through the watcher session's SSE stream — the UI hook simply needs to listen for it.
- Changes to the `EforgeEvent` union or any new event types. `daemon:auto-build:paused` is already written into the event log via `writeAutoBuildPausedEvent` (string-typed; not part of the engine `EforgeEvent` union, by design — it's a daemon-emitted record).
- Killing in-flight PRD subprocesses on pause. Existing comment at `server-main.ts:354-356` is explicit: in-flight builds are not killed when the watcher stops; they complete or are reconciled at next daemon startup. We preserve this.

## Files

### Create

- `test/auto-build-pause-on-failure.test.ts` — unit test for the new policy. Mirrors the style of `test/daemon-watcher-hooks.test.ts`: open a real `MonitorDB` via `openDatabase()` against a tmpdir, build a fake `daemonState` object matching the `DaemonState` shape, feed a synthetic `AsyncGenerator<EforgeEvent>` through the drain-loop logic, and assert (a) `daemonState.autoBuild === false`, (b) `db.getEventsByType(sessionId, 'daemon:auto-build:paused')` returns a row whose parsed `data.reason` matches `"Build failed: <prdId>"`, (c) `onKillWatcher` was called exactly once. (Implementer may instead append cases to `test/daemon-watcher-hooks.test.ts` to keep tests grouped by logical unit per `AGENTS.md` — either location is acceptable.)

### Modify

- `packages/monitor/src/server-main.ts` — replace the silent drain loop at lines 408-420 with an inspection loop that pauses auto-build on the first failed `queue:prd:complete` for the active controller. Reuse `writeAutoBuildPausedEvent` (already in scope at line 181) and `daemonState.onKillWatcher` (already wired at line 368). Drop the `eslint-disable` and `_event` rename. Guards: `daemonState.autoBuild === true` and `watcherAbort === controller` must both hold before pausing. Confirm the `for await` loop exits cleanly after `controller.abort()` (it does — `engine.watchQueue` listens to the abort signal and yields a final `queue:complete`, then ends).
- `packages/monitor-ui/src/hooks/use-auto-build.ts` — accept an optional `sessionId: string | null` parameter; subscribe to `daemon:auto-build:paused` events on that session via the existing SSE infrastructure (either by reading from `useEforgeEvents` or by composing a small `usePausedEventTrigger` hook); re-fetch `/api/auto-build` and update local state when a paused event arrives. Keep the 5 s polling interval as fallback for the no-sessionId case. Update `packages/monitor-ui/src/app.tsx` to pass `currentSessionId` into `useAutoBuild(currentSessionId)`. Verify no other call sites of `useAutoBuild` exist (`grep` confirms only `app.tsx` uses it).

## Verification

- [ ] `pnpm type-check` exits 0.
- [ ] `pnpm test` exits 0, including the new `test/auto-build-pause-on-failure.test.ts` (or the new cases appended to `test/daemon-watcher-hooks.test.ts`).
- [ ] Unit test asserts that after feeding a `queue:prd:complete` event with `status: 'failed'` and `prdId: 'sample-prd'` through the drain-loop policy, `daemonState.autoBuild === false`.
- [ ] Unit test asserts that `db.getEventsByType(sessionId, 'daemon:auto-build:paused')` returns at least one row whose parsed `data.reason` equals `"Build failed: sample-prd"`.
- [ ] Unit test asserts that `daemonState.onKillWatcher` is invoked exactly once when a single failure event is processed.
- [ ] Unit test asserts that a second failed `queue:prd:complete` event arriving after the first does not invoke `onKillWatcher` a second time and does not write a second `daemon:auto-build:paused` row (the `daemonState.autoBuild === true` guard short-circuits).
- [ ] Unit test asserts that a `queue:prd:complete` event with `status: 'completed'` does not trigger the pause path.
- [ ] `grep` confirms the `eslint-disable @typescript-eslint/no-unused-vars` previously at `server-main.ts:419` has been removed.
- [ ] `grep` confirms the `_event` rename has been replaced with `event` in the drain loop.
- [ ] `grep` confirms `useAutoBuild` is invoked from `packages/monitor-ui/src/app.tsx` with a sessionId argument (e.g. `useAutoBuild(currentSessionId)`).
- [ ] Reading `packages/monitor-ui/src/hooks/use-auto-build.ts` shows it subscribes to `daemon:auto-build:paused` SSE events on the provided sessionId and re-fetches `/api/auto-build` on receipt; the 5 s polling interval is preserved as fallback.
