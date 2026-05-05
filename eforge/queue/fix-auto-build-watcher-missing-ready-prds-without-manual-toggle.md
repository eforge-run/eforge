---
title: Fix auto-build watcher missing ready PRDs without manual toggle
created: 2026-05-05
---

# Fix auto-build watcher missing ready PRDs without manual toggle

## Problem / Motivation

In real-world auto-build use (project: `~/projects/ytc/member-portal/`, default parallelism = 2), three flavors of "stuck queue" reproduce:

1. Build A is running. User enqueues independent build B. B should start immediately (slot 2 free). It doesn't.
2. A is running, B (depends on A) is queued. A completes. B does not start.
3. A is running, B (depends on A) is queued, user adds independent C. C does not start.

Workaround in all three cases: toggle Auto-build OFF then ON in the monitor UI. That spawns a fresh watcher, whose initial scan (`packages/engine/src/eforge.ts:1818`) calls `startReadyPrds()` and picks up whatever was stuck.

### Honest diagnosis status

The scheduler algorithm itself (`prdState`, `isReady`, deps tracking, semaphore) reads correctly. Every stuck case clears on a manual fresh-scan. So the gap is in **what triggers** `startReadyPrds()` between scans, not in `startReadyPrds()` itself.

`watchQueue` (`packages/engine/src/eforge.ts:1524`) currently triggers `startReadyPrds()` from exactly three places:
- Initial scan on watcher start (line 1818).
- `onFsChange` (line 1735), debounced 500 ms after a Node `fs.watch` event on the queue root.
- `queue:prd:complete` consumer branch (lines 1856–1858) after a build finishes.

For new enqueues (cases 1 and 3) the only path is the `fs.watch` event. It cannot be proven from code alone that `fs.watch` is dropping events in this environment - that would need daemon-side instrumentation and a reproducer. So instead of trying to confirm `fs.watch` is broken, this plan removes the daemon's dependence on it for correctness. Every code path that mutates the queue directory will explicitly wake the scheduler.

## Goal

Make the scheduler a discrete event listener decoupled from the consumer-yield loop, so every queue-mutating code path explicitly wakes it and ready PRDs always start without requiring a manual auto-build toggle.

## Approach

Make the scheduler **a discrete event listener**, decoupled from the consumer-yield loop.

Today, `watchQueue` is one big async generator that does three things in one body: yields events, schedules new PRDs, and (for completion events) reacts to terminal status. We split that:

1. The watcher's `eventQueue` keeps its current job: yield events to downstream consumers (SSE, hooks, persistence).
2. A new `QueueScheduler` class owns the scheduling state (`prdState`, `orderedPrds`, the semaphore, `discoverNewPrds`, `startReadyPrds`, `propagateBlocked`). It subscribes to a typed `EventEmitter` and reacts to a documented union of event types.
3. The watcher's loop becomes a thin pump: for each event flowing through `eventQueue`, yield it to the outer consumer **and** emit it on the scheduler's bus. The scheduler reacts independently.
4. Daemon HTTP routes don't call any `kick` function. They emit a `queue:mutation { reason }` event onto the bus (via an `injectEvent` plumbed onto `DaemonState`). Identical channel to build completion, identical match logic.

This answers "can the scheduler be an event listener itself?" with **yes** - it's a class whose only inputs are `bus.on(...)` subscriptions, whose outputs are spawn-child calls and `prdState` mutations.

### Event types it listens on

A single typed union, defined once and imported:

```ts
export type SchedulerInputEvent =
  | QueuePrdCompleteEvent           // from build subprocess IIFE — already exists
  | { type: 'queue:mutation'; reason: 'enqueue' | 'playbook-enqueue' | 'apply-recovery' | 'external'; timestamp: string };

export const SCHEDULER_INPUT_TYPES: ReadonlySet<EforgeEvent['type']> =
  new Set<EforgeEvent['type']>(['queue:prd:complete', 'queue:mutation']);
```

The bus is a `TypedEventEmitter<SchedulerInputEvent>` (use a tiny generic wrapper or keep raw `EventEmitter` with manual cast - there are existing typed-emitter patterns in the engine, follow what's already there).

Scheduler subscriptions inside the constructor:

```ts
bus.on('queue:prd:complete', (event) => { void this.onComplete(event); });
bus.on('queue:mutation',     ()       => { void this.onMutation();     });
```

`onComplete` runs the existing unblock-waiting / propagate-skip-fs logic, then calls the same `tick()` that `onMutation` calls. **One** code path for "rescan and launch ready PRDs", subscribed from two events.

### Mutation events to emit

Enumerated by walking `packages/monitor/src/server.ts`:

| # | Route | Site | Emits |
|---|---|---|---|
| 1 | `POST /api/enqueue` | server.ts:941 (`spawnWorker('enqueue', args)`) | `queue:mutation { reason: 'enqueue' }` from the worker's `onExit` callback. |
| 2 | `POST /api/playbook/enqueue` | server.ts:1530 (in-process `enqueuePrd`) | `queue:mutation { reason: 'playbook-enqueue' }` after `commitEnqueuedPrd` returns. |
| 3 | `POST /api/apply-recovery` | server.ts:1069 (`spawnWorker('apply-recovery', ...)`) | `queue:mutation { reason: 'apply-recovery' }` from worker `onExit`. |
| 4 | `POST /api/scheduler/kick` | new route | `queue:mutation { reason: 'external' }`. Manual / out-of-band escape hatch. |
| 5 | Build subprocess completion | already-wired in `watchQueue` (eforge.ts:1856–1858) | Already emits `queue:prd:complete` via the existing IIFE. **No change.** |

### Removing `fs.watch`

`fs.watch` and its supporting machinery are deleted from `watchQueue` - debounce timer, `setupWatcher`, error recovery, circuit-breaker constants (eforge.ts:1726–1815). With the scheduler driven by explicit `queue:mutation` events, `fs.watch` has no remaining role.

Out-of-band callers (autonomous loop's `mv` recovery flow noted in user memory; any future script touching the queue dir directly) use the new `POST /api/scheduler/kick` endpoint. It emits a `queue:mutation { reason: 'external' }` event and returns 200. No-op when no watcher is running.

### Concurrency / idempotence note

`tick()` is safe to call concurrently from overlapping bus events:
- `discoverNewPrds` is idempotent against `prdState` (`Map.set` replaces; the `!prdState.has` guard runs synchronously after `await loadQueue` resumes, so two interleaved calls can't double-add a PRD).
- `startReadyPrds` is synchronous; the JS event loop serializes it. The `state.status = 'running'` assignment guards against double-launch.

Node's `EventEmitter` invokes listeners synchronously in the order they were registered, so two `bus.emit('queue:mutation', ...)` calls in quick succession produce two sequential listener invocations - no overlapping `await`s inside `tick()` that the scheduler would have to coordinate. No "scheduler is busy, drop this event" gate is needed.

## Scope

### In scope

- **`packages/engine/src/queue/scheduler.ts`** (new file)
  - Define `SchedulerInputEvent` union and `SCHEDULER_INPUT_TYPES` set (exported).
  - Define `QueueScheduler` class. Constructor takes `{ bus, cwd, queueDir, config, configProfile, parallelism, abortController, eventQueue, spawnPrdChild }` - all the dependencies the existing inline scheduler closure pulls from `watchQueue`'s lexical scope.
  - Move into the class: `prdState`, `orderedPrds`, the semaphore, `isReady`, `propagateBlocked`, `discoverNewPrds`, `startReadyPrds` - same logic, no behavior changes. Make them private methods / private fields.
  - Public API: a single `start()` method that does the initial scan + `startReadyPrds()`, and the bus subscriptions.
  - Internal `tick()` = `await discoverNewPrds(); startReadyPrds();`. `onComplete(event)` runs unblockWaiting / propagateSkipFS then `tick()`. `onMutation()` is just `tick()`.
  - Class is unit-testable in isolation: feed it a fake bus, drive it with synthetic events, assert spawnPrdChild calls.

- **`packages/engine/src/eforge.ts`** (`watchQueue`, ~1524–1875)
  - Add a `bus = new EventEmitter()` (or thin typed wrapper) at the top of `watchQueue`.
  - Extend `QueueOptions` with `onInjectEventRegister?: (inject: (event: SchedulerInputEvent) => void) => void`. Publish `(event) => bus.emit(event.type, event)` so the daemon can inject mutation events.
  - Construct `QueueScheduler` with the bus and pass through the existing dependencies. Call `await scheduler.start()` (replaces the existing inline initial scan at line 1818).
  - Replace the existing consumer loop with a thin pump:
    ```ts
    for await (const event of eventQueue) {
      yield event;
      if (SCHEDULER_INPUT_TYPES.has(event.type)) {
        bus.emit(event.type, event);
      }
    }
    ```
  - **Delete** all `fs.watch` machinery (FSWatcher import, `watcher`/`debounceTimer`/`failureTimestamps` locals, `MAX_CONSECUTIVE_FAILURES`/`FAILURE_WINDOW_MS` constants, `setupWatcher()` function, the call to `setupWatcher()`).
  - **Delete** the inline scheduler closure (`prdState`/`orderedPrds`/semaphore/etc. - all moved into `QueueScheduler`).
  - **Keep** `eventQueue.addProducer()` (it's the refcount that keeps the consumer loop alive between builds). Update its comment to "Watcher producer - keeps the consumer loop alive while the watcher is running."
  - **Keep** the build subprocess IIFE that pushes `queue:prd:complete` onto `eventQueue` - that's how completion events still reach the bus (they flow through the same pump and get re-emitted).
  - Simplify `onAbort`: `bus.removeAllListeners(); eventQueue.removeProducer();`.

- **`packages/client/src/routes.ts`**
  - Add `schedulerKick: '/api/scheduler/kick'` to `API_ROUTES` (around line 145).
  - No `DAEMON_API_VERSION` bump required - adding a route is additive, not breaking. The shared API version constant lives at `packages/client/src/api-version.ts` and only bumps for breaking changes per the convention in `AGENTS.md`.

- **`packages/client/src/api/`** (new file `scheduler.ts` or co-located)
  - Add a thin typed helper `apiSchedulerKick(opts: { cwd: string }): Promise<{ ok: true }>` that POSTs to `API_ROUTES.schedulerKick`. Mirrors the existing `apiCancel`, `apiHealth` shape.

- **`packages/monitor/src/server.ts`**
  - Add `injectSchedulerEvent?: (event: SchedulerInputEvent) => void` to the `DaemonState` interface (~line 148, near `onSpawnWatcher` / `onKillWatcher`).
  - Define a tiny local helper at the top of the file:
    ```ts
    const emitMutation = (
      state: DaemonState | undefined,
      reason: 'enqueue' | 'playbook-enqueue' | 'apply-recovery' | 'external',
    ): void => {
      state?.injectSchedulerEvent?.({
        type: 'queue:mutation',
        reason,
        timestamp: new Date().toISOString(),
      });
    };
    ```
  - **Site 1 - enqueue route** (line 941):
    ```ts
    const result = options.workerTracker.spawnWorker('enqueue', args, () => {
      emitMutation(options.daemonState, 'enqueue');
    });
    ```
  - **Site 2 - playbook enqueue route** (after `commitEnqueuedPrd` at line 1541):
    ```ts
    emitMutation(options?.daemonState, 'playbook-enqueue');
    ```
  - **Site 3 - apply-recovery route** (line 1069):
    ```ts
    const result = options.workerTracker.spawnWorker('apply-recovery', [body.prdId], () => {
      emitMutation(options.daemonState, 'apply-recovery');
    });
    ```
  - **New route handler** for `POST /api/scheduler/kick` (place near the other auto-build routes around line 1115):
    ```ts
    if (req.method === 'POST' && url === API_ROUTES.schedulerKick) {
      if (!options?.daemonState) {
        sendJsonError(res, 503, 'Daemon mode not active');
        return;
      }
      emitMutation(options.daemonState, 'external');
      sendJson(res, { ok: true });
      return;
    }
    ```
    No-op when `injectSchedulerEvent` is undefined (auto-build OFF) - caller still gets `{ ok: true }`. A kick against a stopped watcher is a sensible no-op; the next ON-toggle does its own initial scan.

- **`packages/monitor/src/server-main.ts`** (`startWatcher`, ~407–482)
  - Pass `onInjectEventRegister` into `engine.watchQueue({ ... })` at line 446:
    ```ts
    onInjectEventRegister: (inject) => {
      if (daemonState && watcherAbort === controller) daemonState.injectSchedulerEvent = inject;
    },
    ```
  - Clear `daemonState.injectSchedulerEvent = undefined` in:
    - the early-bailout paths at lines 425–430 and 435–441,
    - the `finally` block at line 472, alongside `daemonState.watcher = { running: false, ... }`.
  - This guarantees a stale inject from a prior watcher session can't fire against a torn-down generator.

### Out of scope

- `POST /api/recover` (server.ts:1035) - runs the recovery analyst, writes sidecars *outside* the queue tree. Doesn't need a kick. Confirmed by reading recovery code paths; sidecars land at `eforge/queue/<prdId>.recovery.json` etc. inside `queue/failed/`, not in the active queue root, so the scheduler doesn't care.
- Cancel - a SIGTERM'd build still emits `queue:prd:complete` via the parent's exit handler in `spawnPrdChild` (eforge.ts:1257). The existing complete-event path handles it.
- No changes to monitor UI, MCP plugin, or Pi extension. This is daemon-internal plumbing.

## Acceptance Criteria

Rebuild + restart with the `eforge-daemon-restart` skill so MCP/HTTP picks up the new build.

1. **Independent parallel start (scenario 1).** Auto-build ON. Enqueue A. While A runs, enqueue independent B. Expect B's `queue:prd:start` event within ~1 s of the enqueue worker exiting (no UI interaction). Both run concurrently.
2. **Dependent unblock on completion (scenario 2).** Auto-build ON. Enqueue A. While A runs, enqueue B with `depends_on: [A]`. Confirm B is pending. Let A finish normally. Expect B to start within ~1 s of A's completion event. (This case was already supposed to work via the `queue:prd:complete` branch - verifying it didn't regress.)
3. **Mixed dep + independent (scenario 3).** Auto-build ON. Enqueue A, then B (depends on A), then independent C. Expect A and C to run concurrently within ~1 s of C's enqueue worker exiting; B starts after A completes.
4. **Apply-recovery retry kicks the scheduler.** Cause a build to fail (any easy trigger); auto-build pauses (existing behavior). Toggle ON. Click "retry" in monitor UI (drives `apply-recovery`). Confirm the retried PRD starts without a second toggle.
5. **Playbook chained enqueue.** With auto-build ON, enqueue a playbook with `afterQueueId`. Verify the chained PRD lands in `queue/waiting/` and is picked up after its upstream completes.
6. **No regression in existing toggle path.** Toggle OFF mid-build → in-flight builds drain, no new launches. Toggle back ON → fresh-scan picks up anything pending.
7. **Type check + tests.** `pnpm type-check && pnpm test`. The class extraction enables direct unit tests for the scheduler:
   - Construct a `QueueScheduler` with a stub bus and a stub `spawnPrdChild`. Drive it with synthetic events (`{ type: 'queue:mutation', reason: 'enqueue', ... }`, `{ type: 'queue:prd:complete', status: 'completed', ... }`) and assert correct sequencing of `spawnPrdChild` calls. No subprocess, no daemon, no filesystem watcher.
   - End-to-end watcher test: construct `watchQueue` with a stub `onInjectEventRegister` capturing the inject function. Write a PRD file to a temp queue dir, then call `inject({ type: 'queue:mutation', reason: 'external', ... })`. Assert a `queue:prd:start` event is yielded.
   - Symmetrical test verifying inject is a no-op after abort (bus listeners removed).
