---
title: Fix monitor live updates so enqueue sessions appear under Enqueuing, queued PRDs appear without refresh, and newly running builds appear automatically after enqueue completes
created: 2026-05-07
---

# Fix monitor live updates so enqueue sessions appear under Enqueuing, queued PRDs appear without refresh, and newly running builds appear automatically after enqueue completes

## Problem / Motivation

The monitor sidebar is now driven by daemon-wide SSE state rather than SWR polling: `useDaemonEvents()` seeds from `stream:hello` and applies `ADD_EVENT` deltas, then `app.tsx` passes `daemonState.runs` and `daemonState.queue` to `Sidebar`. A browser refresh is correct because `stream:hello` snapshots authoritative state from `db.getRuns()` and `loadQueueItemsSync(...)` in `packages/monitor/src/server.ts`.

The live path drifts from the snapshot path. `packages/monitor/src/recorder.ts` creates an enqueue run row in SQLite when `enqueue:start` arrives, with command `enqueue` and a generated `enqueueRunId`, but the persisted JSON event remains the original `enqueue:start` payload and does not include that generated run id. The client projector for `enqueue:start` in `packages/client/src/event-registry.ts` requires `event.runId`, so it returns without adding/updating the enqueue run. Separately, persisted `session:start` events project to a synthetic build run with empty `planSet` and `command: 'build'`, which is what makes the sidebar show an untitled/unknown active build while the formatter is running.

When enqueue completes and auto-build starts the queued PRD, `recorder.ts` inserts the real compile/build run rows on `phase:start`, but `phase:start` is `persist: false`/session-scoped in the event registry, so `/api/daemon-events` does not deliver a daemon delta that upserts the new running build. Again, refresh fixes the UI because the snapshot reads the real DB rows.

The queue section has a similar live/snapshot split: refresh reads queue files and locks with `loadQueueItemsSync`, while live queue state relies on daemon events such as `queue:prd:discovered`, `queue:prd:start`, and `queue:prd:complete`. The fix should make daemon SSE deltas and `stream:hello` snapshots equivalent, not reintroduce UI polling.

When a user triggers `eforge:build`/enqueue through the daemon while the monitor is open, the monitor sidebar shows a transient untitled/unknown active build during the enqueue formatter step instead of showing the session under the Enqueuing section. The queue section also does not show the newly enqueued PRD live. After enqueue completes and auto-build starts the PRD, the build list does not automatically show the new running compile/build session. A browser refresh immediately corrects the display because the monitor reseeds from the authoritative snapshot. This makes the monitor unreliable for live daemon-driven builds and forces users to refresh to see accurate state.

### Root Cause

The daemon SSE delta stream and `stream:hello` snapshot are not equivalent for run/queue state. `stream:hello` snapshots `runs` from `db.getRuns()` and `queue` from `loadQueueItemsSync(...)`, so refresh shows correct state. Live updates depend on projected daemon events, and several events that mutate DB/filesystem state either lack enough payload identity to project or are not daemon-visible.

- For enqueue, `recorder.ts` generates an `enqueueRunId` and inserts/updates the SQLite run row with `command: 'enqueue'`, but the serialized `enqueue:start`, `enqueue:complete`, and `enqueue:failed` payloads do not carry that generated run id. The client projectors for enqueue lifecycle events require `event.runId`, so the live reducer cannot create or complete/fail the enqueue row from deltas. The preceding persisted `session:start` event then projects to a synthetic running build run with empty `planSet` and `command: 'build'`, producing the untitled/unknown build-list row.
- For compile/build runs after dequeue, real run rows are inserted on `phase:start` and completed on `phase:end`, but both phase lifecycle events are session-scoped/non-persisted in the registry and therefore are not delivered/projected on `/api/daemon-events`. Fixing only `phase:start` would make builds appear but then remain running until refresh; terminal status parity requires handling `phase:end` too.
- For queue state, live parity also depends on complete projector coverage for all queue lifecycle events that can affect snapshot output. `queue:prd:discovered`, `queue:prd:start`, `queue:prd:skip`, and `queue:prd:complete` have some projection coverage, but `queue:prd:stale` and `queue:prd:commit-failed` are daemon-persisted events without projectors today. The implementation should audit the full queue event surface against `loadQueueItemsSync(...)` rather than only fixing the visible happy path.

Concurrency note: `enqueueRunId` is local to a `withRecording()` generator invocation, not a module-global variable, so separate worker processes should not overwrite one another's local variable. Still, the recorder relies on mutable stream-local correlation between `session:start`, enqueue lifecycle, and run rows. Regression tests should cover concurrent enqueue/build sequences and reconnects so the fix cannot reintroduce cross-session correlation drift.

### Reproduction Steps

1. Start the eforge daemon/monitor and open the monitor UI in a browser.
2. From Pi or another daemon client, run `eforge:build`/`eforge_build` with a new PRD source so the daemon spawns an enqueue worker.
3. While the formatter step is running, observe the sidebar.
   - Expected: the session appears under Enqueuing with an enqueue label/title; no active build row is shown yet.
   - Actual: the build/session list shows an untitled/unknown running build; the Enqueuing and Queue sections do not reflect the new item correctly.
4. Refresh the browser during enqueue.
   - Expected and actual after refresh: the item appears correctly under Enqueuing and not in the active build list.
5. Let enqueue finish and auto-build dequeue/start the PRD.
   - Expected: queue/enqueue state updates and the running compile/build session appears automatically.
   - Actual: the build list does not show the new running build until another browser refresh.

### Roadmap Alignment

This fits the daemon-as-single-orchestration-authority direction and the existing guardrail. It is a monitor/daemon/client consistency bugfix, not a new workflow/scheduling feature.

## Goal

Make the monitor sidebar's live SSE-driven state provably equivalent to the authoritative `stream:hello` snapshot so enqueue sessions appear under Enqueuing, queued PRDs appear without refresh, and newly running compile/build sessions appear automatically after enqueue completes — without reintroducing UI polling.

## Approach

The implementation should choose one coherent live-state model instead of patching only the first missing `runId` symptom. Acceptable approaches include:

1. **Enrich existing lifecycle events** — ensure enqueue/phase/session events that mutate daemon-visible run state carry enough identity and metadata for the shared event registry to project them. This is incremental, but risks continuing the current pattern of parallel DB mutation plus event projection if not done comprehensively.
2. **Add explicit daemon run-state events** — emit typed daemon-scoped events such as run upsert/status update after recorder DB mutations, and project those into `DaemonState.runs`. This makes the daemon-visible contract explicit and avoids overloading session-scoped lifecycle events.
3. **Promote selected lifecycle events to daemon-visible** — make `phase:start`/`phase:end` (and possibly enriched enqueue lifecycle events) daemon-persisted/projected. This is straightforward but changes event scope semantics and must preserve session stream behavior.
4. **Reduce parallel projection paths** — centralize run/queue shaping so snapshot and delta projection share named helpers/contracts wherever possible. This best matches the recurring drift pattern, but may be larger than a narrow bugfix.

**Preference:** favor an explicit daemon run-state contract or otherwise centralize projection so `stream:hello` snapshots and live deltas are provably equivalent. Avoid adding ad hoc UI polling or one-off sidebar fixes.

### Profile Signal

Recommended profile: **Excursion**.

Rationale: this is still a cohesive bugfix with a confirmed root-cause family, but it crosses the shared client event schema/registry, monitor recorder/server behavior, monitor UI reducer/sidebar projection, and parity tests. It is not an Errand because the fix needs schema/projection design and snapshot-vs-delta regression coverage. It is close to the upper bound of Excursion after expanding the event surface, but still does not require Expedition unless implementation discovers that separate subsystem redesigns are needed; a single cohesive plan should be able to select and execute one live-state model.

### Test Focus

Use existing parity infrastructure where possible, especially `packages/monitor/src/__tests__/stream-hello-parity.test.ts` and `packages/monitor-ui/test/event-replay-equivalence.test.ts`. Add coverage for:

- enqueue start/complete/failed live projection and replay after reconnect;
- phase start/end (or equivalent run upsert/status events) for both compile and build runs;
- terminal-state parity after reconnect, so rows do not remain running live when the DB snapshot says completed/failed/killed;
- queue discovery/start/skip/complete/stale/commit-failed parity against snapshot queue shaping;
- concurrent enqueue/build event sequences to prove run identity and session correlation remain isolated.

## Scope

### In Scope

- Shared client event schema/registry in `@eforge-build/client` (event shapes, projectors).
- Monitor recorder/server behavior in `packages/monitor/src/recorder.ts` and `packages/monitor/src/server.ts` (event payload identity, daemon-visible event scope).
- Monitor UI reducer/sidebar projection (`useDaemonEvents()`, `app.tsx`, `Sidebar`).
- Parity and regression tests, including reconnect replay and concurrent enqueue/build sequences.
- Coverage of full queue lifecycle event surface: `queue:prd:discovered`, `queue:prd:start`, `queue:prd:skip`, `queue:prd:complete`, `queue:prd:stale`, `queue:prd:commit-failed`.
- Coverage of phase lifecycle: both `phase:start` and `phase:end` (or equivalent run-upsert/run-status events).
- Coverage of enqueue lifecycle: `enqueue:start`, `enqueue:complete`, `enqueue:failed`, and relevant `session:end` handling.

### Out of Scope

- Reintroducing sidebar SWR polling for runs or queue.
- New workflow or scheduling features beyond live/snapshot consistency.
- Changing session-scoped event stream behavior or activity feed behavior, unless the chosen design explicitly changes event scope with tests and migration rationale.

## Acceptance Criteria

- With the monitor already open, starting an enqueue via daemon client causes the live sidebar to show exactly one running enqueue-only session under Enqueuing, not an untitled/unknown row in the build list.
- The live enqueue row has a stable key/session association and a useful label derived from source/title; `enqueue:start`, `enqueue:complete`, `enqueue:failed`, and relevant `session:end` handling all update live state consistently with a refreshed `stream:hello` snapshot.
- The live queue section reflects PRD state without a browser refresh. Covered transitions include discovery/pending, dequeue/running, skipped/removed, completed/removed, failed, stale/revision/obsolete behavior, and commit-failed behavior where those affect the queue row shown by `loadQueueItemsSync(...)`.
- When auto-build dequeues/starts the new PRD, the live build/session list automatically shows the running compile/build session with the correct planSet/title, command grouping, status, and sessionId, without refresh.
- Compile/build terminal state updates live: after `phase:end`, completed/failed/killed statuses shown in the sidebar match the authoritative DB snapshot without requiring refresh.
- A browser refresh at any point produces the same sidebar state as the live SSE-updated state; add/adjust regression tests to prove snapshot/delta parity for enqueue start/complete/failed, session start/end interactions, phase start/end or equivalent run-upsert/run-status events, queue discovery/start/skip/complete/stale/commit-failed, and reconnect replay.
- Add or adjust tests for concurrent enqueue/build sequences so generated run identity and session correlation cannot cross-contaminate between sessions.
- Do not reintroduce sidebar SWR polling for runs or queue. The fix should keep daemon SSE plus `stream:hello` as the state source.
- Preserve session-scoped event streams and existing activity feed behavior unless the chosen design explicitly changes event scope with tests and migration rationale. Any new/changed daemon event shape must be added to `@eforge-build/client` schemas/types and projected through the shared event registry.
