---
title: "Per-Plan Build Config: Foundation"
created: 2026-03-19
status: pending
---

# Per-Plan Build Config: Foundation

## Problem / Motivation

Currently eforge has one `ResolvedProfileConfig` in `orchestration.yaml` that bundles compile config (how we plan) with build config (how we build each plan). All plans share the same build stages and review config. This is the first of 3 PRDs to move build/review config to per-plan entries.

This PRD adds per-plan build/review as **additive, optional** fields - nothing breaks, no existing types change.

## Goal

Add the foundational types, constants, and wiring so that per-plan `build` and `review` fields can be written to and read from orchestration.yaml. All changes are additive - the existing profile type keeps its `build`/`review`/`agents` fields for now.

## Approach

### New constants in `src/engine/config.ts`

Add and export:
```typescript
export const DEFAULT_BUILD: readonly BuildStageSpec[] = ['implement', 'review-cycle'];
export const DEFAULT_BUILD_WITH_DOCS: readonly BuildStageSpec[] = [['implement', 'doc-update'], 'review-cycle'];
```

Export `buildStageSpecSchema`, `reviewProfileConfigSchema`, and `DEFAULT_REVIEW` (currently not exported, needed by plan.ts for per-plan parsing).

### Add optional build/review to OrchestrationConfig plans - `src/engine/events.ts`

Add `build?: BuildStageSpec[]` and `review?: ReviewProfileConfig` as **optional** fields on each plan entry in `OrchestrationConfig.plans`. Import these types from `./config.js`.

### Add build/review to BuildStageContext - `src/engine/pipeline.ts`

Add `build: BuildStageSpec[]` and `review: ReviewProfileConfig` as required fields on `BuildStageContext`.

Add `moduleBuildConfigs: Map<string, { build: BuildStageSpec[]; review: ReviewProfileConfig }>` to `PipelineContext`.

Update all build stage reads to prefer `ctx.build`/`ctx.review` with fallback to `ctx.profile.build`/`ctx.profile.review` during transition:
- `ctx.profile.build` → `ctx.build` in `runBuildPipeline` and `implementStage`
- `ctx.profile.review.*` → `ctx.review.*` in `reviewStageInner`, `reviewFixStageInner`, `evaluateStageInner`, `reviewCycleStage`

Simplify `resolveAgentConfig`: drop the `profile` parameter (first arg), drop the dead `prompt`/`tools`/`model` return fields. New signature: `resolveAgentConfig(role: AgentRole, config: EforgeConfig): { maxTurns: number }`. Update all 5 call sites to drop the profile argument.

### Parse optional per-plan build/review - `src/engine/plan.ts`

In `parseOrchestrationConfig`, read optional `build` and `review` from each plan entry. If present, validate with `buildStageSpecSchema` / `reviewProfileConfigSchema`. If absent, default to the profile's values. Import `z`, `buildStageSpecSchema`, `reviewProfileConfigSchema` from `config.js`.

Update `WritePlanArtifactsOptions` to accept `build: BuildStageSpec[]` and `review: ReviewProfileConfig`. Update `writePlanArtifacts` to include `build` and `review` in the orchestration.yaml plan entries it generates.

In `validatePlanSet`, add per-plan build stage validation when `build` is present:
```typescript
const { getBuildStageNames } = await import('./pipeline.js');
const buildStageNames = getBuildStageNames();
for (const plan of config.plans) {
  if (!plan.build) continue;
  const flatStages = plan.build.flatMap(s => Array.isArray(s) ? s : [s]);
  for (const name of flatStages) {
    if (!buildStageNames.has(name)) {
      errors.push(`Plan '${plan.id}': unknown build stage "${name}"`);
    }
  }
}
```

### Wire per-plan config in build phase - `src/engine/eforge.ts`

In the `planRunner` closure, read per-plan build/review from orchConfig plan entries:
```typescript
const planEntry = orchConfig.plans.find(p => p.id === planId)!;
```
Pass `build: planEntry.build ?? buildProfile.build` and `review: planEntry.review ?? buildProfile.review` into the `BuildStageContext`.

Initialize `moduleBuildConfigs: new Map()` in the PipelineContext during `compile()`.

### Accept moduleBuildConfigs in compiler - `src/engine/compiler.ts`

Update `compileExpedition` to accept an optional `moduleBuildConfigs` parameter. Write per-plan `build` and `review` into orchestration.yaml plan entries, falling back to `DEFAULT_BUILD`/`DEFAULT_REVIEW` when no module config exists.

### Update prd-passthrough - `src/engine/pipeline.ts`

Update the `prd-passthrough` stage's call to `writePlanArtifacts` to pass `build: DEFAULT_BUILD` and `review: DEFAULT_REVIEW`.

Update the `compile-expedition` stage to pass `ctx.moduleBuildConfigs` to `compileExpedition`.

### Exports - `src/engine/index.ts`

Export `DEFAULT_BUILD`, `DEFAULT_BUILD_WITH_DOCS`, `DEFAULT_REVIEW`, `buildStageSpecSchema`, `reviewProfileConfigSchema`.

## Scope

**In scope:**
- New constants: `DEFAULT_BUILD`, `DEFAULT_BUILD_WITH_DOCS`
- Export existing `buildStageSpecSchema`, `reviewProfileConfigSchema`, `DEFAULT_REVIEW`
- Optional `build`/`review` on `OrchestrationConfig.plans` entries
- `build`/`review` on `BuildStageContext`
- `moduleBuildConfigs` on `PipelineContext`
- All build stage reads updated to `ctx.build`/`ctx.review` (with fallback)
- `resolveAgentConfig` simplified (drop profile param, drop dead fields)
- `parseOrchestrationConfig` reads optional per-plan fields
- `writePlanArtifacts` writes per-plan fields
- `validatePlanSet` validates per-plan build stages
- `compileExpedition` accepts `moduleBuildConfigs`
- `prd-passthrough` passes defaults
- Index exports

**Out of scope:**
- Removing build/review/agents from profile type (PRD 2)
- Prompt changes (PRD 2)
- Agent changes (PRD 2)
- Test updates (PRD 3)
- Monitor UI (PRD 3)

## Acceptance Criteria

1. `pnpm type-check` passes - all changes are additive, nothing breaks
2. `pnpm test` passes - existing tests still work (no behavior change for existing code paths)
3. `pnpm build` succeeds
4. `resolveAgentConfig` takes 2 arguments (`role`, `config`) and returns `{ maxTurns: number }`
5. `BuildStageContext` has `build` and `review` fields
6. `PipelineContext` has `moduleBuildConfigs` field
7. `DEFAULT_BUILD`, `DEFAULT_BUILD_WITH_DOCS`, `DEFAULT_REVIEW` are exported from `src/engine/index.ts`
