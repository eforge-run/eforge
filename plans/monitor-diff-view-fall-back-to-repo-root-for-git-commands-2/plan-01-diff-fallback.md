---
id: plan-01-diff-fallback
name: Monitor Diff View Falls Back to Repo Root for Git Commands
dependsOn: []
branch: monitor-diff-view-fall-back-to-repo-root-for-git-commands-2/diff-fallback
---

# Monitor Diff View Falls Back to Repo Root for Git Commands

## Architecture Context

The monitor server's `serveDiff()` function (in `src/monitor/server.ts`, around line 608) runs `git diff-tree` and `git diff` commands using a `cwd` resolved from the DB run record. With worktree isolation, the stored `cwd` may point to a deleted worktree directory after build completion. Since commit SHAs are repo-global (all worktrees share the same git object store), `git diff-tree <sha>` works from any directory within the repo - so falling back to the repo root is safe.

The `resolveCommitSha()` function (line 546) also uses `cwd` for a `git log --grep` fallback. The `resolvePlanBranch()` function (line 572) reads `orchestration.yaml` from disk using `run.cwd` - this path could also be a deleted worktree, but this is for pre-merge branch-based diffs which only matter during active builds when the worktree still exists, so no change needed there.

## Implementation

### Overview

Modify `resolveCwd()` to detect when the stored `cwd` no longer exists and fall back to the git repo root. The approach:

1. Add a helper function `resolveGitCwd()` that takes the stored `cwd` string and:
   - Checks if the directory exists using `stat()`
   - If it exists, returns it as-is
   - If it doesn't exist (worktree was cleaned up), runs `git rev-parse --show-toplevel` from the parent directory or walks up the path to find the repo root
   - Since the worktree path is typically `../{project}-{setName}-worktrees/__merge__/{branch}` and the repo is a sibling, we can derive the repo root by checking the DB run records for a compile run (which always runs in the repo root), or by stripping the worktree suffix pattern

2. Actually, the simplest approach: store the repo root alongside `cwd` in the run record is out of scope. Instead, look at all session runs - the compile run's `cwd` is always the repo root. Use that as fallback.

### Key Decisions

1. **Use compile run's cwd as fallback** - The compile phase always runs in the repo root (before worktrees are created). The build phase runs in a worktree. So `resolveCwd()` can fall back to the compile run's `cwd` when the build run's `cwd` doesn't exist. This is the simplest approach - no git commands needed, no path manipulation, just check directory existence and fall back.

2. **Check existence with `stat()`** - Already imported in server.ts. Wrap in try/catch to detect deleted directories.

3. **Apply fallback to all git operations in serveDiff()** - The resolved `cwd` flows through to `resolveCommitSha()` (called on line 616) and all `git diff-tree`/`git diff` commands. By fixing `resolveCwd()` or adding a wrapper, all downstream git commands get a valid directory.

## Scope

### In Scope
- Modifying `resolveCwd()` in `src/monitor/server.ts` to check if the resolved `cwd` exists on disk
- Falling back to the compile run's `cwd` when the build run's `cwd` is a deleted worktree
- Making `resolveCwd` async (it currently calls only sync DB methods, but `stat()` is async)
- Updating the `serveDiff()` call site to `await resolveCwd()`

### Out of Scope
- Changes to DB schema or run record storage
- Changes to worktree lifecycle
- Changes to `resolvePlanBranch()` (only used for pre-merge diffs during active builds)

## Files

### Modify
- `src/monitor/server.ts` - Update `resolveCwd()` to check directory existence and fall back to compile run cwd; update `serveDiff()` to await the now-async `resolveCwd()`

## Verification

- [ ] `resolveCwd()` returns the build run's `cwd` when the directory exists on disk
- [ ] `resolveCwd()` returns the compile run's `cwd` when the build run's `cwd` does not exist on disk
- [ ] `resolveCwd()` returns `null` when neither run's `cwd` exists
- [ ] `serveDiff()` calls `resolveCwd()` with `await` (function is now async)
- [ ] `pnpm type-check` passes
- [ ] `pnpm test` passes
