---
id: plan-01-scheduler-pause-resume-lifecycle
name: Decouple auto-build pause from watcher abort and make re-enable deterministic
branch: fix-auto-build-scheduler-pause-resume-after-a-failed-queued-build-so-parallelism-and-independent-queued-builds-continue-correctly/plan-01-scheduler-pause-resume-lifecycle
agents:
  builder:
    effort: high
    rationale: "Lifecycle race fix across engine and daemon: scheduler pause/resume
      state, watcher pump ordering, callback wiring through DaemonState, and
      HTTP route re-enable behavior. Requires careful reasoning about async
      event flow (yield-vs-bus-emit, abort listener ordering, eventQueue
      producer accounting) plus regression tests using real QueueScheduler +
      AsyncEventQueue."
  reviewer:
    effort: high
    rationale: Correctness review must verify the race is actually closed (failed
      PRD finalizes in scheduler state before any abort that could remove bus
      listeners), that re-enable cannot leave autoBuild=true with no effective
      scheduler, and that queue mutation injection cannot silently no-op.
  tester:
    effort: high
    rationale: Regression tests need to drive the real race using real
      QueueScheduler, EventEmitter, and AsyncEventQueue (no mocks per repo
      convention). Verifying that scheduler state is finalized and capacity is
      recovered after a failed completion requires careful event-ordering setup.
---

# Decouple auto-build pause from watcher abort and make re-enable deterministic

## Architecture Context

The daemon owns queue orchestration via `EforgeEngine.watchQueue()` (`packages/engine/src/eforge.ts`) which creates a `QueueScheduler` (`packages/engine/src/queue/scheduler.ts`) wired to an `EventEmitter` bus and an `AsyncEventQueue`. The watcher pump yields events outward to the daemon consumer first, then re-emits scheduler-relevant types onto the bus so `QueueScheduler.onComplete()` can finalize PRD state and trigger new launches.

In the persistent daemon (`packages/monitor/src/server-main.ts`), the watcher consumer inspects each event with `maybePauseOnFailure()`. On a failed `queue:prd:complete`, it currently flips `daemonState.autoBuild = false`, sets `autoBuildPaused = true`, and synchronously calls `onKillWatcher()`. That callback aborts the watcher's `AbortController`, whose abort listener calls `bus.removeAllListeners()` and `eventQueue.removeProducer()`. The pump loop body has already executed `yield event` but has not yet reached `bus.emit(event.type, event)` for the same iteration. By the time the pump tries to emit, the listeners are gone — so `QueueScheduler.onComplete()` never runs for the failed PRD. The PRD's in-memory state stays at `running`, so `QueueScheduler.startReadyPrds()`'s capacity calculation (`prdState.status === 'running'`) treats one slot as permanently occupied even though the child has exited and the queue lock is gone.

Re-enable in `packages/monitor/src/server.ts` (auto-build POST route) only spawns a fresh watcher when `daemonState.watcher.running === false`. During the abort/drain window, `watcher.running` can still be true (the IIFE in `startWatcher`'s `finally` clears it only after `watcherDone` resolves), so re-enable becomes a no-op for spawn but still flips `autoBuild = true` and emits `daemon:auto-build:resumed`. Net effect: UI shows enabled, scheduler is inert, independent pending PRDs never start.

## Implementation

### Overview

Separate "pause new launches" from "abort the watcher". When a queued PRD fails, suspend the scheduler so no new PRDs are dequeued, but keep the watcher generator and bus alive long enough for the failed `queue:prd:complete` to flow through `QueueScheduler.onComplete()` and finalize state. On re-enable, resume the scheduler (clearing the suspended flag triggers an immediate re-tick) when a live watcher exists; otherwise spawn a fresh watcher. Guard the route against the "enabled but inert" state by detecting a missing `injectSchedulerEvent` handle and either restarting the watcher or emitting a `daemon:error`.

### Key Decisions

1. **Add a `suspended` flag to `QueueScheduler`.** When set, `startReadyPrds()` returns early (after the dequeue-loop guard) and emits a single `daemon:scheduler:paused` diagnostic per transition for observability. `onComplete()` still runs to full completion (status finalization, `propagateBlocked`, `discoverNewPrds`) — only the subsequent `startReadyPrds()` call is gated by the flag. Rationale: keeps state transitions intact during pause; resuming is a simple flag flip plus a tick.

2. **Expose scheduler control to the daemon via a register callback.** Add an `onSchedulerControlRegister` option to `QueueOptions` mirroring the existing `onInjectEventRegister` pattern. `watchQueue()` calls it once after constructing the scheduler, passing `{ pause: () => scheduler.pause(), resume: () => scheduler.resume(), isAlive: () => !abortController.signal.aborted }`. Rationale: matches existing callback-registration idiom (`packages/engine/src/eforge.ts:1648`); avoids leaking the scheduler instance.

3. **`maybePauseOnFailure` calls `onPauseScheduler` instead of `onKillWatcher`.** The watcher keeps running; the scheduler stops launching new PRDs; the failed completion is processed normally by `onComplete()`. The route's manual "disable auto-build" path (toggle off) continues to call `onKillWatcher` for a full abort — that is the intended UX for manual disable. Rationale: matches the PRD's stated product semantics (pause = stop new starts, drain in-flight; manual disable = stop everything).

4. **Pump ordering: emit on bus BEFORE yield.** Currently `yield event; if (...) bus.emit(...)`. Reverse it: `if (SCHEDULER_INPUT_TYPES.has(event.type)) bus.emit(event.type, event); yield event;`. This guarantees the scheduler's bus handler is queued (microtask) before the consumer's synchronous reaction runs. Combined with decision #3 (no synchronous abort on pause), the pump-ordering change is belt-and-suspenders: even if some future code path does call `onKillWatcher()` synchronously inside the consumer, the bus listener has already been notified. Rationale: addresses the second part of the documented race (PRD's "yield-before-bus-emit abort race"). The existing docstring on `onComplete` claims "the pump yields the event to downstream consumers BEFORE emitting it on the bus, so session:start / spawn events pushed here appear after the completion event in the outer consumer's view" — this guarantee is restated to acknowledge that `onComplete`'s subsequent pushes to `eventQueue` are async (they enqueue into the AsyncEventQueue which the pump reads later), so flipping the bus-emit-vs-yield order does NOT cause out-of-order events in the outer stream. Update the docstring to reflect the new ordering.

5. **Re-enable repair path.** In the auto-build POST route, when `enabled === true`:
   - If `watcher.running === false` OR `injectSchedulerEvent === undefined`: call `onSpawnWatcher()`. If `injectSchedulerEvent` is undefined while `watcher.running === true` and `autoBuild` is being enabled, emit `daemon:error` (source: `auto-build:enable`) before spawning so observers see the repair.
   - Else: call `onResumeScheduler()` if available; the scheduler clears its suspended flag and re-ticks.
   The existing `wasPaused`/`autoBuildPaused` logic for emitting `daemon:auto-build:resumed` vs `daemon:auto-build:enabled` stays as-is.

6. **No DB schema or wire-format changes.** `DaemonState` gains internal callback fields (`onPauseScheduler`, `onResumeScheduler`) that are not exposed over the HTTP wire. `autoBuildPaused` is already part of the wire shape. Rationale: preserves API stability; no `DAEMON_API_VERSION` bump.

## Scope

### In Scope
- Scheduler pause/resume state on `QueueScheduler` and the watcher-side wiring to expose it.
- Watcher pump ordering change (emit on bus before yield).
- `maybePauseOnFailure` switches from `onKillWatcher` to `onPauseScheduler`.
- Auto-build POST route: detect aborted/draining/inert watcher state on enable and spawn fresh; call `onResumeScheduler` when a live watcher exists.
- Regression tests covering: (a) failure pause + resume with `maxConcurrentBuilds: 2` and an independent pending PRD, (b) the yield-before-bus-emit race captured at the pump level, (c) route-level POST auto-build with paused/draining/stale scheduler handle, (d) the in-process simulation ported into vitest using real `QueueScheduler`, real `EventEmitter`, real `AsyncEventQueue`.

### Out of Scope
- Broader queue architecture rewrite, queue snapshot/SSE drift, queue UI changes.
- Changing the existing "pause auto-build on failure" UX (the existing trigger is desired).
- Manual-disable behavior (POST auto-build with `enabled: false`) continues to fully abort the watcher.
- Changes to recovery/sidecar flows.
- Wire-format changes (no `DAEMON_API_VERSION` bump).

## Files

### Modify

- `packages/engine/src/queue/scheduler.ts` — Add private `suspended: boolean` field. Add public `pause()` (sets `suspended = true`, pushes one `daemon:scheduler:paused` diagnostic event to `eventQueue` on transition) and `resume()` (sets `suspended = false`, pushes one `daemon:scheduler:resumed` diagnostic event on transition, then invokes `tick()` to discover and launch). In `startReadyPrds()`, after the existing `runningCount` setup and BEFORE the per-PRD loop, return early when `suspended === true`. `onComplete()` is unchanged: it still finalizes `prdState`, propagates blocked, and calls `discoverNewPrds()` + `startReadyPrds()` — the gate inside `startReadyPrds()` makes the launch a no-op while suspended. Add a public read-only accessor `get isSuspended(): boolean` for tests.

- `packages/engine/src/eforge.ts` — In `watchQueue()`, after constructing `scheduler` (around line 1631) and BEFORE `await scheduler.start()`, invoke `options.onSchedulerControlRegister?.({ pause: () => scheduler.pause(), resume: () => scheduler.resume(), isAlive: () => !abortController.signal.aborted })`. Update the pump loop (lines 1681-1686) so that for events whose type is in `SCHEDULER_INPUT_TYPES`, the bus emit happens BEFORE the yield. Update the inline comment block (lines 1676-1680) to document the new ordering rationale (bus emit before yield ensures scheduler reacts to terminal events even if the downstream consumer triggers a synchronous teardown). Extend `QueueOptions` (find the existing type definition that already includes `onInjectEventRegister`) with `onSchedulerControlRegister?: (control: { pause: () => void; resume: () => void; isAlive: () => boolean }) => void`. Export a `SchedulerControl` type alias from the same module for daemon-side typing.

- `packages/monitor/src/server.ts` — Extend the `DaemonState` interface with optional `onPauseScheduler?: () => void`, `onResumeScheduler?: () => void`, `isSchedulerAlive?: () => boolean` fields (JSDoc: set by server-main when the watcher starts; cleared when it stops). In the `POST autoBuildSet` handler, replace the current `if (body.enabled)` branch so that when enabling: (i) if `!options.daemonState.watcher.running` OR `!options.daemonState.injectSchedulerEvent` OR (typeof `isSchedulerAlive === 'function'` && `!isSchedulerAlive()`), call `onSpawnWatcher?.()` (and, when `watcher.running` is true but the scheduler handle is missing, also call `options.daemonState.onDaemonEvent?.({ type: 'daemon:error', source: 'auto-build:enable', message: 'Watcher marked running but scheduler handle missing; restarting watcher', timestamp: new Date().toISOString() } as EforgeEvent)` before spawning); (ii) else call `onResumeScheduler?.()`. Keep the existing `wasPaused`/`autoBuildPaused` event-emission logic.

- `packages/monitor/src/server-main.ts` — In `maybePauseOnFailure` (lines 290-304), change `ctx.daemonState.onKillWatcher?.()` to `ctx.daemonState.onPauseScheduler?.()`. Update the function's JSDoc to reflect that pause now suspends new starts rather than aborting the watcher. In `startWatcher()`, pass an `onSchedulerControlRegister` callback in the `watchQueue` options that, when invoked, stashes the control object on `daemonState.onPauseScheduler` / `onResumeScheduler` / `isSchedulerAlive` — guarded by the existing `watcherAbort === controller` check so a superseded watcher cannot stomp on a fresh one. Clear those three fields in the same places where `injectSchedulerEvent` is cleared today (the error branch at line 521, the post-init abort branch at line 543, and the `finally` block at line 615). Update `PauseOnFailureCtx` JSDoc since `onKillWatcher` is no longer the pause path.

### Create

- `test/auto-build-resume-after-failure.test.ts` — Integration-style regression test using real `QueueScheduler`, real `EventEmitter`, real `AsyncEventQueue`, and a stub `spawnPrdChild` whose return value the test controls. Three cases:
  1. With `maxConcurrentBuilds: 2`, PRDs `a`, `b`, `c` (independent), launch `a` and `b`, fail `a`, verify scheduler finalizes `a`'s state to `failed` AND `c` is dequeued in the same tick (proves capacity recovered). Drive the failure path by emitting a `queue:prd:complete` with `status: 'failed'` through the bus, then invoking `scheduler.pause()` to simulate the daemon's pause callback, then `scheduler.resume()` to simulate re-enable, and assert `daemon:scheduler:dequeued` for `c` appears after resume.
  2. With pause held active, verify that subsequent `queue:mutation` events do NOT dequeue new PRDs (suspended state honored), and that after `resume()`, eligible PRDs are dequeued on the next tick.
  3. Verify `scheduler.onComplete` still runs while suspended (so a failed completion delivered after pause still transitions `prdState[failedId].status` to `'failed'` and `propagateBlocked` runs on dependent PRDs).

- `test/watch-queue-pump-ordering.test.ts` — Pump-level test that drives `EforgeEngine.watchQueue()` end-to-end (with a stubbed `spawnPrdChild` via the existing `StubHarness` pattern in `test/watch-queue.test.ts`) and asserts that when a consumer of the watcher generator synchronously calls the registered scheduler-control `pause()` immediately upon seeing a `queue:prd:complete` failed event, the scheduler's `prdState` for the failed PRD is already (or eventually) finalized to `'failed'`. The assertion uses the `onSchedulerControlRegister` hook plus a public read-only accessor on `QueueScheduler` (e.g. `get isSuspended` and the existing `processed`/`skipped` counters) to verify state. This test exists specifically to catch a regression of the yield-before-bus-emit race.

### Modify (tests)

- `test/auto-build-pause-on-failure.test.ts` — Update `makeDaemonState` to include `onPauseScheduler: vi.fn()` (and keep `onKillWatcher` for negative assertions). Update the assertions in the existing three test cases: `maybePauseOnFailure` should now call `onPauseScheduler` exactly once on the first failed event (replacing the current `onKillWatcher` assertion), `onKillWatcher` should NOT be called from `maybePauseOnFailure`, and the idempotency / superseded-controller / non-failed-status guards still hold for the new callback. The new contract: pause suspends new launches, it does not abort the watcher.

- `test/queue-scheduler.test.ts` — Extend the existing `createTestEnv` helper if needed, then add two cases: (a) `pause()` causes a subsequent ready PRD to NOT be dequeued (no `daemon:scheduler:dequeued` event emitted for it); (b) `resume()` immediately dequeues the same PRD on the next tick. Use the existing `eventQueue` collector pattern in that file.

## Verification

- [ ] When a queued PRD fails while another build is running, `daemon:auto-build:paused` is emitted exactly once and `daemonState.autoBuild === false`, `daemonState.autoBuildPaused === true`.
- [ ] The failed PRD's `prdState` entry transitions from `running` to `failed` (asserted via `QueueScheduler.processed` increment plus public state inspection in tests).
- [ ] After `scheduler.resume()` (or after the auto-build POST route enables when the watcher is alive), an independent pending PRD with no `depends_on` on the failed PRD is dequeued in the same tick, asserted via `daemon:scheduler:dequeued` event for that PRD.
- [ ] The watcher generator is NOT aborted by `maybePauseOnFailure`: the post-pause `watcherAbort` reference remains the same controller and `watcherDone` is not resolved.
- [ ] Auto-build POST with `{enabled: true}` while `watcher.running === true` but `injectSchedulerEvent === undefined`: a `daemon:error` event is written and `onSpawnWatcher` is invoked exactly once.
- [ ] Auto-build POST with `{enabled: true}` while `watcher.running === false`: `onSpawnWatcher` is invoked exactly once and no `daemon:error` is emitted for that path.
- [ ] Auto-build POST with `{enabled: false}` continues to call `onKillWatcher` (manual disable path is unchanged).
- [ ] Dependents of a failed PRD are still marked `blocked` by `propagateBlocked()` and counted as skipped at terminal `queue:complete` time.
- [ ] All new and updated tests pass: `pnpm exec vitest run test/queue-scheduler.test.ts test/auto-build-pause-on-failure.test.ts test/auto-build-resume-after-failure.test.ts test/watch-queue-pump-ordering.test.ts`.
- [ ] `pnpm type-check` passes with zero errors.
- [ ] `pnpm test` passes (full suite, no regressions in existing scheduler/watcher/auto-build tests).
