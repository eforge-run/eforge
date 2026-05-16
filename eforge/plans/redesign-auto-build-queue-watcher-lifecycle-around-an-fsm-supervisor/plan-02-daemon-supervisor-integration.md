---
id: plan-02-daemon-supervisor-integration
name: Daemon Runtime and Route Integration for Auto-Build Supervisor
branch: redesign-auto-build-queue-watcher-lifecycle-around-an-fsm-supervisor/plan-02-daemon-supervisor-integration
agents:
  builder:
    effort: xhigh
    rationale: Refactors daemon watcher lifecycle, HTTP routes, extension reload,
      pause-on-failure, and SSE projection around a single supervisor while
      preserving existing engine behavior.
  reviewer:
    effort: high
    rationale: Lifecycle races and API route semantics require detailed review
      across server-main.ts, server.ts, and integration tests.
  tester:
    effort: high
    rationale: Regression tests must simulate inert scheduler handles, draining
      watchers, queue mutation wakeups, and route delegation without real
      subprocesses.
---

# Daemon Runtime and Route Integration for Auto-Build Supervisor

## Architecture Context

Plan-01 provides a supervisor/controller contract and enriched wire shape. This plan moves daemon watcher lifecycle ownership from scattered booleans and callbacks into that supervisor. `server-main.ts` becomes the integration layer that supplies engine/watchQueue primitives, while `server.ts` delegates route actions to the controller.

The daemon remains the single orchestration authority. The engine scheduler remains unchanged except for test coverage around existing pause/resume/parallelism behavior.

## Implementation

### Overview

Instantiate `AutoBuildSupervisor` in persistent daemon mode, move watcher abort/drain/generation tracking into it, and route all auto-build toggles, queue mutation wakes, failure pauses, extension reload restarts, snapshots, and shutdown drains through supervisor methods.

### Key Decisions

1. `server.ts` must not inspect `injectSchedulerEvent`, `isSchedulerAlive`, `onSpawnWatcher`, or `onKillWatcher`. It calls controller methods and serializes the controller snapshot through `autoBuildStateToWire`.
2. `server-main.ts` supplies side-effect primitives: create `EforgeEngine`, call `watchQueue()`, register scheduler inject/control handles, wrap watcher events, write daemon events, compute queue/runtime stats, and drain/abort watcher generations.
3. Disabling auto-build calls scheduler pause before aborting the watcher so new launches stop immediately while in-flight PRD builds continue to finish or get reconciled by existing daemon recovery.
4. Enabling from `stopping`, `restarting`, `faulted`, or an inert running watcher either resumes a live scheduler or retires the old generation and starts a new watcher. The old `startWatcher()` early return path is removed.
5. Queue mutation routes call `notifyQueueMutation(reason)`. A live scheduler receives the injected `queue:mutation`; desired-enabled non-running states trigger repair/restart instead of silently dropping the wake.
6. `stream:hello.autoBuild` and `GET /api/auto-build` use the same `autoBuildStateToWire` projection for byte-for-byte parity.

## Scope

### In Scope

- Replace module-local ad hoc watcher lifecycle logic in `server-main.ts` with supervisor-owned generation state, bounded drain, restart, fault, and shutdown behavior.
- Replace `DaemonState` auto-build booleans and scheduler callbacks in `server.ts` with a narrow controller field plus shutdown/reload hooks as needed.
- Update auto-build GET/POST, enqueue completion wake, playbook enqueue wake, apply-recovery wake, and scheduler kick to use supervisor methods.
- Preserve `wrapWatcherEvents()` ordering and native event hook/recording/hook composition.
- Preserve failure-triggered pause semantics by converting `maybePauseOnFailure()` to call supervisor pause handling.
- Update extension reload to restart the watcher through the supervisor and return watcher metadata from the controller snapshot.
- Add regression coverage for the inert watcher race and mutation wake repair path.

### Out of Scope

- Rewriting queue ordering, dependency handling, priority handling, or `QueueScheduler.startReadyPrds()`.
- Killing in-flight build subprocesses on auto-build disable.
- Monitor UI rendering changes.
- Database schema migrations.

## Files

### Modify

- `packages/monitor/src/server-main.ts` — Instantiates and wires `AutoBuildSupervisor`; moves watcher generation, abort/drain, scheduler handle registration, pause-on-failure, reload, startup enable, and shutdown behavior behind supervisor methods.
- `packages/monitor/src/server.ts` — Replaces direct auto-build state mutation and scheduler handle checks with controller calls; routes queue mutation wakes through `notifyQueueMutation`; projects REST/SSE snapshots from controller state.
- `packages/monitor/src/auto-build-supervisor.ts` — Adds any integration hooks discovered while wiring `server-main.ts`, while preserving plan-01 reducer semantics and tests.
- `packages/monitor/src/__tests__/auto-build-route.test.ts` — Expands route tests for enable, disable, invalid bodies, controller delegation, inert watcher restart, and scheduler kick wake behavior.
- `packages/monitor/src/__tests__/stream-hello-parity.test.ts` — Updates daemon state fixtures and asserts `stream:hello.autoBuild` equals `GET /api/auto-build` including detail fields.
- `packages/monitor/src/__tests__/daemon-sse-handshake.test.ts` — Updates daemon snapshot fixtures for enriched auto-build state when asserted.
- `test/auto-build-pause-on-failure.test.ts` — Updates pause-on-failure tests to assert supervisor pause is called and scheduler pause happens once.
- `test/auto-build-resume-after-failure.test.ts` — Keeps the existing maxConcurrentBuilds=2 pause/resume regression passing and adds any assertion needed for independent queued PRD dispatch after resume.
- `test/queue-scheduler.test.ts` — Adds or preserves coverage that a live scheduler with `maxConcurrentBuilds: 2` can dispatch an independent queued PRD while capacity remains.
- `test/apply-recovery-route.test.ts` — Updates daemon state fixtures and asserts apply-recovery calls the supervisor wake method after a successful apply.
- `test/extension-tooling-routes.test.ts` — Updates extension reload route fixtures to use supervisor-backed watcher metadata.
- `test/extension-tooling-wiring.test.ts` — Updates static wiring checks to assert reload uses the supervisor rather than direct `stopWatcher()`/`startWatcher()` calls.

## Verification

- [ ] `server.ts` contains no direct references to legacy auto-build fields or callbacks: `daemonState.autoBuild`, `daemonState.autoBuildPaused`, `daemonState.watcher`, `injectSchedulerEvent`, `isSchedulerAlive`, `onSpawnWatcher`, `onKillWatcher`, `onPauseScheduler`, or `onResumeScheduler` after the controller refactor.
- [ ] `POST /api/auto-build` with `{ "enabled": true }` calls `AutoBuildController.enable()` and returns the controller snapshot.
- [ ] `POST /api/auto-build` with `{ "enabled": false }` calls `AutoBuildController.disable()` and returns a snapshot whose mode is `stopping` or `disabled`.
- [ ] A test simulates `watcher.running === true` with a missing or dead scheduler handle; enabling auto-build retires/restarts the watcher generation or surfaces `mode: 'faulted'` with a reason.
- [ ] Queue mutation paths for enqueue completion, playbook enqueue, apply recovery, and scheduler kick call `notifyQueueMutation()` with the expected reason string.
- [ ] A daemon-level regression test with `maxConcurrentBuilds: 2` simulates one auto-build PRD already running and an independent queued PRD; a queue mutation wake dispatches the second PRD without a manual toggle when the supervisor is running.
- [ ] `stream:hello.autoBuild` deep-equals `GET /api/auto-build` for `enabled`, `watcher`, `desired`, `mode`, `scheduler`, and `lastTransition` fields.
- [ ] `pnpm test -- packages/monitor/src/__tests__/auto-build-route.test.ts packages/monitor/src/__tests__/stream-hello-parity.test.ts packages/monitor/src/__tests__/daemon-sse-handshake.test.ts test/auto-build-pause-on-failure.test.ts test/auto-build-resume-after-failure.test.ts test/queue-scheduler.test.ts test/apply-recovery-route.test.ts test/extension-tooling-routes.test.ts test/extension-tooling-wiring.test.ts` exits 0.
