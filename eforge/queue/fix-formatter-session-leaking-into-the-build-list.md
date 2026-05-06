---
title: Fix formatter session leaking into the build list
created: 2026-05-06
---

# Fix formatter session leaking into the build list

## Problem / Motivation

After commit `045c901` (monitor-ui-cleaner-event-consumption-architecture) migrated the monitor UI from SWR polling to a daemon-events SSE stream + reducer, the formatter agent that runs as part of `engine.enqueue()` now leaks into the **build list** as a phantom row labeled `unknown` with stage `Compile` (the formatter's tool span). When the formatter completes, that row stays in the build list as a `Completed` build — a regression, since previously it appeared briefly and then disappeared.

A second symptom on top of that: until the user manually refreshes the page, the *real* PRD build that follows the formatter never shows up live, and clicking other entries appears to do nothing (the UI is locked on the phantom session).

User preference: the formatter is a flow into the queue, so its status should appear in the existing **Enqueuing** section above the queue (already present at `packages/monitor-ui/src/components/layout/sidebar.tsx:209`). It must never appear in the build list.

### Root cause

`packages/monitor-ui/src/lib/daemon-reducer/handle-runs.ts:10-37` — `handleSessionStart` unconditionally creates a fresh `RunInfo` for every `session:start` event with `planSet: ''`, `command: 'build'`, and the session id as both `id` and `sessionId`.

The engine emits two distinct events at the start of an enqueue:
1. `session:start` (wrapping all formatter agent events) → the new handler creates a phantom `RunInfo` keyed by sessionId.
2. `enqueue:start` (carries its own `runId`) → `handleEnqueueStart` creates a *second* `RunInfo` with `command: 'enqueue'` and no `sessionId`.

`groupRunsBySessions` (`packages/monitor-ui/src/lib/session-utils.ts:33-98`) routes them to different buckets because the two `RunInfo`s share no `sessionId`:
- The session:start phantom (has `sessionId`) → session bucket → label `'unknown'`, command `'build'`.
- The enqueue:start row (no `sessionId`) → planSet bucket → label `''` → also `'unknown'`.

`partitionEnqueueSessions` (`session-utils.ts:100-118`) only filters groups where every run has `command === 'enqueue'`. The session-bucket phantom has command `'build'`, so the partition routes it into the build list rather than the Enqueuing section, and it stays there as `Completed` after `session:end`.

The same handler also explains why real PRD builds don't surface live: when the queue scheduler later starts a build session, `handleSessionStart` again creates a `RunInfo` with `planSet: ''`, and nothing on the daemon-events stream (`packages/monitor/src/db.ts:136-152`, `DAEMON_EVENT_TYPES`) carries the actual planSet/title to update it. `phase:start` is the event that does carry that data, but it's session-scoped and never reaches the daemon reducer.

The recorder on the daemon side (`packages/monitor/src/recorder.ts:48-50`) already implements the correct semantics: it **buffers** `session:start` and only creates a runs row when either `phase:start` (real build, line 22-31) or `enqueue:start` (enqueue/formatter, line 58-67) arrives. The UI reducer needs to mirror that.

### Verified during planning

- `phase:start` shape (`packages/client/src/events.ts:278, 285`): base `{ sessionId?, runId?, timestamp }` plus member `{ runId: string, planSet: string, command: 'compile' | 'build' }`. `sessionId` is stamped on every event at runtime by `runSession()` (`packages/engine/src/session.ts:107`), so it is reliably present even though the type marks it optional.
- `phase:end` shape (`events.ts:286`): `{ runId: string, result: EforgeResult }` plus base.
- All `session:start` emit sites enumerated. `runSession()` is called from `enqueue` (emits `enqueue:start`), `compile` (emits `phase:start`), **`recover`** (emits `recovery:start` only), and **`applyRecovery`** (emits `recovery:apply:start` only). Standalone parent emits at `eforge.ts:982`, `eforge.ts:1393`, and `scheduler.ts:350` are all followed by `phase:start`.
- The recorder stamps `sessionId` on the enqueue runs row (`recorder.ts:60`), but the UI's `handleEnqueueStart` does **not** stamp `sessionId` on the live `RunInfo` — a divergence that causes mount-snapshot grouping (by sessionId) to differ from live grouping (by planSet bucket). Fix this here.

## Goal

Stop the formatter session from creating a phantom `unknown` row in the build list, and surface real PRD builds live in the build list with the correct title, while routing formatter activity to the existing Enqueuing section above the queue.

## Approach

Two coordinated changes:

1. **Stop creating phantom `RunInfo`s from `session:start`.** A bare session has no display value yet — let `enqueue:start` (Enqueuing section) or `phase:start` (build list) be the events that surface a row.
2. **Add `phase:start` to the daemon-events stream** with a reducer handler that creates a real `RunInfo` carrying the planSet/title and sessionId. This is what makes live PRD builds appear in the build list with their correct name (currently they only appear after a hard refresh because the snapshot endpoint has the data but no live event populates it).

After this, the flow is:

- `eforge:build` runs → `session:start` (no UI row) → `enqueue:start` (Enqueuing row appears) → formatter agent events (animate the Enqueuing row) → `enqueue:complete` (row drops out per existing partition logic, since `command === 'enqueue'` and `status === 'completed'`) → `session:end` (no-op).
- Queue scheduler picks up the queue file → new session `session:start` (no UI row) → `phase:start` (build row appears in the build list with the correct PRD title and sessionId) → build proceeds normally.

The freeze symptom is resolved as a side effect: there is no longer a phantom `state.runs[0]` for `selectLatestSessionId` (`packages/monitor-ui/src/lib/daemon-reducer.ts:105`) to anchor on, so auto-select and the `userSelectedSessionId` clearing logic in `app.tsx:101-105` see consistent state.

### Changes

#### 1. `packages/monitor-ui/src/lib/daemon-reducer/handle-runs.ts`

`handleSessionStart`: drop the create-new branch. Keep only the "update existing" branch — if a `RunInfo` already exists for this session id (e.g. from the mount-time snapshot), set its status to `running`. If nothing exists, return `undefined` (no state change).

Update the file's leading docblock to reflect that session:start no longer creates rows; rows are created by `enqueue:start` (Enqueuing) or `phase:start` (build list).

`handleSessionEnd`: no functional change. Returning `undefined` when no matching run exists is already correct, which is now the common case for formatter-only sessions (no row was ever created).

#### 2. New handler: `packages/monitor-ui/src/lib/daemon-reducer/handle-phase.ts`

Add `handlePhaseStart` and `handlePhaseEnd`:

- `phase:start` carries (verified): `runId: string`, `planSet: string`, `command: 'compile' | 'build'`, plus base `sessionId` and `timestamp` (sessionId stamped by `runSession()` at runtime). Create a `RunInfo` keyed by `runId` with `id: event.runId, sessionId: event.sessionId, planSet: event.planSet, command: event.command, status: 'running', startedAt: event.timestamp, cwd: ''` (matching the recorder's `db.insertRun` at `recorder.ts:22-31`), prepend to `state.runs`. If a row with the same `id` already exists (snapshot), update status to `running` and fill any missing fields.
- `phase:end` carries (verified): `runId: string`, `result: EforgeResult`, plus base. Locate the row by `runId`, set `status: event.result.status` and `completedAt: event.timestamp`. Mirrors `recorder.ts:117`.

#### 3. `packages/monitor-ui/src/lib/daemon-reducer/index.ts`

- Import `handlePhaseStart` (and `handlePhaseEnd` if added).
- Register `'phase:start'` (and `'phase:end'`) in `daemonHandlerRegistry`.
- Add `'phase:start'` (and `'phase:end'`) to the `DaemonEventSubset` union so the existing `_Exhaustive` compile-time check covers them.

#### 4. `packages/monitor/src/db.ts`

Add `'phase:start'` (and `'phase:end'`) to the `DAEMON_EVENT_TYPES` allowlist at line 136 so they're surfaced via `GET /api/daemon-events`. This is the only change needed on the server — the recorder already records phase events, and the SSE plumbing in `serveDaemonEventsSSE` filters off this list.

#### 5. `packages/monitor-ui/src/lib/daemon-reducer/handle-enqueue.ts`

In `handleEnqueueStart` (`handle-enqueue.ts:22-29`), stamp `sessionId: event.sessionId` on the new `RunInfo`. This event already carries `sessionId` at runtime (the recorder reads it at `recorder.ts:60` to set the DB row's sessionId via the buffered session lookup; it's stamped on every event by `runSession()`). Without this fix, mount-snapshot enqueue runs (which the recorder *did* persist with sessionId) group by sessionId, while live-received enqueue runs go to the planSet bucket — causing inconsistent grouping. With the fix, both paths route through `sessionMap` in `groupRunsBySessions`.

#### 6. `packages/client/src/api/session-stream.ts` (docstring only)

Update the `subscribeToDaemonEvents` docstring (referenced by the comment block in `packages/monitor-ui/src/lib/daemon-reducer/index.ts:80-86`) to mention `phase:start`/`phase:end` are now part of the daemon-wide stream.

### Critical files

- `packages/monitor-ui/src/lib/daemon-reducer/handle-runs.ts` — remove the create-new branch in `handleSessionStart`.
- `packages/monitor-ui/src/lib/daemon-reducer/handle-phase.ts` — **new file**, phase:start/end handlers.
- `packages/monitor-ui/src/lib/daemon-reducer/handle-enqueue.ts` — stamp `sessionId` on the live enqueue `RunInfo`.
- `packages/monitor-ui/src/lib/daemon-reducer/index.ts` — register handlers and extend `DaemonEventSubset`.
- `packages/monitor/src/db.ts:136` — extend `DAEMON_EVENT_TYPES`.
- `packages/client/src/api/session-stream.ts` — docstring update.

## Scope

### In scope

- Removing the create-new branch in `handleSessionStart` and updating its docblock.
- Adding new `handlePhaseStart` and `handlePhaseEnd` handlers in a new `handle-phase.ts` file.
- Registering `phase:start` / `phase:end` in the daemon handler registry and extending the `DaemonEventSubset` union.
- Adding `phase:start` / `phase:end` to `DAEMON_EVENT_TYPES` in `packages/monitor/src/db.ts`.
- Stamping `sessionId` on the live enqueue `RunInfo` in `handleEnqueueStart`.
- Updating the `subscribeToDaemonEvents` docstring in `packages/client/src/api/session-stream.ts`.

### Out of scope

- Surfacing `recover()` and `applyRecovery()` sessions in the UI. These emit only `recovery:start` and `recovery:apply:start` respectively — neither `phase:start` nor `enqueue:start`. With this change they no longer appear in the build list, **matching pre-refactor behavior**: the recorder also never created a DB runs row for them (it only inserts on `phase:start`/`enqueue:start`), so the old SWR-backed `/api/runs` UI didn't show them either. Surfacing recovery sessions is a separate enhancement (would require adding `recovery:start` to `DAEMON_EVENT_TYPES` plus a new handler).

### What does *not* change

- `packages/monitor-ui/src/lib/session-utils.ts` is already correct: `partitionEnqueueSessions` will continue to drop completed enqueue-only groups (they hit neither the `running` branch nor the `failed` branch at lines 107-112), and a future enqueue group with command `'enqueue'` partitions cleanly into the Enqueuing section.
- `packages/monitor-ui/src/components/layout/enqueue-section.tsx` and the sidebar order at `sidebar.tsx:209-214` are already what the user wants — Enqueuing above Queue.
- `packages/monitor-ui/src/lib/daemon-reducer/handle-enqueue.ts` is otherwise unchanged beyond the `sessionId` stamp.

## Acceptance Criteria

1. **Build & restart daemon.** Use the `eforge-daemon-restart` skill (or `pnpm build` + restart) so the daemon picks up the new `DAEMON_EVENT_TYPES` and the UI bundle. Check no active builds first (per the existing safety practice).
2. **Type-check passes.** `pnpm type-check` — confirms the `_Exhaustive` check in `index.ts` still passes after adding `phase:start`/`phase:end` to both the registry and `DaemonEventSubset`.
3. **Tests pass.** `pnpm test` — confirm no daemon-reducer tests broke. If `handle-runs.test.ts` exists and asserts the create-new behavior, update it to assert no-op when no matching run is present.
4. **End-to-end in the browser.**
   - Open the monitor UI before enqueueing.
   - Run `/eforge:build` on a plan.
   - Verify: the formatter status shows under **Enqueuing** (above the queue), labeled with the enqueue title once `enqueue:complete` fires; it disappears when complete; **no `unknown` row ever appears in the build list**.
   - Verify: the real PRD build appears in the build list **live** (without a refresh) with the correct PRD name once `phase:start` fires; clicking it selects it normally.
   - Click between sessions while the build is still running — the UI stays responsive (no freeze).
5. **Refresh sanity.** Hard-refresh the page mid-build; the snapshot already returns the running build. Confirm the live updates continue to flow through the new `phase:start`/`phase:end` handlers without duplicating rows (the existing-row branch in `handlePhaseStart` covers this).
