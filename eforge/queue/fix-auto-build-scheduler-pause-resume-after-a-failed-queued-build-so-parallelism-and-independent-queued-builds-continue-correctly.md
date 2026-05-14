---
title: Fix auto-build scheduler pause/resume after a failed queued build so parallelism and independent queued builds continue correctly
created: 2026-05-14
profile: claude-sdk-4-7
---

# Fix auto-build scheduler pause/resume after a failed queued build so parallelism and independent queued builds continue correctly

## Problem / Motivation

A queued PRD failure pauses auto-build as intended, but after the user re-enables auto-build, the scheduler can continue as if one parallelism slot is occupied even though the failed child process has exited and no queue lock remains. Independent queued PRDs are not started despite available configured capacity (`maxConcurrentBuilds: 2`).

Affected users: anyone relying on auto-build for queued PRD orchestration, especially concurrent queues where one PRD fails while another remains running.

Why it matters: the daemon is supposed to be the queue orchestration authority. After a failure, users expect auto-build to pause, let them inspect/re-enable, then continue scheduling eligible independent work. Current behavior undermines queue reliability and makes the UI/state misleading: auto-build can show enabled while the scheduler is effectively not scheduling.

### Evidence gathered

- **Live symptom:** after `extend-03-typed-event-extension-runtime` failed, auto-build paused automatically as intended. The user re-enabled auto-build, but only one build continued running despite `maxConcurrentBuilds: 2` and an independent pending PRD (`improve-pi-eforge-footer-status-so-active-builds-and-plan-counts-are-accurate`) being available.
- **Configuration evidence:** `eforge/config.yaml` sets `maxConcurrentBuilds: 2`.
- **Queue evidence:** `eforge_queue_list` showed one running item, two pending items, and one failed item. Only one queue lock existed under `.eforge/queue-locks/`, for the currently running PRD. This means the second build slot was not occupied by a real child process.
- **Monitor DB evidence:** `daemon:auto-build:paused` was emitted by watcher session `watcher-1778797785176-f23be284e01f`; later `daemon:auto-build:resumed` / `enabled` events were emitted, but `eforge_auto_build` still reported the same watcher session. This supports the conclusion that re-enable did not create a fresh scheduler.
- **Scheduler code evidence:** `QueueScheduler.startReadyPrds()` computes capacity by counting `prdState` entries with `status === 'running'`. State transitions from `running` to terminal happen in `QueueScheduler.onComplete()`, which is invoked only when the `watchQueue()` pump re-emits `queue:prd:complete` onto the scheduler bus.
- **Watcher code evidence:** `watchQueue()` yields events outward first, then emits scheduler-relevant events onto the bus. Its abort handler removes all bus listeners. `maybePauseOnFailure()` reacts to a failed `queue:prd:complete` and calls `onKillWatcher()`, which aborts the watcher. Therefore a failure can abort/remove bus listeners before the pump re-emits the completion to `QueueScheduler.onComplete()`.
- **Re-enable code evidence:** the auto-build POST route sets `daemonState.autoBuild = true`, but only calls `onSpawnWatcher()` when `daemonState.watcher.running` is false. If a watcher is aborted/draining but still marked running, re-enable does not start a fresh scheduler.
- **Test evidence:** existing scheduler tests cover dequeue/capacity/dependency event emission, but do not appear to cover the failure pause + re-enable lifecycle or the yield-before-bus-emit abort race.
- **Roadmap alignment:** the roadmap emphasizes the daemon as the single orchestration authority with richer controls and safety checks. Fixing this scheduler/auto-build correctness issue fits that direction and is a prerequisite for trustworthy queue controls.

### Reproduction Steps

Observed reproduction from the live project:

1. Configure `maxConcurrentBuilds: 2`.
2. Have at least two PRDs running or eligible to run under auto-build.
3. Let one PRD fail while another PRD remains running.
4. Auto-build is automatically toggled off / paused after the failure.
5. User manually re-enables auto-build.
6. Ensure there is an independent pending PRD in `eforge/queue/` with no `depends_on` on the failed PRD.

**Expected behavior:**

- The failed PRD is finalized in scheduler state.
- Re-enabling auto-build either resumes a live scheduler or starts a fresh scheduler.
- The independent pending PRD is started while the other build continues, respecting `maxConcurrentBuilds: 2`.

**Actual behavior:**

- Only the pre-existing running build continues.
- The independent pending PRD remains pending.
- Only one queue lock exists, so the missing slot is not occupied by a real child process.
- The auto-build API reports enabled and watcher running using the same watcher session that emitted the failure pause.

## Goal

Restore correct auto-build pause/resume semantics so that, after a queued PRD failure pauses auto-build and the user re-enables it, the scheduler reliably finalizes the failed PRD's state and starts independent pending PRDs up to `maxConcurrentBuilds`, with no stale parallelism slots and no misleading "enabled but inert" daemon state.

## Approach

### Root Cause (confirmed / evidence-backed)

- `QueueScheduler.startReadyPrds()` calculates available capacity from `prdState` entries whose status is `running`.
- `QueueScheduler.onComplete()` is responsible for transitioning a PRD from `running` to `completed` / `failed` / `skipped`, then rescanning and starting newly-ready PRDs.
- `watchQueue()` yields each event outward before re-emitting scheduler-relevant events (`queue:mutation`, `queue:prd:complete`) onto the internal scheduler bus.
- `maybePauseOnFailure()` reacts to the outward-yielded failed `queue:prd:complete` and calls `onKillWatcher()`, which aborts the watcher.
- The watcher abort handler removes all bus listeners. If abort happens before the pump re-emits the failed completion to the scheduler bus, `QueueScheduler.onComplete()` does not run for that failed PRD.
- The failed PRD can therefore remain `running` in in-memory scheduler state even after the child exits and the semaphore/lock are released. Future `startReadyPrds()` calls see capacity as full or reduced.
- Re-enable does not repair this because the auto-build POST route only spawns a watcher when `daemonState.watcher.running` is false. During an aborted/draining watcher state, `watcher.running` can still be true, so no fresh scheduler is created.

### Validation performed

- Static line-number inspection confirmed the ordering chain:
  - `watchQueue()` abort removes bus listeners before cleanup (`packages/engine/src/eforge.ts:1660-1665`).
  - `watchQueue()` yields outward before emitting scheduler-relevant events onto the bus (`packages/engine/src/eforge.ts:1681-1685`).
  - `maybePauseOnFailure()` pauses and calls `onKillWatcher()` during outward event handling (`packages/monitor/src/server-main.ts:289-301`).
  - Auto-build re-enable only spawns if `watcher.running` is false (`packages/monitor/src/server.ts:1687-1692`).
  - `QueueScheduler.startReadyPrds()` counts `prdState.status === 'running'` to determine capacity (`packages/engine/src/queue/scheduler.ts:286-329`).
- Live DB/queue validation confirmed the failed watcher pause and subsequent resume happened, while only one queue lock existed and the independent pending PRD had no `depends_on` frontmatter.
- A small in-process simulation using real `QueueScheduler`, real `EventEmitter`, and real `AsyncEventQueue` validated the core race:
  - When a failed `queue:prd:complete` is delivered to the scheduler bus, the scheduler starts independent PRD `c` (`daemon:scheduler:dequeued:c`).
  - When bus listeners are removed before delivering that same completion, a subsequent scheduling pass emits `daemon:scheduler:capacity-blocked` instead of starting `c`, demonstrating stale running state.

### Assumptions

| Assumption | Evidence / validation performed | Confidence | Cost to validate further | Validation path | Impact if wrong |
|------------|----------------------------------|------------|--------------------------|-----------------|-----------------|
| The effective lost parallel slot is stale scheduler state, not a real leaked child/lock. | Live queue had only one lock/process while pending independent work remained. Code shows capacity derives from in-memory `prdState`. Simulation showed missing completion delivery causes capacity-blocked instead of dequeueing independent work. | high | low | Convert the simulation into a committed regression test. | If wrong, fix would miss a separate semaphore/lock leak. |
| Failure pause can abort/remove bus listeners before scheduler handles the failed completion. | Static code ordering proves the possibility; simulation reproduced the behavioral consequence with real scheduler primitives. | high | low | Add test around `watchQueue` pump or scheduler bus delivery ordering. | If wrong, root cause may be elsewhere in child finalization. |
| The correct product behavior is pause-new-work, not immediately abort-scheduler-before-finalization. | User confirmed auto-off after failure is good; user also expects re-enable to pick up independent queued work. Existing comments say in-flight builds drain. | high | low | No further validation needed unless product semantics change. | If wrong, implementation may continue or suppress scheduling contrary to desired UX. |
| Re-enable should repair/resume scheduler state, not merely flip `autoBuild` boolean. | Live evidence: re-enable emitted resumed/enabled, but watcher session remained the same and independent work did not start. Static route inspection shows spawn only when `watcher.running` is false. | high | low | Add route-level test for POST auto-build with paused/draining/stale scheduler handle. | UI could still report enabled while scheduler is inert. |
| A small cohesive fix is sufficient; no broad queue architecture rewrite is required for this bug. | The core race is now reproduced narrowly. Broader queue snapshot/SSE issues remain separate but are not required to explain the lost-slot behavior. | high | medium | Keep implementation focused; add regression tests to prevent scope creep. | Patch may fix this scenario while leaving separate queue UI drift bugs for later. |
| Test harness can simulate the race without spawning real long-running agent builds. | Verified with an ad-hoc `pnpm exec tsx` script using synthetic PRDs and controllable promises. | high | low | Port script logic into vitest under scheduler/watchQueue tests. | If not ported carefully, regression may remain uncovered. |

### Early assumptions / unknowns

- **Assumption (high confidence):** the observed effective loss of a parallel slot is caused by stale in-memory scheduler state, not a leaked queue lock or live child process. Evidence: only one lock/process exists, but scheduler capacity is derived from in-memory `prdState`.
- **Assumption (medium confidence):** the minimal safe fix is to separate auto-build pause from watcher abort so the scheduler can process terminal completion before suppressing future starts. Needs implementation-time validation against desired behavior: failed build should pause auto-build and prevent new starts until user resumes, but must still finalize the failed build and leave the scheduler resumable.
- **Assumption (medium confidence):** re-enable should either unpause the existing watcher/scheduler or force a clean scheduler restart when the current watcher is aborted/draining. Need to inspect final implementation constraints before choosing exact mechanics.

### Related latent issue

- Queue mutation injection is only `state?.injectSchedulerEvent?.(...)`. If the injected function targets a bus whose listeners were removed, mutations can silently no-op.

### Profile Signal

Recommended profile: **Excursion**.

Rationale: this is a focused but cross-cutting daemon/engine bugfix involving scheduler lifecycle, auto-build pause/resume semantics, and regression tests. A single cohesive plan can cover the fix without delegated module planning. It is not an Errand because it changes queue lifecycle behavior and needs careful tests around failure/resume ordering; it is not an Expedition because the scope is bounded to the scheduler/watcher state machine path rather than multiple independently planned subsystems.

## Scope

### In scope

- Scheduler/watcher lifecycle behavior in:
  - `packages/engine/src/eforge.ts` (watchQueue pump, abort handler, yield-vs-bus-emit ordering)
  - `packages/engine/src/queue/scheduler.ts` (capacity calculation, `onComplete` finalization)
  - `packages/monitor/src/server-main.ts` (`maybePauseOnFailure`, `onKillWatcher`)
  - `packages/monitor/src/server.ts` (auto-build POST route, re-enable behavior when watcher is paused/aborted/draining)
- Separating auto-build pause from watcher abort so the failed PRD's completion still finalizes scheduler state.
- Making re-enable deterministic when a watcher is paused/aborted/draining: either resume the existing scheduler or start a fresh one; never leave `autoBuild.enabled=true` with no effective scheduler.
- Ensuring queue mutation injection cannot silently target a dead scheduler bus (restart/recreate scheduling or surface a daemon warning/error when this happens with auto-build enabled).
- Regression coverage:
  - Failure pause + resume with `maxConcurrentBuilds: 2` and an independent pending PRD.
  - The yield-before-bus-emit abort race in `watchQueue`.
  - Route-level test for POST auto-build with paused/draining/stale scheduler handle.
  - Porting the in-process simulation (real `QueueScheduler`, `EventEmitter`, `AsyncEventQueue`) into vitest.

### Out of scope

- Broader queue architecture rewrite.
- Separate queue UI / queue snapshot / SSE drift bugs not required to explain the lost-slot behavior.
- Any product change to the "pause auto-build on failure" UX itself (the existing behavior is desired).

## Acceptance Criteria

1. When a queued PRD fails while another build is running, auto-build still pauses and emits `daemon:auto-build:paused`.
2. The failed PRD's scheduler state is finalized even when auto-build pauses: it is no longer counted as `running` for capacity.
3. After the user re-enables auto-build, an independent pending PRD starts if capacity is available.
4. Re-enable behavior is deterministic when a watcher is paused/aborted/draining: it either resumes the existing scheduler or starts a fresh scheduler; it must not leave `autoBuild.enabled=true` with no effective scheduler.
5. Queue mutation injection cannot silently target a dead scheduler bus. If the active scheduler is unavailable and auto-build is enabled, the daemon should restart/recreate scheduling or surface a daemon warning/error.
6. Dependent PRDs on a failed upstream remain blocked/skipped according to existing queue semantics; independent PRDs are not blocked by unrelated failures.
7. Add regression coverage for failure pause + resume with `maxConcurrentBuilds: 2` and an independent pending PRD.
8. Existing scheduler tests for dequeue, capacity-blocked, dependency-blocked, and queue completion continue to pass.
9. `pnpm type-check` and relevant vitest suites pass.
