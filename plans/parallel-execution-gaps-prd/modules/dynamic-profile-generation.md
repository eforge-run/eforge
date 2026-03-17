# Dynamic Profile Generation

## Architecture Reference

This module implements [Between dynamic-profile-generation and the planner] from the architecture.

Key constraints from architecture:
- The planner (or a dedicated pre-step) generates a `ResolvedProfileConfig` and emits it via the existing `plan:profile` event with the `config` field populated
- The pipeline's existing logic already handles inline config - `event.config` is preferred over named lookup
- New validation ensures the generated config has valid stage names and required fields before it reaches the pipeline
- Depends on review-strategy-wiring being complete (otherwise generated profiles with non-default review config are silently ignored)

## Scope

### In Scope
- `validateProfileConfig()` function in `config.ts` that validates a `ResolvedProfileConfig` has valid stage names, required fields, and allowed enum values
- Planner prompt extension to support generating/extending profiles when `--generate-profile` mode is active
- XML format for agent-generated profile configs (`<generated-profile>` block)
- Parser for the generated profile XML in `common.ts`
- Planner wiring to parse the generated profile, validate it, and emit `plan:profile` with inline `config`
- `--generate-profile` CLI flag on the `run` command
- `generateProfile` option threaded through `EforgeEngineOptions` → `CompileOptions` → `PlannerOptions`

### Out of Scope
- Dedicated profile-generation agent (uses the planner agent with an extended prompt section)
- Eval harness for comparing generated vs pre-defined profiles (future work)
- Profile generation during `adopt` flow
- Changes to the pipeline's profile consumption logic (already handles inline `config`)

## Implementation Approach

### Overview

Extend the planner agent to optionally generate a profile config instead of selecting one by name. When `--generate-profile` is passed, the planner prompt includes an additional section instructing the agent to output a `<generated-profile>` XML block containing either a base profile name with overrides or a complete profile config. The planner parses this block, validates the resulting config via `validateProfileConfig()`, and emits `plan:profile` with the validated config inline. The pipeline already consumes `event.config` over named lookup - no pipeline changes needed.

### Key Decisions

1. **Use the planner agent, not a separate agent.** The planner already has full PRD context and codebase exploration capabilities. Adding a profile generation instruction to its prompt is simpler than orchestrating a separate agent before the planner runs. The planner already emits `<profile>` blocks - generating config is a natural extension.

   *Rejected alternative*: A separate pre-pipeline profile-generation agent. Would require a new compile stage, additional agent lifecycle overhead, and duplicate codebase exploration.

2. **New `<generated-profile>` XML block rather than overloading `<profile>`.** The existing `<profile name="excursion">` format selects by name. Profile generation produces structured config (JSON within XML). Using a separate block name keeps parsing unambiguous and backward-compatible. When both blocks are present, `<generated-profile>` takes precedence.

3. **Validation at parse time, not pipeline time.** The planner validates the generated config immediately after parsing the XML block. Invalid configs fail with a `plan:progress` warning and fall back to name-based selection. This avoids late failures deep in the pipeline.

4. **Overrides-based generation as the primary mode.** The prompt instructs the agent to extend a base profile rather than generating from scratch. This keeps the output small and grounded in known-good defaults. The agent can still produce a complete config when no base fits, but the prompt steers toward extension.

## Files

### Create
- `test/dynamic-profile-generation.test.ts` — Unit tests for `validateProfileConfig()`, `parseGeneratedProfileBlock()`, and planner wiring with generated profiles

### Modify
- `src/engine/config.ts` — Add `validateProfileConfig(config: ResolvedProfileConfig, compileRegistry?: Set<string>, buildRegistry?: Set<string>): { valid: boolean; errors: string[] }`. Validates: `description` is non-empty string, `compile` and `build` are non-empty arrays, all stage names exist in the provided registries (when given), `agents` keys are from the valid `AgentRole` set, `review` fields match allowed enums (`strategy`, `evaluatorStrictness`), `review.maxRounds` is a positive integer, `review.perspectives` is a non-empty array. Also add `resolveGeneratedProfile(generated: { extends?: string; overrides?: Partial<PartialProfileConfig>; full?: ResolvedProfileConfig }, availableProfiles: Record<string, ResolvedProfileConfig>): ResolvedProfileConfig` that merges an extends-based generated config into a resolved profile.

- `src/engine/agents/common.ts` — Add `parseGeneratedProfileBlock(text: string): GeneratedProfileBlock | null` that parses a `<generated-profile>` XML block. The block contains JSON with either `{ extends: "base-name", overrides: { ... } }` or `{ config: { description, compile, build, agents, review } }`. Returns a typed object or null if no block found / parse failure.

- `src/engine/agents/planner.ts` — Three changes:
  1. Accept new `generateProfile?: boolean` option in `PlannerOptions`
  2. When `generateProfile` is true, inject the profile generation prompt section (via a new template variable `{{profileGeneration}}`) and pass available profiles as JSON (not just the markdown table) so the agent can reference exact field names
  3. After agent message parsing, check for `<generated-profile>` block. When found: parse it, resolve it (extend base or use full config), validate via `validateProfileConfig()`, and emit `plan:profile` with `config` field. If validation fails, log a warning via `plan:progress` and fall back to `<profile>` name-based selection.

- `src/engine/prompts/planner.md` — Add `{{profileGeneration}}` template variable after the existing Profile Selection section. When populated, it contains instructions for generating a custom profile config with the XML format, available fields, and examples.

- `src/engine/pipeline.ts` — Export the stage registry keys for validation. Add `getCompileStageNames(): string[]` and `getBuildStageNames(): string[]` functions that return the registered stage names. These are consumed by `validateProfileConfig()` at runtime.

- `src/engine/events.ts` — Add `generateProfile?: boolean` to `CompileOptions` interface.

- `src/engine/eforge.ts` — Thread `generateProfile` from `EforgeEngineOptions` through to `CompileOptions` when calling `compile()`. Pass it to the planner stage via `PipelineContext`. In the planner stage, pass it to `runPlanner()` options.

- `src/cli/index.ts` — Add `--generate-profile` flag to the `run` command. Pass it to `engine.compile()` as `generateProfile: true`.

## Detailed Implementation

### 1. `validateProfileConfig()` in `config.ts`

```typescript
const VALID_AGENT_ROLES = new Set<string>([
  'planner', 'builder', 'reviewer', 'evaluator', 'module-planner',
  'plan-reviewer', 'plan-evaluator', 'cohesion-reviewer', 'cohesion-evaluator',
  'validation-fixer', 'assessor', 'review-fixer', 'merge-conflict-resolver',
]);

const VALID_STRATEGIES = new Set(['auto', 'single', 'parallel']);
const VALID_STRICTNESS = new Set(['strict', 'standard', 'lenient']);
const VALID_AUTO_ACCEPT = new Set(['suggestion', 'warning']);

export function validateProfileConfig(
  config: ResolvedProfileConfig,
  compileStageNames?: Set<string>,
  buildStageNames?: Set<string>,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!config.description || typeof config.description !== 'string') {
    errors.push('description is required and must be a non-empty string');
  }
  if (!Array.isArray(config.compile) || config.compile.length === 0) {
    errors.push('compile must be a non-empty array of stage names');
  }
  if (!Array.isArray(config.build) || config.build.length === 0) {
    errors.push('build must be a non-empty array of stage names');
  }

  // Validate stage names against registries when provided
  if (compileStageNames) {
    for (const name of config.compile) {
      if (!compileStageNames.has(name)) {
        errors.push(`unknown compile stage: "${name}"`);
      }
    }
  }
  if (buildStageNames) {
    for (const name of config.build) {
      if (!buildStageNames.has(name)) {
        errors.push(`unknown build stage: "${name}"`);
      }
    }
  }

  // Validate agent roles
  if (config.agents) {
    for (const role of Object.keys(config.agents)) {
      if (!VALID_AGENT_ROLES.has(role)) {
        errors.push(`unknown agent role: "${role}"`);
      }
    }
  }

  // Validate review config
  if (config.review) {
    if (!VALID_STRATEGIES.has(config.review.strategy)) {
      errors.push(`invalid review strategy: "${config.review.strategy}"`);
    }
    if (!VALID_STRICTNESS.has(config.review.evaluatorStrictness)) {
      errors.push(`invalid evaluator strictness: "${config.review.evaluatorStrictness}"`);
    }
    if (config.review.autoAcceptBelow && !VALID_AUTO_ACCEPT.has(config.review.autoAcceptBelow)) {
      errors.push(`invalid autoAcceptBelow: "${config.review.autoAcceptBelow}"`);
    }
    if (typeof config.review.maxRounds !== 'number' || config.review.maxRounds < 1) {
      errors.push('review.maxRounds must be a positive integer');
    }
    if (!Array.isArray(config.review.perspectives) || config.review.perspectives.length === 0) {
      errors.push('review.perspectives must be a non-empty array');
    }
  } else {
    errors.push('review config is required');
  }

  return { valid: errors.length === 0, errors };
}
```

### 2. `parseGeneratedProfileBlock()` in `common.ts`

```typescript
export interface GeneratedProfileBlock {
  extends?: string;
  overrides?: Partial<{
    description: string;
    compile: string[];
    build: string[];
    agents: Record<string, unknown>;
    review: Partial<ReviewProfileConfig>;
  }>;
  config?: ResolvedProfileConfig;
}

export function parseGeneratedProfileBlock(text: string): GeneratedProfileBlock | null {
  const match = text.match(/<generated-profile>([\s\S]*?)<\/generated-profile>/);
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[1].trim());
    if (parsed.config) return { config: parsed.config };
    if (parsed.extends) return { extends: parsed.extends, overrides: parsed.overrides };
    return null;
  } catch {
    return null;
  }
}
```

### 3. `resolveGeneratedProfile()` in `config.ts`

```typescript
export function resolveGeneratedProfile(
  generated: GeneratedProfileBlock,
  availableProfiles: Record<string, ResolvedProfileConfig>,
): ResolvedProfileConfig {
  // Full config mode - use as-is
  if (generated.config) return generated.config;

  // Extends mode - merge overrides onto base
  const baseName = generated.extends ?? 'excursion';
  const base = availableProfiles[baseName];
  if (!base) {
    throw new Error(`Generated profile extends unknown base: "${baseName}"`);
  }

  const overrides = generated.overrides ?? {};
  return {
    description: overrides.description ?? base.description,
    compile: overrides.compile ?? base.compile,
    build: overrides.build ?? base.build,
    agents: { ...base.agents, ...(overrides.agents as Record<AgentRole, AgentProfileConfig> ?? {}) },
    review: { ...base.review, ...(overrides.review ?? {}) } as ReviewProfileConfig,
  };
}
```

### 4. Profile generation prompt section

Injected via `{{profileGeneration}}` when `generateProfile` is true:

```markdown
### Profile Generation

Instead of selecting a predefined profile by name, generate a custom profile configuration tailored to this specific work. Analyze the PRD and your codebase exploration to determine the optimal review strategy, perspectives, and pipeline stages.

Output a `<generated-profile>` block with JSON content. Prefer extending a base profile with overrides:

\`\`\`xml
<generated-profile>
{
  "extends": "excursion",
  "overrides": {
    "review": {
      "perspectives": ["code", "security"],
      "maxRounds": 2,
      "evaluatorStrictness": "strict"
    }
  }
}
</generated-profile>
\`\`\`

Available base profiles:
{{profilesJson}}

Available review fields:
- `strategy`: "auto" | "single" | "parallel"
- `perspectives`: array of review perspective names (e.g. ["code", "security", "performance"])
- `maxRounds`: number of review-fix-evaluate cycles (default 1)
- `autoAcceptBelow`: auto-accept issues at or below this severity — "suggestion" | "warning"
- `evaluatorStrictness`: "strict" | "standard" | "lenient"

Rules:
- When a base profile fits with minor tweaks, use `extends` + `overrides`
- Only override fields that differ from the base — omit fields you want to inherit
- When the `<generated-profile>` block is present, skip the `<profile>` block
- After generating a profile, still emit the `<scope>` block (both are required)
```

### 5. Planner wiring changes

In `runPlanner()`, after parsing `agent:message` events:

```typescript
if (!profileEmitted && options.generateProfile) {
  const generatedBlock = parseGeneratedProfileBlock(event.content);
  if (generatedBlock) {
    profileEmitted = true;
    const resolved = resolveGeneratedProfile(generatedBlock, options.profiles ?? {});
    const { valid, errors } = validateProfileConfig(resolved);
    if (valid) {
      yield {
        type: 'plan:profile',
        profileName: generatedBlock.extends ?? 'generated',
        rationale: `Generated profile${generatedBlock.extends ? ` extending ${generatedBlock.extends}` : ''} tailored to this PRD`,
        config: resolved,
      };
    } else {
      yield { type: 'plan:progress', message: `Generated profile invalid (${errors.join('; ')}), falling back to name-based selection` };
    }
  }
}
```

The existing `<profile>` parsing block runs after this as a fallback when `profileEmitted` remains false.

## Testing Strategy

### Unit Tests (`test/dynamic-profile-generation.test.ts`)

**`validateProfileConfig()`:**
- A valid `ResolvedProfileConfig` (clone of `BUILTIN_PROFILES.excursion`) returns `{ valid: true, errors: [] }`
- Missing `description` (empty string) returns `valid: false` with error containing "description"
- Empty `compile` array returns `valid: false` with error containing "compile"
- Empty `build` array returns `valid: false` with error containing "build"
- Unknown compile stage name (e.g. `'nonexistent'`) returns error when `compileStageNames` set is provided
- Unknown build stage name returns error when `buildStageNames` set is provided
- Unknown agent role (e.g. `'wizard'`) returns error containing "unknown agent role"
- Invalid `review.strategy` value (e.g. `'turbo'`) returns error containing "invalid review strategy"
- Invalid `review.evaluatorStrictness` (e.g. `'extreme'`) returns error
- `review.maxRounds: 0` returns error containing "positive integer"
- `review.maxRounds: -1` returns error containing "positive integer"
- Empty `review.perspectives` array returns error containing "perspectives"
- Missing `review` object entirely returns error containing "review config is required"

**`parseGeneratedProfileBlock()`:**
- Text with `<generated-profile>{"extends":"excursion","overrides":{"review":{"maxRounds":2}}}</generated-profile>` returns `{ extends: 'excursion', overrides: { review: { maxRounds: 2 } } }`
- Text with `<generated-profile>{"config":{...full config...}}</generated-profile>` returns `{ config: { ... } }`
- Text with no `<generated-profile>` block returns `null`
- Text with malformed JSON inside the block returns `null`
- Text with empty `<generated-profile></generated-profile>` returns `null`

**`resolveGeneratedProfile()`:**
- Extends mode: `{ extends: 'errand', overrides: { review: { maxRounds: 2 } } }` resolves to errand base with `review.maxRounds: 2`, all other fields inherited
- Extends mode with description override: the resolved config has the overridden description
- Full config mode: `{ config: fullConfig }` returns the config as-is
- Unknown base name throws an error containing "unknown base"
- Missing extends defaults to `'excursion'` as base

**Planner wiring with `generateProfile: true`:**
- StubBackend returns text containing a `<generated-profile>` block with valid extends config. Planner yields a `plan:profile` event whose `config` field is a `ResolvedProfileConfig` with the overridden values. No `<profile>` fallback event emitted.
- StubBackend returns text containing a `<generated-profile>` block with invalid JSON. Planner yields a `plan:progress` warning event and does NOT yield `plan:profile` with inline config. (Falls through to `<profile>` block if present.)
- StubBackend returns text containing both `<generated-profile>` and `<profile>` blocks. Only the generated profile is used (first match wins since `profileEmitted` is set to true).

**Planner wiring with `generateProfile: false` (or omitted):**
- StubBackend returns text containing a `<generated-profile>` block. The block is ignored - planner uses `<profile>` name-based selection as before.

## Verification

- [ ] `pnpm type-check` passes with zero errors
- [ ] `pnpm test` passes — all existing tests remain green, new tests in `test/dynamic-profile-generation.test.ts` pass
- [ ] `validateProfileConfig()` returns `{ valid: true, errors: [] }` for each of the three `BUILTIN_PROFILES` (errand, excursion, expedition)
- [ ] `validateProfileConfig()` returns `valid: false` with at least one error string when given a config with an empty `compile` array
- [ ] `validateProfileConfig()` returns `valid: false` when given `review.strategy: 'turbo'` (not in allowed set)
- [ ] `validateProfileConfig()` returns `valid: false` when given an agent role key `'wizard'` (not in allowed set)
- [ ] `validateProfileConfig()` returns errors for unknown stage names when compile/build registry sets are provided, and returns no stage-name errors when registries are omitted
- [ ] `parseGeneratedProfileBlock()` returns `null` for text without a `<generated-profile>` block
- [ ] `parseGeneratedProfileBlock()` returns `null` for malformed JSON inside the block (no exception thrown)
- [ ] `parseGeneratedProfileBlock()` returns `{ extends: 'excursion', overrides: { review: { maxRounds: 2 } } }` for text containing that JSON wrapped in `<generated-profile>` tags
- [ ] `resolveGeneratedProfile()` with `{ extends: 'errand', overrides: { review: { maxRounds: 3 } } }` produces a config where `review.maxRounds === 3` and `review.strategy === 'auto'` (inherited from errand base)
- [ ] `resolveGeneratedProfile()` with `{ config: fullConfig }` returns `fullConfig` unchanged
- [ ] When `generateProfile: true`, the planner parses `<generated-profile>` blocks from agent output and emits `plan:profile` with an inline `config` field
- [ ] When `generateProfile` is false or omitted, `<generated-profile>` blocks in agent output are ignored
- [ ] When the generated profile fails validation, the planner emits a `plan:progress` warning and does not set `profileEmitted` to true (allowing `<profile>` fallback)
- [ ] The `--generate-profile` CLI flag is accepted by `eforge run` and passes `generateProfile: true` through to `engine.compile()`
- [ ] The `generateProfile` option flows from `EforgeEngineOptions` → `compile()` → `PipelineContext` → `runPlanner()` options
