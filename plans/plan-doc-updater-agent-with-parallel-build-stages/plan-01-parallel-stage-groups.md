---
id: plan-01-parallel-stage-groups
name: Parallel Stage Groups in Build Pipeline
depends_on: []
branch: plan-doc-updater-agent-with-parallel-build-stages/parallel-stage-groups
---

# Parallel Stage Groups in Build Pipeline

## Architecture Context

The build pipeline currently runs stages sequentially from a flat `string[]` in profile config. This plan adds support for nested arrays within the `build` field, where a nested array means "run these stages concurrently." This is a prerequisite for the doc-updater agent (plan-02), which runs in parallel with the builder.

The existing `runParallel` and `AsyncEventQueue` concurrency primitives in `src/engine/concurrency.ts` handle the heavy lifting - no new concurrency code needed.

## Implementation

### Overview

Change the `build` field type in profile config from `string[]` to `(string | string[])[]`, update the pipeline runner to handle parallel groups, and update validation to flatten nested arrays when checking stage names. `DEFAULT_BUILD_STAGES` is left unchanged - plan-02 updates it after registering the `doc-update` stage.

### Key Decisions

1. **Reuse existing concurrency primitives** - `runParallel` from `concurrency.ts` already handles semaphore-limited parallel execution with event multiplexing. No new primitives needed.
2. **Post-parallel-group git commit** - After a parallel group completes, the pipeline runner checks for uncommitted changes and commits them. This handles the case where parallel stages (like doc-update) only edit files without committing.
3. **Schema uses `z.union`** - The build field becomes `z.array(z.union([z.string(), z.array(z.string())]))` to allow both flat strings and nested arrays.
4. **Type alias `BuildStageSpec`** - A named type for `string | string[]` improves readability throughout the codebase.

## Scope

### In Scope
- Schema change in `config.ts` for `build` field (both partial and resolved)
- `BuildStageSpec` type alias
- Pipeline runner update in `pipeline.ts` to handle parallel groups
- Validation update to flatten nested arrays when checking stage names
- Barrel re-export of `BuildStageSpec`

### Out of Scope
- The doc-update build stage registration (plan-02)
- The doc-updater agent itself (plan-02)
- Parallel stage groups in compile pipeline (not needed)

## Files

### Modify
- `src/engine/config.ts` — Change `partialProfileConfigSchema.build` and `resolvedProfileConfigSchema.build` from `z.array(z.string())` to `z.array(z.union([z.string(), z.array(z.string())]))`. Add `BuildStageSpec` type alias. Do NOT modify `DEFAULT_BUILD_STAGES` (plan-02 updates it after registering the `doc-update` stage). Update `validateProfileConfig` to flatten nested arrays when checking build stage names.
- `src/engine/pipeline.ts` — Update `runBuildPipeline` to check if each step is an array. When it is, use `runParallel` to run stages concurrently, then check for uncommitted changes and commit them. When it's a string, run sequentially (existing behavior). Import `ParallelTask` type and `runParallel` from `concurrency.ts` (already imported). Import `execFile` for git operations (already imported).
- `src/engine/index.ts` — Add re-export of `BuildStageSpec` from `config.ts`.

### Test Updates
- `test/pipeline.test.ts` — Add test: parallel group runs both stages and yields events from both. Add test: mixed config `[['a', 'b'], 'c']` runs a+b in parallel then c sequentially. Add test: `buildFailed` set during parallel group stops pipeline after group completes. Existing tests for default build stages should remain unchanged (plan-02 updates them).
- `test/config-profiles.test.ts` — Add test for nested array schema validation (both partial and resolved schemas accept nested arrays in `build`).

## Verification

- [ ] `pnpm type-check` passes with zero errors
- [ ] `pnpm build` bundles with zero errors
- [ ] `pnpm test` passes - all existing tests pass, new parallel stage group tests pass
- [ ] `BuildStageSpec` type is exported from `src/engine/index.ts`
- [ ] `DEFAULT_BUILD_STAGES` remains unchanged (plan-02 updates it after registering the stage)
- [ ] `validateProfileConfig` accepts profiles with nested arrays in `build`
- [ ] `runBuildPipeline` runs nested-array stages concurrently via `runParallel`
- [ ] `runBuildPipeline` commits any uncommitted changes after a parallel group completes
- [ ] Sequential stages in build pipeline continue to work unchanged
