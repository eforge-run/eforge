---
id: plan-01-types-and-daemon-emission
name: Daemon event types + monitor emission + heartbeat transport
branch: daemon-activity-events-monitor-ui-status-surface/types-and-daemon-emission
agents:
  builder:
    effort: xhigh
    rationale: "Multi-file change spanning client wire types, monitor persistence,
      monitor transport (SSE bypass timer), and emission across many call sites
      in server-main.ts including a structural refactor of
      reconcileOrphanedState. SSE replay invariant for the heartbeat (id: 0 / no
      id) is a subtle correctness concern."
  reviewer:
    effort: high
    rationale: SSE replay correctness, daemon session id/FK-off invariant, and
      recovery emission ordering are non-trivial.
---

# Daemon event types + monitor emission + heartbeat transport

## Architecture Context

This is the foundation plan. It establishes the wire-level vocabulary, the persistence allowlist, the heartbeat transport mechanic, and emission of all daemon-scoped events that originate inside the monitor process. Downstream plans (scheduler emission in plan-02, monitor UI in plan-03) consume these types but cannot ship until they exist.

The project follows "engine emits, consumers render" (AGENTS.md). The daemon is one consumer of engine events; here we extend that pattern with a parallel daemon-emission lane: events the daemon itself originates (lifecycle, recovery, orphan reaping, auto-build extensions, errors) and a live-only heartbeat that bypasses the DB poll loop because it is stateless and historically uninteresting.

Key verified facts about the existing code:

- `packages/client/src/events.ts` defines `EforgeEvent` as a **pure TypeScript** discriminated union (NOT Zod, contrary to the PRD wording). The union begins at line 278 and currently has exactly one daemon variant: `daemon:auto-build:paused` at line 449.
- `packages/monitor/src/db.ts:136-152` defines `DAEMON_EVENT_TYPES`, the allowlist consulted by `getDaemonEventsAfter` (line 229-231). The DB has `PRAGMA foreign_keys = OFF` (line 170) with an explicit comment that daemon-level events use a watcher sessionId without a matching `runs` row.
- `packages/monitor/src/server.ts:322-358` contains `serveDaemonEventsSSE`. Subscribers are tracked in `daemonSubscribers: Set<DaemonSSESubscriber>` at line 186. The poll loop at lines 369-402 reads from the DB every 200ms and emits any new persisted rows.
- `packages/monitor/src/server-main.ts:181-191` defines `writeAutoBuildPausedEvent`, the existing pattern this plan generalises into `writeDaemonEvent`.
- `reconcileOrphanedState` (server-main.ts:124-179) currently emits a synthetic `phase:end` inline for each dead-PID run. This plan refactors it to return a structured report and moves emission to the caller.
- `registerPort` is called at server-main.ts:541; lockfile write is around line 535-546; orphan watcher is the 5s `setInterval` at lines 567-579; auto-build pause logic is at lines 216-226.

## Implementation

### Overview

Add 17 new daemon-scoped event types to the `EforgeEvent` discriminated union, extend the persistence allowlist for all of them except `daemon:heartbeat`, generalise the existing `writeAutoBuildPausedEvent` helper into `writeDaemonEvent`, install a server-instance-level 10s heartbeat timer that pushes directly to active SSE subscribers (bypassing the DB), and wire emissions at lifecycle/recovery/orphan/auto-build/error call sites in `server-main.ts`.

### Key Decisions

1. **Pure-TS event variants.** `events.ts` is not Zod-based, so each new variant is a literal `type` plus inline payload fields, mirroring existing variants like `daemon:auto-build:paused`. No Zod schemas to add.
2. **Heartbeat bypasses the DB poll loop.** A single `setInterval(10_000)` per server instance writes `data: ...\n\n` directly to each entry in `daemonSubscribers`. SSE `id:` field is omitted (or `id: 0`) so the existing `last-event-id` parser (which uses `parseInt` and filters ids <=0) skips heartbeats on replay. DB-issued ids are always >=1 so there is no collision risk. The interval is `.unref()`'d, cleared on shutdown, and its body is a no-op when `daemonSubscribers.size === 0`.
3. **`reconcileOrphanedState` returns a structured report.** Refactor to `(db, lockDir) => { runsFailed: Array<{ runId, sessionId, planSet, reason }>, locksRemoved: Array<{ path, pid }>, durationMs }`. The caller in `main()` emits `daemon:recovery:start`, then per-item events, then `daemon:recovery:complete` with counts and duration. **Preserve the existing synthetic `phase:end` emission** for backward compatibility; emit it from the caller alongside the new `daemon:recovery:run-marked-failed` event (per Risk 11 in the PRD).
4. **Daemon session id at `main()` entry.** `const daemonSessionId = \`daemon-${process.pid}-${Date.now()}\`` — used as `sessionId` for every daemon-scoped event so they aggregate cleanly. FK is OFF in the DB so unmatched run_id is safe.
5. **One heartbeat timer per server instance, not per subscriber.** Iterating the live `daemonSubscribers` set on each tick avoids leaked timers on subscriber churn.

### Event variants to add to `EforgeEvent` in `packages/client/src/events.ts`

All variants extend the base `{ sessionId?: string; runId?: string; timestamp: string }` already provided by the union root. Inline payload fields (no `details` wrapper):

- `daemon:lifecycle:starting` — `{ pid: number; port: number; version: string; mode: string }`
- `daemon:lifecycle:ready` — `{ pid: number; port: number; version: string; mode: string; recoveryDurationMs: number }`
- `daemon:lifecycle:shutdown:start` — `{ signal: string; reason: string }`
- `daemon:lifecycle:shutdown:complete` — `{ durationMs: number }`
- `daemon:heartbeat` — `{ uptime: number; queueDepth: number; runningBuilds: number; autoBuild: { enabled: boolean; paused: boolean }; subscribers: number }` — **JSDoc must read: `LIVE-ONLY: never persisted, never replayed`**
- `daemon:scheduler:dequeued` — `{ prdId: string; queueDepth: number; capacityRemaining: number }`
- `daemon:scheduler:capacity-blocked` — `{ queueDepth: number; runningCount: number; limit: number }`
- `daemon:scheduler:dependency-blocked` — `{ prdId: string; blockedBy: string[] }`
- `daemon:auto-build:enabled` — `{}` (no payload required)
- `daemon:auto-build:resumed` — `{}` (no payload required)
- `daemon:auto-build:triggered` — `{ trigger: 'file' | 'git' | string; prdsEnqueued: number }`
- `daemon:recovery:start` — `{}` (no payload required)
- `daemon:recovery:run-marked-failed` — `{ runId: string; planSet: string; reason: string }`
- `daemon:recovery:lock-removed` — `{ path: string; pid: number }`
- `daemon:recovery:complete` — `{ runsFailed: number; locksRemoved: number; durationMs: number }`
- `daemon:orphan:reaped` — `{ runId: string; sessionId: string; planSet: string; pid: number }`
- `daemon:warning` — `{ source: string; message: string; details?: string }`
- `daemon:error` — `{ source: string; message: string; stack?: string }`

The pre-existing `daemon:auto-build:paused` variant is kept as-is.

## Scope

### In Scope

- All 17 new daemon-scoped event variants added to `packages/client/src/events.ts`.
- All persisted variants (everything except `daemon:heartbeat`) added to `DAEMON_EVENT_TYPES` in `packages/monitor/src/db.ts`. `daemon:heartbeat` explicitly excluded with a comment.
- `writeDaemonEvent(db, event)` helper in `server-main.ts` modeled on `writeAutoBuildPausedEvent`.
- `daemonSessionId` generated at `main()` entry and reused for all daemon-scoped emissions.
- Lifecycle emissions: `:starting` before lockfile write (~535), `:ready` after `registerPort` (~541) including `recoveryDurationMs`, `:shutdown:start` at top of shutdown handler (~660), `:shutdown:complete` immediately before `process.exit(0)` (~676).
- Recovery refactor: `reconcileOrphanedState` returns the structured report described above; the caller in `main()` emits `daemon:recovery:start`, per-item `:run-marked-failed` and `:lock-removed`, then `:recovery:complete`. The existing `phase:end` synthetic emission per failed run is preserved (now emitted by the caller).
- Orphan watcher: `daemon:orphan:reaped` emitted from inside the 5s `setInterval` (~567-579) only when a run is actually marked killed.
- Auto-build extensions: `:enabled` and `:resumed` emitted from the auto-build toggle HTTP handler (search server.ts/server-main.ts for the auto-build PUT endpoint), `:triggered` emitted when a watcher event drain (~407-493) yields `prdsEnqueued > 0`.
- Error events: `daemon:warning` and `daemon:error` emitted from watcher catch blocks where errors are currently swallowed or only logged.
- Heartbeat transport: one `setInterval(10_000)` per server instance inside or alongside `serveDaemonEventsSSE`, `.unref()`'d, cleared on server shutdown, body is a no-op when `daemonSubscribers.size === 0`. Writes `data: ${JSON.stringify(envelope)}\n\n` (omitting the `id:` field, or using `id: 0`) directly to each subscriber. Payload assembled from `Date.now() - serverStartedAt`, DB queries for queue depth and running runs, and the in-memory `daemonState`.
- JSDoc on `daemon:heartbeat` Zod-equivalent variant: `LIVE-ONLY: never persisted, never replayed`.
- JSDoc on the heartbeat timer in `server.ts` explaining why it bypasses the DB poll loop.
- JSDoc on the refactored `reconcileOrphanedState` clarifying the return-a-report contract.
- Comment near `DAEMON_EVENT_TYPES` in `db.ts` noting `daemon:heartbeat` is intentionally absent.
- Tests covering: new event variants in any existing wire-shape coverage; `getDaemonEventsAfter` includes all new persisted types and excludes `daemon:heartbeat`; `reconcileOrphanedState` returns the expected structured report against a synthetic SQLite DB and a temp lock dir; the caller emits the documented sequence and counts.

### Out of Scope

- Engine scheduler emission (handled in plan-02).
- Monitor UI reducer extensions, status pill, and drawer (handled in plan-03).
- New CLI surface, retention loop, scheduler tick events, log-file tailing — explicitly excluded by the PRD.
- `DAEMON_API_VERSION` bump in `packages/client/src/api-version.ts` — additive event types are not a breaking change to the HTTP API surface.

## Files

### Create

- `packages/monitor/src/__tests__/recovery-emit.test.ts` — vitest coverage for the refactored `reconcileOrphanedState` and the caller's emission sequence. Uses an in-memory or tmp SQLite DB built via the existing `db.ts` infra and a `mkdtempSync` for the lock dir. No mocks; constructs synthetic input rows directly.

### Modify

- `packages/client/src/events.ts` — extend the `EforgeEvent` union (after line 449) with the 17 new variants listed above. Add JSDoc on `daemon:heartbeat` as specified.
- `packages/monitor/src/db.ts` — extend `DAEMON_EVENT_TYPES` (lines 136-152) with all new persisted variants, leaving `daemon:heartbeat` explicitly absent with a comment explaining why.
- `packages/monitor/src/server.ts` — add the heartbeat `setInterval` near or inside `serveDaemonEventsSSE` (lines 322-402). Track the timer at server-instance scope; clear it when the server shuts down. Add JSDoc explaining the DB-bypass.
- `packages/monitor/src/server-main.ts`:
  - Add `writeDaemonEvent(db, event)` helper near the existing `writeAutoBuildPausedEvent` (lines 181-191).
  - Generate `daemonSessionId` at the top of `main()`. Stash it for reuse.
  - Refactor `reconcileOrphanedState` (lines 124-179) to return the structured report; remove the inline `phase:end` emission.
  - In `main()`, emit `daemon:recovery:start`, iterate the report and emit `:run-marked-failed` (alongside the preserved `phase:end` synthetic) and `:lock-removed`, then emit `:recovery:complete` with counts and duration.
  - Emit `daemon:lifecycle:starting` before the lockfile write (~535) and `daemon:lifecycle:ready` after `registerPort` (~541) with `recoveryDurationMs`.
  - Emit `daemon:lifecycle:shutdown:start` at the top of the shutdown handler (~660) and `daemon:lifecycle:shutdown:complete` immediately before `process.exit(0)` (~676).
  - Emit `daemon:orphan:reaped` from inside the orphan watcher 5s `setInterval` (~567-579) only when a run is actually marked killed.
  - Emit `daemon:auto-build:enabled` and `daemon:auto-build:resumed` from the auto-build toggle HTTP handler. Emit `daemon:auto-build:triggered` when the watcher drain yields `prdsEnqueued > 0`.
  - Emit `daemon:warning`/`daemon:error` from watcher catch blocks where errors are currently silent or log-only.
- `packages/monitor/src/__tests__/db.test.ts` (extend if it exists, otherwise create) — assert `getDaemonEventsAfter` includes the new persisted types and excludes `daemon:heartbeat`. Build the DB via the existing `openDatabase` infra.

## Verification

- [ ] `packages/client/src/events.ts` exports an `EforgeEvent` union containing all 17 new variants with the exact `type` literals listed above and inline payload fields matching the contracts above; `daemon:heartbeat` carries a JSDoc comment containing `LIVE-ONLY: never persisted, never replayed`.
- [ ] `pnpm type-check` passes after the events.ts change with no `any` introduced for the new variants.
- [ ] `DAEMON_EVENT_TYPES` in `packages/monitor/src/db.ts` contains every new persisted variant; `daemon:heartbeat` is absent and a comment explains why.
- [ ] `getDaemonEventsAfter(0)` against a DB seeded with one row of every persisted type returns all of them; the same DB seeded with a synthetic `daemon:heartbeat` row returns no heartbeat row (the allowlist filters it out).
- [ ] Starting the daemon and running `curl -N http://localhost:PORT/api/daemon-events` produces `daemon:lifecycle:starting` followed by `daemon:lifecycle:ready` with `pid`, `port`, `version`, `mode`, and a numeric `recoveryDurationMs`.
- [ ] Sending `SIGTERM` to a running daemon produces `daemon:lifecycle:shutdown:start` (with `signal="SIGTERM"` and a `reason`) followed by `daemon:lifecycle:shutdown:complete` (with a numeric `durationMs`) before the process exits.
- [ ] After a daemon restart with at least one orphan run and at least one stale lock file present in the lock dir, the SSE stream emits `daemon:recovery:start`, exactly N `daemon:recovery:run-marked-failed` events (one per orphan run) **and** the existing synthetic `phase:end` per failed run, exactly M `daemon:recovery:lock-removed` events, then `daemon:recovery:complete` with `runsFailed=N`, `locksRemoved=M`, and a numeric `durationMs`.
- [ ] When the orphan watcher's 5s tick marks a run as killed, exactly one `daemon:orphan:reaped` event is emitted with `runId`, `sessionId`, `planSet`, and `pid` populated. Ticks that mark zero runs emit zero orphan events.
- [ ] Toggling auto-build on via the HTTP endpoint emits `daemon:auto-build:enabled`. After a paused state, a successful resume toggle emits `daemon:auto-build:resumed`. A watcher drain that produces `prdsEnqueued >= 1` emits `daemon:auto-build:triggered` with the matching `prdsEnqueued` count.
- [ ] An error caught in the auto-build watcher catch block emits `daemon:error` with `source`, `message`, and (when available) `stack` populated, instead of being silently swallowed.
- [ ] While at least one daemon-events SSE subscriber is connected, the server pushes `daemon:heartbeat` envelopes with `uptime`, `queueDepth`, `runningBuilds`, `autoBuild`, and `subscribers` populated approximately every 10 seconds (verified via `curl -N` and a stopwatch); the cadence does not double when a second subscriber connects.
- [ ] An SSE client that disconnects, then reconnects with a `last-event-id` matching the most recent persisted DB row, replays all persisted events newer than that id and replays zero `daemon:heartbeat` events.
- [ ] When `daemonSubscribers.size === 0`, the heartbeat interval body executes no DB queries (verified by adding a temporary counter or by inspection — must be a no-op fast path).
- [ ] On daemon shutdown, the heartbeat `setInterval` is cleared (no leaked interval handles, verified via `process._getActiveHandles()` in a test or an explicit cleanup assertion).
- [ ] `reconcileOrphanedState` returns `{ runsFailed: Array<{ runId, sessionId, planSet, reason }>, locksRemoved: Array<{ path, pid }>, durationMs: number }` and emits no events itself (events are emitted by the caller).
- [ ] The `recovery-emit.test.ts` test asserts the structured-report shape and (separately) the caller's emission sequence and counts.
- [ ] All daemon-scoped events carry `sessionId === \`daemon-${pid}-${startedAt}\`` (the daemon session id), allowing them to be filtered as a group.
- [ ] `pnpm type-check`, `pnpm test`, and `pnpm build` all pass.
