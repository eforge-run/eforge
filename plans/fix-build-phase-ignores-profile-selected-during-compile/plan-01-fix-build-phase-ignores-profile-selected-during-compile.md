---
id: plan-01-fix-build-phase-ignores-profile-selected-during-compile
name: Persist resolved profile in orchestration.yaml for build phase
depends_on: []
branch: fix-build-phase-ignores-profile-selected-during-compile/main
---

# Persist resolved profile in orchestration.yaml for build phase

## Architecture Context

The compile and build phases share no runtime state - profile selection during compile is local to `PipelineContext` and lost when `build()` creates a fresh context. The planner LLM agent writes orchestration.yaml via file tools, then the pipeline injects additional metadata. The fix persists the resolved profile into orchestration.yaml during compile so the build phase can read it back.

## Implementation

### Overview

Add a `profile` field to `OrchestrationConfig`, serialize the resolved profile into orchestration.yaml during the compile pipeline (after `plan:complete` for errand/excursion, and during `compileExpedition` for expeditions), parse it back in `parseOrchestrationConfig`, and use it in `build()` instead of hardcoding `config.profiles['excursion']`.

### Key Decisions

1. **Profile injected by the pipeline, not the LLM agent** - The planner agent writes orchestration.yaml via SDK tools. Rather than modifying the planner prompt to include profile data, the pipeline injects the resolved profile into the existing orchestration.yaml after the planner finishes. This keeps the agent prompt simple and gives the pipeline control over serialization format.

2. **Full resolved profile object, not just a profile name** - Storing the name would require re-resolving at build time, which breaks for dynamically generated profiles that don't exist in config. The resolved `ResolvedProfileConfig` object contains everything the build phase needs.

3. **Zod validation on parse** - Use `resolvedProfileConfigSchema.safeParse()` when reading the profile back from YAML to catch corruption or schema drift early.

4. **Profile field is required on `OrchestrationConfig`** - Since the build phase must always know which profile to use, the field is required. No fallback for missing profile - `parseOrchestrationConfig` throws if the field is absent, consistent with the project's no-backwards-compat policy.

## Scope

### In Scope
- Add `profile` to `OrchestrationConfig` type
- Serialize resolved profile into orchestration.yaml (errand/excursion path via pipeline, expedition path via compiler)
- Parse and validate profile from orchestration.yaml
- Use parsed profile in `build()` instead of hardcoded excursion
- Export `resolvedProfileConfigSchema` from config.ts for use in plan.ts
- Tests for round-tripping and parsing

### Out of Scope
- Changes to the planner agent prompt
- Changes to the planner agent's file writing behavior

## Files

### Modify
- `src/engine/events.ts` — Add `profile: ResolvedProfileConfig` to `OrchestrationConfig` interface (line 46-54)
- `src/engine/config.ts` — Export `resolvedProfileConfigSchema` so plan.ts can use it for validation
- `src/engine/plan.ts` — Add `profile` to `WritePlanArtifactsOptions` and serialize it in `writePlanArtifacts()` (line 432-488). Parse and validate `profile` from YAML in `parseOrchestrationConfig()` (line 163-194). Add a new `injectProfileIntoOrchestrationYaml()` function for the pipeline to call after the planner writes orchestration.yaml.
- `src/engine/pipeline.ts` — After `plan:complete` in the planner stage (line 330-332), call `injectProfileIntoOrchestrationYaml()` to persist `ctx.profile` into the existing orchestration.yaml. In the `compile-expedition` stage (line 528-539), pass `ctx.profile` to `compileExpedition()`.
- `src/engine/compiler.ts` — Accept optional `profile` parameter in `compileExpedition()` and serialize it into orchestration.yaml (line 117-131).
- `src/engine/eforge.ts` — Replace `config.profiles['excursion']` (line 338) with `orchConfig.profile`.
- `src/engine/index.ts` — Export new `injectProfileIntoOrchestrationYaml` function.
- `test/plan-parsing.test.ts` — Add tests for profile round-tripping, parsing with inline profile, and rejection of missing/malformed profile.
- `test/fixtures/orchestration/valid.yaml` — Add a profile block to the existing fixture.
- `test/adopt.test.ts` — Update `writePlanArtifacts` test calls to include required `profile` option.

## Verification

- [ ] `writePlanArtifacts` called with a resolved profile produces an orchestration.yaml that `parseOrchestrationConfig` reads back with matching `profile.description`, `profile.compile`, `profile.build`, `profile.agents`, and `profile.review` fields
- [ ] `parseOrchestrationConfig` reads a hand-crafted YAML fixture containing an inline `profile` block and returns all profile fields (description, compile, build, agents, review)
- [ ] `parseOrchestrationConfig` throws when YAML has no `profile` field
- [ ] `injectProfileIntoOrchestrationYaml` reads an existing orchestration.yaml, adds the profile, and writes it back - verified by parsing the result
- [ ] `compileExpedition` with a profile parameter includes it in the generated orchestration.yaml
- [ ] `build()` in eforge.ts uses `orchConfig.profile` instead of `config.profiles['excursion']` (verified by code inspection)
- [ ] `pnpm type-check` passes with zero errors
- [ ] `pnpm test` passes — all existing and new tests green
