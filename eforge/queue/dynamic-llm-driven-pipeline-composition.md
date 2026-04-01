---
title: Dynamic LLM-Driven Pipeline Composition
created: 2026-04-01
---

# Dynamic LLM-Driven Pipeline Composition

## Problem / Motivation

Currently, eforge's planner selects from three hardcoded profiles (errand, excursion, expedition) that lock in fixed compile and build stage sequences. The planner prompt is heavily prescriptive about which stages to use when. This rigid system prevents the planner from composing tailor-made pipelines based on the specific nature of the work. The EEE scope classification should determine planning depth (how much upfront exploration and delegation), but the implementation pipeline (which agents run at which stages, in what order, with what parallelization) should be dynamically composed by the planner based on the specific work.

## Goal

Replace the hardcoded profile system with a stage registry containing rich metadata and an intelligent pipeline composer that uses structured outputs (Zod schemas) to dynamically compose valid, tailor-made pipelines from available agents/stages. Old profile infrastructure (`<profile>`, `<generated-profile>`, `BUILTIN_PROFILES`) gets ripped out cleanly with no backward compatibility.

## Approach

Four phases:

### Phase 1: Stage Registry with Rich Metadata

- Add a `StageDescriptor` type to `src/engine/pipeline.ts` (~line 98):

```typescript
export type StagePhase = 'compile' | 'build';

export interface StageDescriptor {
  name: string;
  phase: StagePhase;
  description: string;           // One-liner for planner prompt
  whenToUse: string;             // Guidance on when this stage adds value
  requires: string[];            // Must appear before this stage
  conflictsWith: string[];       // Cannot coexist in same pipeline
  parallelizable: boolean;       // Can run alongside other stages
  parallelWith?: string[];       // Specific stages it can parallel with
  costHint: 'low' | 'medium' | 'high';
  after?: string[];              // Ordering: IF both present, this comes second
}
```

- Upgrade internal stage maps from `Map<string, StageFn>` to `Map<string, { fn: StageFn; descriptor: StageDescriptor }>`.

- Replace `registerCompileStage(name, fn)` / `registerBuildStage(name, fn)` signatures to require descriptors:

```typescript
export function registerCompileStage(descriptor: StageDescriptor, stage: CompileStage): void;
export function registerBuildStage(descriptor: StageDescriptor, stage: BuildStage): void;
```

- Annotate all ~17 existing `registerCompileStage`/`registerBuildStage` calls with descriptor metadata. Example:

```typescript
registerCompileStage({
  name: 'planner',
  phase: 'compile',
  description: 'Explores the codebase and generates implementation plans with dependency ordering.',
  whenToUse: 'Required for any work beyond trivial errands.',
  requires: [],
  conflictsWith: ['prd-passthrough'],
  parallelizable: false,
  costHint: 'high',
}, async function* plannerStage(ctx) { ... });
```

- Add descriptor getters:

```typescript
export function getCompileStageDescriptors(): StageDescriptor[];
export function getBuildStageDescriptors(): StageDescriptor[];
```

- Add pipeline validator:

```typescript
export function validatePipeline(
  compile: string[], build: BuildStageSpec[]
): { valid: boolean; errors: string[]; warnings: string[] };
```

  Validation rules derived from descriptors:
  - Every stage name exists in the appropriate registry
  - Required predecessors present and ordered before
  - No conflicting stages coexist
  - Parallel groups only contain `parallelizable: true` stages

### Phase 2: Structured Output for Pipeline Composition

- Add structured output support to `AgentBackend` in `src/engine/backend.ts`:

```typescript
export interface AgentRunOptions {
  // ... existing fields ...
  /** JSON Schema for structured output. When set, the result includes structured_output. */
  outputFormat?: { type: 'json_schema'; schema: Record<string, unknown> };
}
```

- In `src/engine/backends/claude-sdk.ts` (~line 50), pass `outputFormat` through to SDK query options:

```typescript
...(options.outputFormat !== undefined ? { outputFormat: options.outputFormat } : {}),
```

- In `src/engine/events.ts`, add `structuredOutput` to `AgentResultData`:

```typescript
export interface AgentResultData {
  // ... existing fields ...
  structuredOutput?: unknown;
}
```

  Extract from `SDKResultSuccess.structured_output` in `mapSDKMessages`.

- Define Zod schema for `PipelineComposition` in `src/engine/schemas.ts`:

```typescript
export const pipelineCompositionSchema = z.object({
  scope: z.enum(['errand', 'excursion', 'expedition']),
  compile: z.array(z.string()),
  defaultBuild: z.array(buildStageSpecSchema),
  defaultReview: reviewProfileConfigSchema,
  rationale: z.string(),
});

export type PipelineComposition = z.infer<typeof pipelineCompositionSchema>;
```

  Convert to JSON Schema for the SDK's `outputFormat` parameter using `z.toJSONSchema()` (zod/v4).

- Create new file `src/engine/agents/pipeline-composer.ts` - a dedicated agent call that takes the PRD + stage catalog and returns a `PipelineComposition` via structured output:

```typescript
export async function* composePipeline(
  source: string,
  options: PipelineComposerOptions,
): AsyncGenerator<EforgeEvent> {
  const stageRegistry = formatStageRegistry(); // markdown table of all stages
  const jsonSchema = z.toJSONSchema(pipelineCompositionSchema);

  const prompt = await loadPrompt('pipeline-composer', {
    source,
    stageRegistry,
  });

  for await (const event of backend.run({
    prompt,
    cwd: options.cwd,
    maxTurns: 1,        // Single-turn structured output call
    tools: 'none',      // No tool use needed - just reasoning
    outputFormat: { type: 'json_schema', schema: jsonSchema },
    ...pickSdkOptions(options),
  }, 'planner')) {
    yield event;
    if (event.type === 'agent:result' && event.result.structuredOutput) {
      const parsed = pipelineCompositionSchema.parse(event.result.structuredOutput);
      const validation = validatePipeline(parsed.compile, parsed.defaultBuild);
      if (!validation.valid) {
        // Could retry or fall back - TBD
      }
      yield { type: 'plan:pipeline', ...parsed, timestamp: new Date().toISOString() };
    }
  }
}
```

- Create new file `src/engine/prompts/pipeline-composer.md` - a focused prompt for pipeline composition:
  - Receives the PRD/source
  - Sees the full stage catalog (auto-generated from descriptors)
  - Scope guidance (simplified EEE - determines planning depth)
  - Instructions to compose compile + build stages from the registry
  - No codebase exploration needed - just reasoning about the work's nature

### Phase 3: Integrate into Planner Flow

- In `src/engine/agents/planner.ts`, replace profile selection with pipeline composition:
  1. **Before the planner runs**, call `composePipeline()` to get the `PipelineComposition` via structured output
  2. The planner agent then runs with the composed pipeline already determined - it focuses purely on codebase exploration and plan generation
  3. Remove `parseProfileBlock()`, `parseGeneratedProfileBlock()`, `formatProfileDescriptions()`, `formatProfileGenerationSection()` from planner.ts

- Remove old profile infrastructure from `src/engine/config.ts`:
  - Remove `BUILTIN_PROFILES` (lines 377-390)
  - Remove `resolveGeneratedProfile()` (lines 902-922)
  - Remove `resolveProfileExtensions()` - profiles no longer exist as a user-config concept
  - Keep `ReviewProfileConfig` and `BuildStageSpec` schemas (still used by pipeline composition)
  - Remove `resolvedProfileConfigSchema` and `partialProfileConfigSchema`
  - Remove `DEFAULT_BUILD`, `DEFAULT_BUILD_WITH_DOCS`, `DEFAULT_BUILD_TDD`, `DEFAULT_BUILD_WITH_TESTS` constants

- Remove from `src/engine/agents/common.ts`:
  - Remove `parseProfileBlock()`, `parseGeneratedProfileBlock()`, `GeneratedProfileBlock` type
  - Keep `parseBuildConfigBlock()` (still used by module planners for per-plan overrides)

- Update planner prompt in `src/engine/prompts/planner.md`:
  - Remove the entire "Profile Selection" section (~lines 53-98)
  - Remove `{{profiles}}` and `{{profileGeneration}}` template variables
  - The planner no longer selects profiles - pipeline composition happens before it runs
  - Keep scope-dependent plan generation instructions (errand makes 1 implicit plan, expedition writes architecture + modules, etc.) - the scope comes from the pre-computed `PipelineComposition`

- Update `PipelineContext` in `src/engine/pipeline.ts` - replace `profile: ResolvedProfileConfig` with `pipeline: PipelineComposition`:

```typescript
export interface PipelineContext {
  pipeline: PipelineComposition;  // replaces `profile`
  // ... rest unchanged
}
```

  `runCompilePipeline` uses `ctx.pipeline.compile` to drive the stage sequence.

- Update build defaults in `src/engine/eforge.ts` (~line 519): when constructing `BuildStageContext`, use `pipeline.defaultBuild` / `pipeline.defaultReview` as defaults. Per-plan overrides from `orchestration.yaml` still take precedence.

- Update events in `src/engine/events.ts` - replace `plan:profile` event with `plan:pipeline`:

```typescript
{ type: 'plan:pipeline'; scope: string; compile: string[]; defaultBuild: BuildStageSpec[]; rationale: string }
```

### Phase 4: Module Planner Stage Catalog

- In `src/engine/prompts/module-planner.md`, inject `{{buildStageRegistry}}` (build stages only) so module planners can make informed `<build-config>` choices from the same catalog. The `<build-config>` block mechanism is unchanged - module planners still emit per-module build/review overrides.

## Scope

### In Scope

| File | Change |
|------|--------|
| `src/engine/pipeline.ts` | `StageDescriptor` type, registry upgrade, descriptor getters, `validatePipeline()`, update all stage registrations, replace `profile` with `pipeline` on `PipelineContext` |
| `src/engine/backend.ts` | Add `outputFormat` to `AgentRunOptions` |
| `src/engine/backends/claude-sdk.ts` | Pass `outputFormat` to SDK, extract `structured_output` from results |
| `src/engine/events.ts` | Add `structuredOutput` to `AgentResultData`, replace `plan:profile` with `plan:pipeline` |
| `src/engine/schemas.ts` | Add `pipelineCompositionSchema` Zod schema |
| `src/engine/agents/pipeline-composer.ts` | **New file** - dedicated pipeline composition via structured output |
| `src/engine/prompts/pipeline-composer.md` | **New file** - focused prompt for pipeline composition |
| `src/engine/agents/planner.ts` | Remove profile parsing, call `composePipeline()` first, remove `formatProfileDescriptions`/`formatProfileGenerationSection` |
| `src/engine/agents/common.ts` | Remove `parseProfileBlock`, `parseGeneratedProfileBlock`, `GeneratedProfileBlock` |
| `src/engine/prompts/planner.md` | Remove profile selection section, remove `{{profiles}}`/`{{profileGeneration}}` |
| `src/engine/prompts/module-planner.md` | Add `{{buildStageRegistry}}` injection |
| `src/engine/config.ts` | Remove `BUILTIN_PROFILES`, `resolveGeneratedProfile`, `resolveProfileExtensions`, `DEFAULT_BUILD*` constants, old profile schemas |
| `src/engine/eforge.ts` | Use `pipeline.defaultBuild`/`defaultReview` as defaults |

### Out of Scope

- Backward compatibility with old profile system - old code is ripped out cleanly
- Changes to the `<build-config>` block mechanism used by module planners for per-plan overrides (kept as-is)

## Acceptance Criteria

1. **Unit tests**: Tests pass for `pipelineCompositionSchema` validation, `validatePipeline()`, `formatStageRegistry()`, and structured output parsing.
2. **Agent wiring test**: `test/agent-wiring.test.ts` updated - profile-related tests replaced with pipeline composition tests, `plan:pipeline` event verified.
3. **Integration**: A real build verifies:
   - Pipeline composer returns valid structured output
   - Composed stages execute in correct order
   - Per-plan build config overrides still work
   - Errand/excursion/expedition scope drives correct planning depth
4. **Prompt quality**: The pipeline-composer prompt and stage catalog reviewed - the model makes reasonable composition choices.
5. All old profile infrastructure removed: no references to `<profile>`, `<generated-profile>`, `BUILTIN_PROFILES`, `resolveGeneratedProfile`, `resolveProfileExtensions`, `DEFAULT_BUILD*` constants, `resolvedProfileConfigSchema`, `partialProfileConfigSchema`, `formatProfileDescriptions`, `formatProfileGenerationSection`, `parseProfileBlock`, `parseGeneratedProfileBlock`, or `GeneratedProfileBlock` remain in the codebase.
6. `StageDescriptor` metadata annotated on all ~17 existing stage registrations.
7. `outputFormat` support wired through `AgentBackend` and `claude-sdk` backend.
8. Module planner prompt receives `{{buildStageRegistry}}` with build stage catalog.
