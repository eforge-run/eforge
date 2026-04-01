---
id: plan-03-integration-profile-removal
name: Integration and Profile System Removal
dependsOn: [plan-01-stage-registry, plan-02-structured-output-pipeline-composer]
branch: dynamic-llm-driven-pipeline-composition/integration-profile-removal
---

# Integration and Profile System Removal

## Architecture Context

This plan is the core integration that wires the pipeline composer (Plan 02) into the planner flow and rips out the old profile system entirely. After this plan, the compile pipeline is driven by `PipelineComposition` (returned by the composer) instead of `ResolvedProfileConfig` (selected by the planner agent's text output). The planner agent no longer selects profiles - it focuses purely on codebase exploration and plan generation.

Key behavioral change: pipeline composition happens as a separate, fast LLM call *before* the planner agent runs. The planner receives the pre-determined scope but does not participate in pipeline selection.

## Implementation

### Overview

Replace `PipelineContext.profile` with `PipelineContext.pipeline` (type `PipelineComposition`), call `composePipeline()` at the start of the planner compile stage, remove all profile parsing/selection from the planner agent and its prompt, remove profile infrastructure from config.ts, update eforge.ts to construct contexts with pipeline data, replace `plan:profile` event with `plan:pipeline`, update `OrchestrationConfig` to store pipeline instead of profile, and inject `{{buildStageRegistry}}` into the module planner prompt.

### Key Decisions

1. **`composePipeline()` called inside the planner compile stage** - before the planner agent itself runs. This keeps the compose call within the existing stage execution model rather than adding a new top-level stage. The planner stage first yields pipeline composition events, then runs the planner agent.
2. **`PipelineContext.pipeline` replaces `profile`** - the `compile` array is read from `pipeline.compile`, and `runCompilePipeline` uses `ctx.pipeline.compile` instead of `ctx.profile.compile`.
3. **`OrchestrationConfig.profile` replaced with `pipeline`** - build phase reads `orchConfig.pipeline.defaultBuild` and `orchConfig.pipeline.defaultReview` as fallback defaults (per-plan `build`/`review` in orchestration.yaml still take precedence).
4. **No backward compatibility** - old profile code is removed cleanly per project conventions. No migration path for existing orchestration.yaml files with `profile` field.
5. **`prd-passthrough` stage updated** - instead of emitting `plan:profile` with errand config, it composes a pipeline (or uses a hardcoded errand pipeline since the PRD is already the plan).
6. **Module planner gets `{{buildStageRegistry}}`** - build-stage-only catalog injected into module-planner prompt so module planners can make informed `<build-config>` choices.

## Scope

### In Scope
- Replace `PipelineContext.profile: ResolvedProfileConfig` with `pipeline: PipelineComposition`
- Replace `BuildStageContext.profile: ResolvedProfileConfig` with `pipeline: PipelineComposition`
- Update `runCompilePipeline()` to read `ctx.pipeline.compile`
- Update planner compile stage to call `composePipeline()` first, then run planner agent
- Update `prd-passthrough` stage to use pipeline instead of profile
- Remove `parseProfileBlock()`, `parseGeneratedProfileBlock()`, `GeneratedProfileBlock` from `common.ts`
- Remove `formatProfileDescriptions()`, `formatProfileGenerationSection()` from `planner.ts`
- Remove profile selection section from `planner.md` prompt (remove `{{profiles}}`, `{{profileGeneration}}`)
- Remove `BUILTIN_PROFILES`, `resolveGeneratedProfile()`, `resolveProfileExtensions()`, `DEFAULT_BUILD`, `DEFAULT_BUILD_WITH_DOCS`, `DEFAULT_BUILD_WITH_TESTS`, `DEFAULT_BUILD_TDD` from `config.ts`
- Remove `resolvedProfileConfigSchema`, `partialProfileConfigSchema` from `config.ts`
- Remove `getProfileSchemaYaml()`, `getCompileOnlyProfileSchemaYaml()` from `config.ts`
- Replace `plan:profile` event with `plan:pipeline` event in `events.ts`
- Update `OrchestrationConfig` to replace `profile: ResolvedProfileConfig` with `pipeline: PipelineComposition`
- Update `injectProfileIntoOrchestrationYaml` in `plan.ts` to inject pipeline instead of profile
- Update `parseOrchestrationConfig` in `plan.ts` to parse pipeline instead of profile
- Update `eforge.ts` compile flow: remove default profile selection, construct PipelineContext with pipeline
- Update `eforge.ts` build flow: use `orchConfig.pipeline` for default build/review config
- Inject `{{buildStageRegistry}}` into `module-planner.md` prompt
- Update `agent-wiring.test.ts`: replace profile formatting/emission tests with pipeline composition tests

### Out of Scope
- Changes to the `<build-config>` block mechanism (kept as-is for module planner per-plan overrides)
- Changes to `BuildStageSpec` or `ReviewProfileConfig` schemas (still used by pipeline composition)
- Runtime retry/fallback logic for invalid pipeline compositions

## Files

### Modify
- `src/engine/pipeline.ts` - Replace `profile: ResolvedProfileConfig` with `pipeline: PipelineComposition` on `PipelineContext` and `BuildStageContext`. Update `runCompilePipeline()` to read `ctx.pipeline.compile`. Update planner stage: call `composePipeline()` first, receive `plan:pipeline` event, set `ctx.pipeline`, then run planner agent without profile selection. Remove `plan:profile` event handling (previously updated `ctx.profile`). Update `prd-passthrough` stage: emit `plan:pipeline` instead of `plan:profile`, construct errand pipeline composition. Update `writePlanArtifacts` calls: pass pipeline instead of profile. Update all internal references from `ctx.profile` to `ctx.pipeline`.
- `src/engine/agents/planner.ts` - Remove `formatProfileDescriptions()` and `formatProfileGenerationSection()`. Remove profile-related options (`profiles`, `generateProfile`). Remove `<profile>` and `<generated-profile>` parsing from agent output loop. The planner agent now receives scope from the pre-computed pipeline but does not participate in pipeline/profile selection.
- `src/engine/agents/common.ts` - Remove `parseProfileBlock()`, `parseGeneratedProfileBlock()`, `GeneratedProfileBlock` type, `ProfileSelection` type. Keep `parseBuildConfigBlock()` (used by module planners).
- `src/engine/prompts/planner.md` - Remove the "Profile Selection" section (~lines 53-98). Remove `{{profiles}}` and `{{profileGeneration}}` template variables. Add a `{{scope}}` variable so the planner knows the pre-determined scope (errand/excursion/expedition) for plan generation depth decisions.
- `src/engine/prompts/module-planner.md` - Add `{{buildStageRegistry}}` template variable injection point. The build stage catalog (build stages only) is injected so module planners can reference available stages when emitting `<build-config>` blocks.
- `src/engine/config.ts` - Remove `BUILTIN_PROFILES` constant, `resolveGeneratedProfile()` function, `resolveProfileExtensions()` function, `validateProfileConfig()` function, `getProfileSchemaYaml()` function, `getCompileOnlyProfileSchemaYaml()` function, `resolvedProfileConfigSchema`, `partialProfileConfigSchema`. Remove `DEFAULT_BUILD`, `DEFAULT_BUILD_WITH_DOCS`, `DEFAULT_BUILD_WITH_TESTS`, `DEFAULT_BUILD_TDD` constants. Keep `DEFAULT_REVIEW`, `BuildStageSpec`, `ReviewProfileConfig`, `buildStageSpecSchema`, `reviewProfileConfigSchema` (still used by pipeline composition and orchestration).
- `src/engine/events.ts` - Remove `plan:profile` event variant (replaced by `plan:pipeline` added in Plan 02). Update `OrchestrationConfig.profile` to `OrchestrationConfig.pipeline` typed as `PipelineComposition`. Remove `generateProfile` from `CompileOptions`.
- `src/engine/plan.ts` - Rename `injectProfileIntoOrchestrationYaml` to `injectPipelineIntoOrchestrationYaml`, update to write `pipeline` field instead of `profile`. Update `parseOrchestrationConfig` to parse `pipeline` field instead of `profile` field using `pipelineCompositionSchema`.
- `src/engine/eforge.ts` - Compile flow: remove `const selectedProfile = this.config.profiles['excursion']` default, construct PipelineContext without `profile` (pipeline set by planner stage after composer runs). Remove `generateProfile` option from compile. Build flow: replace `orchConfig.profile` with `orchConfig.pipeline`, use `orchConfig.pipeline.defaultBuild`/`orchConfig.pipeline.defaultReview` as fallbacks when per-plan entries don't override. Construct BuildStageContext with `pipeline` instead of `profile`.
- `src/engine/index.ts` - Update exports: rename `injectProfileIntoOrchestrationYaml` to `injectPipelineIntoOrchestrationYaml`. Export `composePipeline` from pipeline-composer.
- `test/agent-wiring.test.ts` - Remove `formatProfileDescriptions` tests (lines 220-257). Remove `plan:profile` emission tests (lines 261-313). Add tests: `composePipeline` yields `plan:pipeline` event with valid PipelineComposition fields; planner prompt no longer contains `{{profiles}}` or `{{profileGeneration}}`; `plan:pipeline` event includes `scope`, `compile`, `defaultBuild`, `defaultReview`, `rationale` fields.

## Verification

- [ ] `pnpm type-check` passes with zero errors
- [ ] `pnpm test` passes - updated and new tests pass
- [ ] No references to `<profile>`, `<generated-profile>`, `BUILTIN_PROFILES`, `resolveGeneratedProfile`, `resolveProfileExtensions`, `DEFAULT_BUILD `, `DEFAULT_BUILD_WITH_DOCS`, `DEFAULT_BUILD_WITH_TESTS`, `DEFAULT_BUILD_TDD`, `resolvedProfileConfigSchema`, `partialProfileConfigSchema`, `formatProfileDescriptions`, `formatProfileGenerationSection`, `parseProfileBlock`, `parseGeneratedProfileBlock`, or `GeneratedProfileBlock` remain in the codebase (verified by grep)
- [ ] `PipelineContext` type has `pipeline: PipelineComposition` field and no `profile` field
- [ ] `BuildStageContext` type has `pipeline: PipelineComposition` field and no `profile` field
- [ ] `runCompilePipeline` reads `ctx.pipeline.compile` (not `ctx.profile.compile`)
- [ ] `OrchestrationConfig` has `pipeline` field (not `profile`) typed as `PipelineComposition`
- [ ] `plan:pipeline` event type exists in `EforgeEvent` union; `plan:profile` does not
- [ ] `module-planner.md` contains `{{buildStageRegistry}}` placeholder
- [ ] `planner.md` does not contain `{{profiles}}` or `{{profileGeneration}}`
- [ ] `planner.md` contains `{{scope}}` placeholder
