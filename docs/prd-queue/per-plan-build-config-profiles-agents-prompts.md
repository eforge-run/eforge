---
title: "Per-Plan Build Config: Profiles, Agents & Prompts"
created: 2026-03-19
status: pending
depends_on: ["per-plan-build-config-foundation"]
---

# Per-Plan Build Config: Profiles, Agents & Prompts

## Problem / Motivation

After the foundation PRD, per-plan `build` and `review` fields exist as optional additions. This PRD completes the migration by removing `build`/`review`/`agents` from the profile type, making per-plan fields required, and updating all agents and prompts.

## Goal

Profiles become `{ description, compile }` only. Per-plan `build` and `review` become required. Agents and prompts are updated to generate and consume per-plan config.

## Approach

### Remove build/review/agents from profile schemas - `src/engine/config.ts`

Update `resolvedProfileConfigSchema` to only contain `description`, `extends` (optional), and `compile`:
```typescript
export const resolvedProfileConfigSchema = z.object({
  description: z.string().min(1),
  extends: z.string().optional(),
  compile: z.array(z.string()).nonempty(),
});
```

Same for `partialProfileConfigSchema` (all fields optional).

Update `BUILTIN_PROFILES` - remove `build`, `agents`, `review` from each profile. They now only have `description` and `compile`.

Remove `DEFAULT_BUILD_STAGES` and `ERRAND_BUILD_STAGES` constants (replaced by `DEFAULT_BUILD`/`DEFAULT_BUILD_WITH_DOCS` from foundation PRD).

Remove `agentProfileConfigSchema` from profile schemas.

Update `resolveProfileExtensions` - remove agents/review/build merging. Profile merge becomes trivial: just `description`, `compile`, `extends`.

Update `mergePartialConfigs` - remove agents and review merging from profiles section.

Update `resolveGeneratedProfile` - remove build/review/agents handling.

Update `validateProfileConfig` - remove build stage validation and agents validation. Only validates compile stages and description.

### Make per-plan build/review required - `src/engine/events.ts`

Change `build` and `review` from optional (`?`) to required on `OrchestrationConfig.plans` entries.

**Note:** Pipeline build stages already read from `ctx.build`/`ctx.review` (no fallbacks to remove - foundation PRD implemented this directly).

### Update planner agent - `src/engine/agents/planner.ts`

Remove `formatParallelLanes` function entirely.

Remove the parallelLanes computation in `buildPrompt()`. Set `parallelLanes` template var to empty string or remove it.

Update `formatProfileGenerationSection` to exclude build/review/agents from schema docs and examples. Generated profiles now only customize compile stages + description.

### Update common agent utilities - `src/engine/agents/common.ts`

Add `parseBuildConfigBlock()` for expedition module planner output:
```typescript
export function parseBuildConfigBlock(text: string): { build?: BuildStageSpec[]; review?: Partial<ReviewProfileConfig> } | null {
  const match = text.match(/<build-config>([\s\S]*?)<\/build-config>/);
  if (!match) return null;
  try { return JSON.parse(match[1].trim()); }
  catch { return null; }
}
```

Update `GeneratedProfileBlock` - remove `build`, `agents`, `review` from overrides:
```typescript
export interface GeneratedProfileBlock {
  extends?: string;
  name?: string;
  overrides?: Partial<{
    description: string;
    compile: string[];
  }>;
  config?: ResolvedProfileConfig;
}
```

### Update planner prompt - `src/engine/prompts/planner.md`

Add per-plan build/review instructions to the orchestration.yaml format section:

- Each plan entry MUST include `build` and `review` fields
- `build` uses `review-cycle` as the composite stage (not individual `review`/`review-fix`/`evaluate`):
  - Code changes: `["implement", "review-cycle"]` or `[["implement", "doc-update"], "review-cycle"]`
  - `doc-update` included when plan touches user-facing surfaces (APIs, CLI, config, docs)
  - `review-cycle` should almost always be included - only omit for purely mechanical changes with zero logic
- `review` configures review-cycle knobs: `strategy` (auto), `perspectives` (code, security, performance, api), `maxRounds` (1-3), `evaluatorStrictness` (standard or strict)
- Remove build/review/agents from profile generation section
- Remove `{{parallelLanes}}` template variable usage (or keep as empty string)

### Update module planner prompt - `src/engine/prompts/module-planner.md`

Add section instructing `<build-config>` block emission:
- Module planner should emit a `<build-config>` JSON block specifying per-module build stages and review config
- Use `review-cycle` as the composite stage
- `review-cycle` almost always included
- `doc-update` when touching user-facing surfaces

### Intercept build-config in module planning - `src/engine/pipeline.ts`

In the module-planning stage's wave task runner, intercept `agent:message` events to parse `<build-config>`:
```typescript
if (event.type === 'agent:message' && event.agent === 'module-planner') {
  const config = parseBuildConfigBlock(event.content);
  if (config) {
    ctx.moduleBuildConfigs.set(mod.id, {
      build: config.build ?? [...DEFAULT_BUILD],
      review: { ...DEFAULT_REVIEW, ...(config.review ?? {}) },
    });
  }
}
```

Import `parseBuildConfigBlock` from `./agents/common.js`.

### Exports - `src/engine/index.ts`

Remove `formatParallelLanes` export.

## Scope

**In scope:**
- Remove build/review/agents from profile schemas and BUILTIN_PROFILES
- Remove DEFAULT_BUILD_STAGES, ERRAND_BUILD_STAGES
- Simplify resolveProfileExtensions, mergePartialConfigs, resolveGeneratedProfile, validateProfileConfig
- Make per-plan build/review required in OrchestrationConfig
- Remove formatParallelLanes from planner agent
- Update formatProfileGenerationSection (compile-only)
- Add parseBuildConfigBlock to common.ts
- Update GeneratedProfileBlock
- Update planner prompt with per-plan build/review instructions and review-cycle guidance
- Update module planner prompt with build-config block instructions
- Intercept build-config in module planning stage
- Remove formatParallelLanes export

**Out of scope:**
- Test updates (PRD 3)
- Monitor UI (PRD 3)
- Plugin docs (PRD 3)

## Acceptance Criteria

1. `pnpm type-check` passes
2. `pnpm build` succeeds
3. `ResolvedProfileConfig` contains only `description`, `extends` (optional), and `compile` - no `build`, `review`, or `agents`
4. `OrchestrationConfig.plans` entries have required `build` and `review` fields
5. `formatParallelLanes` no longer exists
6. `parseBuildConfigBlock` exists in `src/engine/agents/common.ts`
7. Planner prompt documents per-plan `build`/`review` with `review-cycle` as standard composite stage
8. Module planner prompt documents `<build-config>` block emission
