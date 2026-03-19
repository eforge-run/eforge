---
title: Per-Plan Build Configuration
created: 2026-03-19
status: pending
---

# Per-Plan Build Configuration

## Problem / Motivation

Currently eforge has one `ResolvedProfileConfig` in `orchestration.yaml` that bundles compile config (how we plan) with build config (how we build each plan). All plans share the same build stages and review config. This means if the profile includes `doc-update`, every plan runs it even if only one plan touches docs. Same for review perspectives.

The builtin profiles (errand, excursion, expedition) differ **only** in their compile stages. Build stages, review config, and agents are identical. This reveals that profiles are really about "which planning workflow to use" - build config is a separate concern that should be per-plan, determined during planning.

## Goal

Separate compile config (profiles) from build config (per-plan), so each plan in an orchestration carries its own `build` stages and `review` config - determined by the planner based on what the plan actually needs.

## Approach

**Profiles become `{ description, compile }` only.** The `build`, `review`, and `agents` fields are removed. A profile is just a name for a planning workflow.

**Each plan carries its own `build` and `review` config** as required fields in orchestration.yaml plan entries. The planner determines these during planning. For errands (no planner agent), `prd-passthrough`/`writePlanArtifacts` writes sensible defaults.

**`agents` config removed from profiles entirely.** `resolveAgentConfig` simplifies to per-role defaults + `config.agents.maxTurns`. The returned `prompt`/`tools`/`model` fields are dead code (no caller reads them) and are removed.

**No backward compat. No fallback defaults.**

### Key design decisions

1. **Profiles = `{ description, compile }` only** — everything else removed.
2. **`agents` removed from profiles** — `resolveAgentConfig` drops the profile parameter. Only reads per-role defaults + `config.agents.maxTurns`. The `prompt`/`tools`/`model` return fields are removed (dead code — no call site reads them).
3. **Per-plan `build`/`review` are required** — planner must always determine them.
4. **`BuildStageContext` gains direct `build` and `review` fields** — all build stages read `ctx.build`/`ctx.review`.
5. **For errands** — `prd-passthrough`/`writePlanArtifacts` writes sensible defaults since no planner agent runs.

### Target orchestration.yaml shape

```yaml
profile:
  description: "expedition workflow"
  compile: [planner, architecture-review-cycle, module-planning, cohesion-review-cycle, compile-expedition]

plans:
  - id: plan-01-auth
    name: Auth middleware rewrite
    depends_on: []
    branch: my-set/auth
    build: [["implement", "doc-update"], "review", "review-fix", "evaluate"]
    review: { strategy: auto, perspectives: [code, security], maxRounds: 2, evaluatorStrictness: strict }
  - id: plan-02-refactor-utils
    name: Internal utils cleanup
    depends_on: []
    branch: my-set/utils
    build: ["implement", "review", "review-fix", "evaluate"]
    review: { strategy: auto, perspectives: [code], maxRounds: 1, evaluatorStrictness: standard }
```

### Implementation steps

#### Step 1: Slim down profile types — `src/engine/config.ts`

Remove `build`, `review`, `agents` from both schema objects:

```typescript
// resolvedProfileConfigSchema — was 7 fields, now 3
export const resolvedProfileConfigSchema = z.object({
  description: z.string().min(1),
  extends: z.string().optional(),
  compile: z.array(z.string()).nonempty(),
});

// partialProfileConfigSchema — same fields but all optional
const partialProfileConfigSchema = z.object({
  description: z.string().optional(),
  extends: z.string().optional(),
  compile: z.array(z.string()).optional(),
});
```

Export `buildStageSpecSchema` and `reviewProfileConfigSchema` (add `export` keyword — currently not exported, needed for per-plan parsing in `plan.ts`).

Update `BUILTIN_PROFILES`:
```typescript
errand: { description: '...', compile: ['prd-passthrough'] },
excursion: { description: '...', compile: ['planner', 'plan-review-cycle'] },
expedition: { description: '...', compile: ['planner', 'architecture-review-cycle', 'module-planning', 'cohesion-review-cycle', 'compile-expedition'] },
```

Remove `DEFAULT_BUILD_STAGES`, `ERRAND_BUILD_STAGES` constants. Keep `DEFAULT_REVIEW` as a standalone exported constant (used by `writePlanArtifacts` and compiler for defaults).

Add a `DEFAULT_BUILD` constant for errand defaults:
```typescript
export const DEFAULT_BUILD: readonly BuildStageSpec[] = ['implement', 'review', 'review-fix', 'evaluate'];
export const DEFAULT_BUILD_WITH_DOCS: readonly BuildStageSpec[] = [['implement', 'doc-update'], 'review', 'review-fix', 'evaluate'];
```

Update `resolveProfileExtensions` (line 507-586) — remove agents/review/build merging. Profile merge becomes trivial: just `description`, `compile`, `extends`.

Update `mergePartialConfigs` (line 386-452) — remove agents and review merging from the profiles section. Profile merge simplifies to just `description`/`compile`/`extends`.

Update `resolveGeneratedProfile` (line 697-720) — remove build/review/agents handling. Generated profiles only carry `description`/`compile`/`extends`.

Update `validateProfileConfig` (line 615-689) — remove build stage validation and agents validation. Only validates compile stages and description.

Update `getProfileSchemaYaml` — reflects the simplified schema automatically since it reads from `resolvedProfileConfigSchema`.

Remove `agentProfileConfigSchema` from the profile schemas (no longer used by profiles). Keep `AGENT_ROLES` if used elsewhere.

Remove the `ResolvedProfileConfig` fields: `build`, `review`, `agents` from the type (derived from schema, so automatic).

#### Step 1b: Simplify `resolveAgentConfig` — `src/engine/pipeline.ts`

Remove the `profile` parameter. Drop the dead `prompt`/`tools`/`model` return fields:

```typescript
export function resolveAgentConfig(
  role: AgentRole,
  config: EforgeConfig,
): { maxTurns: number } {
  const roleDefault = AGENT_MAX_TURNS_DEFAULTS[role];
  return { maxTurns: roleDefault ?? config.agents.maxTurns };
}
```

Update all 5 call sites to drop the profile argument:
- Line 379: `resolveAgentConfig(ctx.profile, 'planner', ctx.config)` → `resolveAgentConfig('planner', ctx.config)`
- Line 574: same pattern for `'module-planner'`
- Line 703: same for `'builder'`
- Line 861: same for `'evaluator'`
- Line 913: same for `'doc-updater'`

#### Step 1c: Update `GeneratedProfileBlock` — `src/engine/agents/common.ts`

Remove `build`, `agents`, `review` from the overrides interface:

```typescript
export interface GeneratedProfileBlock {
  extends?: string;
  name?: string;
  overrides?: Partial<{
    description: string;
    compile: string[];
  }>;
  config?: ResolvedProfileConfig;  // now just { description, compile }
}
```

#### Step 2: Add build/review to plan entries — `src/engine/events.ts`

```typescript
import type { BuildStageSpec, ReviewProfileConfig } from './config.js';

export interface OrchestrationConfig {
  name: string;
  description: string;
  created: string;
  mode: (typeof ORCHESTRATION_MODES)[number];
  baseBranch: string;
  profile: ResolvedProfileConfig;  // now just description + compile
  plans: Array<{
    id: string;
    name: string;
    dependsOn: string[];
    branch: string;
    build: BuildStageSpec[];       // required per-plan
    review: ReviewProfileConfig;   // required per-plan
  }>;
  validate?: string[];
}
```

No changes to `PlanFile`.

#### Step 3: Add build/review to BuildStageContext — `src/engine/pipeline.ts`

```typescript
export interface BuildStageContext extends PipelineContext {
  planId: string;
  worktreePath: string;
  planFile: PlanFile;
  orchConfig: OrchestrationConfig;
  reviewIssues: ReviewIssue[];
  buildFailed?: boolean;
  build: BuildStageSpec[];       // per-plan build stages
  review: ReviewProfileConfig;   // per-plan review config
}
```

Update **all** build stage reads (mechanical find-and-replace):
- `ctx.profile.build` → `ctx.build` (lines ~712, ~1048)
- `ctx.profile.review.strategy` → `ctx.review.strategy` (lines ~767, ~883)
- `ctx.profile.review.perspectives` → `ctx.review.perspectives` (lines ~768, ~884)
- `ctx.profile.review.autoAcceptBelow` → `ctx.review.autoAcceptBelow` (lines ~808, ~885)
- `ctx.profile.review.evaluatorStrictness` → `ctx.review.evaluatorStrictness` (lines ~854, ~886)
- `ctx.profile.review.maxRounds` → `ctx.review.maxRounds` (line ~882)

This covers `runBuildPipeline`, `implementStage`, `reviewStageInner`, `reviewFixStageInner`, `evaluateStageInner`, and `reviewCycleStage`.

#### Step 4: Parse per-plan build/review — `src/engine/plan.ts`

Update `parseOrchestrationConfig` (around line 174) to parse required `build` and `review` from each plan entry:

```typescript
// Parse required build config
const buildResult = z.array(buildStageSpecSchema).safeParse(p.build);
if (!buildResult.success) {
  throw new Error(`Plan '${p.id}' has invalid or missing 'build' field`);
}

// Parse required review config
const reviewResult = reviewProfileConfigSchema.safeParse(p.review);
if (!reviewResult.success) {
  throw new Error(`Plan '${p.id}' has invalid or missing 'review' field`);
}
```

Import `z` and `buildStageSpecSchema`, `reviewProfileConfigSchema` from `config.js`.

#### Step 5: Wire per-plan config in build phase — `src/engine/eforge.ts`

In the `planRunner` closure (around line 372), read per-plan build/review from orchConfig:

```typescript
const planEntry = orchConfig.plans.find(p => p.id === planId)!;

const buildCtx: BuildStageContext = {
  backend, config,
  profile: orchConfig.profile,
  tracing, cwd: worktreePath,
  planSetName: planSet,
  sourceContent: '',
  verbose, abortController,
  plans: Array.from(planFileMap.values()),
  expeditionModules: [],
  moduleBuildConfigs: new Map(),
  planId, worktreePath, planFile, orchConfig,
  reviewIssues: [],
  build: planEntry.build,
  review: planEntry.review,
};
```

Remove `const buildProfile = orchConfig.profile;` (line 370).

Also initialize `moduleBuildConfigs: new Map()` in the PipelineContext during `compile()`.

#### Step 6: Update `writePlanArtifacts` — `src/engine/plan.ts`

Update `WritePlanArtifactsOptions` to replace `profile` with per-plan build/review:

```typescript
export interface WritePlanArtifactsOptions {
  cwd: string;
  planSetName: string;
  sourceContent: string;
  planName: string;
  baseBranch: string;
  profile: ResolvedProfileConfig;  // still needed for orchestration.yaml profile field
  build: BuildStageSpec[];
  review: ReviewProfileConfig;
  validate?: string[];
  mode?: 'errand' | 'excursion';
}
```

In the orchestration.yaml generation (~line 476-492), add per-plan build/review:

```typescript
plans: [{
  id: planId,
  name: planName,
  depends_on: [],
  branch,
  build: options.build,
  review: options.review,
}],
```

Update callers of `writePlanArtifacts` (the `prd-passthrough` stage in pipeline.ts) to pass `build: DEFAULT_BUILD` and `review: DEFAULT_REVIEW`.

#### Step 7: Planner prompt — `src/engine/prompts/planner.md`

Update to instruct per-plan build/review in orchestration.yaml plan entries:

- Each plan entry MUST include `build` and `review` fields
- Provide the `BuildStageSpec` and `ReviewProfileConfig` schemas for reference
- Document when to include `doc-update` (user-facing surface changes)
- Document review perspective choices (code, security, performance, api)
- Remove build/review/agents from profile generation section

Remove `{{parallelLanes}}` template variable usage (or keep as empty string).

#### Step 8: Builder prompt — `src/engine/prompts/builder.md`

The builder prompt uses `{{parallelLanes}}` at line 37. This variable is populated by the implement stage from `ctx.build` (after our change). Update the implement stage to compute the `parallelLanes` string from `ctx.build` and inject it into the builder prompt. The implement stage already does this (line ~712) — just update the source from `ctx.profile.build` to `ctx.build`.

#### Step 9: Planner agent — `src/engine/agents/planner.ts`

- Remove `formatParallelLanes` function entirely.
- Remove the parallelLanes computation in `buildPrompt()` (lines 192-201). Set `parallelLanes` template var to empty string or remove it.
- Update `formatProfileGenerationSection` to exclude build/review/agents from schema docs and examples. Generated profiles now only customize compile stages + description.

#### Step 10: Expedition — module planner + compiler

**10a. XML parser — `src/engine/agents/common.ts`**

Add `parseBuildConfigBlock()`:

```typescript
export function parseBuildConfigBlock(text: string): { build?: BuildStageSpec[]; review?: Partial<ReviewProfileConfig> } | null {
  const match = text.match(/<build-config>([\s\S]*?)<\/build-config>/);
  if (!match) return null;
  try { return JSON.parse(match[1].trim()); }
  catch { return null; }
}
```

**10b. Pipeline context — `src/engine/pipeline.ts`**

Add to `PipelineContext`:
```typescript
moduleBuildConfigs: Map<string, { build: BuildStageSpec[]; review: ReviewProfileConfig }>;
```

**10c. Module-planning stage — `src/engine/pipeline.ts` (around line 540)**

In the module wave task runner, intercept `agent:message` events to parse `<build-config>`:

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

**10d. Compiler — `src/engine/compiler.ts`**

Update `compileExpedition` signature:

```typescript
export async function compileExpedition(
  cwd: string,
  planSetName: string,
  profile?: ResolvedProfileConfig,
  moduleBuildConfigs?: Map<string, { build: BuildStageSpec[]; review: ReviewProfileConfig }>,
): Promise<PlanFile[]>
```

In orchestration.yaml plan entries (~line 127), include per-plan build/review:

```typescript
plans: planFiles.map((p) => {
  const moduleId = orderedModules.find(m => m.planId === p.id)?.id;
  const config = moduleId ? moduleBuildConfigs?.get(moduleId) : undefined;
  return {
    id: p.id,
    name: p.name,
    depends_on: p.dependsOn,
    branch: p.branch,
    build: config?.build ?? [...DEFAULT_BUILD],
    review: config?.review ?? { ...DEFAULT_REVIEW },
  };
}),
```

**10e. Compile-expedition stage — `src/engine/pipeline.ts` (around line 685)**

Pass `ctx.moduleBuildConfigs` to compiler:
```typescript
const plans = await compileExpedition(ctx.cwd, ctx.planSetName, ctx.profile, ctx.moduleBuildConfigs);
```

**10f. Module planner prompt — `src/engine/prompts/module-planner.md`**

Add section instructing `<build-config>` block emission with schema reference and guidelines.

#### Step 11: Validation — `src/engine/plan.ts`

In `validatePlanSet` (around line 280), add per-plan build stage validation:

```typescript
const { getBuildStageNames } = await import('./pipeline.js');
const buildStageNames = getBuildStageNames();

for (const plan of config.plans) {
  const flatStages = plan.build.flatMap(s => Array.isArray(s) ? s : [s]);
  for (const name of flatStages) {
    if (!buildStageNames.has(name)) {
      errors.push(`Plan '${plan.id}': unknown build stage "${name}"`);
    }
  }
}
```

#### Step 12: Monitor UI — `src/monitor/`

**12a. Types — `src/monitor/ui/src/lib/types.ts`**

Remove `build`, `review`, `agents` from `ProfileConfig` type. Profile becomes `{ description, compile }`.

**12b. Pipeline view — `src/monitor/ui/src/components/pipeline/thread-pipeline.tsx`**

- `ProfileHeader` — show only description + compile stages (remove build stage rendering)
- `StageOverview` — remove `build` prop, only show compile stages
- `ReviewConfig` component — remove or relocate (review config is now per-plan, not profile-level)

**12c. Event details — `src/monitor/ui/src/components/timeline/event-card.tsx`**

Update `eventDetail()` to only show compile stages from the profile, not build/review/agents.

**12d. State — `src/monitor/ui/src/lib/reducer.ts`**

`profileInfo` state update — type will be automatically correct since `ProfileConfig` type changes.

**12e. Mock server — `src/monitor/mock-server.ts`**

Update mock profile objects to match new shape. Add per-plan build/review to mock plan entries if the monitor displays them.

#### Step 13: Plugin docs — `eforge-plugin/skills/config/config.md`

Update profile documentation examples to show `{ description, compile }` only. Document per-plan build/review config.

#### Step 14: Tests

**Test files that need updating** (all construct `ResolvedProfileConfig` with build/review/agents):

| Test file | Changes needed |
|-----------|----------------|
| `test/pipeline.test.ts` | Most impacted. `makeBuildCtx` helper needs `build`/`review` fields. All `BUILTIN_PROFILES` spreads need updating. `resolveAgentConfig` tests need new 2-arg signature. |
| `test/dynamic-profile-generation.test.ts` | `cloneProfile` helper, `resolveGeneratedProfile` tests, `validateProfileConfig` tests — all construct full profiles with build/review/agents. |
| `test/config-profiles.test.ts` | Profile construction with build/review/agents, extension resolution tests. |
| `test/plan-parsing.test.ts` | Orchestration config fixtures need per-plan build/review. |
| `test/lane-awareness.test.ts` | Tests `formatParallelLanes` which is being removed. |
| `test/agent-wiring.test.ts` | May construct profiles with build/review. |
| `test/orchestration-logic.test.ts` | May reference profile.build or construct profiles. |
| `test/plan-complete-depends-on.test.ts` | May construct orchestration configs. |
| `test/adopt.test.ts` | May reference profile shape. |
| `test/fixtures/orchestration/valid.yaml` | Fixture file — needs per-plan build/review, profile slimmed. |

**New tests** in `test/per-plan-build-config.test.ts`:
1. `parseOrchestrationConfig` reads per-plan build/review
2. `parseOrchestrationConfig` throws on missing build/review
3. Validation catches invalid per-plan stage names
4. `parseBuildConfigBlock` parses valid JSON, returns null on invalid

#### Step 15: Exports — `src/engine/index.ts`

Remove `formatParallelLanes` export. Add `DEFAULT_BUILD`, `DEFAULT_BUILD_WITH_DOCS`, `DEFAULT_REVIEW` exports if needed by other consumers.

### Files to modify

| File | Change |
|------|--------|
| `src/engine/config.ts` | Remove build/review/agents from profile schemas; update BUILTIN_PROFILES; export `buildStageSpecSchema`, `reviewProfileConfigSchema`; add `DEFAULT_BUILD`/`DEFAULT_BUILD_WITH_DOCS` constants; update `resolveProfileExtensions`, `mergePartialConfigs`, `resolveGeneratedProfile`, `validateProfileConfig` |
| `src/engine/events.ts` | Add `build`, `review` to `OrchestrationConfig.plans` entries |
| `src/engine/pipeline.ts` | Simplify `resolveAgentConfig` (drop profile param, drop dead fields); add `build`, `review` to `BuildStageContext`; add `moduleBuildConfigs` to PipelineContext; all `ctx.profile.build` → `ctx.build`; all `ctx.profile.review` → `ctx.review`; intercept `<build-config>` in module-planning stage; pass to compiler in compile-expedition |
| `src/engine/plan.ts` | Parse required per-plan build/review in `parseOrchestrationConfig`; update `WritePlanArtifactsOptions`; update `writePlanArtifacts`; validate per-plan stages in `validatePlanSet` |
| `src/engine/eforge.ts` | Wire per-plan build/review into BuildStageContext; init `moduleBuildConfigs`; remove `buildProfile` |
| `src/engine/compiler.ts` | Accept + propagate per-module build configs to orchestration.yaml |
| `src/engine/agents/planner.ts` | Remove `formatParallelLanes`; update `formatProfileGenerationSection` (compile-only); remove parallelLanes computation from `buildPrompt()` |
| `src/engine/agents/common.ts` | Add `parseBuildConfigBlock()`; update `GeneratedProfileBlock` (remove build/agents/review from overrides) |
| `src/engine/prompts/planner.md` | Per-plan build/review instructions; slim profile generation to compile-only |
| `src/engine/prompts/builder.md` | `{{parallelLanes}}` still works (populated from `ctx.build` in implement stage) |
| `src/engine/prompts/module-planner.md` | Add `<build-config>` block instructions |
| `src/engine/index.ts` | Remove `formatParallelLanes` export; add default constants if needed |
| `src/monitor/ui/src/lib/types.ts` | Slim `ProfileConfig` to `{ description, compile }` |
| `src/monitor/ui/src/components/pipeline/thread-pipeline.tsx` | Update StageOverview, ProfileHeader (compile-only); remove/relocate ReviewConfig |
| `src/monitor/ui/src/components/timeline/event-card.tsx` | Update event detail rendering |
| `src/monitor/mock-server.ts` | Update mock profile objects |
| `eforge-plugin/skills/config/config.md` | Update profile documentation |
| `test/pipeline.test.ts` | `makeBuildCtx` + `resolveAgentConfig` + profile construction |
| `test/dynamic-profile-generation.test.ts` | `cloneProfile`, `resolveGeneratedProfile`, `validateProfileConfig` |
| `test/config-profiles.test.ts` | Profile construction + extension tests |
| `test/plan-parsing.test.ts` | Orchestration fixtures with per-plan build/review |
| `test/lane-awareness.test.ts` | `formatParallelLanes` removed |
| `test/agent-wiring.test.ts` | Profile construction |
| `test/orchestration-logic.test.ts` | Profile/orchestration references |
| `test/plan-complete-depends-on.test.ts` | Orchestration config construction |
| `test/adopt.test.ts` | Profile references |
| `test/fixtures/orchestration/valid.yaml` | Fixture update |

## Scope

**In scope:**
- Removing `build`, `review`, `agents` from profile schemas and types
- Adding required per-plan `build` and `review` fields to orchestration.yaml plan entries
- Simplifying `resolveAgentConfig` to drop profile parameter and dead return fields
- Adding `build`/`review` to `BuildStageContext` and updating all build stage reads
- Updating `writePlanArtifacts` for errand/excursion default build/review
- Expedition support: module planner emits `<build-config>` blocks, compiler propagates per-module configs
- Planner and module planner prompt updates for per-plan build/review instructions
- Monitor UI updates to reflect slimmed profile shape
- Plugin docs update
- All test updates and new test coverage for per-plan parsing/validation

**Out of scope:**
- Backward compatibility or migration of existing orchestration.yaml files
- Optional fallbacks or compat shims
- Changes to the `PlanFile` type
- Changes to the builder prompt's `{{parallelLanes}}` mechanism (still works, just sourced from `ctx.build` instead of `ctx.profile.build`)

## Acceptance Criteria

1. `pnpm type-check` — no type errors
2. `pnpm test` — all tests pass
3. `pnpm build` — builds clean
4. `ResolvedProfileConfig` contains only `description`, `extends` (optional), and `compile` — no `build`, `review`, or `agents` fields
5. `resolveAgentConfig` takes 2 arguments (`role`, `config`) and returns only `{ maxTurns: number }`
6. `OrchestrationConfig.plans` entries each have required `build: BuildStageSpec[]` and `review: ReviewProfileConfig` fields
7. `parseOrchestrationConfig` throws on missing or invalid per-plan `build`/`review`
8. `validatePlanSet` validates per-plan build stage names against the stage registry
9. `BuildStageContext` has direct `build` and `review` fields; all build stages read from `ctx.build`/`ctx.review` (not `ctx.profile.build`/`ctx.profile.review`)
10. `prd-passthrough` stage writes `DEFAULT_BUILD` and `DEFAULT_REVIEW` into orchestration.yaml plan entries for errands
11. Planner prompt instructs per-plan `build`/`review` in orchestration.yaml plan entries
12. Module planner prompt instructs `<build-config>` block emission; module-planning stage parses it and passes configs to the expedition compiler
13. `formatParallelLanes` is removed from `src/engine/agents/planner.ts` and `src/engine/index.ts`
14. Monitor UI `ProfileConfig` type reflects `{ description, compile }` only
15. Manual: run an errand — verify `prd-passthrough` writes default build/review per-plan in orchestration.yaml
16. Manual: run an excursion — verify planner writes per-plan build/review in orchestration.yaml
