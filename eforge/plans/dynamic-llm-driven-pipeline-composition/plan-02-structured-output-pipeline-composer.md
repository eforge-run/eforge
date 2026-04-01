---
id: plan-02-structured-output-pipeline-composer
name: Structured Output and Pipeline Composer Agent
dependsOn: [plan-01-stage-registry]
branch: dynamic-llm-driven-pipeline-composition/structured-output-pipeline-composer
---

# Structured Output and Pipeline Composer Agent

## Architecture Context

This plan adds structured output support to the `AgentBackend` interface and creates a dedicated pipeline-composer agent that uses it. The composer takes a PRD plus the stage catalog (from Plan 01's `formatStageRegistry()`) and returns a `PipelineComposition` via structured output - replacing the profile selection that previously happened inside the planner agent's text output.

The Claude SDK already supports `outputFormat` on query options - this plan threads that capability through eforge's `AgentRunOptions` and `AgentResultData` interfaces.

## Implementation

### Overview

Wire `outputFormat` through the backend interface, extract `structured_output` from SDK results, define a `PipelineComposition` Zod schema, and create a `pipeline-composer` agent + prompt that composes valid pipelines from the stage registry.

### Key Decisions

1. **`outputFormat` added to `AgentRunOptions`** - optional field, backward compatible. Only the pipeline-composer uses it initially.
2. **`structuredOutput` added to `AgentResultData`** - extracted from `SDKResultSuccess.structured_output` in `mapSDKMessages`. Typed as `unknown` since it's schema-dependent.
3. **`PipelineComposition` schema in `schemas.ts`** - follows the existing pattern of defining Zod schemas and converting to JSON Schema for SDK consumption. Uses `z.toJSONSchema()` from zod/v4.
4. **Single-turn agent call with `tools: 'none'`** - the pipeline composer only needs reasoning, not tool use. This keeps it fast and cheap.
5. **Validation after parsing** - after receiving structured output, `validatePipeline()` from Plan 01 verifies the composed pipeline is valid.

## Scope

### In Scope
- `outputFormat` field on `AgentRunOptions` in `backend.ts`
- SDK passthrough of `outputFormat` in `claude-sdk.ts`
- `structuredOutput` field on `AgentResultData` in `events.ts`
- Extraction of `structured_output` from SDK results in `claude-sdk.ts`
- `pipelineCompositionSchema` Zod schema in `schemas.ts`
- New `src/engine/agents/pipeline-composer.ts` - `composePipeline()` async generator
- New `src/engine/prompts/pipeline-composer.md` - focused prompt for pipeline composition

### Out of Scope
- Wiring the pipeline composer into the planner flow (Plan 03)
- Removal of profile infrastructure (Plan 03)
- Changes to PipelineContext (Plan 03)

## Files

### Create
- `src/engine/agents/pipeline-composer.ts` - Exports `composePipeline(source, options)` async generator. Loads the pipeline-composer prompt with `formatStageRegistry()` output injected, calls `backend.run()` with `outputFormat` set to the JSON Schema of `pipelineCompositionSchema`, parses the structured output, validates with `validatePipeline()`, and yields a `plan:pipeline` event with the composition result. Options include `backend`, `cwd`, and SDK passthrough fields.
- `src/engine/prompts/pipeline-composer.md` - Prompt template receiving `{{source}}` (the PRD), `{{stageRegistry}}` (markdown table from `formatStageRegistry()`), and `{{attribution}}`. Instructions tell the model to: analyze the work's nature, select scope (errand/excursion/expedition), compose compile stages from the catalog, compose default build stages, select default review config, and explain rationale. Includes guidance on when to use each scope level (errand for trivial, excursion for most work, expedition for 4+ independent subsystems).

### Modify
- `src/engine/backend.ts` - Add `outputFormat?: { type: 'json_schema'; schema: Record<string, unknown> }` to `AgentRunOptions` interface. Add it to `SdkPassthroughConfig` and `pickSdkOptions()`.
- `src/engine/backends/claude-sdk.ts` - In `sdkQuery()`, spread `outputFormat` into SDK query options when present. In `mapSDKMessages()` (or the result extraction path), check for `structured_output` on `SDKResultSuccess` and include it in the yielded `agent:result` event's `AgentResultData` as `structuredOutput`.
- `src/engine/events.ts` - Add `structuredOutput?: unknown` field to `AgentResultData` interface. Add `plan:pipeline` event variant to the `EforgeEvent` union: `{ type: 'plan:pipeline'; scope: string; compile: string[]; defaultBuild: BuildStageSpec[]; defaultReview: ReviewProfileConfig; rationale: string }`. This is needed because `composePipeline()` (created in this plan) yields `plan:pipeline` events and `pnpm type-check` must pass.
- `src/engine/schemas.ts` - Add `pipelineCompositionSchema` Zod schema with fields: `scope` (enum: errand/excursion/expedition), `compile` (array of strings), `defaultBuild` (array of `buildStageSpecSchema`), `defaultReview` (`reviewProfileConfigSchema`), `rationale` (string). Export `PipelineComposition` type. Add `getPipelineCompositionJsonSchema()` helper that calls `z.toJSONSchema(pipelineCompositionSchema)`.

## Verification

- [ ] `pnpm type-check` passes with zero errors
- [ ] `pnpm test` passes - all existing tests still pass
- [ ] `AgentRunOptions` type accepts `outputFormat: { type: 'json_schema', schema: { ... } }` without type errors
- [ ] `AgentResultData` type accepts `structuredOutput: { scope: 'excursion', compile: ['planner'], ... }` without type errors
- [ ] `pipelineCompositionSchema.parse({ scope: 'excursion', compile: ['planner', 'plan-review-cycle'], defaultBuild: ['implement', 'review-cycle'], defaultReview: { strategy: 'auto', perspectives: ['code'], maxRounds: 1, evaluatorStrictness: 'standard' }, rationale: 'test' })` succeeds
- [ ] `pipelineCompositionSchema.parse({ scope: 'invalid' })` throws a Zod validation error
- [ ] `pipeline-composer.md` prompt file exists and contains `{{source}}` and `{{stageRegistry}}` placeholders
- [ ] `composePipeline` function is exported from `src/engine/agents/pipeline-composer.ts`
