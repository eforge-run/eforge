---
id: plan-02-merge-robustness
name: Merge Failure Propagation & Conflict Cleanup
depends_on: []
branch: phase4-polish-prd/merge-robustness
---

# Merge Failure Propagation & Conflict Cleanup

## Architecture Context

The merge phase in `orchestrator.ts` runs sequentially through `mergeOrder` (topological). Currently, if merging plan B fails due to a conflict, plan C (which depends on B) still attempts to merge against inconsistent state. Additionally, a failed `git merge --no-ff` leaves the repo in a `MERGING` state, blocking all subsequent merge attempts. This plan fixes both issues to make the merge phase robust under conflict conditions.

## Implementation

### Overview

1. **Merge blocking**: Track failed merges in a `Set<string>`. Before each merge, check if any of the plan's dependencies are in the failed set. If so, mark as failed with a descriptive error and skip.
2. **Conflict cleanup**: In `worktree.ts`, wrap `mergeWorktree` to run `git merge --abort` when `git merge --no-ff` fails, leaving the repo clean for subsequent merge attempts.

### Key Decisions

1. **Extract `shouldSkipMerge` as a pure function** — This makes the merge-blocking logic independently testable without needing to run the full orchestrator. It takes a `planId`, the plan config array, and the `failedMerges` set, and returns either `null` (proceed) or a string (skip reason).
2. **`git merge --abort` in `mergeWorktree`** — The abort happens inside `mergeWorktree` itself (not the orchestrator) because `mergeWorktree` is the function that initiated the merge. This keeps git state cleanup co-located with the git operation. The error is still re-thrown so the orchestrator can mark the plan as failed.
3. **Use existing `propagateFailure` for build-phase failures only** — The merge-phase blocking is simpler (just check direct dependencies against a set) and doesn't need BFS traversal because merge order is already topological. Failed merges are tracked separately from build failures.

## Scope

### In Scope
- `shouldSkipMerge(planId, plans, failedMerges)` pure function in `orchestrator.ts`
- Merge loop in `Orchestrator.execute()` uses `shouldSkipMerge` and tracks failed merges
- `mergeWorktree()` runs `git merge --abort` on conflict before re-throwing
- 4 new tests for `shouldSkipMerge` in `test/orchestration-logic.test.ts`

### Out of Scope
- Retry logic for failed merges
- Interactive conflict resolution
- Post-merge validation (plan-03)

## Files

### Modify
- `src/engine/orchestrator.ts` — Add exported `shouldSkipMerge` function; update merge loop to track `failedMerges: Set<string>`, call `shouldSkipMerge` before each merge, add planId to `failedMerges` on failure
- `src/engine/worktree.ts` — In `mergeWorktree`, wrap the `git merge --no-ff` in try-catch; on error, run `git merge --abort` (best-effort, ignore abort errors), then re-throw original error
- `test/orchestration-logic.test.ts` — Add `describe('shouldSkipMerge')` block with 4 tests:
  1. Returns `null` when no dependencies failed
  2. Returns skip reason when a direct dependency failed
  3. Returns skip reason when a transitive dependency failed (checked via the failed set containing intermediate)
  4. Returns `null` when dependencies exist but none are in the failed set

## Verification

- [ ] `shouldSkipMerge` returns `null` for plans with no failed dependencies
- [ ] `shouldSkipMerge` returns a descriptive error when a dependency is in the failed set
- [ ] `mergeWorktree` runs `git merge --abort` on conflict (verify repo is clean after failure)
- [ ] Merge loop skips dependent plans when upstream merge fails
- [ ] `pnpm test` passes with all new tests
- [ ] `pnpm run type-check` passes
