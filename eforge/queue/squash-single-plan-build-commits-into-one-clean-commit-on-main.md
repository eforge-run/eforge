---
title: Squash single-plan build commits into one clean commit on main
created: 2026-03-30
status: pending
---

# Squash single-plan build commits into one clean commit on main

## Problem / Motivation

Commit `f947a97` ("Minimize Worktree Creation") introduced the `builtOnMerge` optimization: single-plan builds (where `maxConcurrency <= 1`) skip dedicated worktree creation and build directly on the merge worktree's feature branch. This saves worktree setup/teardown overhead but has a side effect - individual agent commits (builder, review-fixer, validation-fixer) are no longer squash-merged and appear as separate commits on main after the fast-forward merge.

Before this optimization, even single-plan builds used a dedicated worktree branch that was squash-merged into the feature branch, producing one clean commit per plan.

Two symptoms:
1. Two commits with identical messages (`feat(plan-01-...): Plan Name`) from builder + review-fixer
2. A separate `fix: resolve validation failures` commit from the validation fixer

Root cause: The `finalize` phase uses `git merge --ff-only` to bring the feature branch into main, preserving all individual commits.

## Goal

Single-plan builds should produce one clean squash commit on main, matching the clean commit history that existed before the `builtOnMerge` optimization.

## Approach

Squash at the `finalize` phase for single-plan builds. When `mergeFeatureBranchToBase` is called for a single-plan build, use `git merge --squash` instead of `--ff-only` to collapse all feature-branch commits into one commit on main.

Multi-plan builds are unchanged - they already produce clean per-plan squash commits, and the validation fix (if any) stays separate since it may touch files across multiple plans.

### 1. `src/engine/worktree-ops.ts` - Add squash merge path

- Add optional `squashCommitMessage` parameter to `mergeFeatureBranchToBase()`
- When provided: use `git merge --squash featureBranch` + `git commit -m <message>` instead of `--ff-only`
- Handle conflicts via existing `mergeResolver` callback
- Fall back to `git reset --merge` on failure (same pattern as existing code)
- When not provided: existing behavior unchanged (ff-only, fallback to temp worktree merge)

### 2. `src/engine/worktree-manager.ts` - Thread parameter through `mergeToBase`

- Pass `squashCommitMessage` through `mergeToBase()` to `mergeFeatureBranchToBase()`

### 3. `src/engine/orchestrator/phases.ts` - Compute squash message in `finalize`

- In `finalize()`, check if `config.plans.length === 1`
- If so, compute `feat(planId): planName\n\n<ATTRIBUTION>` and pass as `squashCommitMessage`
- Multi-plan builds pass nothing (existing ff-only/merge behavior)
- Import `ATTRIBUTION` from `../git.js`

### 4. Tests

Add tests in existing test files:
- Single-plan squash: verify one commit on main after finalize
- Multi-plan: verify individual commits preserved (no squash)
- Squash with conflict: verify merge resolver is invoked

## Scope

**In scope:**
- Squash merge behavior for single-plan builds in the `finalize` phase
- `squashCommitMessage` parameter plumbing through `mergeFeatureBranchToBase` and `mergeToBase`
- Squash commit message computation in `finalize`
- Tests for single-plan squash, multi-plan preservation, and squash-with-conflict scenarios

**Out of scope:**
- Multi-plan build commit behavior (unchanged)
- Any changes to builder, review-fixer, or validation-fixer commit logic
- Worktree creation/teardown behavior

## Acceptance Criteria

- Single-plan builds produce exactly one commit on main after finalize (squash merge)
- Multi-plan builds preserve individual per-plan commits (existing behavior unchanged)
- Squash commit message follows the format `feat(planId): planName\n\n<ATTRIBUTION>`
- Merge conflicts during squash invoke the existing `mergeResolver` callback
- Failed squash merges fall back to `git reset --merge` (same pattern as existing code)
- `pnpm test` - all existing and new tests pass
- `pnpm type-check` - no type errors
- Running a single-plan build (errand or excursion with 1 plan) produces one clean commit on main in the git log
