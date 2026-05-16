---
id: plan-01-supervisor-foundation
name: Auto-Build Supervisor Foundation and Wire Contract
branch: redesign-auto-build-queue-watcher-lifecycle-around-an-fsm-supervisor/plan-01-supervisor-foundation
agents:
  builder:
    effort: high
    rationale: Defines the lifecycle state model, controller contract, and additive
      wire schema used by the later daemon and UI integration.
  reviewer:
    effort: high
    rationale: The state model and wire schema are cross-package contracts that need
      careful API and type review.
  tester:
    effort: high
    rationale: Supervisor transition coverage must exercise fault, restart, pause,
      and mutation-wake edge cases without real subprocesses.
---

# Auto-Build Supervisor Foundation and Wire Contract

## Architecture Context

Auto-build lifecycle state is currently split across `server-main.ts` local watcher variables, `DaemonState` booleans/callbacks in `server.ts`, scheduler handle callbacks, and monitor UI projections. This plan creates the shared state model and client wire contract that later daemon integration will use. It does not yet replace `server-main.ts` runtime wiring; that happens in plan-02.

The design keeps the engine scheduler algorithm out of scope. `QueueScheduler` pause/resume/isAlive primitives remain the runtime controls used by the daemon supervisor.

## Implementation

### Overview

Create a daemon-local `AutoBuildSupervisor` module with a pure reducer, an imperative controller class for side effects, and exported interfaces for the HTTP layer. Extend the client-owned `AutoBuildState` and event schemas additively so REST/SSE snapshots can expose lifecycle detail while retaining existing `enabled` and `watcher` fields.

### Key Decisions

1. Model lifecycle as `disabled | starting | running | paused | stopping | restarting | faulted`, plus `desired: 'enabled' | 'disabled'`.
2. Keep `AutoBuildState.enabled` as the legacy effective toggle field and add optional detail fields (`desired`, `mode`, `scheduler`, `lastTransition`, `reason`) rather than replacing the existing shape.
3. Export an `AutoBuildController` interface with methods that routes can call later: `getSnapshot()`, `enable()`, `disable()`, `notifyQueueMutation()`, `pauseOnFailure()`, `shutdown()`, and an extension-reload hook if needed.
4. Use a pure reducer for state transitions and a small class wrapper for side effects. Unit tests target both layers without creating real engine processes.
5. Emit a generic additive transition event (for example `daemon:auto-build:transition`) carrying previous mode, next mode, desired state, reason, and source. Keep existing compatibility events (`enabled`, `disabled`, `paused`, `resumed`, `triggered`) available.
6. Bump `DAEMON_API_VERSION` if the implementation adds a new event discriminant to the client schema. Update the version assertion in tests with the new value and comment.

## Scope

### In Scope

- Add the supervisor state union, reducer transition helpers, controller interface, and side-effect class in `packages/monitor/src/auto-build-supervisor.ts`.
- Add supervisor unit tests for enable/disable/fault/restart/pause/mutation-wake transitions.
- Add optional lifecycle fields to `AutoBuildState` in `packages/client/src/types.ts` and the `DaemonAutoBuildSchema` used by daemon stream snapshots.
- Update client exports so browser and Node consumers can import new auto-build detail types.
- Register any new daemon auto-build transition event in `events.schemas.ts` and `event-registry.ts`, including summaries, daemon persistence, and state projection.
- Update client wire/schema tests and API version tests affected by the new wire contract.

### Out of Scope

- Wiring the supervisor into `server-main.ts` and `server.ts` runtime routes.
- Changing `QueueScheduler` scheduling rules.
- Monitor UI rendering changes.
- Database schema migrations.

## Files

### Create

- `packages/monitor/src/auto-build-supervisor.ts` — Defines supervisor state, reducer transitions, controller interface, and controller class used by daemon runtime and HTTP routes.
- `packages/monitor/src/__tests__/auto-build-supervisor.test.ts` — Tests reducer transitions and controller behavior with fake watcher/scheduler primitives.

### Modify

- `packages/client/src/types.ts` — Adds optional `AutoBuildDesired`, `AutoBuildRuntimeMode`, scheduler detail, transition detail, and extended `AutoBuildState` fields.
- `packages/client/src/events.schemas.ts` — Adds schema unions for auto-build runtime modes and extended daemon auto-build snapshot/event payloads.
- `packages/client/src/event-registry.ts` — Registers new transition events, summaries, persistence, and auto-build state projection for richer snapshots.
- `packages/client/src/index.ts` — Re-exports new auto-build detail types from the Node-safe client entrypoint.
- `packages/client/src/browser.ts` — Re-exports new auto-build detail types from the browser-safe client entrypoint.
- `packages/client/src/api-version.ts` — Bumps and documents the daemon API version if a new event discriminant is emitted.
- `packages/client/src/__tests__/events-schemas.test.ts` — Adds schema coverage for enriched `AutoBuildState` and any new transition event.
- `packages/client/src/__tests__/events-wire-parity.test.ts` — Adds representative payloads for enriched heartbeat/snapshot state and any new transition event.
- `packages/client/src/__tests__/events.test.ts` — Updates daemon event registry/allowlist expectations for any new persisted daemon auto-build event.
- `test/daemon-recovery.test.ts` — Updates the fixed `DAEMON_API_VERSION` assertion if the version is bumped.

## Verification

- [ ] `packages/monitor/src/__tests__/auto-build-supervisor.test.ts` asserts transitions for enable from disabled, disable from running, enable while stopping, fault then enable, queue mutation while enabled but not running, failure pause, and resume.
- [ ] `safeParseDaemonStreamSnapshot` accepts an `autoBuild` object containing `enabled`, `watcher`, `desired`, `mode`, `scheduler`, and `lastTransition` fields.
- [ ] `eventRegistry` contains every new `EforgeEvent` discriminant and `DAEMON_EVENT_TYPES` includes persisted daemon auto-build transition events.
- [ ] `pnpm test -- packages/monitor/src/__tests__/auto-build-supervisor.test.ts packages/client/src/__tests__/events-schemas.test.ts packages/client/src/__tests__/events-wire-parity.test.ts packages/client/src/__tests__/events.test.ts test/daemon-recovery.test.ts` exits 0.
