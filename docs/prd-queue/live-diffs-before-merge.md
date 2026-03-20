---
title: Live Diffs Before Merge
created: 2026-03-20
status: pending
---

# Live Diffs Before Merge

## Problem / Motivation

The monitor's diff viewer only works after `merge:complete` because `resolveCommitSha` returns null until then, causing a 404. During active builds, the plan branch already exists with committed changes (via `forgeCommit()`), so diffs could be shown immediately using branch-based diffing as a fallback. Users currently have to wait until merge completes to inspect changes in the monitor, even though the data is available earlier.

## Goal

Show file diffs in the monitor as soon as files appear during an active build, falling back to branch-based diffing (`git diff baseBranch..planBranch`) when no merge commit exists yet.

## Approach

Modify `serveDiff` in `src/monitor/server.ts` (line ~459) to fall back to branch-based diffing when `resolveCommitSha` returns null:

1. Add a `resolvePlanBranch(sessionId, planId)` helper that:
   - Queries `plan:complete` events for the session
   - Parses the event data to find the plan entry matching `planId`
   - Returns `{ branch, baseBranch }` or null

2. In `serveDiff`, when `commitSha` is null:
   - Call `resolvePlanBranch(sessionId, planId)`
   - If found, use `git diff baseBranch..planBranch -- file` for single-file diffs
   - For bulk diffs, use `git diff baseBranch..planBranch --name-only` to get the file list, then `git diff baseBranch..planBranch -- file` for each
   - Return `{ diff, branch }` (no `commitSha` field since there's no merge commit yet)

3. The `plan:complete` event carries the full orchestration data including `baseBranch` and per-plan `branch` fields (from `OrchestrationConfig` in `events.ts`)

The branch-based approach works because:
- The builder commits via `forgeCommit()` during implementation
- The plan branch exists from build start until post-merge cleanup
- `git diff baseBranch..planBranch` shows all committed changes on the plan branch

The existing commit-based path remains unchanged - branch-based diffing is purely a fallback for the pre-merge window.

## Scope

**In scope:**
- Adding `resolvePlanBranch()` helper to `src/monitor/server.ts`
- Modifying `serveDiff` to fall back to branch-based diffing when `resolveCommitSha` returns null
- Single-file and bulk diff support via the branch-based path

**Out of scope:**
- Changes to the existing commit-based diff path (post-merge behavior unchanged)
- Frontend/UI changes to the monitor dashboard
- Changes to `forgeCommit()`, orchestration, or event emission

## Acceptance Criteria

- `pnpm build` compiles successfully
- During an active eforge build, opening the monitor and clicking the Changes tab shows diffs as soon as files appear (branch-based)
- After merge, diffs continue to work via the existing commit-based path
- When `resolveCommitSha` returns null and `resolvePlanBranch` also returns null, a 404 is returned (no regression in error handling)
- Single-file diffs use `git diff baseBranch..planBranch -- file`
- Bulk diffs use `git diff baseBranch..planBranch --name-only` to enumerate files, then diff each individually
- The branch-based response returns `{ diff, branch }` without a `commitSha` field
