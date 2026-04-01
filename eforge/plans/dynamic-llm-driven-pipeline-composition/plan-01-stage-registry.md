---
id: plan-01-stage-registry
name: Stage Registry with Rich Metadata
dependsOn: []
branch: dynamic-llm-driven-pipeline-composition/stage-registry
---

# Stage Registry with Rich Metadata

## Architecture Context

This plan adds rich metadata to eforge's stage registration system. Currently, stages are registered as bare functions in a `Map<string, StageFn>`. This plan upgrades the registry to store a `StageDescriptor` alongside each function, enabling downstream consumers (the pipeline composer in Plan 02) to reason about available stages, their dependencies, costs, and constraints.

This is a non-breaking change - the internal registry structure changes but the external pipeline execution APIs remain compatible.

## Implementation

### Overview

Add a `StageDescriptor` type to `pipeline.ts`, upgrade the internal stage maps from `Map<string, StageFn>` to `Map<string, { fn: StageFn; descriptor: StageDescriptor }>`, update all 17 stage registration call sites to provide descriptors, and add descriptor getter functions plus a `validatePipeline()` function and a `formatStageRegistry()` helper for prompt injection.

### Key Decisions

1. **StageDescriptor lives in pipeline.ts** - it's tightly coupled to stage registration and the pipeline execution model. No need for a separate file.
2. **Registration signature changes are backward-incompatible** - all 17 call sites are in pipeline.ts itself, so the blast radius is contained to one file.
3. **`validatePipeline()` derives rules from descriptors** - no hardcoded validation logic. Checks existence, predecessor ordering, conflicts, and parallelizability.
4. **`formatStageRegistry()` generates a markdown table** - consumed by the pipeline-composer prompt (Plan 02) to present the full stage catalog to the LLM.

## Scope

### In Scope
- `StageDescriptor` and `StagePhase` types
- Registry upgrade from `Map<string, StageFn>` to `Map<string, { fn: StageFn; descriptor: StageDescriptor }>`
- Updated `registerCompileStage` and `registerBuildStage` signatures (descriptor as first arg)
- Descriptor metadata for all 7 compile stages and 10 build stages
- `getCompileStageDescriptors()` and `getBuildStageDescriptors()` getter functions
- `validatePipeline(compile, build)` function returning `{ valid, errors, warnings }`
- `formatStageRegistry()` function producing a markdown table of all stages
- Unit tests for `validatePipeline` and `formatStageRegistry`

### Out of Scope
- Changes to PipelineContext or how the compile/build pipeline reads stage sequences (Plan 03)
- Structured output or pipeline composer (Plan 02)
- Removal of profile infrastructure (Plan 03)

## Files

### Modify
- `src/engine/pipeline.ts` - Add `StageDescriptor` type, `StagePhase` type, upgrade internal stage maps, change `registerCompileStage`/`registerBuildStage` signatures to accept `(descriptor: StageDescriptor, stage: StageFn)`, update all 17 `registerCompileStage`/`registerBuildStage` call sites with descriptor metadata, add `getCompileStageDescriptors()`, `getBuildStageDescriptors()`, `validatePipeline()`, and `formatStageRegistry()` functions. The existing `getCompileStage(name)` and `getBuildStage(name)` functions update to read from the new map structure (`map.get(name)?.fn`). The existing `getCompileStageNames()` and `getBuildStageNames()` remain unchanged.
- `test/agent-wiring.test.ts` - Add test cases for `validatePipeline()` (valid pipeline, missing stage, missing predecessor, conflicting stages, non-parallelizable in parallel group) and `formatStageRegistry()` (returns non-empty string, contains all registered stage names).

## Verification

- [ ] `pnpm type-check` passes with zero errors
- [ ] `pnpm test` passes - all existing tests still pass, new `validatePipeline` and `formatStageRegistry` tests pass
- [ ] All 7 compile stages have descriptors with non-empty `description`, `whenToUse`, and `costHint` fields
- [ ] All 10 build stages have descriptors with non-empty `description`, `whenToUse`, and `costHint` fields
- [ ] `validatePipeline(['planner', 'plan-review-cycle'], [['implement', 'doc-update'], 'review-cycle'])` returns `{ valid: true }`
- [ ] `validatePipeline(['nonexistent'], ['implement'])` returns `{ valid: false }` with an error about unknown stage
- [ ] `formatStageRegistry()` output contains the names of all 17 registered stages
