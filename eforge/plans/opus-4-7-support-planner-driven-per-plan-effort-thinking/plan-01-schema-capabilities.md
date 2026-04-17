---
id: plan-01-schema-capabilities
name: Schema Widening + Backend Mappings + Model Capability Map
depends_on: []
branch: opus-4-7-support-planner-driven-per-plan-effort-thinking/schema-capabilities
---

# Schema Widening + Backend Mappings + Model Capability Map

## Architecture Context

This plan establishes the foundational type and data changes that all downstream plans depend on. It widens the effort enum to cover Opus 4.7's full range, fixes the Pi backend's effort/thinking mapping to reach pi-ai's complete `ThinkingLevel` set, and introduces a data-driven model-capability map that serves as the single seam for onboarding new models.

## Implementation

### Overview

Three changes:
1. Widen `effortLevelSchema` and `EffortLevel` type to add `'xhigh'` between `'high'` and `'max'`.
2. Rewrite Pi backend mapping functions to cover the full pi-ai `ThinkingLevel` range (`'minimal' | 'low' | 'medium' | 'high' | 'xhigh'`), including `'max' -> 'xhigh'` since pi-ai has no `'max'`.
3. Create `model-capabilities.ts` with a regex-keyed lookup table and `clampEffort()` function.

### Key Decisions

1. **`'xhigh'` inserted between `'high'` and `'max'`** - matches Claude Agent SDK 0.2.112's `EffortLevel` ordering. The enum becomes `['low', 'medium', 'high', 'xhigh', 'max']`.
2. **Pi `'max' -> 'xhigh'` mapping** - pi-ai 0.67.6 has no `'max'` level; its `'xhigh'` is adaptive-max for Opus 4.6+, which semantically matches eforge's `'max'`.
3. **Pi `thinkingLevel` schema widened to `['off', 'low', 'medium', 'high', 'xhigh']`** - enables profile YAMLs to specify the full pi-ai range directly. The `PiConfig` interface updated to match.
4. **`clampEffort` returns the highest supported level <= requested** - e.g., `'max'` on Sonnet clamps to `'xhigh'`; `'max'` on Haiku clamps to `'high'`. Returns a `{ value, clamped }` tuple so downstream can surface the clamp.
5. **Model capability map uses regex matching** - `match: /^claude-opus-4-[67]/` etc. - flexible enough to handle model ID variations without brittle equality checks. An unknown model ID returns `undefined` from `lookupCapabilities`, meaning no clamping is applied (passthrough).

## Scope

### In Scope
- Widening `effortLevelSchema` to `['low', 'medium', 'high', 'xhigh', 'max']` in `config.ts`
- Widening `EffortLevel` type to `'low' | 'medium' | 'high' | 'xhigh' | 'max'` in `backend.ts`
- Rewriting `mapThinkingConfig` and `mapEffortLevel` in `backends/pi.ts`
- Widening `piThinkingLevelSchema` to `['off', 'low', 'medium', 'high', 'xhigh']` in `config.ts`
- Widening `PiConfig.thinkingLevel` to `'off' | 'low' | 'medium' | 'high' | 'xhigh'` in `config.ts`
- Creating `packages/engine/src/model-capabilities.ts` with `ModelCapabilities` interface, `MODEL_CAPABILITIES` table, `lookupCapabilities()`, and `clampEffort()`
- Creating `test/model-capabilities.test.ts` with unit tests

### Out of Scope
- Changes to `resolveAgentConfig` (Plan 2)
- Event enrichment (Plan 2)
- Planner prompt changes (Plan 2)
- Monitor UI changes (Plan 3)

## Files

### Create
- `packages/engine/src/model-capabilities.ts` - Data-driven model capability map with `ModelCapabilities` interface, `MODEL_CAPABILITIES` lookup table (keyed by regex for model ID prefixes), `lookupCapabilities(modelId)` function, and `clampEffort(modelId, requested)` function returning `{ value, clamped }` tuple
- `test/model-capabilities.test.ts` - Unit tests for `lookupCapabilities` (Opus 4.6, Opus 4.7, Sonnet 4, Haiku 4, unknown model) and `clampEffort` (passthrough for supported values, clamp `'max'` to `'xhigh'` on Sonnet, clamp `'max'` to `'high'` on Haiku, passthrough on Opus 4.7, unknown model passes through without clamp, `undefined` input returns `undefined`)

### Modify
- `packages/engine/src/config.ts` (line 59) - Change `effortLevelSchema` from `z.enum(['low', 'medium', 'high', 'max'])` to `z.enum(['low', 'medium', 'high', 'xhigh', 'max'])`; (line 106) change `piThinkingLevelSchema` from `z.enum(['off', 'medium', 'high'])` to `z.enum(['off', 'low', 'medium', 'high', 'xhigh'])`; (line 252) change `PiConfig.thinkingLevel` type from `'off' | 'medium' | 'high'` to `'off' | 'low' | 'medium' | 'high' | 'xhigh'`
- `packages/engine/src/backend.ts` (line 18) - Change `EffortLevel` type from `'low' | 'medium' | 'high' | 'max'` to `'low' | 'medium' | 'high' | 'xhigh' | 'max'`
- `packages/engine/src/backends/pi.ts` (lines 56-79) - Rewrite `mapThinkingConfig`: `'disabled' -> 'off'`, `'adaptive' -> 'medium'`, `'enabled' -> 'high'` (unchanged). Rewrite `mapEffortLevel`: `'low' -> 'low'`, `'medium' -> 'medium'`, `'high' -> 'high'`, `'xhigh' -> 'xhigh'`, `'max' -> 'xhigh'`. Update JSDoc comments to reflect the new mappings.

## Verification

- [ ] `pnpm type-check` passes with no errors related to exhaustive switch statements on `EffortLevel`
- [ ] `test/model-capabilities.test.ts` passes: `clampEffort('claude-opus-4-7', 'max')` returns `{ value: 'max', clamped: false }`
- [ ] `test/model-capabilities.test.ts` passes: `clampEffort('claude-sonnet-4-5', 'max')` returns `{ value: 'xhigh', clamped: true }`
- [ ] `test/model-capabilities.test.ts` passes: `clampEffort('claude-haiku-4', 'max')` returns `{ value: 'high', clamped: true }`
- [ ] `test/model-capabilities.test.ts` passes: `clampEffort('unknown-model', 'max')` returns `{ value: 'max', clamped: false }` (passthrough for unknown models)
- [ ] `test/model-capabilities.test.ts` passes: `lookupCapabilities('claude-opus-4-7')` returns capabilities with `supportedEffort` containing `'max'`
- [ ] `test/model-capabilities.test.ts` passes: `lookupCapabilities('unknown-model')` returns `undefined`
- [ ] Existing tests in `test/pipeline.test.ts` continue to pass (effort `'high'` and `'low'` still valid values)
- [ ] `pnpm build` compiles with no errors