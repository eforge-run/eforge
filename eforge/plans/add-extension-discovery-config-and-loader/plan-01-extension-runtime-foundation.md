---
id: plan-01-extension-runtime-foundation
name: Extension Runtime Foundation
branch: add-extension-discovery-config-and-loader/plan-01-extension-runtime-foundation
agents:
  builder:
    effort: high
    rationale: New engine runtime foundation with trust, dynamic loading, and
      registry validation across config and SDK boundaries.
  reviewer:
    effort: high
    rationale: Extension loading executes user code in-process and needs careful
      security and API review.
  tester:
    effort: high
    rationale: Discovery, trust, path collision, and TS/JS loading cases need broad
      filesystem-backed coverage.
---

# Extension Runtime Foundation

## Architecture Context

Native eforge extensions are engine-level lifecycle modules, not Claude Code plugins, Pi extensions, shell hooks, playbooks, or profile toolbelts. This plan adds the resolved config shape and the shared engine loader/registry that later tooling and runtime hooks can consume. It must reuse the canonical three-tier scope model from `@eforge-build/scopes` and keep extension load failures non-fatal for build startup.

The foundation intentionally captures registrations without executing hook semantics. Event dispatch, policy gate enforcement, profile routing, input adapters, reviewer perspectives, validation providers, and agent custom-tool injection remain future runtime work unless all they require here is registry capture.

## Implementation

### Overview

Add a top-level `extensions` config section, add runtime dependencies needed to load TypeScript source, create an engine extension loader package, and wire `EforgeEngine.create()` to resolve and store a native extension registry with diagnostics. The loader imports JS/MJS via dynamic `import()` and TS/MTS via `jiti`, invokes default factories with a recording `EforgeExtensionAPI`, validates registrations, and returns status/provenance for every discovered or explicit extension candidate.

### Key Decisions

1. Use `extensions:` at the top level of eforge config. Do not reuse `plugins:` or `agents.tiers.*.pi.extensions`.
2. Default `extensions.enabled` to `true` and `extensions.trustProjectExtensions` to `false`.
3. Treat user and project-local extensions as trusted when enabled; mark project/team extensions as `untrusted` until `trustProjectExtensions: true` is present in merged config.
4. Resolve paths with `@eforge-build/scopes` scope names/directories. If `resolveNamedSet()` cannot model mixed file and directory module entries, use `SCOPES` plus `getScopeDirectory()` rather than local hard-coded scope paths.
5. Support auto-discovered single-file modules (`.ts`, `.mts`, `.js`, `.mjs`) and directory modules with `package.json` `exports`/`main` or `index.{ts,mts,js,mjs}`.
6. Make explicit paths separate from include/exclude filtering. Duplicate explicit names, including collisions with auto-discovered winners, produce diagnostics errors instead of shadowing.
7. Extend the SDK API only as needed for factory-time tool capture. If `EforgeExtensionAPI` lacks `registerTool`, add it and record it without wiring agent execution.
8. Store extension diagnostics on the engine instance and surface error/warning diagnostics as existing `config:warning` events at session start; do not add new event variants in this plan.

## Scope

### In Scope

- `extensions` config schema, type, defaults, merge, resolve, and override support.
- Engine loader modules for discovery, entrypoint resolution, import strategy selection, trust gating, factory invocation, registry capture, diagnostics, and wire projection inputs.
- Recording `EforgeExtensionAPI` validation for `onEvent`, `onAgentRun`, `beforePlanMerge`, `registerProfileRouter`, `registerInputSource`, `registerReviewerPerspective`, `registerValidationProvider`, and `registerTool` if added.
- Global duplicate-name validation for factory-time named registrations: profile routers, input sources, reviewer perspectives, validation providers, and tools.
- `EforgeEngine` storage/accessors for extension registry and diagnostics.
- Tests for config/default/merge, discovery precedence, include/exclude/paths, explicit collisions, trust skips, JS/TS loading, invalid exports, factory errors, and registration capture.

### Out of Scope

- Hook dispatch for `onEvent`.
- Blocking policy gate execution.
- Runtime profile routing.
- Input-source execution.
- Reviewer perspective activation.
- Validation provider execution.
- Agent custom-tool injection.
- Trust prompts, hash trust stores, promote/demote/reload commands, package installation, and `/eforge:extend` scaffolding.

## Files

### Create

- `packages/engine/src/extensions/types.ts` — Internal extension discovery, status, diagnostics, registry, registration, and loader strategy types.
- `packages/engine/src/extensions/discovery.ts` — Scoped auto-discovery, explicit path resolution, layout resolution, include/exclude filtering, shadow construction, collision detection, and trust status assignment.
- `packages/engine/src/extensions/recorder.ts` — Recording `EforgeExtensionAPI` implementation plus per-registration validation.
- `packages/engine/src/extensions/loader.ts` — JS/MJS dynamic import, TS/MTS `jiti` import, factory validation/invocation, registry merge, and non-fatal error handling.
- `packages/engine/src/extensions/projector.ts` — Pure projection helpers that convert internal registry state into client-owned wire shapes introduced by the tooling plan.
- `packages/engine/src/extensions/index.ts` — Public engine exports for extension discovery/loading helpers.
- `test/extension-discovery.test.ts` — Filesystem tests for scoped discovery, precedence, include/exclude, explicit paths, collisions, unsupported layouts, and trust skips.
- `test/extension-loader.test.ts` — Filesystem tests for JS/TS/MJS/MTS loading, invalid exports, factory failures, duplicate registration validation, and registry summaries.

### Modify

- `packages/engine/src/config.ts` — Add `extensionConfigSchema`, `ExtensionConfig`, `EforgeConfig.extensions`, `PartialEforgeConfig.extensions`, defaults, `resolveConfig()`, `mergePartialConfigs()`, validation, and comments describing array replacement semantics.
- `packages/engine/src/eforge.ts` — Merge extension config overrides, load native extensions during `EforgeEngine.create()`, store registry/diagnostics, expose getters, and append diagnostics to session-start warnings without failing engine creation.
- `packages/engine/package.json` — Add runtime dependencies on `@eforge-build/extension-sdk` and `jiti`.
- `packages/engine/tsup.config.ts` — Externalize `jiti` if bundling it breaks dynamic runtime loading; keep the setting explicit after verifying `pnpm build`.
- `pnpm-lock.yaml` — Update via pnpm after adding engine dependencies.
- `packages/extension-sdk/src/api.ts` — Add `registerTool(tool: ExtensionTool): void` if required for factory-time tool registration capture.
- `packages/extension-sdk/src/index.ts` — Re-export any SDK type changes caused by the new API method.
- `test/config.test.ts` — Add native extension config schema/default/merge validation tests.
- `test/extension-sdk-example.test.ts` — Keep SDK smoke coverage aligned with any API addition.

## Verification

- [ ] `configYamlSchema.safeParse({ extensions: { enabled: true, include: ['a'], exclude: ['b'], paths: ['./x.ts'], trustProjectExtensions: false } })` succeeds.
- [ ] `DEFAULT_CONFIG.extensions` resolves to `{ enabled: true, trustProjectExtensions: false }` with absent include/exclude/paths.
- [ ] `mergePartialConfigs()` keeps lower-layer scalar extension fields when a higher layer overrides only an array field, and replaces include/exclude/paths arrays from the higher layer.
- [ ] Discovery returns one winner per auto-discovered name with precedence `project-local > project-team > user` and shadow entries containing lower-scope provenance.
- [ ] Include then exclude filters affect auto-discovered entries and do not remove configured explicit paths.
- [ ] Duplicate explicit path names produce `error` diagnostics and no silent shadowing.
- [ ] A project/team extension is reported as `untrusted` when `trustProjectExtensions` is absent or false, and loads when the flag is true.
- [ ] `.js`, `.mjs`, `.ts`, and `.mts` extension factories load in tests and record the loader strategy used.
- [ ] Invalid default exports, unsupported explicit formats, factory throws, invalid registration arguments, and duplicate contributed names produce path-specific diagnostics.
- [ ] `EforgeEngine.create()` does not throw when one extension fails to load; the failing extension appears in diagnostics and the registry contains other loaded extensions.
- [ ] `pnpm --filter @eforge-build/engine type-check` passes.
- [ ] `pnpm test -- test/extension-discovery.test.ts test/extension-loader.test.ts test/config.test.ts test/extension-sdk-example.test.ts` passes.