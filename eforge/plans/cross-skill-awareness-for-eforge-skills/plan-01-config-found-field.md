---
id: plan-01-config-found-field
name: Add configFound field to engine and client types
depends_on: []
branch: cross-skill-awareness-for-eforge-skills/config-found-field
---

# Add configFound field to engine and client types

## Architecture Context

The validate config API currently returns `{ valid: true, errors: [] }` both when config exists and validates successfully AND when no config file exists at all. Skills cannot distinguish these cases, so they cannot suggest `/eforge:init` when the user hasn't initialized eforge. This plan adds a `configFound` boolean to the response and updates build/status skills to use it.

## Implementation

### Overview

Add `configFound: boolean` to `validateConfigFile` return type and `ConfigValidateResponse`, then update build and status skill files to check this field and suggest `/eforge:init` when no config exists. Also add Related Skills tables to these 4 skill files since they're already being modified.

### Key Decisions

1. `configFound` is a non-optional boolean (always present) - avoids ambiguity with undefined vs false.
2. The daemon HTTP layer (`packages/monitor/src/server.ts`) already passes `validateConfigFile` results directly to the client via `sendJson(res, result)`, so adding the field to the engine function automatically flows through the HTTP API with no server.ts changes needed.

## Scope

### In Scope
- Adding `configFound: boolean` to `ConfigValidateResponse` in `packages/client/src/types.ts`
- Updating `validateConfigFile` in `packages/engine/src/config.ts` to return `configFound`
- Updating build skill Step 5 in both `eforge-plugin/skills/build/build.md` and `packages/pi-eforge/skills/eforge-build/SKILL.md` to check `configFound` and suggest `/eforge:init`
- Updating status skills in both `eforge-plugin/skills/status/status.md` and `packages/pi-eforge/skills/eforge-status/SKILL.md` with "No config found" error handling
- Adding Related Skills tables to the 4 skill files modified in this plan (build x2, status x2)

### Out of Scope
- Related Skills tables for the remaining 9 skill files (plan-02)
- Plugin version bump (plan-02)

## Files

### Modify
- `packages/client/src/types.ts` - Add `configFound: boolean` to `ConfigValidateResponse` interface
- `packages/engine/src/config.ts` - Update `validateConfigFile` return type and populate `configFound` in all return paths (false when no config file found, true otherwise)
- `eforge-plugin/skills/build/build.md` - Add `configFound` check in Step 5 that suggests `/eforge:init` when false; add Related Skills table; add "No config found" error handling row
- `packages/pi-eforge/skills/eforge-build/SKILL.md` - Add `configFound` check in Step 5 that suggests `/eforge:init` when false; add Related Skills table; add "No config found" error handling row
- `eforge-plugin/skills/status/status.md` - Add "No config found" error handling guidance; add Related Skills table
- `packages/pi-eforge/skills/eforge-status/SKILL.md` - Add "No config found" error handling guidance; add Related Skills table

## Verification

- [ ] `ConfigValidateResponse` in `packages/client/src/types.ts` contains `configFound: boolean` (non-optional)
- [ ] `validateConfigFile` in `packages/engine/src/config.ts` returns `configFound: false` when `findConfigFile()` returns null/undefined, and `configFound: true` in all other return paths
- [ ] `validateConfigFile` return type annotation includes `configFound: boolean`
- [ ] `eforge-plugin/skills/build/build.md` Step 5 contains a conditional check on `configFound` that tells the user to run `/eforge:init`
- [ ] `packages/pi-eforge/skills/eforge-build/SKILL.md` Step 5 contains a conditional check on `configFound` that tells the user to run `/eforge:init`
- [ ] All 4 modified skill files contain a Related Skills table with at least init, build, config, status entries
- [ ] Build and status skills contain a "No config found" error handling row or section
- [ ] `pnpm type-check` passes