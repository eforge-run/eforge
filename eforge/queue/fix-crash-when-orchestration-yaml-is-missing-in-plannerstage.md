---
title: Fix crash when orchestration.yaml is missing in plannerStage
created: 2026-04-03
---



# Fix crash when orchestration.yaml is missing in plannerStage

## Problem / Motivation

In `src/engine/pipeline.ts`, the `injectPipelineIntoOrchestrationYaml()` call at ~line 814 in `plannerStage` sits outside the try/catch block that protects `parseOrchestrationConfig()`. If the planner agent fails to write `orchestration.yaml` (runs out of turns, model error, etc.), `injectPipelineIntoOrchestrationYaml()` performs a hard `readFile()` that throws ENOENT and crashes the entire compile. The plans themselves are already available in the `plan:complete` event - the orchestration file is supplementary metadata for dependency ordering and pipeline injection, so this crash is unnecessary.

## Goal

Ensure that a missing or broken `orchestration.yaml` gracefully falls back to yielding unenriched plan events instead of crashing the compile.

## Approach

Move the `injectPipelineIntoOrchestrationYaml()` call inside the existing try/catch block so both it and `parseOrchestrationConfig()` are protected. On failure, fall through to yield unenriched plans.

Current code (~line 813-830 in `pipeline.ts`, inside the `plan:complete` handler in `plannerStage`):

```ts
const orchYamlPath = resolve(ctx.cwd, ctx.config.plan.outputDir, ctx.planSetName, 'orchestration.yaml');
await injectPipelineIntoOrchestrationYaml(orchYamlPath, ctx.pipeline, ctx.baseBranch);

try {
  const orchConfig = await parseOrchestrationConfig(orchYamlPath);
  const enrichedPlans = backfillDependsOn(event.plans, orchConfig);
  ctx.plans = enrichedPlans;
  yield { ...event, plans: enrichedPlans };
  continue;
} catch {
  ctx.plans = event.plans;
}
```

Fixed code:

```ts
const orchYamlPath = resolve(ctx.cwd, ctx.config.plan.outputDir, ctx.planSetName, 'orchestration.yaml');
try {
  await injectPipelineIntoOrchestrationYaml(orchYamlPath, ctx.pipeline, ctx.baseBranch);
  const orchConfig = await parseOrchestrationConfig(orchYamlPath);
  const enrichedPlans = backfillDependsOn(event.plans, orchConfig);
  ctx.plans = enrichedPlans;
  yield { ...event, plans: enrichedPlans };
  continue;
} catch {
  // orchestration.yaml missing or unparseable — yield plans without enrichment
  ctx.plans = event.plans;
}
```

## Scope

**In scope:**
- `src/engine/pipeline.ts` - move `injectPipelineIntoOrchestrationYaml()` inside the existing try/catch
- `test/pipeline.test.ts` - add a test verifying `plannerStage` handles a missing `orchestration.yaml` gracefully (emits `plan:complete` with unenriched plans instead of throwing)

**Out of scope:**
- Any other files or behavior changes

## Acceptance Criteria

- `injectPipelineIntoOrchestrationYaml()` is inside the try/catch block alongside `parseOrchestrationConfig()` in `plannerStage`
- When `orchestration.yaml` is missing, `plannerStage` emits a `plan:complete` event with unenriched plans instead of throwing
- A test in `test/pipeline.test.ts` verifies that `plannerStage` handles a missing `orchestration.yaml` gracefully
