---
id: plan-01-fix-stale-state
name: Fix stale state.json poisoning re-runs
depends_on: []
branch: fix-stale-state-json-from-failed-run-poisons-re-runs-gh-1/fix-stale-state
---

# Fix stale state.json poisoning re-runs

## Architecture Context

The orchestrator (`src/engine/orchestrator.ts`) manages build state via `.eforge/state.json`. When a run fails, `initializeState()` loads stale state with `status: 'failed'`, returns it as-is, and `execute()` short-circuits at the `state.status !== 'running'` check (line 169). This means re-running the same PRD silently does nothing.

The fix extracts `initializeState` as an exported standalone function and removes the `return existing` on the non-resumable branch so it falls through to fresh state creation. TDD approach - tests first, then implementation.

## Implementation

### Overview

1. Add 5 failing tests for `initializeState` in `test/orchestration-logic.test.ts`
2. Extract `initializeState` as an exported function in `src/engine/orchestrator.ts`
3. Fix the non-resumable branch to fall through to fresh state creation
4. Thin out the private method to delegate to the new exported function

### Key Decisions

1. **Extract as exported standalone function** - the private method can't be tested directly. Following the same pattern as `propagateFailure`, `resumeState`, and `shouldSkipMerge` which are already exported standalone functions in the same file.
2. **TDD order** - write failing tests first, then make them pass. Tests will initially fail because `initializeState` isn't exported yet.
3. **Use `useTempDir` + `saveState`** - tests need real filesystem state to exercise `loadState`/`saveState` round-tripping, matching the existing test infrastructure.

## Scope

### In Scope
- Extract and export `initializeState` as a standalone function
- Remove `return existing` on non-resumable branch (the bug fix)
- Delegate from private method to exported function
- 5 new tests covering fresh, failed, completed, resumable, and mismatched setName cases

### Out of Scope
- `src/engine/state.ts` - `loadState`, `saveState`, `isResumable` are correct as-is
- `src/engine/events.ts` - types unchanged
- `src/engine/worktree.ts` - `computeWorktreeBase` unchanged

## Files

### Modify
- `test/orchestration-logic.test.ts` - Add imports for `initializeState`, `saveState`, `useTempDir`, `BUILTIN_PROFILES`. Add `makeConfig()` helper. Add `describe('initializeState', ...)` block with 5 tests.
- `src/engine/orchestrator.ts` - Export new standalone `initializeState(stateDir, config, repoRoot)` function near the other exported helpers. Remove `return existing` on line 537 (non-resumable branch). Replace private method body with delegation to the exported function.

## Verification

- [ ] `pnpm type-check` exits 0 with no type errors
- [ ] `pnpm test test/orchestration-logic.test.ts` passes all tests including 5 new `initializeState` tests
- [ ] `pnpm test` passes (full suite, no regressions)
- [ ] Test "creates fresh state when existing is failed" asserts `status: 'running'` and all plans `pending`
- [ ] Test "creates fresh state when existing is completed" asserts `status: 'running'` and all plans `pending`
- [ ] Test "resumes when existing state is resumable" asserts plan-a stays `completed` and plan-b stays `pending`
- [ ] Test "creates fresh state when setName differs" asserts fresh state with matching `setName`
- [ ] `initializeState` is exported from `src/engine/orchestrator.ts` and importable in tests
