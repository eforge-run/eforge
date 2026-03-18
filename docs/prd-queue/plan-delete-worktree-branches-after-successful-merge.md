---
title: Plan: Delete worktree branches after successful merge
created: 2026-03-18
status: pending
---

## Problem / Motivation

eforge creates a git branch per plan during orchestrated builds (`createWorktree` in `src/engine/worktree.ts`). After a plan completes, the worktree directory is removed (`removeWorktree`), and after all plans finish, `cleanupWorktrees` prunes git metadata and removes the worktree base directory. However, none of these cleanup steps delete the branch itself. Since merges are squash merges, the branch refs are fully redundant post-merge - they just accumulate indefinitely.

## Goal

Delete plan branches after orchestrated builds so redundant branch refs don't accumulate. Cover both the success path (immediately after squash merge) and the failure/skip path (sweep in the finally block).

## Approach

Two complementary deletion points in `src/engine/orchestrator.ts`:

1. **Immediate deletion after successful merge (~line 382):** After `mergeWorktree()` succeeds and before `updatePlanStatus(state, planId, 'merged')`, delete the branch:

```typescript
// Delete the merged branch — squash merge means it's fully redundant
try {
  await exec('git', ['branch', '-D', plan.branch], { cwd: repoRoot });
} catch {
  // Best-effort — branch may not exist (e.g., already cleaned up)
}
```

Use `-D` (force delete) rather than `-d` because squash merges don't create a merge commit, so git doesn't recognize the branch as "fully merged" - `-d` would refuse.

`exec` is already imported in `orchestrator.ts` (used for `git checkout` and other git commands elsewhere in the file).

2. **Sweep of remaining branches in the finally block (~line 493-500):** Alongside `cleanupWorktrees`, iterate `planMap` and attempt `git branch -D` for each plan's branch, best-effort. This catches failed and skipped plans that never reached the merge path.

**One file to modify:** `src/engine/orchestrator.ts`

## Scope

**In scope:**
- Deleting plan branches after successful squash merge in the orchestrator
- Sweeping all remaining plan branches (failed, skipped) in the finally block
- Best-effort deletion (silent catch on failure)

**Out of scope:**
- Changes to `worktree.ts` cleanup functions (`removeWorktree`, `cleanupWorktrees`)
- Any changes to branch creation or naming logic
- Changes to non-orchestrated (single-plan) builds

## Acceptance Criteria

- `pnpm type-check` passes with no type errors
- `pnpm test` passes - all existing tests still pass
- After a successful orchestrated (expedition-mode) build, `git branch` shows no leftover plan branches
- Failed or skipped plan branches are also cleaned up via the finally-block sweep
- Branch deletion is best-effort - failures are silently caught and do not interrupt the build
