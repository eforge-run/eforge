---
id: plan-01-model-tier
name: Model Tier Abstraction
depends_on: []
branch: model-tier-abstraction/model-tier
---

# Model Tier Abstraction

## Architecture Context

The engine has partial model plumbing: `AgentRunOptions.model` exists as `string | undefined`, `ClaudeSDKBackend` passes it through to the SDK, `AgentProfileConfig.model` is parsed from YAML as `string`, and `resolveAgentConfig()` returns it. But the chain is broken - no caller ever populates the model field, so every `backend.run()` call sends `undefined`. This plan completes the chain with a tier abstraction between config and concrete model strings.

## Implementation

### Overview

Define a `ModelTier` union type, add `resolveModel()` to the backend interface, export per-agent default tiers, tighten config validation to tier values, and wire the resolution chain through every pipeline stage and direct caller so that `backend.run()` always receives a resolved concrete model string.

### Key Decisions

1. **Tiers live in `backend.ts`** - they're part of the backend contract. `resolveModel()` is the backend's responsibility because only the backend knows what concrete models it supports.
2. **Resolution happens in the pipeline layer, not in agents** - agents don't know about tiers. The pipeline resolves `tier → model string` and passes the concrete string via `AgentRunOptions.model`. This keeps agent code backend-agnostic.
3. **Agent option interfaces gain an optional `model?: string` field** - each agent function accepts and forwards it to `backend.run()`. The pipeline populates it; agents don't interpret it.
4. **`formatter` and `staleness-assessor` get `balanced` as default tier** - the PRD table doesn't list them but they exist as agents and need defaults. Both are lighter utility tasks where `balanced` is appropriate. `formatter` normalizes text, `staleness-assessor` does lightweight diff assessment.

## Scope

### In Scope
- `ModelTier` type in `backend.ts`, re-exported from `index.ts`
- `resolveModel(tier: ModelTier): string` on `AgentBackend` interface
- `ClaudeSDKBackend` implementation with default model map and optional `modelMap` constructor override
- `StubBackend` implementation
- `DEFAULT_MODEL_TIER` export from every agent file
- `AgentProfileConfig.model` type change from `z.string()` to `z.enum(['powerful', 'balanced', 'fast'])`
- Pipeline helper `resolveModelForAgent()` implementing the resolution chain
- `model` field added to every agent option interface
- Every agent function forwards `model` to `backend.run()`
- Every pipeline stage and direct caller in `eforge.ts` resolves and passes the model
- Tests for tier validation, resolution chain, and wiring

### Out of Scope
- New backends
- CLI flags for per-run model override
- Cost tracking

## Files

### Modify
- `src/engine/backend.ts` — Add `ModelTier` type, add `resolveModel()` to `AgentBackend` interface
- `src/engine/backends/claude-sdk.ts` — Implement `resolveModel()` with default model map, accept optional `modelMap` in constructor options
- `test/stub-backend.ts` — Implement `resolveModel()` returning `stub-{tier}`
- `src/engine/config.ts` — Change `agentProfileConfigSchema.model` from `z.string()` to `z.enum(['powerful', 'balanced', 'fast'])`
- `src/engine/index.ts` — Re-export `ModelTier` from barrel
- `src/engine/pipeline.ts` — Add `resolveModelForAgent()` helper, wire model through all compile and build stages
- `src/engine/eforge.ts` — Wire model through direct callers (formatter, staleness-assessor, validation-fixer, merge-conflict-resolver)
- `src/engine/agents/planner.ts` — Export `DEFAULT_MODEL_TIER = 'powerful'`, add `model?: string` to `PlannerOptions`, forward to `backend.run()`
- `src/engine/agents/builder.ts` — Export `DEFAULT_MODEL_TIER = 'powerful'`, add `model?: string` to `BuilderOptions`, forward to `backend.run()` in both `builderImplement()` and `builderEvaluate()`
- `src/engine/agents/reviewer.ts` — Export `DEFAULT_MODEL_TIER = 'powerful'`, add `model?: string` to `ReviewerOptions`, forward to `backend.run()`
- `src/engine/agents/parallel-reviewer.ts` — Add `model?: string` to `ParallelReviewerOptions`, forward to underlying reviewer calls
- `src/engine/agents/review-fixer.ts` — Export `DEFAULT_MODEL_TIER = 'powerful'`, add `model?: string` to `ReviewFixerOptions`, forward to `backend.run()`
- `src/engine/agents/plan-reviewer.ts` — Export `DEFAULT_MODEL_TIER = 'powerful'`, add `model?: string` to `PlanReviewerOptions`, forward to `backend.run()`
- `src/engine/agents/plan-evaluator.ts` — Export `DEFAULT_MODEL_TIER = 'powerful'`, add `model?: string` to `PlanEvaluatorOptions`, forward to `backend.run()`
- `src/engine/agents/module-planner.ts` — Export `DEFAULT_MODEL_TIER = 'powerful'`, add `model?: string` to `ModulePlannerOptions`, forward to `backend.run()`
- `src/engine/agents/cohesion-reviewer.ts` — Export `DEFAULT_MODEL_TIER = 'powerful'`, add `model?: string` to `CohesionReviewerOptions`, forward to `backend.run()`
- `src/engine/agents/cohesion-evaluator.ts` — Export `DEFAULT_MODEL_TIER = 'powerful'`, add `model?: string` to `CohesionEvaluatorOptions`, forward to `backend.run()`
- `src/engine/agents/validation-fixer.ts` — Export `DEFAULT_MODEL_TIER = 'powerful'`, add `model?: string` to `ValidationFixerOptions`, forward to `backend.run()`
- `src/engine/agents/merge-conflict-resolver.ts` — Export `DEFAULT_MODEL_TIER = 'powerful'`, add `model?: string` to `MergeConflictResolverOptions`, forward to `backend.run()`
- `src/engine/agents/assessor.ts` — Export `DEFAULT_MODEL_TIER = 'balanced'`, add `model?: string` to `AssessorOptions`, forward to `backend.run()`
- `src/engine/agents/staleness-assessor.ts` — Export `DEFAULT_MODEL_TIER = 'balanced'`, add `model?: string` to `StalenessAssessorOptions`, forward to `backend.run()`
- `src/engine/agents/formatter.ts` — Export `DEFAULT_MODEL_TIER = 'balanced'`, add `model?: string` to `FormatterOptions`, forward to `backend.run()`

### Create
- `test/model-tier.test.ts` — Tests for tier parsing/validation, resolution chain logic, and `resolveModelForAgent()` helper

## Implementation Details

### Type Definition (`backend.ts`)

```typescript
export type ModelTier = 'powerful' | 'balanced' | 'fast';

export const MODEL_TIERS: readonly ModelTier[] = ['powerful', 'balanced', 'fast'] as const;
```

Add to `AgentBackend`:
```typescript
resolveModel(tier: ModelTier): string;
```

### ClaudeSDKBackend (`backends/claude-sdk.ts`)

Add `modelMap` to `ClaudeSDKBackendOptions`:
```typescript
modelMap?: Partial<Record<ModelTier, string>>;
```

Default map as class field:
```typescript
private modelMap: Record<ModelTier, string>;
```

Constructor merges caller-provided overrides over defaults:
```typescript
const DEFAULT_MODEL_MAP: Record<ModelTier, string> = {
  powerful: 'claude-sonnet-4-20250514',
  balanced: 'claude-sonnet-4-20250514',
  fast: 'claude-haiku-3-5-20241022',
};
this.modelMap = { ...DEFAULT_MODEL_MAP, ...options?.modelMap };
```

### Pipeline Helper (`pipeline.ts`)

```typescript
import type { ModelTier } from './backend.js';

export function resolveModelForAgent(
  backend: AgentBackend,
  profile: ResolvedProfileConfig,
  role: AgentRole,
  agentDefaultTier: ModelTier,
): string {
  const tier = profile.agents[role]?.model ?? agentDefaultTier;
  return backend.resolveModel(tier);
}
```

Each pipeline stage calls this and passes the result as `model` to the agent runner. Example for planner stage:

```typescript
import { DEFAULT_MODEL_TIER as PLANNER_DEFAULT_TIER } from './agents/planner.js';

// Inside plannerStage:
const model = resolveModelForAgent(ctx.backend, ctx.profile, 'planner', PLANNER_DEFAULT_TIER);
// Pass model to runPlanner options
```

### Agent Wiring Pattern

Every agent option interface gains `model?: string`. Every `backend.run()` call includes it:

```typescript
backend.run(
  { prompt, cwd, maxTurns, tools: 'coding', model: options.model, abortSignal: ... },
  'planner',
)
```

### Direct Callers in `eforge.ts`

For agents called directly (formatter, staleness-assessor, validation-fixer, merge-conflict-resolver), `EforgeEngine` resolves the model using the active profile and passes it through. These agents don't go through pipeline stages, so the resolution happens inline.

### Config Validation (`config.ts`)

Change:
```typescript
model: z.string().optional(),
```
To:
```typescript
model: z.enum(['powerful', 'balanced', 'fast']).optional(),
```

Existing configs using raw model strings (e.g., `model: 'claude-sonnet-4-20250514'`) will fail validation with a clear error message from zod listing the valid tier values.

## Verification

- [ ] `pnpm type-check` passes with zero errors
- [ ] `pnpm test` passes with zero failures
- [ ] `ModelTier` type is importable from `@eforge/engine` (or the barrel at `src/engine/index.ts`)
- [ ] `ClaudeSDKBackend.resolveModel('powerful')` returns `'claude-sonnet-4-20250514'`
- [ ] `ClaudeSDKBackend.resolveModel('fast')` returns `'claude-haiku-3-5-20241022'`
- [ ] Constructor `modelMap` override replaces specific tier mappings: `new ClaudeSDKBackend({ modelMap: { fast: 'custom-model' } })` makes `resolveModel('fast')` return `'custom-model'` while other tiers keep defaults
- [ ] `StubBackend.resolveModel('powerful')` returns a string (any non-empty string)
- [ ] Config with `model: 'powerful'` parses without error
- [ ] Config with `model: 'claude-sonnet-4-20250514'` fails zod validation with an error mentioning the valid tier values
- [ ] Every agent file exports a `DEFAULT_MODEL_TIER` constant of type `ModelTier`
- [ ] `resolveModelForAgent()` returns `backend.resolveModel(profile.agents[role].model)` when the profile specifies a tier override
- [ ] `resolveModelForAgent()` returns `backend.resolveModel(agentDefaultTier)` when the profile has no tier override for that role
- [ ] Test file `test/model-tier.test.ts` exists with passing tests for tier validation, resolution chain, and the helper function
