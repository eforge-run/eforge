---
id: plan-01-engine-extension-foundation
name: Engine Extension Config, Discovery, and Loader
branch: add-extension-discovery-config-and-loader/plan-01-engine-extension-foundation
agents:
  builder:
    effort: high
    rationale: Introduces a new trusted-code loading path, config schema fields,
      cross-scope precedence, runtime TypeScript import support, and registry
      capture in the engine.
  reviewer:
    effort: high
    rationale: The loader executes extension modules and needs careful review for
      trust gating, path handling, and non-catastrophic failure behavior.
---

# Engine Extension Config, Discovery, and Loader

## Architecture Context

Native eforge extensions are engine lifecycle modules, not Claude Code plugins and not Pi harness extensions. The engine already owns layered config loading in `packages/engine/src/config.ts`, scope directory lookup lives in `@eforge-build/scopes`, and the SDK contract lives in `@eforge-build/extension-sdk`. This plan adds the engine foundation: top-level `extensions` config, deterministic scoped discovery, JS/TS loading, registration capture, and non-fatal diagnostics.

Runtime execution semantics for registered hooks remain out of scope in this plan set. The registry must capture registrations and expose provenance for later runtimes.

## Implementation

### Overview

Add a native extension config section and a new `packages/engine/src/extensions/` module family that discovers extension modules across user, project-team, and project-local scopes; applies config filters and trust gating; imports JS/TS modules; invokes default factories with a recording API; and returns a registry with statuses, diagnostics, shadows, and registration summaries. Wire this registry into `EforgeEngine.create()` without letting one bad extension abort engine creation.

### Key Decisions

1. Use a top-level `extensions` config block distinct from `plugins` and `agents.tiers.*.pi.extensions`.
2. Use `getScopeDirectory()` from `@eforge-build/scopes` for canonical roots and precedence; implement extension-specific scanning because extension discovery must support multiple file extensions and directory entrypoints.
3. Support `.js`/`.mjs` through dynamic `import()` and `.ts`/`.mts` through a small runtime loader dependency such as `jiti`.
4. Keep project/team auto-discovered extensions untrusted by default via `trustProjectExtensions: false`; user, project-local, and explicit paths are treated as operator-controlled when `extensions.enabled` is true.
5. When `extensions.enabled` is false, report discovered and explicit entries as `disabled` and skip all imports.
6. Capture registrations through a recording `EforgeExtensionAPI`; do not dispatch event hooks, agent hooks, policy gates, profile routers, input sources, reviewer perspectives, validation providers, or tools in this slice.

## Scope

### In Scope

- Top-level native extension config schema/default/merge support.
- Runtime dependency setup for TypeScript source loading.
- Scoped discovery for user, project-team, and project-local `extensions/` directories.
- Supported layouts: single `*.ts`, `*.mts`, `*.js`, `*.mjs` files and directories with `package.json` entrypoints or `index.{ts,mts,js,mjs}`.
- Include/exclude filtering for auto-discovered names and unfiltered explicit `paths` handling.
- `extensions.enabled: false` disabled status handling for auto-discovered entries and explicit paths without imports.
- Deterministic shadow metadata for same-name auto-discovered entries.
- Duplicate explicit-name diagnostics.
- Trust skip diagnostics for untrusted project/team auto entries.
- Loader diagnostics for unsupported formats, missing entrypoints, import errors, invalid default exports, factory errors, and invalid registrations.
- Recording API validation and registry summary counts, including a direct SDK `registerTool(tool)` method if no direct tool-registration method exists.
- `EforgeEngine` storage/exposure of the loaded registry.
- Unit tests for config, discovery, trust, loading, and capture.

### Out of Scope

- Hook dispatch or mutation semantics.
- Hash-based trust prompts/stores.
- Extension scaffold/promote/demote/reload commands.
- Registry package installation.
- Pi harness extension discovery changes.

## Files

### Create

- `packages/engine/src/extensions/types.ts` — Native extension diagnostics, discovery entries, statuses, registration records, and registry types.
- `packages/engine/src/extensions/discovery.ts` — Scope scanning, supported layout resolution, include/exclude filtering, shadow handling, explicit path handling, duplicate detection, and trust status assignment.
- `packages/engine/src/extensions/recorder.ts` — Recording `EforgeExtensionAPI` implementation with registration validation and duplicate-name diagnostics.
- `packages/engine/src/extensions/loader.ts` — JS/TS import strategy, default export validation, factory invocation, and registry assembly.
- `packages/engine/src/extensions/index.ts` — Public engine exports for discovery/loading helpers and types.
- `test/native-extension-loader.test.ts` — Temp-directory tests for discovery precedence, filters, explicit paths, trust, TS/JS imports, invalid exports, diagnostics, and registration summaries.

### Modify

- `packages/engine/src/config.ts` — Add `extensionConfigSchema`, `ExtensionConfig`, `EforgeConfig.extensions`, `DEFAULT_CONFIG.extensions`, `resolveConfig()` support, `mergePartialConfigs()` support, and `configYamlSchema` recognition.
- `packages/engine/src/eforge.ts` — Merge extension overrides, load native extensions during `EforgeEngine.create()`, expose a read-only registry getter, and keep load failures in registry diagnostics instead of throwing.
- `packages/extension-sdk/src/api.ts` — Add direct tool registration to `EforgeExtensionAPI` only if required to capture tool registrations during factory invocation.
- `packages/extension-sdk/src/index.ts` — Re-export any added tool-registration type surface.
- `test/config.test.ts` — Add schema/default/merge tests for the `extensions` section.
- `test/extension-sdk-example.test.ts` — Add SDK surface assertions if `registerTool` is added to `EforgeExtensionAPI`.
- `packages/engine/package.json` — Add `@eforge-build/extension-sdk` and the chosen TS loader dependency.
- `pnpm-lock.yaml` — Record dependency graph updates.
- `packages/engine/tsup.config.ts` — Externalize or bundle the chosen TS loader in a way that works from the published engine package.

## Verification

- [ ] `resolveConfig({}, {})` returns `extensions.enabled === true` and `extensions.trustProjectExtensions === false`.
- [ ] `mergePartialConfigs()` shallow-merges `extensions.enabled` and `extensions.trustProjectExtensions`, while higher-precedence `include`, `exclude`, and `paths` arrays replace lower-precedence arrays.
- [ ] When `extensions.enabled` is false, auto-discovered entries and explicit paths are reported with status `disabled` and no module import is attempted.
- [ ] Discovery returns project-local as the winner over project-team and user for the same extension name, with lower tiers listed in `shadows` including paths.
- [ ] Include filtering removes non-included auto entries from loading and marks them `excluded` in list data; explicit paths remain present.
- [ ] Exclude filtering marks matching auto entries `excluded`; explicit paths remain present.
- [ ] A project-team auto entry is marked `untrusted` and is not imported when `trustProjectExtensions` is false.
- [ ] Duplicate explicit paths resolving to the same extension name produce an error diagnostic instead of shadow metadata.
- [ ] Unsupported file formats in auto-discovered entries or explicit paths produce path-specific diagnostics and no import attempt.
- [ ] `.js`, `.mjs`, `.ts`, and `.mts` extension modules load in tests and record the loader strategy used.
- [ ] Invalid default exports and thrown factory errors produce entry diagnostics with `severity: "error"` and do not throw from the registry-loading helper.
- [ ] Invalid registration inputs such as missing handlers, unsupported event patterns, or duplicate contributed names produce path-specific error diagnostics.
- [ ] A factory using every registration method returns registration summary counts greater than zero for each registered capability category.
- [ ] `EforgeEngine.create()` exposes an extension registry getter and completes when one extension has load diagnostics.