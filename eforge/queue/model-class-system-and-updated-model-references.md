---
title: Model class system and updated model references
created: 2026-03-29
status: running
---

# Model class system and updated model references

## Problem / Motivation

The codebase references outdated Claude 4 model names (`claude-sonnet-4`). More importantly, there is no structured way to configure model selection by agent class - every agent either gets the same model or needs individual per-role overrides. This makes it tedious to tune model selection across groups of agents that share similar workload characteristics.

## Goal

Introduce a model class system where agents are classified by workload type (`max`/`balanced`/`fast`/`auto`), each class maps to a default model per backend, and users get full override flexibility at every level. Update all outdated model references to current `4-6` versions.

## Approach

### Model classes

Four classes with default models per backend:

| Class | Purpose | claude-sdk default | pi default |
|-------|---------|-------------------|------------|
| `max` | Heavy reasoning - planning, architectural review | `claude-opus-4-6` | `anthropic/claude-opus-4-6` |
| `balanced` | Standard coding, review, evaluation | `claude-sonnet-4-6` | `anthropic/claude-sonnet-4-6` |
| `fast` | Simple/mechanical tasks | `claude-haiku-4-5-20251001` | `anthropic/claude-haiku-4-5-20251001` |
| `auto` | Let the backend decide | *(no model passed - SDK picks)* | `openrouter/auto` |

### Agent model class assignments

| Class | Roles |
|-------|-------|
| **max** | `planner`, `module-planner`, `plan-reviewer`, `architecture-reviewer`, `cohesion-reviewer` |
| **balanced** | `builder`, `reviewer`, `evaluator`, `plan-evaluator`, `architecture-evaluator`, `cohesion-evaluator`, `review-fixer`, `doc-updater`, `test-writer`, `tester`, `validation-fixer`, `merge-conflict-resolver`, `formatter`, `staleness-assessor` |

No agents default to `fast` or `auto` currently. These classes exist in config so users can opt specific roles into them via per-role `modelClass` override. For `auto` on the claude-sdk backend, `resolveAgentConfig` returns `model: undefined` so the SDK uses its own model selection.

### Model resolution order (highest wins)

1. User per-role `model` (`agents.roles.planner.model`) - explicit model string
2. User global `model` (`agents.model`) - override all agents
3. Effective model class lookup, where effective class is:
   - User per-role `modelClass` (`agents.roles.builder.modelClass: max`) if set, otherwise
   - Built-in class assignment (`AGENT_MODEL_CLASSES[role]`)

   The class resolves to a model via:
   - User class model (`agents.models.max`) if set, otherwise
   - Built-in class default (`MODEL_CLASS_DEFAULTS[backend][class]`)
4. Backend's own default (existing fallback - `pi.model` or SDK default)

### Config example

```yaml
agents:
  models:
    max: claude-opus-4-6               # Override the max class model
    balanced: claude-sonnet-4-6        # Override the balanced class model
    fast: claude-haiku-4-5-20251001    # Override the fast class model
    # auto: (no override needed - defers to backend)
  # model: override-all-agents         # Global override still works (wins over classes)
  roles:
    builder:
      modelClass: max                  # Use the max class's model for builder
    formatter:
      modelClass: auto                 # Let the backend pick the model
    # planner:
    #   model: specific-model          # Per-role model still works (wins over everything)
```

### Implementation steps

**1. Add model class types and constants to `src/engine/config.ts`**

- New `MODEL_CLASSES` const array (`['max', 'balanced', 'fast', 'auto']`) and `ModelClass` type
- New `modelClassSchema` (`z.enum(MODEL_CLASSES)`) for config validation
- Add `models` field to the `agents` section of `eforgeConfigSchema`:
  ```ts
  models: z.object({
    max: z.string().optional(),
    balanced: z.string().optional(),
    fast: z.string().optional(),
  }).optional()
  ```
- Add `modelClass` field to the per-role config (extend `sdkPassthroughConfigSchema` or the roles record value)
- No changes to `DEFAULT_CONFIG` - class defaults are resolved dynamically based on backend

**2. Add class assignments and defaults to `src/engine/pipeline.ts`**

- New `AGENT_MODEL_CLASSES: Record<AgentRole, ModelClass>` mapping each role to its class
- New `MODEL_CLASS_DEFAULTS: Record<Backend, Record<ModelClass, string>>` with per-backend defaults
- Update `resolveAgentConfig` to resolve model through the class chain:
  - After checking `userRole.model` and `userGlobal.model`, determine effective class (`userRole.modelClass` or `AGENT_MODEL_CLASSES[role]`)
  - Resolve class to model via `config.agents.models?.[class]` then `MODEL_CLASS_DEFAULTS[backend][class]`

**3. Update pipeline stage calls**

All `resolveAgentConfig` call sites already have access to `ctx.config` which includes `config.backend`. Update the function signature to accept backend (or extract it from config).

**4. Update Pi backend defaults**

- `src/engine/config.ts:386` - `pi.model`: `'anthropic/claude-sonnet-4'` -> `'anthropic/claude-sonnet-4-6'`
- `src/engine/backends/pi.ts:112-113` - Fallback model: `'claude-sonnet-4'` -> `'claude-sonnet-4-6'`
- `src/engine/config.ts:205` - Schema description example: `"anthropic/claude-sonnet-4"` -> `"anthropic/claude-sonnet-4-6"`

**5. Update docs**

- `docs/config.md` - Update all `claude-sonnet-4` / `claude-sonnet-4-20250514` references to `4-6` versions; add `models` section to the agents config example with model class documentation; update role override examples to show the model class system
- `eforge-plugin/skills/config/config.md` - Same updates as `docs/config.md`

**6. Update CLAUDE.md**

Add model class system to the Architecture/Config sections describing the concept and resolution order.

**7. Update tests**

- `test/config.test.ts` - Add tests for `agents.models` schema validation; add tests for per-role `modelClass` schema validation; update Pi backend test expectations to `'anthropic/claude-sonnet-4-6'`
- `test/` - `resolveAgentConfig` tests (new or existing):
  - Test class resolution: role with no overrides gets class default
  - Test priority: per-role model > global model > per-role modelClass > built-in class default
  - Test per-role `modelClass` override (e.g., builder with `modelClass: 'max'`)
  - Test different backends get different class defaults

### Files to modify

- `src/engine/config.ts` - model class types, schema, pi default
- `src/engine/pipeline.ts` - class assignments, class defaults, `resolveAgentConfig` update
- `src/engine/backends/pi.ts` - fallback model string
- `docs/config.md` - model class docs, model string updates
- `eforge-plugin/skills/config/config.md` - model class docs, model string updates
- `CLAUDE.md` - model class system documentation
- `test/config.test.ts` - schema tests, pi default tests
- `test/` - `resolveAgentConfig` model class resolution tests

## Scope

**In scope:**

- Model class type system (`max`, `balanced`, `fast`, `auto`) with per-backend defaults
- Built-in agent-to-class mapping for all existing roles
- Full resolution chain: per-role model > global model > model class (per-role override or built-in) > backend default
- Config schema additions (`agents.models`, per-role `modelClass`)
- Updating all outdated `claude-sonnet-4` / `claude-sonnet-4-20250514` references to `4-6` versions across code, config defaults, and docs
- Tests for schema validation and model resolution logic
- Documentation updates (config docs, plugin skills, CLAUDE.md)

**Out of scope:**

- Assigning any agents to `fast` or `auto` by default (classes exist for user opt-in only)
- Changes to `DEFAULT_CONFIG` for class defaults (resolved dynamically based on backend)

## Acceptance Criteria

1. `pnpm type-check` passes with no type errors
2. `pnpm test` passes, including all new model class tests
3. `resolveAgentConfig('planner', defaultConfig)` returns `model: 'claude-opus-4-6'` (max class)
4. `resolveAgentConfig('formatter', defaultConfig)` returns `model: 'claude-sonnet-4-6'` (balanced class)
5. Per-role `modelClass: 'max'` override resolves to the max class model
6. Per-role `model` override still wins over all other resolution levels
7. Global `agents.model` override wins over class-based resolution
8. Pi backend resolves to `anthropic/claude-*-4-6` variants by default
9. `auto` class on claude-sdk backend results in `model: undefined` (SDK picks)
10. No remaining references to outdated `claude-sonnet-4` (non-`4-6`) model strings in code, config defaults, or docs
11. `docs/config.md`, `eforge-plugin/skills/config/config.md`, and `CLAUDE.md` are updated with model class documentation
