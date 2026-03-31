---
id: plan-02-greedy-scheduler
name: Greedy Queue Scheduler and CLI Flag
depends_on: [plan-01-config-and-agent]
branch: parallel-queue-builds/greedy-scheduler
---

# Greedy Queue Scheduler and CLI Flag

## Architecture Context

This plan replaces the sequential `for` loop in `runQueue()` with a greedy semaphore-limited scheduler, replicating the proven pattern from `executePlans()` in `src/engine/orchestrator/phases.ts`. It also removes the unsafe `git reset --hard` that would be catastrophic under concurrency, and adds the `--queue-parallelism` CLI flag.

The scheduler uses the same concurrency primitives (`Semaphore`, `AsyncEventQueue`) already battle-tested in the orchestrator. At `parallelism: 1` (the default from plan-01), the semaphore serializes execution naturally - identical behavior to the current sequential loop with no special-casing.

## Implementation

### Overview

Four changes:
1. Remove `git reset --hard` from the queue loop (lines 800, 854)
2. Extract the per-PRD body into a `buildSinglePrd()` async generator method
3. Restructure `runQueue()` with greedy scheduler using `Semaphore` + `AsyncEventQueue`
4. Add `--queue-parallelism` CLI flag

### Key Decisions

1. **Remove `git reset --hard`** - Compile already operates in a merge worktree (line 258 of `compile()`). The main tree's HEAD doesn't change during compile. On build failure, the feature branch simply isn't merged to base. The worktree cleanup handles isolation. This reset is a legacy safety net that would destroy concurrent builds' work.
2. **Replicate `executePlans()` pattern exactly** - The greedy scheduler in `src/engine/orchestrator/phases.ts:184-403` is the proven model. Track per-PRD state, check readiness (all `depends_on` completed/skipped), launch ready items up to semaphore limit, scan for newly-unblocked items on each completion.
3. **`--queue-parallelism` overrides `config.prdQueue.parallelism`** - Follows the same override pattern as `--parallelism` overrides `config.build.parallelism`. Extend `buildConfigOverrides()` to handle the new option.
4. **Propagate blocked status on failure** - When a PRD fails, mark all transitive dependents as `blocked` so they don't wait forever. Same pattern as `executePlans()` propagates failures.

## Scope

### In Scope
- Removing `git reset --hard` from `runQueue()` (lines 800, 854 in `eforge.ts`)
- Extracting `buildSinglePrd()` private async generator method from the `for` loop body
- Restructuring `runQueue()` with `Semaphore`, `AsyncEventQueue`, per-PRD state tracking, `isReady()`, `launchPrd()`, `startReadyPrds()`, and event-driven loop
- `--queue-parallelism <n>` CLI flag on `build` and `queue run` commands
- Extending `buildConfigOverrides()` to map `queueParallelism` to `config.prdQueue.parallelism`
- Passing resolved `prdQueue.parallelism` into `runQueue()` for semaphore sizing

### Out of Scope
- Config schema changes (done in plan-01)
- Dependency detection agent (done in plan-01)
- Monitor UI changes for parallel queue visualization

## Files

### Modify
- `src/engine/eforge.ts` - (1) Remove the `preCompileHead` recording (line 800) and the `git reset --hard preCompileHead` call (line 854) from the queue loop body. (2) Extract the per-PRD processing body (lines 707-878, everything inside the `for (const prd of orderedPrds)` loop) into a new private async generator method `buildSinglePrd(prd: QueuedPrd, options: QueueOptions): AsyncGenerator<EforgeEvent>`. This method handles: claim, staleness check, session lifecycle events, compile, build, error handling, lock release, status updates, and yielding `queue:prd:complete`. (3) Replace the sequential `for` loop in `runQueue()` with a greedy scheduler: import `Semaphore` and `AsyncEventQueue` from `./concurrency.js`, create per-PRD state tracking (`Map<string, PrdRunState>` with status and dependsOn), implement `isReady(prdId)` (status is pending and all depends_on have completed/skipped status), implement `launchPrd(prd)` (acquire semaphore, add producer to event queue, iterate `buildSinglePrd()`, push events, update state, release semaphore, remove producer - on failure propagate blocked status to transitive dependents), implement `startReadyPrds()` (scan all PRDs, launch any ready and not running), and the event loop (call `startReadyPrds()` to seed, iterate `AsyncEventQueue`, on each prd completion call `startReadyPrds()` again, terminate when nothing running and nothing ready). The semaphore is sized from `this.config.prdQueue.parallelism`.
- `src/cli/index.ts` - (1) Add `--queue-parallelism <n>` option (with `parseInt` parser) to the `build` command (around line 199, near existing `--parallelism`). (2) Add the same option to the `queue run` command (around line 504). (3) Extend `buildConfigOverrides()` to accept `queueParallelism?: number` and map it to `prdQueue: { parallelism: value }` in the overrides object. (4) Pass `queueParallelism` from parsed options through to `buildConfigOverrides()` calls.

## Verification

- [ ] `pnpm type-check` passes with zero errors
- [ ] `pnpm test` passes - no existing tests break (behavior at `parallelism: 1` is identical to sequential loop)
- [ ] No `git reset --hard` calls remain in `runQueue()` or `buildSinglePrd()`
- [ ] `buildSinglePrd()` is a private async generator method on `EforgeEngine` that accepts `(prd: QueuedPrd, options: QueueOptions)` and returns `AsyncGenerator<EforgeEvent>`
- [ ] `runQueue()` imports and uses `Semaphore` from `./concurrency.js` sized to `this.config.prdQueue.parallelism`
- [ ] `runQueue()` imports and uses `AsyncEventQueue` from `./concurrency.js` for event multiplexing
- [ ] Per-PRD state is tracked with `status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'blocked'` and `dependsOn: string[]`
- [ ] `isReady()` returns true only when status is `'pending'` and all `dependsOn` entries have status `'completed'` or `'skipped'`
- [ ] When a PRD fails, all transitive dependents are marked `'blocked'`
- [ ] `eforge build --help` shows `--queue-parallelism <n>` option
- [ ] `eforge queue run --help` shows `--queue-parallelism <n>` option
- [ ] `--queue-parallelism 3` overrides `config.prdQueue.parallelism` to `3`
