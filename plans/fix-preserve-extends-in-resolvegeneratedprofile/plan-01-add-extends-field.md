---
id: plan-01-add-extends-field
name: Add extends field to resolveGeneratedProfile return
dependsOn: []
branch: fix-preserve-extends-in-resolvegeneratedprofile/add-extends-field
---

# Add extends field to resolveGeneratedProfile return

## Architecture Context

Commit `e243220` added `extends` as an optional field on `ResolvedProfileConfig` and wired it through `resolveProfileExtensions()` (user-defined profiles in `eforge.yaml`) and the monitor UI. The `resolveGeneratedProfile()` code path - used when the planner dynamically generates a custom profile during compile - consumes the `extends` value to look up the base profile but drops it from the returned object. This means the monitor dashboard shows custom profile names without their base relationship.

## Implementation

### Overview

Add `extends: baseName` to the return object in the extends-mode branch of `resolveGeneratedProfile()` in `src/engine/config.ts`.

### Key Decisions

1. Use `baseName` (the already-resolved variable on line 701) as the value - it defaults to `'excursion'` when `generated.extends` is absent, matching the existing base-lookup logic.

## Scope

### In Scope
- Adding `extends: baseName` to the return value in `resolveGeneratedProfile()`

### Out of Scope
- Schema changes to `ResolvedProfileConfig` (already done in `e243220`)
- Monitor UI changes (already done in `e243220`)
- `resolveProfileExtensions()` changes (already done in `e243220`)

## Files

### Modify
- `src/engine/config.ts` — Add `extends: baseName` to the return object at line 708-714

## Verification

- [ ] `pnpm type-check` exits with code 0
- [ ] `pnpm test` exits with code 0
- [ ] `resolveGeneratedProfile()` return value includes `extends` matching the base profile name when the generated profile uses extends mode
