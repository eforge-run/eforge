---
id: plan-01-extension-config-threading
name: Fix Pi Extension Config Threading
dependsOn: []
branch: fix-pi-extension-config-threading/extension-config-threading
---

# Fix Pi Extension Config Threading

## Architecture Context

`PiConfig.extensions` in `config.ts` already defines `include`/`exclude` fields, and `PiBackendOptions` in `pi.ts` already accepts `PiExtensionConfig`. The gap is two-fold: (1) the `PiExtensionConfig` interface lacks `include`/`exclude` fields, so the type system can't carry them, and (2) `eforge.ts` omits `extensions` when constructing `PiBackend`, so config never reaches the backend.

## Implementation

### Overview

Add `include`/`exclude` to `PiExtensionConfig`, implement filtering logic in `discoverPiExtensions()`, thread the config in `eforge.ts`, and add comprehensive unit tests.

### Key Decisions

1. **Filter only auto-discovered extensions, not explicit paths.** Explicit `paths` are intentionally specified by the user and must not be filtered. Include/exclude applies only to auto-discovered directories.
2. **Include first, then exclude.** When both are set, include acts as a whitelist first, then exclude removes from the whitelist. This matches standard filter chain conventions.
3. **Filter by directory basename.** Extensions are directories; matching uses `path.basename()` against the include/exclude lists for simple, predictable behavior.
4. **Collect auto-discovered paths separately.** Refactor `discoverPiExtensions()` to accumulate auto-discovered paths in a separate array, apply filters, then combine with explicit paths. This keeps the filtering isolated.

## Scope

### In Scope
- Adding `include?: string[]` and `exclude?: string[]` to `PiExtensionConfig` interface
- Implementing include/exclude filtering in `discoverPiExtensions()` on auto-discovered extensions only
- Threading `extensions` config from `eforge.ts` to `PiBackend` constructor
- Unit tests for all discovery and filtering scenarios

### Out of Scope
- Changes to `config.ts` (PiConfig already has include/exclude)
- Changes to `pi.ts` (PiBackendOptions already accepts PiExtensionConfig)
- Testing `~/.pi/extensions/` global path (same `collectExtensionDirs` logic, reads real home dir)

## Files

### Create
- `test/pi-extension-discovery.test.ts` - Unit tests for `discoverPiExtensions()` covering auto-discovery, explicit paths, include/exclude filtering, and combinations

### Modify
- `src/engine/backends/pi-extensions.ts` - Add `include?: string[]` and `exclude?: string[]` to `PiExtensionConfig`; refactor `discoverPiExtensions()` to collect auto-discovered paths separately and apply include then exclude filtering by basename before combining with explicit paths
- `src/engine/eforge.ts` - Pass `extensions` (with `autoDiscover`, `include`, `exclude`) from `config.pi.extensions` to the `PiBackend` constructor at line 185

## Verification

- [ ] `pnpm test test/pi-extension-discovery.test.ts` runs 9 tests and all pass
- [ ] `pnpm type-check` exits with code 0
- [ ] `pnpm build` exits with code 0
- [ ] `PiExtensionConfig` interface has `include?: string[]` and `exclude?: string[]` fields
- [ ] `discoverPiExtensions()` filters auto-discovered extensions by basename when `include` is set (keeps only matching)
- [ ] `discoverPiExtensions()` filters auto-discovered extensions by basename when `exclude` is set (removes matching)
- [ ] When both `include` and `exclude` are set, include whitelist is applied first, then exclude blacklist
- [ ] Explicit `paths` entries are never filtered by include/exclude
- [ ] `eforge.ts` passes `extensions: { autoDiscover, include, exclude }` from `config.pi.extensions` to `PiBackend` constructor
