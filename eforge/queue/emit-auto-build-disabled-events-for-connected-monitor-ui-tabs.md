---
title: Emit Auto-build Disabled Events for Connected Monitor UI Tabs
created: 2026-05-16
profile: pi-codex-5-5
---

# Emit Auto-build Disabled Events for Connected Monitor UI Tabs

## Problem / Motivation

Connected monitor UI clients can show stale Auto-build toggle state after another client manually disables auto-build.

### Evidence sources reviewed

- `AGENTS.md`: event wire shapes are owned by `@eforge-build/client`; event variants and TypeBox schemas belong in `packages/client/src/events.schemas.ts`; monitor UI should render engine/daemon events rather than inventing parallel state paths; daemon wire shapes for auto-build should use shared projections.
- `docs/roadmap.md`: this change is not a named roadmap item, but aligns with the daemon maturity goal of richer controls and observable daemon/orchestrator behavior.
- `packages/monitor/src/server.ts`: `GET /api/auto-build`, `POST /api/auto-build`, and the `/api/daemon-events` `stream:hello` snapshot all use `autoBuildStateToWire()`. The enable branch emits persisted `daemon:auto-build:enabled` or `daemon:auto-build:resumed`; the disable branch mutates `options.daemonState.autoBuild = false` and calls `onKillWatcher?.()` but does not emit a corresponding disabled event.
- `packages/monitor-ui/src/hooks/use-daemon-events.ts`: monitor UI page-load state is seeded from the daemon-events `stream:hello` snapshot, including `snapshot.autoBuild`, and later live events are dispatched through `ADD_EVENT`.
- `packages/monitor-ui/src/lib/daemon-reducer.ts` and `packages/monitor-ui/src/lib/daemon-reducer/index.ts`: live daemon events are applied through projectors derived from `@eforge-build/client`'s event registry. Non-heartbeat daemon events are also appended to the activity ring buffer.
- `packages/client/src/events.schemas.ts`: existing daemon auto-build variants are `daemon:auto-build:enabled`, `daemon:auto-build:resumed`, and `daemon:auto-build:triggered`; there is no disabled variant.
- `packages/client/src/event-registry.ts`: enabled/resumed event projectors set `autoBuild.enabled = true`; paused sets `enabled = false` for failure pauses. There is no manual-disable projector.

### Current behavior summary

- A fresh page load/reconnect should be correct because the server sends an authoritative `stream:hello` snapshot with `autoBuild` from in-memory daemon state.
- The tab/client that performs a manual toggle-off gets the POST response and updates its local `daemonState.autoBuild` directly.
- Other already-connected monitor UI clients have no disable event to consume, so they can remain stale until reconnect/refresh. Heartbeats carry `autoBuild.enabled`, but the header toggle is not driven from heartbeat payload.

### User-visible impact

- If one browser tab or client turns Auto-build off, other already-connected monitor UI tabs may continue to render the toggle as on until they reconnect or refresh.
- This matters because the toggle is a daemon-wide control and should reflect the current daemon state for all connected observers.

## Goal

Emit and project a daemon-scoped `daemon:auto-build:disabled` event so already-connected monitor UI clients update their Auto-build toggle state immediately when another client manually disables auto-build.

Fresh page load/reconnect behavior should remain unchanged through the authoritative `stream:hello.autoBuild` snapshot.

## Approach

### High-level implementation

- Add a new daemon-scoped event variant named `daemon:auto-build:disabled` to the shared client wire schema.
- Add the event to the shared client event registry with:
  - `persist: true`
  - An activity summary
  - A projector that sets `state.autoBuild.enabled = false` when an auto-build state exists.
- Emit the event from the daemon’s manual disable path in `POST /api/auto-build` after the server accepts `enabled: false` and invokes watcher shutdown.
- Update monitor UI exhaustive event lists/tests as needed so the new event is accepted by type checks and rendered through the existing daemon reducer path.
- Add/update tests proving:
  - A disabled event flips `daemonState.autoBuild.enabled` to `false`.
  - The event is part of the event wire/schema/DB allowlists.

### Primary files likely to change

- `packages/client/src/events.schemas.ts`
  - Add `Type.Object({ type: Type.Literal('daemon:auto-build:disabled') })` near existing auto-build event variants.
  - This is the canonical wire schema source of truth per `AGENTS.md`.

- `packages/client/src/event-registry.ts`
  - Add registry entry for `daemon:auto-build:disabled` with:
    - `scope: 'daemon'`
    - `persist: true`
    - Summary text
    - A `project()` function that sets `{ autoBuild: { ...state.autoBuild, enabled: false } }` when `state.autoBuild` exists and is currently enabled.
  - Pattern to follow: existing `daemon:auto-build:enabled`, `daemon:auto-build:resumed`, and `daemon:auto-build:paused` entries.

- `packages/monitor/src/server.ts`
  - In `POST /api/auto-build`, false branch currently only calls `options.daemonState.onKillWatcher?.()`.
  - Add:

    ```ts
    options.daemonState.onDaemonEvent?.({
      type: 'daemon:auto-build:disabled',
      timestamp: new Date().toISOString(),
    } as EforgeEvent)
    ```

    after the server accepts the disable request.
  - Existing enable branch already emits enabled/resumed events in the same route, so this keeps behavior symmetric.

- `packages/monitor-ui/src/lib/reducer/index.ts`
  - Add the new event type to the no-op/exhaustive event list if required by the compile-time event coverage check.
  - The daemon reducer itself should not need custom code because it derives handlers from the client event registry.

### Likely tests to update/add

- `packages/client/src/__tests__/events.test.ts`
  - Add disabled variant to sample events and expected literal set.
  - Update count text from current `"18 new daemon variants"` if present.

- `packages/client/src/__tests__/events-wire-parity.test.ts`
  - Add a payload case for `daemon:auto-build:disabled`.

- `packages/monitor/src/__tests__/db.test.ts`
  - Add disabled to persisted daemon event type allowlist expectations.

- `packages/monitor-ui/src/lib/__tests__/daemon-reducer.test.ts`
  - Add a reducer test proving `daemon:auto-build:disabled` changes `autoBuild.enabled` from true to false and appends to activity.
  - Also test no-op when `autoBuild` is null if matching enabled behavior.

### Potential additional impact

- If there are generated docs/reference artifacts for events, `pnpm docs:generate` / `pnpm docs:check` may detect drift after the schema change.
- This is an assumption; validate via targeted docs check only if normal tests or docs gate indicate it.

### Design decisions

1. Use a new explicit event name: `daemon:auto-build:disabled`.
   - Rationale: Existing event names are explicit daemon auto-build lifecycle facts: `enabled`, `resumed`, `triggered`, and `paused`. `disabled` clearly distinguishes intentional manual disable from failure-triggered `paused`.
   - Assumption: Consumers may care about manual disable vs failure pause semantically. Confidence high because `paused` already carries a failure reason and `resumed` is emitted only after failure-triggered pause.

2. Make the event persisted (`persist: true`) and daemon-scoped.
   - Rationale: Existing enabled/resumed/triggered events are persisted daemon events, and connected/reconnecting UIs rely on daemon event replay plus `stream:hello` snapshot. Persisting also keeps the activity log/audit trail symmetric.

3. Put state projection in `@eforge-build/client` event registry, not monitor UI local code.
   - Rationale: The monitor UI daemon reducer derives handlers from the shared event registry. This follows the existing shared wire/projection pattern and avoids parallel state logic in the UI.

4. Emit from the server route after accepting `enabled: false`.
   - Rationale: The server has already validated the request and mutated `options.daemonState.autoBuild = false` before entering the false branch. Emitting there makes other subscribers update immediately, while the initiating client still receives the canonical POST response.
   - Open implementation detail: emit before or after `onKillWatcher?.()`. Prefer after calling `onKillWatcher?.()` to represent the disable action including watcher shutdown request; however, either ordering is acceptable because `daemonState.autoBuild` is already false before both. If `onKillWatcher` can throw, which is not confirmed, emitting before may be safer for event delivery. Cheap validation: inspect or rely on tests/type behavior during implementation.

5. Projector should be idempotent/no-op when `state.autoBuild` is null.
   - Rationale: Existing enabled/resumed/paused projectors do this to support clients/daemons that do not expose auto-build state.

6. Do not update the header to use heartbeat state.
   - Rationale: The bug is missing event propagation; the architecture already treats `daemonState.autoBuild` as the authoritative reader path. Heartbeat is liveness-oriented and would create a second reader path.

### Early assumptions / unknowns

- Assumption, high confidence and low validation cost: adding a persisted `daemon:auto-build:disabled` event in the shared client schema/registry is sufficient for connected monitor UI clients because daemon reducer handlers are generated from `eventRegistry`.
  - Validation path: add reducer/hook tests for the new event and run type-check/tests.
- Assumption, medium confidence and low validation cost: existing event schema tests and DB event allowlist tests will identify all required test updates.
  - Validation path: run targeted vitest for client event schemas, monitor DB tests, and monitor UI daemon reducer tests.

### Assumptions and validation

| Assumption | Evidence / validation performed | Confidence | Cost to validate further | Validation path | Impact if wrong |
|------------|----------------------------------|------------|--------------------------|-----------------|-----------------|
| Adding `daemon:auto-build:disabled` to the shared event schema and registry is enough for monitor UI live state updates. | Reviewed `useDaemonEvents()` dispatch path and `daemonReducer` handler lookup from `eventRegistry`. Existing enabled/resumed/paused projectors already mutate `autoBuild.enabled`. | High | Low | Add reducer test for disabled event; run monitor UI daemon reducer tests. | If wrong, a custom UI reducer handler or hook change would be needed. |
| The disable path should emit a manual-disable event distinct from failure `paused`. | Reviewed server route: manual disable branch is separate from failure pause/resume lifecycle. Reviewed existing `daemon:auto-build:paused` requires a reason and represents failure-triggered pause. | High | Low | Add event registry/schema tests; manually inspect event summaries/activity. | If wrong, consumers might conflate operator intent with failure state, reducing observability. |
| Persisting the disabled event is appropriate. | Existing `enabled`, `resumed`, and `triggered` auto-build events are persisted. Non-heartbeat daemon events populate activity/replay. | High | Low | Add to DB persisted type tests and event registry `persist: true`; run DB/event tests. | If wrong, reconnect/replay/activity behavior would be asymmetric or noisy. |
| Emitting in `POST /api/auto-build` false branch does not require changing watcher shutdown behavior. | Reviewed route: `options.daemonState.autoBuild = body.enabled` happens before branch; false branch only invokes `onKillWatcher?.()`. The new event can be added without altering shutdown. | High | Low | Add/adjust server route test if one exists or rely on integration/typed tests; implementation can inspect `onKillWatcher` behavior. | If wrong, event ordering or exception behavior could prevent delivery. |
| All required test updates are in the identified event/schema/DB/reducer tests. | Searched for existing auto-build event references across `packages/client`, `packages/monitor`, and `packages/monitor-ui`. | Medium | Low | Run `rg "daemon:auto-build:"` after implementation and run targeted tests plus `pnpm type-check`. | If wrong, type-check or test failures will reveal additional exhaustive lists/docs references. |
| No documentation update is needed beyond generated event references, if any. | README/roadmap describe monitor generally, not this low-level event. Event docs may be generated from schema/registry but not confirmed. | Medium | Low | Run `pnpm docs:check` if docs generation gates fail or if event reference artifacts are changed by tests/build. | If wrong, docs drift could remain until docs check catches it. |

No low-confidence/high-impact assumptions remain. The main unknowns are cheap to validate with targeted tests/type-check during implementation.

### Profile signal

Recommended profile: **Excursion**.

Rationale:

- This is cohesive and does not need delegated module planning, so Expedition would be overkill.
- It crosses the shared client wire schema, daemon server emission, monitor UI reducer behavior, and tests. That is more than a trivial single-file errand because event contracts and consumer behavior must stay in sync.
- A single planner can enumerate the required changes and validation path with high confidence.

The build should produce one cohesive plan with clear cross-package test updates.

## Scope

### In scope

- Add a new daemon-scoped event variant named `daemon:auto-build:disabled` to the shared client wire schema.
- Add the event to the shared client event registry with:
  - `persist: true`
  - An activity summary
  - A projector that sets `state.autoBuild.enabled = false` when an auto-build state exists.
- Emit the event from the daemon's manual disable path in `POST /api/auto-build` after the server accepts `enabled: false` and invokes watcher shutdown.
- Update monitor UI exhaustive event lists/tests as needed so the new event is accepted by type checks and rendered through the existing daemon reducer path.
- Add/update tests proving a disabled event flips `daemonState.autoBuild.enabled` to false and is part of the event wire/schema/DB allowlists.

### Out of scope

- Changing the page-load snapshot mechanism. `stream:hello` remains the authoritative initial/reconnect state.
- Driving the header toggle from heartbeat payloads.
- Changing auto-build persistence/config semantics.
- Changing watcher shutdown behavior or killing in-flight builds.
- Adding a new UI element; the existing switch should update through daemon state.
- Changing public REST route shapes. `GET/POST /api/auto-build` continue returning the existing `AutoBuildState` shape.

## Acceptance Criteria

### Functional acceptance criteria

- When `POST /api/auto-build` is called with `{ "enabled": false }` in daemon mode, the daemon emits a persisted daemon event with type `daemon:auto-build:disabled`.
- Already-connected monitor UI clients subscribed to `/api/daemon-events` receive the disabled event and update `daemonState.autoBuild.enabled` to `false` without requiring refresh/reconnect.
- The client/tab that initiated the toggle-off still updates from the `POST /api/auto-build` response as before.
- Fresh page load/reconnect behavior remains unchanged: `stream:hello.autoBuild` continues to match `GET /api/auto-build`.
- Failure-triggered auto-build pauses continue to use `daemon:auto-build:paused`, not `disabled`.
- Enabling after a failure-triggered pause continues to emit `daemon:auto-build:resumed`; enabling otherwise continues to emit `daemon:auto-build:enabled`.

### Wire/API criteria

- `daemon:auto-build:disabled` is part of the canonical `EforgeEvent` TypeBox schema in `packages/client/src/events.schemas.ts`.
- The event registry includes a daemon-scoped, persisted registry entry with summary and projector.
- No REST response shape changes are introduced for `GET/POST /api/auto-build`.

### Test/validation criteria

- Client event schema/wire tests include `daemon:auto-build:disabled`.
- Monitor DB/persistence tests include `daemon:auto-build:disabled` as a persisted daemon event.
- Monitor UI daemon reducer tests prove the event flips `autoBuild.enabled` from true to false and appends to activity.
- Existing stream hello parity tests still pass, proving page-load/reconnect state remains authoritative.
- Run at least targeted tests for the touched packages.
- Run `pnpm type-check` if test/type changes indicate cross-package typing risk.
