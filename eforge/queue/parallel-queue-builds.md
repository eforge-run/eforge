---
title: Parallel Queue Builds
created: 2026-03-31
status: pending
---

# Parallel Queue Builds

## Problem / Motivation

Currently, eforge processes queued PRDs sequentially - one build must complete before the next starts. When independent PRDs are queued (no `depends_on` relationship), they could run concurrently. The infrastructure is largely already in place: concurrency primitives (`Semaphore`, `AsyncEventQueue`) are battle-tested, compile/build operate in isolated git worktrees, and PRD claims use atomic lock files designed for concurrent access.

The gap is narrow: `runQueue()` iterates PRDs in a sequential `for` loop. Plus one unsafe `git reset --hard` on the main tree that would be catastrophic under concurrency.

## Goal

Replace the sequential queue loop with a greedy semaphore-limited scheduler that runs independent PRDs concurrently, and add automatic dependency detection at enqueue time so conflicts are serialized by default while truly independent work runs in parallel.

## Approach

Replicate the greedy scheduler pattern the orchestrator already uses for plan-level parallelism in `executePlans()` (`src/engine/orchestrator/phases.ts:183`). That pattern:

1. Tracks dependency state per item
2. Launches all items with satisfied deps immediately (up to semaphore limit)
3. On each completion, merges the result, then scans for newly-unblocked items and launches them
4. Keeps the pipeline full - no waiting for "waves" to drain

Default to `parallelism: 1` for backwards compatibility.

Additionally, add automatic dependency detection at enqueue time. A lightweight, toolless agent call analyzes the new PRD against existing queue items and running builds to auto-populate `depends_on`. The merge conflict resolver (already wired into `mergeToBase()`) serves as a safety net for anything the detection misses.

### 1. Config: add `prdQueue.parallelism` (`src/engine/config.ts`)

Add `parallelism` to the `prdQueue` config schema and `DEFAULT_CONFIG`:

- Schema: `parallelism: z.number().int().positive().optional()`
- Default: `1` (sequential, backwards-compatible)
- CLI flag: `--queue-parallelism <n>` on `eforge build --queue` and `eforge queue run`

### 2. Dependency detection agent (`src/engine/agents/dependency-detector.ts`, `src/engine/prompts/dependency-detector.md`)

A new toolless, one-shot agent that runs during enqueue (in `EforgeEngine.enqueue()` at `src/engine/eforge.ts:367`, after formatting and before `enqueuePrd()`). Uses `fast` model class for speed and cost.

**Agent input** (via prompt template):
- The new PRD's formatted content (title, scope, approach, acceptance criteria)
- List of existing queue items: id, title, scope summary (first ~200 chars of body) for each pending PRD from `loadQueue()`
- List of running builds: plan set name + plan titles from `.eforge/state.json` via `loadState()`

**Agent output**: A JSON array of PRD ids that the new PRD depends on (should wait for), or empty array if independent. The agent should declare a dependency when two PRDs are likely to modify the same files or the new PRD's work builds on another's output.

**Integration into enqueue flow** (`src/engine/eforge.ts`):
```
format -> infer title -> detect dependencies -> enqueuePrd(depends_on) -> git commit
```

The detection step:
1. Call `loadQueue()` to get existing pending PRDs
2. Call `loadState()` to get running builds
3. Run the dependency detector agent with the context
4. Parse the JSON output into a `depends_on` string array
5. Pass `depends_on` to `enqueuePrd()` (which already accepts it)

**Config**: Add `'dependency-detector'` to `AGENT_MODEL_CLASSES` in `src/engine/pipeline.ts` with default class `max` (consistent with all other roles). This avoids breaking Pi backend users who haven't configured `agents.models.fast`. The operation is lightweight enough that `max` is fine on cost. Users can override to `fast` via per-role `modelClass` in config if desired.

**No changes to `resolveQueueOrder()`** - keep it returning `QueuedPrd[]` (flattened). The greedy scheduler reads `depends_on` from PRD frontmatter directly and checks dep satisfaction dynamically at runtime, same as `executePlans()`.

### 3. Remove `git reset --hard` from queue loop (`src/engine/eforge.ts`)

Lines 747 and 801 record `preCompileHead` and reset the main tree on build failure. But compile already operates in a merge worktree (line 258) - the main tree's HEAD doesn't change during compile. This reset is a legacy safety net that would destroy concurrent builds. Remove it.

On build failure, the feature branch simply isn't merged to base - the worktree cleanup already handles this.

### 4. Extract `buildSinglePrd()` from `runQueue()` (`src/engine/eforge.ts`)

Extract the per-PRD body (lines 730-825) into a standalone async generator method:

```typescript
private async *buildSinglePrd(
  prd: QueuedPrd,
  options: QueueOptions,
): AsyncGenerator<EforgeEvent>
```

This method handles: claim, staleness check, session lifecycle events, compile, build, error handling, lock release, status updates. Everything that currently lives inside the `for` loop body for a single PRD.

### 5. Restructure `runQueue()` with greedy scheduler (`src/engine/eforge.ts`)

Model after `executePlans()` in `src/engine/orchestrator/phases.ts:183`. The key components:

**State tracking** per PRD:
```typescript
interface PrdRunState {
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'blocked';
  dependsOn: string[];
}
```

**`isReady(prdId)`** - true when status is `pending` and all `depends_on` items have completed/skipped status.

**`launchPrd(prd)`** - acquires semaphore, adds producer to event queue, runs `buildSinglePrd()`, pushes events, updates state, releases semaphore, removes producer. On failure, propagates blocked status to transitive dependents.

**`startReadyPrds()`** - scans all PRDs, launches any that are ready and not already running.

**Event loop** - same pattern as `executePlans()`:
```
startReadyPrds()  // launch all zero-dep PRDs
for await (event of eventQueue):
  yield event
  // check for completions
  for each just-completed PRD:
    remove from running
    startReadyPrds()  // launch newly-unblocked items
  // if nothing running and nothing ready, done
```

When `parallelism: 1`, the semaphore serializes execution naturally - same behavior as today, no special-casing needed.

### 6. CLI flag (`src/cli/index.ts`)

Add `--queue-parallelism <n>` option to the `build` and `queue run` commands. Pass through to `QueueOptions` and override `config.prdQueue.parallelism`.

### 7. Daemon config propagation (`src/monitor/server-main.ts`)

The watcher spawns `eforge run --queue --auto --no-monitor`. The `prdQueue.parallelism` config is picked up from `eforge/config.yaml` automatically. No daemon changes needed.

### What already works (no changes needed)

- **Worktree isolation**: `compile()` creates a merge worktree per plan set (line 258). `build()` orchestrator creates per-plan worktrees. Each concurrent PRD build is fully isolated.
- **Event multiplexing**: `AsyncEventQueue` multiplexes events from concurrent producers into a single stream.
- **Session separation**: Each PRD already gets its own `sessionId` (line 730). The monitor groups by session, so concurrent builds naturally appear as separate entries in the sidebar.
- **Claim exclusivity**: `claimPrd()` uses atomic lock files - designed for concurrent access.
- **Branch isolation**: Each PRD's compile creates a unique feature branch (`eforge/{planSetName}`). No conflicts between concurrent builds.
- **Merge conflict resolution**: `mergeToBase()` in `worktree-ops.ts` already calls the merge conflict resolver agent when conflicts arise. If dependency detection misses an overlap, conflicts are handled at merge time automatically.
- **Proven pattern**: `executePlans()` in `src/engine/orchestrator/phases.ts` is the exact greedy scheduler we're replicating, battle-tested for plan-level parallelism.
- **`enqueuePrd()` already accepts `depends_on`**: The function signature and frontmatter serialization already support it - just not auto-populated today.

### Files to modify

| File | Change | Size |
|------|--------|------|
| `src/engine/config.ts` | Add `prdQueue.parallelism` | S |
| `src/engine/agents/dependency-detector.ts` | New toolless one-shot agent (same pattern as `formatter.ts`) | S |
| `src/engine/prompts/dependency-detector.md` | Prompt template for dependency detection | S |
| `src/engine/pipeline.ts` | Add `'dependency-detector'` to `AGENT_MODEL_CLASSES` with class `max` | S |
| `src/engine/eforge.ts` | Remove `git reset --hard`, add dep detection to `enqueue()`, extract `buildSinglePrd()`, restructure `runQueue()` with greedy scheduler | L |
| `src/cli/index.ts` | Add `--queue-parallelism` flag | S |

## Scope

### In scope

- Adding `prdQueue.parallelism` config option with default `1`
- Automatic dependency detection agent at enqueue time
- Removing unsafe `git reset --hard` from queue loop
- Extracting `buildSinglePrd()` method
- Restructuring `runQueue()` with greedy semaphore-limited scheduler
- CLI `--queue-parallelism` flag for `build` and `queue run` commands
- Daemon picking up parallelism config from `eforge/config.yaml`

### Out of scope

- Queue-level dependency graph visualization in the monitor UI Graph tab (infrastructure exists in `src/monitor/ui/src/components/graph/`, currently scoped to plans within a single build)

## Acceptance Criteria

1. `pnpm test` - existing tests pass (no behavioral change at `parallelism: 1`)
2. `pnpm type-check` - no type errors
3. Enqueue a PRD when another is already queued with overlapping scope - verify `depends_on` is auto-populated in the new PRD's frontmatter
4. Enqueue a PRD with clearly independent scope - verify `depends_on` is empty
5. Set `prdQueue.parallelism: 2` in `eforge/config.yaml`, enqueue two independent PRDs, run `eforge build --queue --foreground --verbose` and verify both builds run concurrently (overlapping agent events in output)
6. Enqueue two PRDs where one `depends_on` the other (auto or manual), verify the dependent waits until its dependency completes before starting
7. Enqueue 3 independent PRDs with `parallelism: 2`, verify only 2 run at a time and the 3rd starts as soon as one finishes
8. Test with daemon: `eforge daemon start`, enqueue two independent PRDs, verify parallel execution in monitor UI
