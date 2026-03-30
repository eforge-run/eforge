---
id: plan-01-fix-branch-drift
name: Fix builder branch drift and add drift recovery
dependsOn: []
branch: fix-builder-branch-drift-causing-lost-implementation-commits/fix-branch-drift
---

# Fix builder branch drift and add drift recovery

## Architecture Context

The builder agent receives a `{{plan_branch}}` template variable in its prompt, which signals it to create/checkout that branch - drifting off the feature branch the orchestrator expects. The `builtOnMergeWorktree` merge path in the orchestrator blindly captures HEAD without verifying the worktree is still on the expected branch, causing implementation commits to be orphaned.

This plan removes the branch signal from the builder prompt, adds a defensive `recoverDriftedWorktree` function to `worktree.ts`, wires it into the orchestrator's merge path, and adds tests.

## Implementation

### Overview

Three-pronged fix: (1) prevent drift by removing `{{plan_branch}}` from the builder prompt and adding an explicit constraint, (2) detect and recover from drift in the orchestrator's merge path via a new `recoverDriftedWorktree` utility, (3) resurrect the lost `eforge config init` commits via cherry-pick onto the feature branch.

### Key Decisions

1. **Extract drift recovery to `worktree.ts`** - keeps it testable with real git repos without needing the full orchestrator. The function uses the existing `mergeWorktree` to squash-merge drifted changes back.
2. **Use `-B` for temp branch creation** - force-creates the branch to avoid collision errors if a previous recovery attempt left a stale branch.
3. **Best-effort cleanup of drift branch** - the drift branch is deleted after recovery but failure is silently ignored since the recovery itself already succeeded.
4. **Cherry-pick lost commits onto feature branch** - when merged to main, the implementation will land. The commits `d1b31fa` and `a3c301d` are dangling but still in the object store.

## Scope

### In Scope
- Remove `{{plan_branch}}` template variable from `src/engine/prompts/builder.md`
- Add "No branch operations" constraint to builder prompt
- Remove `plan_branch` from `loadPrompt` call in `src/engine/agents/builder.ts`
- New `recoverDriftedWorktree` export in `src/engine/worktree.ts`
- Update `builtOnMergeWorktree` block in `src/engine/orchestrator.ts` to call `recoverDriftedWorktree`
- New test file `test/worktree-drift.test.ts` with three test cases
- Cherry-pick lost commits `d1b31fa` and `a3c301d`

### Out of Scope
- Changes to other merge paths in the orchestrator
- Builder agent behavioral changes beyond removing the branch signal

## Files

### Create
- `test/worktree-drift.test.ts` - tests for `recoverDriftedWorktree` covering no-drift, branch drift, and detached HEAD drift scenarios

### Modify
- `src/engine/prompts/builder.md` - remove line `- **Branch**: {{plan_branch}}` (line 11), add `- **No branch operations** - do not create, checkout, or switch git branches. The orchestrator manages all branching.` as the first bullet in the `## Constraints` section
- `src/engine/agents/builder.ts` - remove `plan_branch: plan.branch,` from the `loadPrompt` call (~line 126)
- `src/engine/worktree.ts` - add new exported `recoverDriftedWorktree(cwd, expectedBranch, commitMessage)` function that detects branch drift, squash-merges drifted changes back to the expected branch, and cleans up. Uses existing `mergeWorktree` internally. Handles both named branch drift and detached HEAD drift (creates temp branch via `git checkout -B eforge/drift-recovery`).
- `src/engine/orchestrator.ts` - (1) add `recoverDriftedWorktree` to the import from `./worktree.js` (lines 16-24), (2) replace the `builtOnMergeWorktree` block (lines 509-520) to call `recoverDriftedWorktree` before capturing the commit SHA. Constructs a commit message using the existing `prefix`/`ATTRIBUTION` pattern, then captures HEAD SHA after recovery.

## Verification

- [ ] `pnpm type-check` exits with code 0
- [ ] `pnpm test` exits with code 0 (all existing + new tests pass)
- [ ] `pnpm build` exits with code 0
- [ ] `src/engine/prompts/builder.md` does not contain the string `{{plan_branch}}`
- [ ] `src/engine/prompts/builder.md` contains the string "No branch operations"
- [ ] `src/engine/agents/builder.ts` does not contain the string `plan_branch`
- [ ] `recoverDriftedWorktree` is exported from `src/engine/worktree.ts`
- [ ] `test/worktree-drift.test.ts` exists and contains three `it()` or `test()` blocks
- [ ] `src/engine/orchestrator.ts` imports `recoverDriftedWorktree` from `./worktree.js`
