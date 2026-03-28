---
id: plan-02-minimize-worktrees
name: Minimize Worktree Creation Using Dependency Graph
dependsOn: []
branch: monitor-diff-view-fall-back-to-repo-root-for-git-commands-2/minimize-worktrees
---

# Minimize Worktree Creation Using Dependency Graph

## Architecture Context

The orchestrator (`src/engine/orchestrator.ts`) currently creates a separate git worktree for every plan via `createWorktree()` in `launchPlan()` (line 301). Each worktree branches off the feature branch, runs the build, then gets cleaned up and squash-merged back. For the common case (single plan, or linear dependency chains), this is unnecessary overhead - the merge worktree already has the feature branch checked out and is the correct base for building.

The orchestrator uses a greedy scheduling approach: it starts all zero-dependency plans immediately, then starts newly unblocked plans after each merge. The concurrency is bounded by a `Semaphore`. The key insight is: if the maximum number of plans that could run simultaneously (determined by the dependency graph's wave structure) is 1, no plan worktrees are needed.

## Implementation

### Overview

1. Before the scheduling loop, compute the maximum wave concurrency from the dependency graph
2. Add a `needsPlanWorktrees` boolean based on whether max concurrency > 1
3. In `launchPlan()`, when `!needsPlanWorktrees`, set `worktreePath = mergeWorktreePath` instead of calling `createWorktree()`
4. Skip `removeWorktree()` in the finally block when reusing the merge worktree
5. Skip `mergeWorktree()` for plans that built directly on the merge worktree (commits land directly on the feature branch)

### Key Decisions

1. **All-or-nothing approach** - If any wave has concurrency > 1, use plan worktrees for all plans. The simpler approach avoids complex per-wave logic and matches the PRD's recommendation.

2. **Compute max concurrency via topological wave analysis** - Group plans into waves where wave 0 has no dependencies, wave N depends only on plans in waves < N. The max wave size determines whether plan worktrees are needed. This is a pure function of the dependency graph - add it as an exported helper for testability.

3. **Skip merge for direct-on-merge-worktree plans** - When a plan builds directly on the merge worktree, its commits land on the feature branch already. The squash merge step must be skipped. Track this with a `Set<string>` of plan IDs that ran on the merge worktree.

4. **No worktree removal for merge worktree** - The merge worktree cleanup is handled separately in the finally block (line 613). When reusing it for plan builds, the per-plan `removeWorktree()` in the finally block of `launchPlan()` must not run.

## Scope

### In Scope
- Adding a `computeMaxConcurrency()` function to `src/engine/orchestrator.ts`
- Adding `needsPlanWorktrees` logic before the scheduling loop
- Modifying `launchPlan()` to conditionally skip worktree creation
- Skipping `removeWorktree()` when the plan used the merge worktree
- Skipping `mergeWorktree()` for plans that built directly on the merge worktree
- Marking those plans as `merged` directly (commits are already on the feature branch)
- Adding unit tests for `computeMaxConcurrency()`

### Out of Scope
- Changes to the dependency graph computation itself
- Per-wave optimization (only worktrees for concurrent waves)
- Changes to `createWorktree()` or `removeWorktree()` signatures

## Files

### Modify
- `src/engine/orchestrator.ts` - Add `computeMaxConcurrency()`, add `needsPlanWorktrees` logic, modify `launchPlan()` and merge logic
- `test/orchestration-logic.test.ts` - Add tests for `computeMaxConcurrency()`

## Verification

- [ ] `computeMaxConcurrency()` returns 1 for a single plan with no dependencies
- [ ] `computeMaxConcurrency()` returns 1 for a linear chain (A -> B -> C)
- [ ] `computeMaxConcurrency()` returns 2 for two independent plans (A, B with no deps)
- [ ] `computeMaxConcurrency()` returns the max wave size for a diamond graph (A -> B, A -> C, B -> D, C -> D) which is 2 (B and C run concurrently)
- [ ] When `needsPlanWorktrees` is false, `launchPlan()` sets `worktreePath` to `mergeWorktreePath` instead of calling `createWorktree()`
- [ ] When `needsPlanWorktrees` is false, `removeWorktree()` is not called for the plan's worktree path
- [ ] When a plan builds on the merge worktree, it is marked `merged` without calling `mergeWorktree()` and no squash-merge commit is created
- [ ] When `needsPlanWorktrees` is true (concurrent plans exist), existing behavior is preserved - plan worktrees are created, used, cleaned up, and squash-merged
- [ ] `pnpm type-check` passes
- [ ] `pnpm test` passes
