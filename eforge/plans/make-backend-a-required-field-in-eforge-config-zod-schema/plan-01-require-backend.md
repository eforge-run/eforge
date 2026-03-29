---
id: plan-01-require-backend
name: Make backend required in eforge config Zod schema
depends_on: []
branch: make-backend-a-required-field-in-eforge-config-zod-schema/require-backend
---

# Make backend required in eforge config Zod schema

## Architecture Context

The `eforgeConfigSchema` Zod schema in `src/engine/config.ts` has `backend` as optional, but the engine requires it at runtime (`eforge.ts:172`). This inconsistency means `eforge config validate` passes for configs missing `backend`, only to fail later at build time with a confusing runtime error.

The `PartialEforgeConfig` type is derived from the schema via `z.output<typeof eforgeConfigSchema>`. Making `backend` required in the schema would make it required in `PartialEforgeConfig` too, breaking the merge/parse functions that construct partial configs without backend. The fix is to derive `PartialEforgeConfig` from a `.partial()` version of the schema, which re-optionalizes the `backend` field for merging while keeping the strict schema for validation.

## Implementation

### Overview

Change `backend` from optional to required in `eforgeConfigSchema`, introduce a partial schema for `PartialEforgeConfig` derivation, and update tests that expect empty configs to pass schema validation.

### Key Decisions

1. Use Zod's `.partial()` to derive `PartialEforgeConfig` - this keeps backend optional for config merging (global + project layers) while the strict schema catches missing backend during `validateConfigFile`. `.partial()` on a Zod object wraps each top-level field in `.optional()`; fields already optional are unaffected.
2. Keep `EforgeConfig.backend` optional and the runtime check at `eforge.ts:172` - the `EforgeConfig` interface and `resolveConfig` represent the resolved state which legitimately might lack backend (e.g., `eforge config show` works without it). The validation gate is `validateConfigFile` / `eforge config validate`, not the type system.
3. Keep `DEFAULT_CONFIG` without a `backend` field - there is no sensible default backend, and forcing one would silently mask missing config.

## Scope

### In Scope
- Make `backend` required in `eforgeConfigSchema`
- Derive `PartialEforgeConfig` from a partial version of the schema
- Update test expectations in `test/config.test.ts`
- Update skill docs in `eforge-plugin/skills/config/config.md`

### Out of Scope
- Changing `EforgeConfig` interface (backend stays optional there)
- Changing backend loading/initialization logic
- Changing `resolveConfig` or `DEFAULT_CONFIG`

## Files

### Modify
- `src/engine/config.ts` - Change `backend: backendSchema.optional()` to `backend: backendSchema` in `eforgeConfigSchema`. Add `const partialEforgeConfigSchema = eforgeConfigSchema.partial();` and change `PartialEforgeConfig` to `z.output<typeof partialEforgeConfigSchema>`. In `parseRawConfig`, use `partialEforgeConfigSchema.safeParse(data)` instead of `eforgeConfigSchema.safeParse(data)`. In `parseRawConfigFallback`, no change needed (it constructs objects manually). In `validateConfigFile`, the existing `eforgeConfigSchema.safeParse(data)` call now catches missing backend automatically.
- `test/config.test.ts` - Update `eforgeConfigSchema backend and pi validation` test: change "accepts empty config and does not require backend" to expect failure when backend is missing. Add a test that `eforgeConfigSchema` rejects `{}` with a backend-required error. Existing tests that pass `{ backend: 'claude-sdk' }` or `{ backend: 'pi' }` remain unchanged.
- `eforge-plugin/skills/config/config.md` - In the reference config template (around line 109), add a comment marking backend as required: `backend: claude-sdk  # REQUIRED - 'claude-sdk' or 'pi'`. Confirm the "Backend selection (required)" note on line 42 already marks it as required (it does - no change needed there).

## Verification

- [ ] `eforgeConfigSchema.safeParse({})` returns `success: false` with an error mentioning `backend`
- [ ] `eforgeConfigSchema.safeParse({ backend: 'claude-sdk' })` returns `success: true`
- [ ] `eforgeConfigSchema.safeParse({ backend: 'pi' })` returns `success: true`
- [ ] `PartialEforgeConfig` type still allows `backend` to be absent (merge functions compile)
- [ ] `parseRawConfig({})` returns an empty `PartialEforgeConfig` without throwing
- [ ] `pnpm type-check` passes with zero errors
- [ ] `pnpm test` passes with zero failures
