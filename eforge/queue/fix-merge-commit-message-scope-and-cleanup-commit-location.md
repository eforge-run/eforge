---
title: Fix merge commit message scope and cleanup commit location
created: 2026-03-31
status: pending
---

# Fix merge commit message scope and cleanup commit location

## Problem / Motivation

After introducing the `--no-ff` merge strategy, two issues remain in the git history:

1. **Merge commit uses plan-level name instead of set-level name** - For single-plan builds, the `--no-ff` merge commit message is `feat(plan-01-parallelism-docs): ...` when it should be `feat(document-parallelism-configuration-in-docs-config-md): ...` to match the multi-plan behavior. The single-plan case uses `config.plans[0].id` but should use `config.name` (the set-level identifier).

2. **Cleanup commit lands on base branch after the merge** - The `cleanup(...): remove plan files and PRD` commit appears on `main` after the merge commit. It should be on the feature branch before the `--no-ff` merge, so the merge commit is the single entry point on the base branch.

## Goal

Ensure the merge commit scope always uses the set-level name (`config.name`), and ensure the cleanup commit appears inside the feature branch (before the merge) rather than on the base branch after it.

## Approach

### Fix 1: Merge commit message (`src/engine/orchestrator/phases.ts:519-527`)

Use `config.name` for the scope in the single-plan case, matching the multi-plan behavior. Keep `config.plans[0].name` for the description since it is the human-readable plan name (same content as `config.description` for single-plan builds).

```typescript
// Before (line 522-523):
if (config.plans.length === 1) {
  commitMessage = `${prefix}(${config.plans[0].id}): ${config.plans[0].name}\n\n${ATTRIBUTION}`;

// After:
if (config.plans.length === 1) {
  commitMessage = `${prefix}(${config.name}): ${config.plans[0].name}\n\n${ATTRIBUTION}`;
```

### Fix 2: Move cleanup to feature branch before finalize

Add cleanup as a step inside `finalize()` before the `--no-ff` merge. The sequence inside `finalize()` becomes:

1. Checkout feature branch
2. Run cleanup (git rm plan files + PRD, commit)
3. Checkout base branch
4. `git merge --no-ff` feature branch into base

This keeps the cleanup contained and avoids passing plan/PRD paths through the orchestrator separately.

**Key file changes:**

- **`src/engine/orchestrator/phases.ts`** - Merge commit message fix + cleanup before merge. Expand `finalize()` to accept cleanup info (planSet, outputDir, prdFilePath) via `PhaseContext`, checkout feature branch, do cleanup commit, checkout base branch, then merge.
- **`src/engine/orchestrator.ts`** - Pass cleanup config into `PhaseContext`.
- **`src/engine/eforge.ts`** - Remove the `cleanupPlanFiles()` call at line 703-706. Pass cleanup info (planSet, outputDir, prdFilePath, shouldCleanup flag) to the orchestrator so it can include them in the phase context.
- **`src/engine/eforge.ts`** - `cleanupPlanFiles()` function: reuse as-is or with minor adaptation. Simplest approach is to keep the function and call it from `finalize()` with the repoRoot after checking out the feature branch.

The orchestrator flow becomes:

```
executePlans → validate → prdValidate → finalize (cleanup on feature branch + merge to base)
```

## Scope

**In scope:**

- Fixing the merge commit message scope to always use `config.name` (set-level identifier)
- Moving the cleanup commit (plan files + PRD removal) onto the feature branch before the `--no-ff` merge
- Updating `finalize()` in `phases.ts` to perform cleanup before merging
- Removing the post-orchestrator cleanup call in `eforge.ts`
- Passing cleanup configuration through the orchestrator via `PhaseContext`

**Out of scope:**

- Changes to the multi-plan merge commit message (already correct)
- Changes to the cleanup logic itself (reusing existing `cleanupPlanFiles()`)
- Changes to the `--no-ff` merge strategy

## Acceptance Criteria

1. `pnpm test` passes with no regressions.
2. `pnpm build` succeeds.
3. For single-plan builds, the merge commit on the base branch uses the set-level name (`config.name`) in the scope - not the plan-level id (`config.plans[0].id`).
4. The cleanup commit (`cleanup(...): remove plan files and PRD`) appears inside the feature branch, visible in `git log --graph` as part of the branch history before the merge.
5. No cleanup commit appears on the base branch after the merge commit.
6. The merge commit remains the single entry point on the base branch.
