---
id: plan-01-delete-branches
name: Delete worktree branches after merge and on cleanup
depends_on: []
branch: plan-delete-worktree-branches-after-successful-merge/delete-branches
---

# Delete worktree branches after merge and on cleanup

## Architecture Context

eforge creates a git branch per plan during orchestrated builds. After plans complete, worktree directories and git metadata are cleaned up - but the branch refs are never deleted. Since merges are squash merges, branch refs are fully redundant post-merge and accumulate indefinitely.

## Implementation

### Overview

Add branch deletion at two points in `src/engine/orchestrator.ts`:

1. **After successful merge** (~line 381-386): Delete the branch immediately after `mergeWorktree()` succeeds, before updating state to `merged`. Use `git branch -D` (force) because squash merges don't create a merge commit, so git's `-d` (safe delete) would refuse.

2. **In the finally block** (~line 493-500): Sweep all plan branches alongside `cleanupWorktrees()`. Iterate `planMap` and attempt `git branch -D` for each plan's branch. This catches failed, skipped, and blocked plans that never reached the merge path.

Both deletions are best-effort with silent catch - branch may already be deleted or never created.

### Key Decisions

1. Use `git branch -D` (force) instead of `-d` (safe) because squash merges leave branches appearing "unmerged" to git's tracking. `-d` would refuse to delete them.
2. Best-effort deletion (silent catch) at both points - branch deletion must never interrupt or fail a build.
3. Delete after merge but before `updatePlanStatus(state, planId, 'merged')` so the branch is gone before downstream plans start.

## Scope

### In Scope
- Deleting plan branches after successful squash merge in the orchestrator
- Sweeping all remaining plan branches (failed, skipped, blocked) in the finally block
- Best-effort deletion with silent catch on failure

### Out of Scope
- Changes to `worktree.ts` cleanup functions (`removeWorktree`, `cleanupWorktrees`)
- Changes to branch creation or naming logic
- Changes to non-orchestrated (single-plan) builds

## Files

### Modify
- `src/engine/orchestrator.ts` — Add `git branch -D` after successful merge (~line 381) and add branch sweep loop in the finally block (~line 493-500) alongside `cleanupWorktrees`

## Verification

- [ ] `pnpm type-check` exits with code 0
- [ ] `pnpm test` exits with code 0 (all existing tests pass)
- [ ] After `mergeWorktree()` succeeds, `exec('git', ['branch', '-D', plan.branch], { cwd: repoRoot })` is called before `updatePlanStatus(state, planId, 'merged')`
- [ ] The finally block iterates all plans in `planMap` and attempts `git branch -D` for each plan's branch
- [ ] Both branch deletion calls are wrapped in try/catch with empty catch blocks (best-effort, no interruption)
