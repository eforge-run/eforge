---
id: plan-01-event-driven-scheduler
name: Replace fs.watch with event-driven QueueScheduler
branch: fix-auto-build-watcher-missing-ready-prds-without-manual-toggle/event-driven-scheduler
agents:
  builder:
    effort: high
    rationale: Refactor extracts a stateful inline closure (~200 lines spanning
      prdState, semaphore, discoverNewPrds, startReadyPrds, propagateBlocked)
      into a class while simultaneously deleting fs.watch and threading a new
      EventEmitter-based bus through the daemon. Cross-package interface
      coordination (engine QueueOptions + monitor DaemonState + client routes)
      needs careful attention to avoid regressions in the existing toggle/abort
      paths.
  reviewer:
    effort: high
    rationale: "The watcher is on the critical auto-build path. Reviewer must
      verify: (a) no behavior regression in toggle OFF/ON, abort, in-flight
      drain, and queue:prd:complete branches; (b) inject-after-abort really is a
      no-op (DaemonState.injectSchedulerEvent must be cleared in every teardown
      branch in server-main.ts); (c) the event pump preserves event ordering
      between yield and bus.emit so consumers (SSE, hooks, persistence) still
      see queue:prd:complete before the scheduler reacts."
---

# Replace fs.watch with event-driven QueueScheduler

## Architecture Context

The daemon's auto-build watcher (`packages/engine/src/eforge.ts:1524` `watchQueue`) currently relies on `fs.watch` to discover newly-enqueued PRDs between build completions. In real-world use against `~/projects/ytc/member-portal/` with `maxConcurrentBuilds: 2`, three queue-stuck reproductions occur (independent enqueue while one builds; dependent unblock; mixed dep + independent), all of which clear when the user toggles Auto-build OFF then ON. The toggle spawns a fresh watcher whose initial scan picks up everything stuck, which proves the scheduler logic is correct - the gap is in **what triggers** `startReadyPrds()`, not in `startReadyPrds()` itself.

The fix replaces `fs.watch` with explicit `queue:mutation` events emitted by every daemon HTTP route that mutates the queue directory, plus an `EventEmitter`-based bus inside `watchQueue`. The scheduling state is extracted into a new `QueueScheduler` class so it is testable in isolation and so the bus subscriptions are explicit at the construction site. The watcher's `for await` consumer becomes a thin pump that yields events to the outer caller and re-emits scheduler-relevant types onto the bus.

This keeps engine-vs-plugin boundaries intact: the engine still emits events, consumers still render. The only new public surface in the engine is `QueueOptions.onInjectEventRegister`, which the daemon uses to capture an `inject(event)` callback so HTTP routes can wake the scheduler.

## Implementation

### Overview

1. Create `packages/engine/src/queue/scheduler.ts` defining `SchedulerInputEvent`, `SCHEDULER_INPUT_TYPES`, and the `QueueScheduler` class.
2. Refactor `watchQueue` in `packages/engine/src/eforge.ts` to instantiate the scheduler, register an inject callback via `onInjectEventRegister`, delete all `fs.watch` machinery, and reduce the consumer loop to a yield-and-bus-emit pump.
3. Add `schedulerKick: '/api/scheduler/kick'` to `API_ROUTES` and a typed `apiSchedulerKick` helper in `@eforge-build/client`.
4. Add `injectSchedulerEvent` to the daemon's `DaemonState` interface, an `emitMutation` helper, and emit calls at the three existing queue-mutating routes (enqueue, playbook enqueue, apply-recovery) plus a new `POST /api/scheduler/kick` handler.
5. Wire `onInjectEventRegister` from `server-main.ts` `startWatcher()` so the captured inject is published onto `daemonState` only while this controller is the active watcher, and cleared in every teardown branch.
6. Add unit tests for `QueueScheduler` and an end-to-end watcher inject test in `test/watch-queue.test.ts`.

### Key Decisions

1. **Discrete scheduler class, not a free function.** The current inline closure shares too much lexical state (prdState, orderedPrds, semaphore, parallelism) for a free function refactor to be readable. A class with private fields makes the dependencies explicit at construction time and gives unit tests a handle they can drive directly with synthetic events.
2. **EventEmitter, not an `AsyncEventQueue`, for the scheduler bus.** The bus must invoke listeners synchronously so two `bus.emit('queue:mutation', ...)` calls in quick succession produce sequential listener invocations - exactly Node's `EventEmitter` contract. `AsyncEventQueue` is for the existing yield path (SSE/hooks/persistence) and remains in use there. Two distinct paths, two distinct primitives.
3. **Pump preserves yield-then-emit ordering.** Inside the new consumer loop the order is `yield event; if relevant, bus.emit(event.type, event);`. Yielding first guarantees downstream consumers (SSE, hooks, persistence) see `queue:prd:complete` before the scheduler reacts and pushes follow-up `session:start` / spawn events onto `eventQueue`. This matches the existing observed ordering and avoids surprising hook-firing reorderings.
4. **`onInjectEventRegister` instead of returning the inject from `watchQueue`.** The watcher is an `AsyncGenerator` whose first `yield` does not happen synchronously when the caller invokes `engine.watchQueue(...)`. A registration callback fires inside the generator body before the consumer pump starts, so the daemon receives the inject in time to satisfy any HTTP request that arrives the moment the watcher comes up.
5. **No `DAEMON_API_VERSION` bump.** Adding a route is additive per the convention in `AGENTS.md` ("Bump `DAEMON_API_VERSION` ... when making breaking changes to the HTTP API surface"). Existing clients that don't know about `/api/scheduler/kick` are unaffected.
6. **Inject is cleared in every teardown branch.** A stale inject closure firing after the generator has aborted would re-emit on a `bus` whose listeners are gone (harmless) but could also race with a newer watcher session if the daemon is being torn down and restarted. To eliminate this concern, `daemonState.injectSchedulerEvent` is unset (a) at the early-bailout returns at server-main.ts:425-430 and 435-441, and (b) in the `finally` block at server-main.ts:472, alongside the existing `daemonState.watcher = { running: false, ... }` reset. The `if (watcherAbort === controller && daemonState)` guard governs the assignment, mirroring the surrounding pattern.

## Scope

### In Scope

- New file `packages/engine/src/queue/scheduler.ts` containing the `SchedulerInputEvent` union, `SCHEDULER_INPUT_TYPES` set, and `QueueScheduler` class.
- Refactor `watchQueue` in `packages/engine/src/eforge.ts` to delete `fs.watch` machinery, instantiate `QueueScheduler`, and reduce the consumer loop to a thin pump.
- Extend `QueueOptions` with `onInjectEventRegister?: (inject: (event: SchedulerInputEvent) => void) => void`.
- Add `schedulerKick` route to `API_ROUTES` and typed `apiSchedulerKick` helper in `@eforge-build/client`, exported from `packages/client/src/index.ts`.
- Add `injectSchedulerEvent` to `DaemonState`, the `emitMutation` helper, route emits at three existing sites, and a new `POST /api/scheduler/kick` route handler.
- Wire `onInjectEventRegister` from `server-main.ts` `startWatcher()` and clear `injectSchedulerEvent` in every teardown branch.
- Unit tests for `QueueScheduler` driven by a stub bus and stub `spawnPrdChild`.
- End-to-end watcher inject test in `test/watch-queue.test.ts`.

### Out of Scope

- `POST /api/recover` (server.ts:1004): writes recovery sidecars outside the active queue tree (under `eforge/queue/failed/`), so the scheduler does not care.
- Cancel: a SIGTERM'd build still emits `queue:prd:complete` via the parent's exit handler in `spawnPrdChild` (eforge.ts:1257); no new path needed.
- Monitor UI, MCP plugin, Pi extension: this is daemon-internal plumbing.
- `runQueue` (the one-shot non-watch path): unchanged.
- `DAEMON_API_VERSION` bump: not required for an additive route.

## Files

### Create

- `packages/engine/src/queue/scheduler.ts` - exports `SchedulerInputEvent` union, `SCHEDULER_INPUT_TYPES` set, and `QueueScheduler` class. Class constructor takes `{ bus, cwd, queueDir, config, configProfile, parallelism, abortController, eventQueue, spawnPrdChild, options }`. Public methods: `start(): Promise<void>` (initial scan + first `tick()` + bus subscriptions), and read-only state accessors used by `watchQueue` to compute the final `processed`/`skipped` counters at shutdown. Private members: `prdState`, `orderedPrds`, `semaphore`, `processed`, `skipped`, `isReady()`, `propagateBlocked()`, `discoverNewPrds()`, `startReadyPrds()`, `tick()`, `onComplete()`, `onMutation()`. Bus subscriptions are registered in `start()`, not the constructor, so callers can attach listeners after the scheduler exists but before it has emitted any spawn calls.
- `packages/client/src/api/scheduler.ts` - exports `apiSchedulerKick(opts: { cwd: string }): Promise<{ ok: true }>` mirroring the shape of `apiHealth` / `apiKeepAlive` in `packages/client/src/api/status.ts`.
- `test/queue-scheduler.test.ts` - unit tests for `QueueScheduler` driven by a stub `EventEmitter` and a stub `spawnPrdChild`.

### Modify

- `packages/engine/src/eforge.ts` (lines ~75-100, ~1519-1875) - extend `QueueOptions` with `onInjectEventRegister?: (inject: (event: SchedulerInputEvent) => void) => void`. In `watchQueue`: instantiate `bus = new EventEmitter()`, instantiate `QueueScheduler`, call `options.onInjectEventRegister?.((event) => bus.emit(event.type, event))`, call `await scheduler.start()`. Replace the existing for-await consumer body with the thin pump (yield + conditional `bus.emit`). Delete: `FSWatcher` import, `watcher`/`debounceTimer`/`failureTimestamps` locals, `MAX_CONSECUTIVE_FAILURES`/`FAILURE_WINDOW_MS` constants, `setupWatcher()` function and its call, the inline scheduler closure (`prdState`, `orderedPrds`, `semaphore`, `isReady`, `propagateBlocked`, `discoverNewPrds`, `startReadyPrds`). Keep: `eventQueue.addProducer()` (refcount keeping the consumer loop alive between builds; update its comment to "Watcher producer - keeps the consumer loop alive while the watcher is running."); the build-subprocess IIFE that pushes `queue:prd:complete` onto `eventQueue` (still flows through the pump and reaches the bus). Simplify `onAbort` to `bus.removeAllListeners(); eventQueue.removeProducer();`. Read final `processed`/`skipped` counts off the scheduler accessor for the terminal `queue:complete` yield.
- `packages/client/src/routes.ts` - add `schedulerKick: '/api/scheduler/kick'` to `API_ROUTES` (alongside other auto-build routes near line 102-103). No `DAEMON_API_VERSION` bump.
- `packages/client/src/index.ts` - re-export `apiSchedulerKick` from the new `./api/scheduler.js` module.
- `packages/monitor/src/server.ts` - import `SchedulerInputEvent` type from `@eforge-build/engine` (or a shared path; if engine doesn't already re-export it, add a single named export from `packages/engine/src/index.ts` or wherever the public engine surface lives). Add `injectSchedulerEvent?: (event: SchedulerInputEvent) => void` to the `DaemonState` interface near line 148. Define a top-of-file helper `emitMutation(state: DaemonState | undefined, reason: 'enqueue' | 'playbook-enqueue' | 'apply-recovery' | 'external'): void`. Wire emits at three existing sites: enqueue route line 941 (use the third `onExit` argument of `spawnWorker`); playbook enqueue route after `commitEnqueuedPrd` line 1541; apply-recovery route line 1069 (third `onExit` argument). Add new route handler `POST /api/scheduler/kick` near the auto-build routes (~line 1115) that returns `503` when `daemonState` is missing and `{ ok: true }` otherwise (no-op when `injectSchedulerEvent` is undefined).
- `packages/monitor/src/server-main.ts` - in `startWatcher()` (~line 446), pass `onInjectEventRegister: (inject) => { if (daemonState && watcherAbort === controller) daemonState.injectSchedulerEvent = inject; }` into `engine.watchQueue({ ... })`. Clear `daemonState.injectSchedulerEvent = undefined` in: (a) the early-bailout paths at lines 425-430 and 435-441, (b) the `finally` block at line 472 alongside the existing watcher-state reset, gated by `watcherAbort === controller` so a stale teardown cannot clear a newer watcher's inject.
- `test/watch-queue.test.ts` - add an end-to-end watcher inject test (described in Verification).

## Verification

- [ ] `pnpm type-check` exits 0.
- [ ] `pnpm test` exits 0; the new `test/queue-scheduler.test.ts` and `test/watch-queue.test.ts` additions pass.
- [ ] **Independent parallel start (PRD scenario 1):** With auto-build ON and `maxConcurrentBuilds: 2`, after enqueueing PRD A then independent PRD B while A is running, B's `queue:prd:start` event fires within 1 s of the enqueue worker's `onExit` callback, with no UI interaction.
- [ ] **Dependent unblock (PRD scenario 2):** With auto-build ON, A running and B (`depends_on: [A]`) queued, B's `queue:prd:start` event fires within 1 s of A's `queue:prd:complete` event.
- [ ] **Mixed dep + independent (PRD scenario 3):** With auto-build ON, A then B (`depends_on: [A]`) then independent C, A and C `queue:prd:start` events fire within 1 s of C's enqueue worker `onExit`; B's `queue:prd:start` event fires within 1 s of A's `queue:prd:complete`.
- [ ] **Apply-recovery retry kick:** After auto-build pauses on a failed build, toggling auto-build ON and clicking Retry in the monitor UI (which drives `apply-recovery`) results in the retried PRD's `queue:prd:start` event firing without a second toggle.
- [ ] **Playbook chained enqueue:** With auto-build ON, enqueuing a playbook with `afterQueueId` lands the chained PRD in `eforge/queue/waiting/` and a `queue:prd:start` event for it fires after its upstream completes.
- [ ] **Toggle path unchanged:** Toggling auto-build OFF mid-build allows in-flight builds to drain (no new `queue:prd:start` events), and toggling back ON spawns a fresh watcher whose `start()` initial scan launches anything pending.
- [ ] **Unit test - scheduler in isolation:** `test/queue-scheduler.test.ts` constructs a `QueueScheduler` against a stub `EventEmitter` and a stub `spawnPrdChild`, drives it with a synthetic `{ type: 'queue:mutation', reason: 'enqueue', timestamp }` event, and asserts `spawnPrdChild` is called for the newly-discovered PRD. A second test drives `{ type: 'queue:prd:complete', status: 'completed', prdId, timestamp }` and asserts the dependent PRD's `spawnPrdChild` call follows. A third test drives `{ status: 'failed' }` and asserts dependents are marked blocked (no `spawnPrdChild` call). No subprocess, no daemon, no filesystem watcher.
- [ ] **End-to-end watcher inject test:** In `test/watch-queue.test.ts`, a new test constructs `engine.watchQueue({ abortController, onInjectEventRegister })` capturing the inject callback, writes a PRD file to the temp queue dir, then invokes `inject({ type: 'queue:mutation', reason: 'external', timestamp: new Date().toISOString() })` and asserts a `queue:prd:start` event for that PRD is yielded by the generator.
- [ ] **Inject is a no-op after abort:** A symmetrical test in `test/watch-queue.test.ts` aborts the controller, lets the generator finish, then calls the captured inject. The call returns without throwing and produces no further yielded events. (The inject closure runs against a `bus` whose listeners were removed in `onAbort`; this asserts that contract.)
- [ ] **`fs.watch` deletion is complete:** `rg "fs.watch|FSWatcher|MAX_CONSECUTIVE_FAILURES|FAILURE_WINDOW_MS|setupWatcher" packages/engine/src/eforge.ts` returns no matches.
- [ ] **Inject clearing is complete:** `rg "injectSchedulerEvent" packages/monitor/src/server-main.ts` shows the assignment in `startWatcher()` and at least three `= undefined` clears (two early-bailout paths + the `finally` block).
- [ ] **Route surface check:** A POST to `/api/scheduler/kick` against a running daemon returns `200 { ok: true }`; against a non-daemon-mode server returns `503 { error: 'Daemon mode not active' }`.
