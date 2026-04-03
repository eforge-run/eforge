---
id: plan-01-engine
name: Right-size model classes and add fallback chain in engine
dependsOn: []
branch: right-size-default-model-classes-per-agent-role-with-graceful-fallback/engine
---

# Right-size model classes and add fallback chain in engine

## Architecture Context

The engine's model class system (`config.ts`, `pipeline.ts`) defines how agent roles map to model tiers and how models are resolved at runtime. Currently all 23 roles default to `max`, the `auto` class exists but conflicts with the `ModelRef` type system, and there is no fallback when a role's effective class has no configured model. This plan modifies the core engine to remove `auto`, right-size three roles to `balanced`, and add ascending-then-descending fallback logic to `resolveAgentConfig()`.

## Implementation

### Overview

Three changes to the engine, plus corresponding test updates:

1. **Remove `auto` from `MODEL_CLASSES`** in `config.ts` - delete from the `MODEL_CLASSES` array so the `ModelClass` type becomes `'max' | 'balanced' | 'fast'`. The Zod `modelClassSchema` automatically narrows since it derives from `MODEL_CLASSES`.

2. **Right-size `AGENT_MODEL_CLASSES` and clean `MODEL_CLASS_DEFAULTS`** in `pipeline.ts` - change `staleness-assessor`, `prd-validator`, and `dependency-detector` from `'max'` to `'balanced'`. Remove the `auto` key from both backend entries in `MODEL_CLASS_DEFAULTS`.

3. **Add fallback chain to `resolveAgentConfig()`** in `pipeline.ts` - after the current tier-4 resolution (user class override then backend class default), if model is still undefined, walk the tier list ascending from the effective class position, then descending. At each tier check user class overrides and backend defaults. Emit `fallbackFrom` metadata in the returned config when fallback triggers. Update error messages to list attempted fallback tiers.

4. **Update `claude-sdk.ts`** - change `options.model?.id ?? 'auto'` to `options.model?.id ?? 'default'` in the `agent:start` event. Propagate `fallbackFrom` from resolved config to the `agent:start` event metadata.

5. **Update tests** - adjust role default assertions for the three re-classed roles, remove auto-related tests, add fallback chain test cases.

### Key Decisions

1. **Ascending-first fallback** - walking up toward `max` first is safer because a more capable model is less likely to produce degraded output. Descending is the "something is better than nothing" path.
2. **Static tier list** - `const MODEL_CLASS_TIER: ModelClass[] = ['max', 'balanced', 'fast']` defined once in `pipeline.ts`. The fallback algorithm indexes into this array.
3. **`fallbackFrom` metadata** - added as an optional field on `ResolvedAgentConfig` so it flows naturally through the existing config plumbing without changing event types.
4. **Conservative re-classing** - only 3 roles move to `balanced` (staleness-assessor, prd-validator, dependency-detector). All others remain at `max`.

## Scope

### In Scope
- Remove `'auto'` from `MODEL_CLASSES` array and derived types/schemas in `config.ts`
- Change 3 roles from `'max'` to `'balanced'` in `AGENT_MODEL_CLASSES`
- Remove `auto` keys from `MODEL_CLASS_DEFAULTS`
- Add `MODEL_CLASS_TIER` constant and fallback chain logic in `resolveAgentConfig()`
- Add optional `fallbackFrom` field to `ResolvedAgentConfig`
- Update `claude-sdk.ts` `agent:start` event model fallback string from `'auto'` to `'default'`
- Add `fallbackFrom` to `AgentRunOptions` in `backend.ts` and `agent:start` event type in `events.ts`
- Propagate `fallbackFrom` in `agent:start` event metadata in both `claude-sdk.ts` and `pi.ts`
- Update all tests in `pipeline.test.ts` and `config.test.ts`

### Out of Scope
- Changing the 5-tier resolution priority order
- Changing agent behavior, prompts, or pipeline structure
- Documentation updates (plan-02)
- Plugin/Pi package updates (plan-02)

## Files

### Modify
- `src/engine/config.ts` - Remove `'auto'` from `MODEL_CLASSES` array (line 26). Add optional `fallbackFrom?: ModelClass` field to `ResolvedAgentConfig` interface (around line 230).
- `src/engine/events.ts` - Add optional `fallbackFrom?: string` field to the `agent:start` event type (line 227) so fallback metadata is observable in the monitor.
- `src/engine/backend.ts` - Add optional `fallbackFrom?: ModelClass` field to `AgentRunOptions` (around line 52) so resolved fallback info flows from pipeline to backends.
- `src/engine/pipeline.ts` - Change 3 roles to `'balanced'` in `AGENT_MODEL_CLASSES` (lines 449-451). Remove `auto` keys from both `MODEL_CLASS_DEFAULTS` entries (lines 458-471). Add `MODEL_CLASS_TIER` constant. Add fallback chain logic to `resolveAgentConfig()` after the existing tier-4 check (around line 548). Update error message to list attempted fallback tiers.
- `src/engine/backends/claude-sdk.ts` - Line 46: change `options.model?.id ?? 'auto'` to `options.model?.id ?? 'default'`. Add `fallbackFrom` to `agent:start` event if present in options.
- `src/engine/backends/pi.ts` - Propagate `fallbackFrom` from options to `agent:start` events (lines 244, 250, 257).
- `test/pipeline.test.ts` - Update the "all roles default to max" test to expect 3 roles at `balanced`. Remove the "auto class on claude-sdk returns undefined model" test. Remove the "auto class on pi backend throws" test. Add tests: fallback ascending success (`balanced` -> `max`), fallback descending success (`max` -> `balanced`), fallback total failure error with attempted tiers listed, `fallbackFrom` metadata populated on fallback.
- `test/config.test.ts` - Remove the "accepts auto" test for `modelClassSchema` (lines 916-918). Add a test that `modelClassSchema` rejects `'auto'` as invalid.

## Verification

- [ ] `pnpm type-check` passes with zero errors - no dead code or type mismatches from `auto` removal
- [ ] `MODEL_CLASSES` contains exactly `['max', 'balanced', 'fast']` - verified by reading `config.ts`
- [ ] `AGENT_MODEL_CLASSES` maps `staleness-assessor`, `prd-validator`, `dependency-detector` to `'balanced'` and all other 20 roles to `'max'`
- [ ] `modelClassSchema.safeParse('auto').success` returns `false` (new test asserts this)
- [ ] `resolveAgentConfig('staleness-assessor', DEFAULT_CONFIG, 'pi')` with only `agents.models.max` configured resolves to the `max` model (fallback ascending from `balanced`)
- [ ] `resolveAgentConfig('builder', DEFAULT_CONFIG, 'pi')` with only `agents.models.balanced` configured resolves to the `balanced` model (fallback descending from `max`)
- [ ] `resolveAgentConfig('builder', DEFAULT_CONFIG, 'pi')` with no models configured throws an error containing `tried fallback: balanced, fast`
- [ ] Fallback populates `fallbackFrom` in the returned `ResolvedAgentConfig` (e.g., `fallbackFrom: 'balanced'` when role wanted `balanced` but got `max`)
- [ ] `claude-sdk.ts` emits `model: 'default'` (not `'auto'`) in `agent:start` when no model is configured
- [ ] `pnpm test` passes with all existing tests updated and new fallback tests green
