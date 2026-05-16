---
title: Redesign Auto-Build Queue Watcher Lifecycle Around an FSM/Supervisor
created: 2026-05-16
depends_on: ["implement-blocking-policy-gates"]
profile: pi-codex-5-5
---

# Redesign Auto-Build Queue Watcher Lifecycle Around an FSM/Supervisor

## Problem / Motivation

Observed defect from live daemon state and monitor DB:

- Auto-build can report `enabled: true` with `watcher.running: true` while no live scheduler is able to accept queue mutations.
- A second independent queued PRD did not start despite `maxConcurrentBuilds: 2` and no `depends_on` frontmatter.
- Monitor DB showed repeated `daemon:error` events from `auto-build:enable`: `Watcher marked running but scheduler is inert (handle missing or aborted); restarting watcher`, followed by no new dequeue/build start.

Evidence sources:

- `docs/roadmap.md` frames the daemon as the single orchestration authority; this aligns with moving scattered lifecycle logic into a daemon-owned supervisor.
- `packages/monitor/src/server-main.ts` currently owns in-process watcher lifecycle with module-local `watcherAbort` and `watcherDone`. `startWatcher()` returns early when `watcherAbort` is non-null, even if the scheduler is inert/draining; `stopWatcher()` aborts and waits boundedly but leaves `watcherAbort` non-null until the generator drains.
- `packages/monitor/src/server.ts` stores auto-build state as independent fields/callbacks on `DaemonState`: `autoBuild`, `autoBuildPaused`, `watcher`, `injectSchedulerEvent`, `onSpawnWatcher`, `onKillWatcher`, `onPauseScheduler`, `onResumeScheduler`, and `isSchedulerAlive`.
- `POST /api/auto-build` mutates `daemonState.autoBuild` directly, checks for missing scheduler handles, logs an inert-watcher restart message, then calls `onSpawnWatcher`; however `onSpawnWatcher` delegates to `startWatcher()`, whose early return can make the restart a no-op.
- `QueueScheduler` already has useful lifecycle primitives (`pause()`, `resume()`, `isAlive` through the control handle) and respects `maxConcurrentBuilds` when live. Existing scheduler tests passed, so the core scheduling algorithm is not the primary suspect.
- `emitMutation()` in `server.ts` is a no-op when `injectSchedulerEvent` is absent. That means enqueue/apply-recovery/kick routes can silently fail to wake scheduling if the watcher state and scheduler handle drift.

Evidence-backed conclusion:

The current design permits contradictory state because desired auto-build state, watcher process/generator lifecycle, scheduler handle liveness, and pause/resume semantics are represented as loosely coupled booleans and callbacks. A supervisor/FSM should make impossible states explicit and centralize transitions.

## Goal

Implement a daemon-local auto-build supervisor/FSM that owns desired auto-build state, watcher lifecycle, scheduler handle liveness, pause/resume, and queue mutation wakeups, plus a clearer monitor UI for the scheduler FSM state.

This is a daemon architecture and monitor UI state-model change, not an engine scheduling rewrite.

## Approach

### Target Architecture

Introduce a single auto-build lifecycle owner in monitor daemon code: `AutoBuildSupervisor`.

The supervisor separates:

- desired state: whether the user/config wants auto-build enabled;
- runtime state: whether a watcher is starting/running/paused/stopping/restarting/faulted;
- scheduler handle liveness: whether mutation injection and pause/resume are currently available.

Architecture changes:

- `server-main.ts` becomes the integration layer that supplies primitives to the supervisor: create engine, start/drain watcher event loop, stop/abort watcher, write daemon events, write pause events, and wrap events.
- `server.ts` becomes a caller of supervisor methods via `DaemonState` or a narrower `AutoBuildController` interface; it should not decide restart semantics itself.
- Queue mutation routes call a supervisor wake method rather than directly poking `injectSchedulerEvent`.
- REST/SSE auto-build snapshots are projected from supervisor state through the existing single JSON projection path (`autoBuildStateToWire`).
- The client wire schema (`packages/client/src/events.schemas.ts` / `types.ts`) likely needs additive fields on `AutoBuildState`, e.g. `mode`, `desired`, `scheduler`, `lastTransition`, and/or `reason`. Existing `enabled` and `watcher` fields should remain for compatibility.
- The monitor UI reducer receives the richer snapshot via existing `useDaemonEvents` and renders it in `DaemonDrawer`; heartbeat `autoBuild` can remain coarse while the drawer card shows detailed FSM state.

### Current Architecture

- `server-main.ts` owns watcher process/generator lifecycle with local variables `watcherAbort` and `watcherDone`.
- `server.ts` owns HTTP routes and mutates `DaemonState` directly.
- `DaemonState` mixes desired state (`autoBuild`), pause reason (`autoBuildPaused`), watcher display state (`watcher`), scheduler handles (`injectSchedulerEvent`, `onPauseScheduler`, `onResumeScheduler`, `isSchedulerAlive`), and operational callbacks (`onSpawnWatcher`, `onKillWatcher`).
- `emitMutation()` silently no-ops when `injectSchedulerEvent` is absent.
- The monitor UI daemon drawer (`packages/monitor-ui/src/components/daemon/daemon-drawer.tsx`) currently shows heartbeat metrics and an event list. The screenshot demonstrates that `Auto-build: enabled` can be misleading because it does not expose scheduler FSM/liveness.

### Expected Module / Package Impact

- `packages/monitor/src/server-main.ts`: substantial lifecycle refactor; create and wire supervisor, remove or shrink `watcherAbort`/`watcherDone` ad hoc logic.
- `packages/monitor/src/server.ts`: route simplification; replace direct `daemonState.autoBuild = ...`, `onSpawnWatcher`, `onKillWatcher`, and inert-handle checks with controller calls.
- `packages/client/src/events.schemas.ts`, `packages/client/src/types.ts`: additive auto-build scheduler state fields if the UI needs them from REST/SSE.
- `packages/monitor-ui/src/components/daemon/daemon-drawer.tsx`: add scheduler/FSM card and event grouping.
- `packages/monitor-ui/src/lib/daemon-reducer.ts` and associated tests: update `AutoBuildState` usage and snapshot handling if fields are added.
- `packages/monitor/src/__tests__/auto-build-route.test.ts`: update/expand route behavior tests.
- New focused tests for supervisor transitions, preferably without real subprocesses.

No architecture impact expected in:

- `packages/engine/src/queue/scheduler.ts` beyond maybe exposing a small liveness/capacity detail if the supervisor needs it. Existing pause/resume/isAlive controls already provide enough for the current design.
- `packages/engine/src/eforge.ts` watchQueue pump semantics.
- PRD queue parser/ordering.

### Design Decisions

1. **Model auto-build as a supervisor-owned FSM, not scattered booleans.**
   - Decision: introduce an explicit runtime state union, e.g. `disabled | starting | running | paused | stopping | restarting | faulted`.
   - Rationale: the observed bug is an impossible/contradictory state (`enabled + watcher.running + scheduler inert`). A discriminated union makes such states representable only as explicit `stopping`, `restarting`, or `faulted` states.

2. **Separate desired state from runtime state.**
   - Decision: store user/config intent separately from watcher/scheduler runtime mode, e.g. `desired: 'enabled' | 'disabled'` plus `mode`.
   - Rationale: disabling while builds are in flight and enabling while a watcher is draining are transitional states, not simple booleans.

3. **Use a small hand-written reducer/supervisor rather than an external FSM library.**
   - Decision: implement local transition functions and a class wrapper for side effects.
   - Rationale: the state space is small, daemon-local, and easy to unit-test. Avoid adding dependency and runtime complexity unless implementation discovers the transition set is larger than expected.

4. **Centralize side effects behind supervisor methods.**
   - Decision: HTTP routes and enqueue/recovery/kick routes call methods such as `enable()`, `disable()`, `pauseOnFailure(reason)`, `notifyQueueMutation(reason)`, and `getSnapshot()`.
   - Rationale: `server.ts` should not independently decide whether to spawn, resume, restart, or no-op; otherwise route logic can drift from watcher lifecycle logic again.

5. **Disable should suspend launches immediately, then drain/stop safely.**
   - Decision: on user disable, set desired disabled, pause/suspend scheduler launches if a scheduler handle exists, then transition to `stopping`/`disabled` when the watcher can be safely stopped or has drained. In-flight PRD builds should not be killed by the auto-build toggle.
   - Rationale: this preserves the current principle that stopping auto-build does not cancel builds, but avoids the current abort/draining race where re-enable cannot start a fresh watcher.

6. **Enable from transitional states must be repair-oriented.**
   - Decision: `enable()` from `stopping`, `faulted`, or `restarting` must not call a start function that can silently return. It should either resume a live scheduler or explicitly replace/await the old watcher and start a new one.
   - Rationale: fixes the observed no-op restart path.

7. **Queue mutation is a wake/repair signal.**
   - Decision: if a queue mutation arrives while desired state is enabled but runtime is not `running`, the supervisor should attempt to bring the watcher to `running` instead of silently dropping the mutation.
   - Rationale: enqueue/playbook/apply-recovery are the events users expect auto-build to react to.

8. **Keep the first wire change additive.**
   - Decision: retain existing `AutoBuildState.enabled` and `watcher` fields and add optional/detail fields for FSM/UI rather than replacing the contract in one step.
   - Rationale: reduces blast radius for monitor UI, Pi/Claude tools, and clients. Breaking HTTP/API changes should only happen if necessary and would require `DAEMON_API_VERSION` review.

9. **Make the daemon drawer explain scheduler health visually.**
   - Decision: in the existing `Daemon Activity` drawer, add a top card with a colored FSM status chip, short explanation, and key fields: desired state, runtime state, scheduler handle status, watcher session id, last transition/reason, queue depth/running builds, and available capacity if known.
   - Rationale: the screenshot shows the current drawer buries meaningful lifecycle information in a raw event list and displays only `Auto-build enabled`, which can be false confidence.

10. **Group scheduler events in the UI.**
    - Decision: keep the activity feed, but add a `scheduler` filter/group or a small recent-transition list in the FSM card for `daemon:auto-build:*`, `daemon:scheduler:*`, `queue:mutation`, and `daemon:error` from scheduler/auto-build sources.
    - Rationale: users should not have to scan generic daemon activity to understand why a queued PRD is not building.

11. **Do not make the UI infer state from event history.**
    - Decision: the UI should render canonical supervisor snapshot fields from REST/SSE, with event history used only for context.
    - Rationale: reconnects, retention, and missed transient events make event-derived FSM state fragile.

### Assumptions And Validation

| Assumption | Evidence / validation performed | Confidence | Cost to validate further | Validation path | Impact if wrong |
|------------|----------------------------------|------------|--------------------------|-----------------|-----------------|
| The root issue is daemon watcher/supervisor state drift rather than `QueueScheduler` parallelism. | Live status showed one running build and one independent pending PRD with `maxConcurrentBuilds: 2`; monitor DB showed inert-watcher restart messages; scheduler tests passed; `QueueScheduler.startReadyPrds()` enforces parallelism when live. | High | Low | Add regression test that simulates inert watcher + enabled auto-build and verifies supervisor repair; keep scheduler tests. | If wrong, FSM refactor would improve observability but not fix the actual non-dequeue bug. |
| A hand-written FSM is sufficient; no third-party FSM library is needed. | Current lifecycle states and transitions are few and daemon-local; TypeScript discriminated unions can enforce state shape. | High | Low | Prototype reducer tests before side-effect integration. | If wrong, implementation may become tangled; can still swap reducer internals for a library later. |
| Existing `AutoBuildState` wire shape can be extended additively. | Client schema/type currently has `enabled` and `watcher`; UI consumes via `useDaemonEvents` and `useAutoBuild`. Adding optional/detail fields should not break existing consumers if schemas/types are updated consistently. | Medium | Low | Check TypeBox schema strictness and generated/compiled consumers during implementation; run type-check and UI tests. | If wrong, wire change may require broader client/daemon API version handling. |
| Manual disable should pause/suspend launches and drain rather than aborting in a way that leaves a half-dead watcher. | Current abort/drain behavior contributes to the observed no-op restart race. Existing comments say in-flight PRD subprocesses are not killed by stopping watcher, so preserving build drain is already intended. | Medium | Medium | Implement reducer tests and a daemon lifecycle test; verify actual watcher generator can be stopped/replaced without leaking producers. | If wrong, disable behavior might surprise users or leave watcher resources alive longer than expected. |
| The monitor UI should render supervisor snapshot state, not infer state from events. | Current drawer screenshot shows event history but only a coarse heartbeat `Auto-build enabled` label. Event retention/reconnect makes inference fragile. | High | Low | Add UI tests passing sample `AutoBuildState` snapshots for each FSM mode. | If wrong, UI could drift from real daemon state and repeat the same false-confidence problem. |
| Queue mutation routes can call a supervisor wake method without changing route contracts. | `emitMutation()` is local to `server.ts` and currently no-ops when the scheduler handle is missing. Replacing it with a controller method is internal to the daemon route implementation. | High | Low | Update route tests for enqueue/playbook/apply-recovery/kick wake behavior. | If wrong, API route changes could become broader than planned. |
| The UI card can fit in the existing daemon drawer without broader layout work. | Screenshot shows the drawer already has a heartbeat block and activity list; adding one compact card above metrics is a contained change. | High | Low | Implement component story/test with representative states and inspect in browser. | If wrong, layout may require more CSS/UX work but not deeper backend changes. |

No unresolved low-confidence/high-impact assumptions are currently identified. The main medium-confidence items are disable semantics and additive wire shape; both have low-to-medium validation paths and should be validated before final implementation.

### Early Assumptions / Unknowns

- Assumption: a small hand-written TypeScript FSM/supervisor is enough; no external state-machine library is needed. Confidence: high. Validation cost: low. Evidence: current transitions are few and daemon-local.
- Assumption: the first implementation can preserve existing HTTP wire shape while adding internal supervisor fields and maybe optional observability. Confidence: medium. Validation cost: low; check `AutoBuildState` schema and UI consumers before final design.
- Unknown: whether manual auto-build disable should abort the watcher or pause/drain it. This needs a design decision because the current abort behavior is a contributor to the race, but users may expect disable to stop future scheduling immediately.

### Profile Signal

Recommended eforge profile: **Excursion**.

Rationale: this is cross-cutting daemon/client/UI architecture work, but it is cohesive around one lifecycle subsystem. A single planner can enumerate the state model, route integration, wire shape, monitor UI, and tests. It is too risky for Errand because it changes daemon control flow and scheduler observability. It does not require Expedition because it does not need delegated module planning across independent subsystems; the queue engine itself is intentionally out of scope.

## Scope

### In Scope

- Add a small hand-written TypeScript supervisor/reducer in `packages/monitor/src/` (for example `auto-build-supervisor.ts`) with explicit runtime states such as `disabled`, `starting`, `running`, `paused`, `stopping`, `restarting`, and `faulted`.
- Move auto-build mutations out of ad hoc `DaemonState` field/callback manipulation in `packages/monitor/src/server.ts` and `server-main.ts` into supervisor methods (`enable`, `disable`, `pauseOnFailure`, `notifyQueueMutation`, `restart/reload`, snapshot).
- Preserve current watcher engine integration: the watcher still runs `EforgeEngine.watchQueue()` in-process, uses existing `QueueScheduler` pause/resume controls, records events through `wrapWatcherEvents`, and emits daemon events through existing DB helpers.
- Fix the specific inert-watcher race: enabling auto-build while an old watcher is aborting/draining must either resume a live scheduler or start a new watcher after replacing/awaiting the old one; it must not log a restart and then no-op.
- Ensure queue mutations from enqueue/playbook/apply-recovery/kick trigger scheduling when auto-build is enabled, and repair/restart the watcher when the desired state is enabled but runtime state is not runnable.
- Add additive auto-build/scheduler lifecycle data to the daemon REST/SSE snapshot so the UI can show the FSM state and not merely `enabled`/`watcher.running`.
- Improve the daemon drawer shown in the provided screenshot (`Daemon Activity`) with a dedicated scheduler/auto-build FSM card: current state, desired state, watcher session, scheduler liveness, queue depth/running builds/capacity where available, last transition/reason, and recent scheduler events.
- Add regression tests for the previously observed race, including `maxConcurrentBuilds: 2` with an independent queued PRD while another build is running.

### Out of Scope

- Rewriting the core `QueueScheduler` scheduling algorithm.
- Changing PRD queue file format, dependency semantics, or priority ordering.
- Adding a third-party FSM library unless implementation discovers a compelling need.
- Building a broad new monitor UI; the UI work is limited to clearer scheduler/FSM status in the existing daemon drawer/header surfaces.
- Changing worker subprocess execution or the compile/build pipeline.

## Acceptance Criteria

### Functional Daemon Behavior

- Auto-build cannot report a healthy/runnable state while the scheduler injection handle is missing or the scheduler is aborted. Such a condition is represented as `starting`, `stopping`, `restarting`, or `faulted` with a reason.
- With `maxConcurrentBuilds: 2`, enqueueing an independent PRD while one auto-build PRD is running starts the second PRD without requiring a manual toggle.
- Disabling auto-build while a build is in flight prevents new PRD dispatches immediately and does not cancel the in-flight build.
- Re-enabling auto-build while the previous watcher is draining/stopping eventually results in a live scheduler or a visible `faulted` state; it must not silently no-op.
- Queue mutations from enqueue, playbook enqueue, apply recovery, and scheduler kick either inject into the live scheduler or trigger supervisor repair when desired auto-build state is enabled.
- Failure-triggered pause still suspends new PRD launches while allowing completion handling to finalize state, preserving existing pause/resume semantics.

### API / Wire Behavior

- Existing `AutoBuildState.enabled` and `watcher` fields remain available.
- Any added FSM/detail fields are represented in `packages/client/src/events.schemas.ts` and `packages/client/src/types.ts`, and `stream:hello.autoBuild` remains byte-for-byte consistent with `GET /api/auto-build` for shared fields.
- Daemon events are emitted for meaningful supervisor transitions (`enabled`, `disabled`, `paused`, `resumed`, `restarting`, `faulted` or equivalent), with reason/source where relevant.

### UI Behavior

- The daemon drawer contains a scheduler/FSM status card above or near the heartbeat metrics.
- The card shows at minimum: desired auto-build state, runtime FSM state, scheduler liveness, watcher session id when present, last transition/reason, queue depth, and running builds.
- The card uses distinct visual treatments for healthy/running, paused, transitional, disabled, and faulted/inert states.
- The activity area can filter or highlight scheduler-related events (`daemon:auto-build:*`, `daemon:scheduler:*`, scheduler/auto-build `daemon:error`, and queue wakeups if exposed).
- The UI no longer gives the impression that `Auto-build enabled` means the scheduler is runnable when it is not.

### Tests

- Add unit tests for supervisor transition reducer: enable from disabled, disable from running, enable while stopping, fault then enable, queue mutation while enabled but not running, and failure pause/resume.
- Add route-level tests for `POST /api/auto-build` delegating to supervisor behavior instead of directly mutating scattered state.
- Add or update monitor UI tests for rendering FSM states in the daemon drawer.
- Add regression coverage for the observed race: old watcher still marked running/inert, auto-build enable requested, new scheduler becomes runnable or fault is surfaced.
- Existing scheduler pause/resume tests continue to pass.

### Validation Commands

```bash
pnpm test -- packages/monitor/src/__tests__/auto-build-route.test.ts packages/monitor-ui/src/**/*.test.ts test/auto-build-resume-after-failure.test.ts test/queue-scheduler.test.ts
pnpm type-check
pnpm build
```
