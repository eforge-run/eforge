---
id: plan-01-periodic-file-check
name: Periodic File Heatmap Updates During Build Stages
depends_on: []
branch: periodic-file-heatmap-updates-during-build-stages/periodic-file-check
---

# Periodic File Heatmap Updates During Build Stages

## Architecture Context

The monitor's File Heatmap consumes `build:files_changed` events to show which files are being modified per plan. Currently, `emitFilesChanged()` in `src/engine/pipeline.ts` only emits these events at stage boundaries (after implement, doc-update, test-write complete). During long-running stages like `implement`, the heatmap stays empty for minutes. This plan adds a transparent async generator wrapper that interleaves periodic file-change checks into any agent event stream without changing event types, the frontend reducer, or the heatmap UI.

## Implementation

### Overview

Add a `withPeriodicFileCheck` async generator wrapper to `src/engine/pipeline.ts` that wraps any inner agent generator and periodically runs `git diff --name-only` against the base branch. When the file list changes since the last emission, it yields a `build:files_changed` event. The wrapper is applied to all long-running agent `for await` loops in build stages: implement, review-fix, doc-update, test-write, and test.

### Key Decisions

1. **`Promise.race` between next agent event and a timer** - This allows the wrapper to interleave file-check events without blocking or delaying the inner generator. When the timer fires first, it checks for file changes, then immediately awaits the next agent event again.
2. **Deduplication by comparing sorted file lists** - The wrapper tracks the last emitted file list and only yields a new event when the list differs, avoiding redundant events that would cause unnecessary frontend re-renders.
3. **Timer uses `.unref()`** - Prevents the periodic timer from keeping the Node.js process alive if the generator is abandoned.
4. **`finally` block calls `iterator.return()`** - Ensures the inner generator is cleaned up even on early termination or errors.
5. **Silent on git failure** - Matches the existing `emitFilesChanged()` convention of silently catching errors since file change events are non-critical.
6. **Applied at the `for await` consumption site, not inside agent runners** - This keeps agent runners pure and the wrapper is a pipeline-level concern. The wrapper goes around the generator calls (`builderImplement(...)`, `runReviewFixer(...)`, etc.) before they enter the `for await` loop.

## Scope

### In Scope
- `FILE_CHECK_INTERVAL_MS` constant (15000)
- `arraysEqual` private helper function
- `withPeriodicFileCheck` async generator wrapper
- Wrapping agent generators in implement, review-fix, doc-update, test-write, and test stages
- New test file `test/periodic-file-check.test.ts`

### Out of Scope
- Changes to `EforgeEvent` type definitions
- Changes to the frontend reducer or heatmap UI
- Changes to the monitor mock server (optional enhancement deferred)

## Files

### Modify
- `src/engine/pipeline.ts` - Add `FILE_CHECK_INTERVAL_MS` constant near `emitFilesChanged` (~line 950). Add `arraysEqual(a: string[], b: string[]): boolean` private helper. Add `withPeriodicFileCheck(inner: AsyncGenerator<EforgeEvent>, ctx: BuildStageContext): AsyncGenerator<EforgeEvent>` async generator wrapper. Wrap `builderImplement(...)` call at line ~997, `runReviewFixer(...)` call at line ~1179, `runDocUpdater(...)` call at line ~1240, `runTestWriter(...)` call at line ~1286, and `runTester(...)` call at line ~1322 with the wrapper.

### Create
- `test/periodic-file-check.test.ts` - Tests for the wrapper: inner events pass through unchanged, file change events emitted when timer fires and file list differs from last emission, same file list not re-emitted (deduplication), silent on git failure, `iterator.return()` called on early termination via `break`.

## Verification

- [ ] `pnpm type-check` exits with code 0
- [ ] `pnpm test` exits with code 0 including new tests in `test/periodic-file-check.test.ts`
- [ ] `pnpm build` exits with code 0
- [ ] `withPeriodicFileCheck` is exported or accessible for testing (or tests use the module's internal access pattern)
- [ ] New test file contains at least 5 test cases covering: passthrough, emission on timer, deduplication, git failure silence, and cleanup
- [ ] The `for await` loops in implement, review-fix, doc-update, test-write, and test stages all consume wrapped generators
- [ ] Existing `yield* emitFilesChanged(ctx)` calls at stage end remain unchanged
