---
id: plan-01-greedy-scheduler-engine
name: Greedy Dependency Scheduler Engine
depends_on: []
branch: greedy-dependency-scheduling/engine
---

# Greedy Dependency Scheduler Engine

## Architecture Context

The orchestrator currently uses a wave-based execution model: `resolveDependencyGraph()` computes waves via Kahn's algorithm, then the orchestrator iterates waves sequentially - running all plans in a wave, waiting for them all to complete, merging them, then starting the next wave. This conservative approach leaves throughput on the table when plans in later waves depend on only a subset of the current wave's plans.

The greedy scheduler replaces the wave loop with an event-driven scheduler that starts plans as soon as their declared dependencies are merged. The dependency graph remains the source of truth for correctness - waves were an approximation of that invariant, not the invariant itself.

## Implementation

### Overview

Replace the wave-based `execute()` method in `Orchestrator` with a greedy scheduling loop. Update event types to replace `wave:start`/`wave:complete` with scheduling-oriented events. The `resolveDependencyGraph()` function still exists for dry-run display and the expedition module-planning stage (which genuinely needs wave-based sequencing for context propagation) - it is NOT removed.

### Key Decisions

1. **Scheduler uses a completion-driven loop, not polling.** The loop waits for any running plan to complete (via `Promise.race` on individual plan promises), then checks what's newly unblocked. This avoids busy-waiting and keeps the async generator pattern intact.

2. **Merge queue is inline, not a separate data structure.** When a plan completes, it's merged immediately (serialized via a simple loop). After each merge, re-scan pending plans to see if any are now ready. This keeps the state machine simple.

3. **`wave:start`/`wave:complete` events are replaced with `schedule:start` and `schedule:ready` events.** `schedule:start` fires once at the beginning with all plan IDs. `schedule:ready` fires each time a plan becomes eligible to start (dependencies met + concurrency slot available). Merge events are unchanged.

4. **`resolveDependencyGraph()` is preserved** in `plan.ts` - it's still used by dry-run display, the expedition module-planning stage, and the dependency validation logic. The orchestrator just stops using it for execution ordering.

5. **The `runParallel` primitive from `concurrency.ts` is no longer used by the orchestrator** - the greedy scheduler manages its own concurrency via the existing `Semaphore` and `AsyncEventQueue`. `runParallel` remains available for other consumers (expedition module planning).

## Scope

### In Scope
- Rewrite `Orchestrator.execute()` with greedy scheduling loop
- Replace `wave:start`/`wave:complete` event types with `schedule:start`/`schedule:ready` in `events.ts`
- Update `propagateFailure()` - no behavioral change needed, but verify it works with the new scheduling model
- Update `resumeState()` - no behavioral change, verify correctness
- Update `shouldSkipMerge()` - no behavioral change
- Preserve the `mergeResolver` context enrichment (currently uses wave membership to find "other plan" - adapt to use recently-merged plans instead)
- Update the barrel export in `src/engine/index.ts` if needed

### Out of Scope
- CLI display updates (plan-02)
- Monitor UI updates (plan-02)
- Dry-run rendering changes (plan-02)
- Changes to `resolveDependencyGraph()` or `plan.ts`
- Changes to expedition module-planning (still wave-based in pipeline.ts)
- Priority-based scheduling
- Speculative execution

## Files

### Modify
- `src/engine/events.ts` — Remove `wave:start`/`wave:complete` from `EforgeEvent` union. Add `schedule:start` (with `planIds: string[]`) and `schedule:ready` (with `planId: string, reason: string`). Keep all merge events unchanged.
- `src/engine/orchestrator.ts` — Rewrite `execute()` to use greedy scheduling loop. The new loop: (1) emit `schedule:start`, (2) start all zero-dep plans, (3) wait for any completion via Promise.race on per-plan promises, (4) merge completed plan, (5) emit `schedule:ready` for newly unblocked plans, (6) start them (respecting parallelism), (7) repeat until done. Adapt the merge resolver context enrichment to use "most recently merged plan" instead of "same-wave plan".
- `test/orchestration-logic.test.ts` — Update tests for `propagateFailure`, `resumeState`, `shouldSkipMerge` if any signatures change (unlikely - these are pure functions on state). Add new tests for the scheduling logic if any new exported helper functions are introduced.
- `test/dependency-graph.test.ts` — No changes expected (tests `resolveDependencyGraph` which is unchanged), but verify tests still pass.

## Verification

- [ ] `pnpm type-check` passes with zero errors
- [ ] `pnpm test` passes - all existing tests in `test/orchestration-logic.test.ts` and `test/dependency-graph.test.ts` pass
- [ ] The `EforgeEvent` union no longer contains `wave:start` or `wave:complete` variants
- [ ] The `EforgeEvent` union contains `schedule:start` (with `planIds: string[]`) and `schedule:ready` (with `planId: string`) variants
- [ ] `Orchestrator.execute()` does not call `resolveDependencyGraph()`
- [ ] `Orchestrator.execute()` does not import or use `runParallel` from concurrency.ts
- [ ] A plan with deps `[A]` in a config where `A` and `B` have no deps would be eligible to start after `A` merges, without waiting for `B` to complete
- [ ] Merge operations remain serialized - only one merge at a time
- [ ] The `parallelism` option still caps concurrent running plans
- [ ] Failure propagation still marks transitive dependents as blocked immediately when a plan fails
