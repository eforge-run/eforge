---
id: plan-01-daemon-run-state-events
name: Daemon run-state events for monitor live/snapshot parity
branch: fix-monitor-live-updates-so-enqueue-sessions-appear-under-enqueuing-queued-prds-appear-without-refresh-and-newly-running-builds-appear-automatically-after-enqueue-completes/plan-01-daemon-run-state-events
agents:
  builder:
    effort: high
    rationale: Cross-package wire contract change (new daemon-scoped event type,
      schema, registry projector, recorder integration) plus parity/concurrency
      test design. The PRD provides clear direction so xhigh is unnecessary, but
      high is warranted because mistakes silently re-create the live/snapshot
      drift that this plan is fixing.
  reviewer:
    effort: high
    rationale: Reviewer must verify projector idempotence, snapshot/delta parity,
      persist:true allowlist correctness, and reconnect replay semantics — all
      easy to get subtly wrong.
---

---
id: plan-01-daemon-run-state-events
name: Daemon run-state events for monitor live/snapshot parity
depends_on: []
---

# Daemon run-state events for monitor live/snapshot parity

## Architecture Context

The monitor sidebar is driven by `useDaemonEvents()` which seeds DaemonState from the `stream:hello` SSE handshake and applies live SSE deltas via the shared event registry's `project` functions. The `stream:hello` snapshot is authoritative: `runs` comes from `db.getRuns()` (which uses `rowToRunInfo` to map nullable SQL columns) and `queue` comes from `loadQueueItemsSync(queueDir, lockDir)` which reads `eforge/queue/{,failed,skipped,waiting}/*.md` plus `.lock` and `.recovery.json` sidecars. A browser refresh always shows correct state because it reseeds from the snapshot.

Live deltas drift from the snapshot because:

1. **Enqueue lifecycle has no `runId` at engine emission.** `packages/engine/src/eforge.ts` yields `enqueue:start` / `enqueue:complete` / `enqueue:failed` without a `runId` field. The engine's `withRunId` (`packages/engine/src/session.ts`) only stamps `runId` between `phase:start` and `phase:end`, which never fire for an enqueue-only session. The recorder (`packages/monitor/src/recorder.ts`) generates a `randomUUID()` and inserts the SQLite run row with `command: 'enqueue'`, but the persisted JSON event payload is unchanged, so the projectors in `packages/client/src/event-registry.ts` for `enqueue:start` / `enqueue:complete` / `enqueue:failed` (lines 920-982) all early-return on `if (!event.runId)` and never produce a delta. Meanwhile `session:start` projects (lines 103-128) to a synthetic running build run with empty `planSet` and `command: 'build'`, which is what the user sees as an untitled/unknown row in the build list.
2. **Compile/build runs are inserted on `phase:start`, but `phase:start`/`phase:end` are session-scoped/non-persisted.** `recorder.ts` calls `db.insertRun({ id: event.runId, command: event.command, … })` on `phase:start` and `db.updateRunStatus(event.runId, event.result.status, …)` on `phase:end`, but both events are registered as `scope: 'session', persist: false` (event-registry.ts lines 160-170), so they are never sent through `/api/daemon-events` and the live reducer cannot upsert the new running compile/build run.
3. **Queue projector coverage is incomplete.** `queue:prd:stale` (verdicts `proceed` / `revise` / `obsolete`) and `queue:prd:commit-failed` are daemon-persisted in the registry but have no `project` function, even though both can affect the snapshot returned by `loadQueueItemsSync(...)` (a `revise` or `obsolete` verdict moves/removes the file; a commit-failure may relocate the PRD to `failed/`).

Following the PRD's stated preference ("explicit daemon run-state contract or otherwise centralize projection so `stream:hello` snapshots and live deltas are provably equivalent"), this plan introduces an explicit daemon-scoped run-state event family emitted by the recorder *immediately after* every DB mutation that affects `runs`, and routes both compile/build and enqueue runs through it. The recorder remains the single entry point for `runs` table mutations, so it is the natural choke point for emitting an authoritative wire-state event.

For queue parity, the same pattern is applied: the existing queue lifecycle events that already mutate snapshot state get the missing projectors filled in, and where the existing event payload does not carry enough identity to project (`queue:prd:stale` with `revise`/`obsolete`, `queue:prd:commit-failed`), the events are enriched with the minimum identity (`prdId`, `title`) needed for the projector. This avoids inventing a parallel `daemon:queue:upsert` event family while still closing the parity gap.

The `withRecording()` generator-local `enqueueRunId` correlation continues to work — each daemon worker has its own `withRecording()` invocation, so concurrent enqueue/build sequences cannot cross-contaminate. Regression tests are added to keep that property honest.

## Implementation

### Overview

Introduce `daemon:run:upsert` as a new daemon-scoped, persisted EforgeEvent variant that carries a complete `RunInfo` payload (the same shape `db.getRuns()` returns via `rowToRunInfo`). Emit it from `withRecording()` immediately after every `db.insertRun` / `db.updateRunStatus` / `db.updateRunPlanSet` call, by re-reading the row through a new `db.getRunById(runId)` helper and projecting it with `rowToRunInfo`. The shared event registry projector for `daemon:run:upsert` replaces (or inserts) the matching entry in `state.runs` keyed by `id`, preserving the `startedAt DESC` ordering invariant.

Fill in the three missing/required queue projectors so `queue:prd:stale` (verdicts `revise` / `obsolete`) and `queue:prd:commit-failed` mutate `state.queue` consistently with `loadQueueItemsSync(...)`. Enrich the schemas of those two events with `prdId` (and `title` where needed) so the projectors have stable identity. Audit the rest of the queue surface against the snapshot loader to confirm parity for `queue:prd:discovered` / `:start` / `:skip` / `:complete` / `queue:complete`.

Bump `DAEMON_API_VERSION` (currently 24) to 25 because the wire surface gains a new persisted daemon event type and two enriched event payload shapes; daemon schemas must validate the new type for replay through `/api/daemon-events`.

Add parity, reconnect, and concurrent-correlation tests to lock the new behavior in.

### Key Decisions

1. **One canonical run-state event (`daemon:run:upsert`) over multiple specialized events.** A single event whose payload is the full `RunInfo` (re-read from the DB after mutation) is idempotent, trivially equivalent to the snapshot, and avoids splitting state into start/status/plan-set sub-events whose order on reconnect would have to be carefully preserved. The recorder reads the row back via `db.getRunById(runId)` after each mutation, so the wire payload always matches what `db.getRuns()` would return.
2. **Recorder owns emission, not the engine.** Engine code (`packages/engine/src/eforge.ts`, `pipeline.ts`) is unchanged. Engine session-scoped events (`enqueue:start`, `enqueue:complete`, `enqueue:failed`, `phase:start`, `phase:end`) keep their existing scope/persist settings, preserving session-stream and activity-feed behavior per the PRD's scope guardrail. Only the recorder's mutation hooks gain the additional yield.
3. **`session:start` projector becomes a no-op for runs.** The current projector synthesizes a `command: 'build'` run with empty `planSet` whenever `session:start` arrives without an existing run row. That synthesis is precisely what produces the untitled/unknown row during enqueue. Once `daemon:run:upsert` carries authoritative run state, the `session:start` projector for runs is no longer needed and is removed (the recorder already buffers `session:start` until the first mutation, so the daemon-stream client never relies on `session:start` to learn about a run).
4. **Existing enqueue projectors are simplified, not deleted.** `enqueue:start` / `enqueue:complete` / `enqueue:failed` retain their `persist: true` and `summary` strings (used by the activity feed) but their `project` functions are dropped — `daemon:run:upsert` is now the single source of truth for `state.runs`. This keeps the activity feed unchanged.
5. **Queue projectors stay on existing event types.** Adding `daemon:queue:upsert` would duplicate the queue events that already exist. Instead, fill in the missing `project` functions and enrich schema fields where needed (`queue:prd:stale` gains required `prdId` and `title`; `queue:prd:commit-failed` already has `prdId`). For `verdict: 'proceed'` the projector is a no-op (the queue file remains pending); for `revise` and `obsolete` the projector removes the item from `state.queue`.
6. **`withRecording()` concurrency invariant is documented and tested.** The PRD calls out that `enqueueRunId` is generator-local. Add a doc comment plus a new test that interleaves two `withRecording()` invocations to prove the local variable cannot leak.
7. **API version bump to 25.** Adding a new persisted event type changes what the daemon may write into the SSE stream. Older clients would fail Zod parsing of `daemon:run:upsert`. Bump `DAEMON_API_VERSION` and document the change in its inline comment.

## Scope

### In Scope

- New `daemon:run:upsert` event schema in `@eforge-build/client` plus its registry entry with a `project` function.
- Enrich `queue:prd:stale` schema with `prdId: string` and `title: string`. Enrich `queue:prd:commit-failed` schema with `title: string` (it already has `prdId`).
- Add `project` functions for `queue:prd:stale` and `queue:prd:commit-failed` in the registry.
- Drop `project` functions from `enqueue:start`, `enqueue:complete`, `enqueue:failed` (replaced by `daemon:run:upsert`). Keep `persist: true` and `summary` for activity-feed parity.
- Drop the run-creating branch of the `session:start` projector (it now returns `undefined` because `daemon:run:upsert` is authoritative).
- New `db.getRunById(runId)` helper in `packages/monitor/src/db.ts` that returns a single `RunInfo` (or undefined).
- Modify `packages/monitor/src/recorder.ts` to emit `daemon:run:upsert` immediately after every `db.insertRun`, `db.updateRunStatus`, and `db.updateRunPlanSet` call, re-reading the row through `getRunById`. Yielded synthetic events flow through the same DB-write path so they are persisted to the events table and replayed on reconnect.
- Update engine emission of `queue:prd:stale` / `queue:prd:commit-failed` to include the new required schema fields (`prdId`, `title`) sourced from the queue worker context.
- Bump `DAEMON_API_VERSION` from 24 to 25 with a changelog comment.
- Extend `packages/monitor/src/__tests__/stream-hello-parity.test.ts` to cover `daemon:run:upsert` round-trip plus reconnect replay parity.
- Add a new test `packages/monitor/src/__tests__/recorder-run-upsert.test.ts` that drives `withRecording()` end-to-end for an enqueue-only sequence and a phase-driven build sequence, and asserts the emitted `daemon:run:upsert` payloads match `db.getRuns()` byte-for-byte.
- Add a new test `packages/monitor/src/__tests__/recorder-concurrent-correlation.test.ts` that interleaves two `withRecording()` instances over the same DB and asserts each instance's `enqueueRunId` correlates only to its own `session:start` / `enqueue:*` payloads.
- Extend `packages/monitor-ui/test/event-replay-equivalence.test.ts` (or add a sibling daemon-reducer test in `packages/monitor-ui/test/daemon-reducer-parity.test.ts`) to replay a representative live-event sequence through `daemonReducer` + `BATCH_SEED` and assert the resulting `state.runs` and `state.queue` equal the snapshot path. Cover: enqueue start/complete/failed, phase start/end, and queue discover/start/skip/complete/stale/commit-failed.
- Update inline doc comments in `recorder.ts` and `event-registry.ts` to document the new contract.

### Out of Scope

- Reintroducing sidebar SWR polling for runs or queue.
- Inventing a parallel `daemon:queue:upsert` event family.
- Changing engine session events (`session:start`, `session:end`, `enqueue:*`, `phase:*`) — they keep their current scope/persist settings; only the recorder's emission of synthetic `daemon:run:upsert` events changes.
- Changing the activity feed's event filtering or summary text (the existing `summary` strings on enqueue events remain).
- Migrating existing on-disk SQLite data — there is no schema change to the `runs` or `events` tables.

## Files

### Create

- `packages/monitor/src/__tests__/recorder-run-upsert.test.ts` — End-to-end recorder test: drive an enqueue-only sequence and a phase-driven build sequence through `withRecording()`, capture the yielded events, assert exactly one `daemon:run:upsert` is emitted per `insertRun` / `updateRunStatus` / `updateRunPlanSet` call, and assert each payload deep-equals the corresponding `db.getRuns()` row mapped through `rowToRunInfo`.
- `packages/monitor/src/__tests__/recorder-concurrent-correlation.test.ts` — Concurrency test: run two `withRecording()` invocations interleaved over the same DB (one enqueue worker, one phase-driven build), asserting that each invocation's `enqueueRunId` and `runId` are written only to its own session's events and that the `daemon:run:upsert` payloads do not cross-correlate sessions.
- `packages/monitor-ui/test/daemon-reducer-parity.test.ts` — Replay parity test: feed a hand-built `BATCH_SEED` snapshot plus a sequence of `ADD_EVENT` actions (covering `daemon:run:upsert` for enqueue+phase lifecycles, and queue discover/start/skip/complete/stale/commit-failed) into `daemonReducer`, then assert the live-derived `state.runs` and `state.queue` equal the snapshot-only state computed by feeding the same final state directly via `BATCH_SEED`.

### Modify

- `packages/client/src/events.schemas.ts` — Add `DaemonRunUpsertEventSchema` carrying the `RunInfo` shape: `{ type: 'daemon:run:upsert', run: { id, sessionId?, planSet, command, status, startedAt, completedAt?, cwd, pid? } }` (mirroring `DaemonRunRecordSchema` so the new payload re-uses the existing wire shape). Add it to the `EforgeEventSchema` discriminated union and export the inferred `DaemonRunUpsertEvent` type. Enrich `QueuePrdStaleEventSchema` with required `prdId: z.string()` and `title: z.string()` (in addition to the existing `verdict`, `justification`, `revision?`). Enrich `QueuePrdCommitFailedEventSchema` with required `title: z.string()` (it already has `prdId`).
- `packages/client/src/event-registry.ts` — Add registry entry for `daemon:run:upsert` with `scope: 'daemon'`, `persist: true`, a one-line `summary`, and a `project(event, state)` function that finds an existing run by `event.run.id` and replaces it (preserving array order) or prepends the new run when no match exists. Drop the `project` functions on `enqueue:start` / `enqueue:complete` / `enqueue:failed` (keep their `summary` and `persist: true`). Make the `session:start` projector return `undefined` instead of synthesizing a build run (DaemonState.runs is now driven exclusively by `daemon:run:upsert`). Make `session:end` projector also return `undefined` (run termination is reflected via a `daemon:run:upsert` emitted by the recorder when `session:end` updates `enqueueRunId` to failed). Add `project` functions for `queue:prd:stale` (no-op when verdict='proceed', remove from `state.queue` when verdict='revise' or 'obsolete') and `queue:prd:commit-failed` (mark item status='failed' if present in queue, else no-op). The exhaustiveness type-check at the bottom of the file enforces that no event type is missed.
- `packages/client/src/api-version.ts` — Bump `DAEMON_API_VERSION` from 24 to 25 with an inline comment describing the v25 change ("v25: adds `daemon:run:upsert` daemon-scoped persisted event as authoritative source of `DaemonState.runs`; removes run synthesis from `session:start` projector; enriches `queue:prd:stale` with `prdId`+`title` and `queue:prd:commit-failed` with `title`").
- `packages/monitor/src/db.ts` — Add `getRunById(runId: string): RunInfo | undefined` exported method that runs `SELECT … FROM runs WHERE id = ?` and pipes the single row through `rowToRunInfo`. No schema migration.
- `packages/monitor/src/recorder.ts` — After each of: the `phase:start` `db.insertRun(...)` block, the `enqueue:start` `db.insertRun(...)` block, the `enqueue:complete` `db.updateRunPlanSet(...)`+`db.updateRunStatus(...)` pair, the `enqueue:failed` `db.updateRunStatus(...)` call, the `phase:end` `db.updateRunStatus(...)` call, and the `session:end` enqueue-failure branch, re-read the run via `db.getRunById(...)` and yield a `daemon:run:upsert` event with payload `{ run: <RunInfo>, timestamp: <ISO> }`. The yielded event is processed through the existing `activeRunId && event.type !== 'session:start'` branch so it is persisted via `db.insertEvent(...)` and visible to subscribers via the standard poll loop. Also handle the case where the synthetic event itself flows through the loop: do not re-react to `daemon:run:upsert` by re-emitting another upsert (skip the mutation hooks for that event type). Add a doc comment explaining the generator-local `enqueueRunId` correlation invariant.
- `packages/engine/src/queue.ts` (or the engine module that emits `queue:prd:stale` and `queue:prd:commit-failed` — locate via grep for `'queue:prd:stale'` and `'queue:prd:commit-failed'`) — Update emission sites to include the new required `prdId` (and `title` for `commit-failed` and stale where missing). The PRD already names this surface; the implementation must update the emission to match the enriched schema in lockstep so Zod parsing does not regress.
- `packages/monitor/src/__tests__/stream-hello-parity.test.ts` — Add a second test in the same `describe` block: seed an enqueue run + a completed compile run via `db.insertRun` / `db.updateRunStatus`, then drive a fresh `withRecording()` over a synthetic event stream that emits `enqueue:start` / `enqueue:complete` and `phase:start` / `phase:end`. Capture the resulting events from both `/api/daemon-events` (live deltas) and the `stream:hello` snapshot after a simulated reconnect (open a second SSE stream after the events have flushed). Assert the final `runs` array from the live-applied projection equals `db.getRuns()` and equals the `stream:hello` snapshot's `runs` field.
- `packages/monitor-ui/test/event-replay-equivalence.test.ts` — Add a top-level `describe('daemon-state parity')` block (or split into the new `daemon-reducer-parity.test.ts` as listed in Create) that asserts `daemonReducer` applied to a seed snapshot plus a live-event tail produces the same `runs` / `queue` arrays as a one-shot `BATCH_SEED` of the final snapshot. Cover the full enqueue / phase / queue lifecycles.

## Verification

- [ ] `pnpm type-check` exits 0 (the exhaustiveness type-check in `event-registry.ts` confirms `daemon:run:upsert` is registered; Zod-derived types compile with the new schema).
- [ ] `pnpm test` exits 0, including:
  - [ ] `packages/monitor/src/__tests__/stream-hello-parity.test.ts` — both the existing test and the new live-vs-snapshot reconnect parity test pass.
  - [ ] `packages/monitor/src/__tests__/recorder-run-upsert.test.ts` — for an enqueue-only sequence and a phase-driven build sequence, exactly one `daemon:run:upsert` is yielded per DB mutation, and each payload's `run` field deep-equals the corresponding `db.getRunById(runId)` result.
  - [ ] `packages/monitor/src/__tests__/recorder-concurrent-correlation.test.ts` — two interleaved `withRecording()` invocations produce non-overlapping `enqueueRunId` values and each emitted `daemon:run:upsert` carries the correct `sessionId` for its own session.
  - [ ] `packages/monitor-ui/test/daemon-reducer-parity.test.ts` (or the extended replay-equivalence test) — `daemonReducer(seed + live deltas)` produces `state.runs` and `state.queue` equal to `daemonReducer(BATCH_SEED(final snapshot))` for: enqueue start/complete/failed, phase start/end, queue discover/start/skip/complete/stale(verdict='revise')/stale(verdict='obsolete')/commit-failed.
- [ ] After running an enqueue followed by an auto-build dequeue against a live daemon (manual smoke check is not required for CI but the test must demonstrate equivalence): replaying the persisted daemon-event sequence from `db.getDaemonEventsAfter(0)` through `daemonReducer` produces `state.runs` and `state.queue` equal to the snapshot `db.getRuns()` + `loadQueueItemsSync(queueDir, lockDir)`.
- [ ] Grep confirms zero callers of the removed `project` branches: `enqueue:start` / `enqueue:complete` / `enqueue:failed` registry entries no longer have a `project` field, and `session:start` projector no longer creates a synthetic run.
- [ ] Grep confirms `db.insertRun`, `db.updateRunStatus`, `db.updateRunPlanSet` are called only from `packages/monitor/src/recorder.ts` (and tests). Each of those call sites is followed by a `daemon:run:upsert` emission.
- [ ] `packages/client/src/api-version.ts` `DAEMON_API_VERSION` equals 25 and the inline comment documents the v25 change.
- [ ] No new sidebar SWR polling for runs or queue is introduced (grep `useSWR` and `mutate` in `packages/monitor-ui/src/components/layout/sidebar.tsx` and `app.tsx` — count must not increase compared to baseline).
