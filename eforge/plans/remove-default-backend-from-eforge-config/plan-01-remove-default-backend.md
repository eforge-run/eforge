---
id: plan-01-remove-default-backend
name: Remove Default Backend from Config
depends_on: []
branch: remove-default-backend-from-eforge-config/remove-default-backend
---

# Remove Default Backend from Config

## Architecture Context

The eforge config system currently defaults `backend` to `'claude-sdk'`, silently selecting a backend for users. This change makes `backend` a required, explicit configuration choice - aligning with the broader pattern of removing opinionated defaults (already done for Pi's default model/provider). The `EforgeConfig` interface, `DEFAULT_CONFIG`, `resolveConfig`, engine initialization, and `resolveAgentConfig` all need coordinated updates.

## Implementation

### Overview

Make `backend` optional in the type system, remove it from `DEFAULT_CONFIG`, stop falling back to it in `resolveConfig`, add early validation in `EforgeEngine` that throws a clear error when no backend is configured, update `resolveAgentConfig` to handle undefined backend by skipping model class default lookup, update the config skill documentation to describe backend as required, and bump the plugin version.

### Key Decisions

1. `backend` becomes optional in `EforgeConfig` (`backend?: 'claude-sdk' | 'pi'`) rather than being removed entirely - callers that pass it explicitly continue to work unchanged.
2. Validation happens early in `EforgeEngine` (before backend instantiation) with a clear error message directing users to `eforge/config.yaml` or `/eforge:config`.
3. `resolveAgentConfig` skips `MODEL_CLASS_DEFAULTS` lookup when backend is undefined AND also skips the validation throw at line 367 when backend is undefined. The existing `backend !== 'claude-sdk'` check does NOT cover `undefined` (since `undefined !== 'claude-sdk'` is `true`), so the guard at line 367 must be updated to `backend !== 'claude-sdk' && backend !== undefined`. This avoids breaking callers before the engine validation catches the missing backend.

## Scope

### In Scope
- Making `backend` optional in `EforgeConfig` interface
- Removing `backend: 'claude-sdk'` from `DEFAULT_CONFIG`
- Removing fallback to `DEFAULT_CONFIG.backend` in `resolveConfig`
- Adding early validation in `EforgeEngine` for missing backend
- Handling undefined backend in `resolveAgentConfig` model class default lookup
- Updating config skill documentation to mark backend as required
- Bumping plugin version from `0.5.11` to `0.5.12`

### Out of Scope
- Changes to other default values
- Changes to the `/eforge:config` interactive flow logic
- Pi config default changes (already handled separately)

## Files

### Modify
- `src/engine/config.ts` - Make `backend` optional in `EforgeConfig` interface (line 316), remove `backend: 'claude-sdk' as const` from `DEFAULT_CONFIG` (line 386), change `resolveConfig` to use `backend: fileConfig.backend` instead of `fileConfig.backend ?? DEFAULT_CONFIG.backend` (line 459)
- `src/engine/eforge.ts` - Add early validation before Pi backend check (~line 171): throw if `!options.backend && !config.backend` with message directing to config setup
- `src/engine/pipeline.ts` - Change `resolveAgentConfig` parameter from `backend: 'claude-sdk' | 'pi' = 'claude-sdk'` to `backend?: 'claude-sdk' | 'pi'` (line 312). Guard `MODEL_CLASS_DEFAULTS[backend]` lookup (line 358) to skip when backend is undefined. Also update the validation throw at line 367 from `backend !== 'claude-sdk'` to `backend !== 'claude-sdk' && backend !== undefined` so that undefined backend (pre-engine-validation) doesn't throw here
- `eforge-plugin/skills/config/config.md` - Update backend selection description (line 42) to remove "(default, uses Claude Code's built-in SDK)" and mark as required. Update Pi backend section (line 53) to remove stale `model`/`provider/model` references
- `eforge-plugin/.claude-plugin/plugin.json` - Bump version from `0.5.11` to `0.5.12`

## Verification

- [ ] `pnpm type-check` passes with zero errors
- [ ] `pnpm test` passes with zero failures
- [ ] `EforgeConfig.backend` is typed as `backend?: 'claude-sdk' | 'pi'` (optional)
- [ ] `DEFAULT_CONFIG` object does not contain a `backend` property
- [ ] `resolveConfig` does not fall back to `DEFAULT_CONFIG.backend`
- [ ] `EforgeEngine` throws `Error` with message containing "No backend configured" when `options.backend` and `config.backend` are both falsy
- [ ] `resolveAgentConfig` accepts `backend?: 'claude-sdk' | 'pi'` (optional parameter), skips `MODEL_CLASS_DEFAULTS` lookup when backend is undefined, and skips the "no model configured" throw when backend is undefined
- [ ] Config skill line about backend selection says "required" and does not say "default"
- [ ] Plugin version in `eforge-plugin/.claude-plugin/plugin.json` is `0.5.12`
