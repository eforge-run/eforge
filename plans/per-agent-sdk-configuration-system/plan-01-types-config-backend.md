---
id: plan-01-types-config-backend
name: SDK Passthrough Types, Config Schemas, and Backend Mapping
depends_on: []
branch: per-agent-sdk-configuration-system/types-config-backend
---

# SDK Passthrough Types, Config Schemas, and Backend Mapping

## Architecture Context

eforge's agent configuration pipeline flows: `eforge.yaml` -> Zod schema validation -> `resolveConfig()` -> `EforgeConfig` -> `resolveAgentConfig(role, config)` -> agent Options -> `backend.run(AgentRunOptions)` -> `ClaudeSDKBackend` -> SDK `query()`. Currently only `maxTurns` and `model` travel this pipeline. This plan wires up the full set of SDK passthrough fields (thinking, effort, budget, fallback model, tool filtering) through every layer from config to SDK.

All new fields are optional and default to `undefined`, so existing configs produce identical behavior - the SDK uses its own defaults when fields are absent.

## Implementation

### Overview

Add `SdkPassthroughConfig` shared type and `pickSdkOptions()` helper to `backend.ts`. Extend Zod schemas in `config.ts` for the new fields plus a `roles` map for per-agent overrides. Rewrite `resolveAgentConfig()` in `pipeline.ts` to return a full `ResolvedAgentConfig` implementing four-tier priority: user per-role > user global > built-in per-role > built-in global. Map all new fields through to SDK `query()` in `claude-sdk.ts`.

### Key Decisions

1. **All new fields optional with `undefined` default** - No built-in model/thinking/effort defaults for any role. This preserves current behavior for every user. The SDK decides when fields are absent.
2. **Four-tier priority chain** - `user per-role > user global > built-in per-role > built-in global`. This matches the existing `maxTurns` semantics where builder's built-in 50 isn't overridden by global 30, while letting users override anything explicitly.
3. **`SdkPassthroughConfig` as a shared interface** - Rather than duplicating SDK fields across 15+ agent Options interfaces (done in plan-02), define once in `backend.ts` and extend everywhere. `pickSdkOptions()` strips `undefined` keys to keep SDK calls clean.
4. **`roles` lives under `agents` in config** - Follows existing nesting pattern. `agents.roles.formatter.effort: low` reads naturally. Schema uses `z.record(agentRoleSchema, ...)` for validation.
5. **Rename `AGENT_MAX_TURNS_DEFAULTS` to `AGENT_ROLE_DEFAULTS`** - Same map, wider type (`Partial<ResolvedAgentConfig>` instead of `number`). Existing entries become `{ maxTurns: 50 }` etc.

## Scope

### In Scope
- `SdkPassthroughConfig` interface and `pickSdkOptions()` helper in `backend.ts`
- `ThinkingConfig` and `EffortLevel` type exports in `backend.ts`
- Extend `AgentRunOptions` with SDK passthrough fields
- Zod schemas for `thinkingConfig`, `effortLevel`, `sdkPassthroughConfig` in `config.ts`
- `roles` map in `agentProfileConfigSchema` / `EforgeConfig.agents`
- `resolveConfig()` and `mergePartialConfigs()` updates for `roles` deep-merge
- `ResolvedAgentConfig` type extending `SdkPassthroughConfig` with `maxTurns`
- Rename `AGENT_MAX_TURNS_DEFAULTS` to `AGENT_ROLE_DEFAULTS` with widened type
- Rewrite `resolveAgentConfig()` to return `ResolvedAgentConfig`
- Map new `AgentRunOptions` fields to SDK `query()` in `claude-sdk.ts`
- Tests for priority chain, schema validation, merge logic

### Out of Scope
- Updating agent Options interfaces to extend `SdkPassthroughConfig` (plan-02)
- Updating pipeline call sites to spread resolved config (plan-02)
- Updating `backend.run()` calls in agent files (plan-02)

## Files

### Modify
- `src/engine/backend.ts` - Add `ThinkingConfig`, `EffortLevel` types. Add `SdkPassthroughConfig` interface. Add `pickSdkOptions()` helper. Extend `AgentRunOptions` with all SDK passthrough fields.
- `src/engine/config.ts` - Add `thinkingConfigSchema`, `effortLevelSchema`, `sdkPassthroughConfigSchema` Zod schemas. Add `roles` to `agentProfileConfigSchema` (record of agent role to partial profile). Extend `EforgeConfig.agents` with global SDK fields (`model`, `thinking`, `effort`) and `roles` map. Update `mergePartialConfigs()` to deep-merge `roles` (per-role shallow merge). Update `resolveConfig()` to pass through new fields. Export `ResolvedAgentConfig`.
- `src/engine/pipeline.ts` - Rename `AGENT_MAX_TURNS_DEFAULTS` to `AGENT_ROLE_DEFAULTS` with type `Partial<Record<AgentRole, Partial<ResolvedAgentConfig>>>`. Rewrite `resolveAgentConfig()` to return `ResolvedAgentConfig` implementing four-tier priority for all fields.
- `src/engine/backends/claude-sdk.ts` - Map `thinking`, `effort`, `maxBudgetUsd`, `fallbackModel`, `allowedTools`, `disallowedTools` from `AgentRunOptions` to SDK `query()` options object.
- `test/pipeline.test.ts` - Update existing `resolveAgentConfig` tests to work with `ResolvedAgentConfig` return type. Add tests for: four-tier priority chain with new fields, `undefined` passthrough for unset fields, role-specific override precedence.
- `test/planner-continuation.test.ts` - Update `resolveAgentConfig` assertions to match new return type (existing tests check `.maxTurns` which still works).
- `test/config.test.ts` - Add tests for: `thinkingConfigSchema` variants (disabled/enabled/adaptive with budgetTokens), `effortLevelSchema` (low/medium/high/max), `roles` schema validation (valid roles accepted, invalid roles rejected), `mergePartialConfigs` with `roles` deep-merge, `resolveConfig` with global SDK fields and roles.

## Verification

- [ ] `pnpm type-check` passes with zero errors
- [ ] `pnpm test` passes - all existing tests continue to pass
- [ ] `resolveAgentConfig('builder', DEFAULT_CONFIG)` returns `{ maxTurns: 50 }` with all other fields `undefined` (backward compatible)
- [ ] `resolveAgentConfig('reviewer', configWithGlobalEffort)` returns the global effort value when no role override exists
- [ ] `resolveAgentConfig('formatter', configWithRoleOverride)` returns the role-specific value over global
- [ ] `resolveAgentConfig('builder', configWithGlobalMaxTurns20)` returns `maxTurns: 50` (built-in role default beats user global) unless user sets `roles.builder.maxTurns` explicitly
- [ ] `pickSdkOptions({ model: 'x', thinking: undefined, effort: 'low' })` returns `{ model: 'x', effort: 'low' }` (no `thinking` key)
- [ ] Zod schema rejects `thinking: { type: 'invalid' }` and `effort: 'extreme'`
- [ ] Zod schema rejects `roles: { 'not-a-role': { ... } }`
- [ ] `mergePartialConfigs` with both global and project `roles` produces per-role shallow merge (project role fields override global, global-only fields survive)
- [ ] `eforge config show` displays `roles` section when configured in `eforge.yaml`
- [ ] SDK backend maps `thinking: { type: 'enabled', budgetTokens: 5000 }` to the corresponding SDK query option
