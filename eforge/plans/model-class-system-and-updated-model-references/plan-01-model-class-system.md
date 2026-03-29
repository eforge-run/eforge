---
id: plan-01-model-class-system
name: Model Class System - Types, Resolution, and Config Schema
depends_on: []
branch: model-class-system-and-updated-model-references/model-class-system
---

# Model Class System - Types, Resolution, and Config Schema

## Architecture Context

The codebase uses `resolveAgentConfig()` in `src/engine/pipeline.ts` to resolve per-agent configuration through a four-tier priority chain: user per-role > user global > built-in per-role defaults > built-in global default. Currently, there is no concept of model classes - every agent either gets the same model or needs individual per-role overrides in config. This plan introduces a model class layer between the built-in defaults and user config, grouping agents by workload type (`max`, `balanced`, `fast`, `auto`) with per-backend default models.

The `AgentRole` type is defined in `src/engine/events.ts` and lists all 18 agent roles. The `AGENT_ROLES` const in `src/engine/config.ts` mirrors this. The `resolveAgentConfig` function lives in `src/engine/pipeline.ts` alongside `AGENT_ROLE_DEFAULTS`.

## Implementation

### Overview

Add model class types, constants, and config schema in `src/engine/config.ts`. Add agent-to-class mapping and per-backend class defaults in `src/engine/pipeline.ts`. Update `resolveAgentConfig` to resolve model through the class chain. Update the Pi backend fallback model and all outdated `claude-sonnet-4` references in source code. Add tests for schema validation and model resolution logic.

### Key Decisions

1. Model class constants (`MODEL_CLASSES`, `ModelClass` type) and the `models` schema field live in `config.ts` because they are config concepts. Agent-to-class mapping (`AGENT_MODEL_CLASSES`) and per-backend defaults (`MODEL_CLASS_DEFAULTS`) live in `pipeline.ts` because they are resolution-time concepts alongside `resolveAgentConfig`.
2. `resolveAgentConfig` needs to know which backend is active to look up class defaults. Add a `backend` parameter (defaulting to `'claude-sdk'`) rather than extracting it from config, since the config `backend` field is optional and the function should be explicit about which backend's defaults to use.
3. For the `auto` class on `claude-sdk` backend, the class default is `undefined` (no model string), which means the SDK picks its own model. This is modeled as `MODEL_CLASS_DEFAULTS['claude-sdk']['auto'] = undefined`.
4. The `agents.models` config field uses a simple `z.record` with `modelClassSchema` keys and optional string values, rather than a fixed object shape, so it naturally extends if new classes are added later.

## Scope

### In Scope
- `ModelClass` type and `MODEL_CLASSES` const array
- `modelClassSchema` for config validation
- `agents.models` field in `eforgeConfigSchema` (maps class names to model strings)
- `modelClass` field added to per-role config schema
- `AGENT_MODEL_CLASSES` mapping each `AgentRole` to a `ModelClass`
- `MODEL_CLASS_DEFAULTS` with per-backend defaults for each class
- Updated `resolveAgentConfig` with model class resolution: per-role model > global model > effective class lookup > backend default
- Update `pi.model` default from `'anthropic/claude-sonnet-4'` to `'anthropic/claude-sonnet-4-6'`
- Update `pi.ts` fallback model from `'claude-sonnet-4'` to `'claude-sonnet-4-6'`
- Update Pi config schema description example
- Tests for schema validation (`agents.models`, per-role `modelClass`)
- Tests for `resolveAgentConfig` model class resolution (all priority levels, both backends, `auto` class behavior)
- Update existing test expectations for the new Pi default model string

### Out of Scope
- Assigning agents to `fast` or `auto` by default
- Documentation updates (handled in plan-02)
- Changes to `DEFAULT_CONFIG.agents` for class defaults

## Files

### Modify
- `src/engine/config.ts` - Add `MODEL_CLASSES` const, `ModelClass` type, `modelClassSchema`. Add `models` field (record of class-to-model) to `agents` section of `eforgeConfigSchema`. Add `modelClass` to per-role schema. Update `pi.model` default to `'anthropic/claude-sonnet-4-6'`. Update `piConfigSchema` description example.
- `src/engine/pipeline.ts` - Add `AGENT_MODEL_CLASSES` mapping roles to classes. Add `MODEL_CLASS_DEFAULTS` with per-backend defaults. Update `resolveAgentConfig` signature to accept optional `backend` parameter. Insert model class resolution between global model check and the existing fallback.
- `src/engine/backends/pi.ts` - Update fallback model from `'claude-sonnet-4'` to `'claude-sonnet-4-6'` (line ~113).
- `test/pipeline.test.ts` - Add tests for model class resolution: default class resolution for planner (max) and formatter (balanced), per-role `modelClass` override, per-role `model` overriding class, global `model` overriding class, `auto` class returning `undefined` model on claude-sdk, Pi backend class defaults, user `agents.models` override.
- `test/config.test.ts` - Add tests for `agents.models` schema validation (valid and invalid). Add tests for per-role `modelClass` schema validation. Update Pi default model expectations from `'anthropic/claude-sonnet-4'` to `'anthropic/claude-sonnet-4-6'`.
- `test/sdk-mapping.test.ts` - Update `'claude-sonnet-4-20250514'` reference if it refers to an outdated model string (verify context first - may be a valid test fixture key).

## Verification

- [ ] `pnpm type-check` exits with code 0
- [ ] `pnpm test` exits with code 0, all new model class tests pass
- [ ] `resolveAgentConfig('planner', DEFAULT_CONFIG)` returns `model: 'claude-opus-4-6'` (max class on claude-sdk backend)
- [ ] `resolveAgentConfig('formatter', DEFAULT_CONFIG)` returns `model: 'claude-sonnet-4-6'` (balanced class on claude-sdk backend)
- [ ] `resolveAgentConfig('builder', DEFAULT_CONFIG, 'pi')` returns `model: 'anthropic/claude-sonnet-4-6'` (balanced class on pi backend)
- [ ] Config with `agents.roles.builder.modelClass: 'max'` makes `resolveAgentConfig('builder', ...)` return the max class model
- [ ] Config with `agents.roles.planner.model: 'custom-model'` makes `resolveAgentConfig('planner', ...)` return `'custom-model'` (per-role model wins)
- [ ] Config with `agents.model: 'global-override'` makes `resolveAgentConfig('planner', ...)` return `'global-override'` (global model wins over class)
- [ ] `resolveAgentConfig` with effective class `auto` on `claude-sdk` backend returns `model: undefined`
- [ ] No remaining `claude-sonnet-4` (without `-6` suffix) in `src/engine/config.ts`, `src/engine/backends/pi.ts`
- [ ] `agents.models` config field validates: accepts `{ max: 'some-model' }`, rejects `{ invalid-class: 'model' }`
- [ ] Per-role `modelClass` config field validates: accepts `'max'`, `'balanced'`, `'fast'`, `'auto'`, rejects `'invalid'`
