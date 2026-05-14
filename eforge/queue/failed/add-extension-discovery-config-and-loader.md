---
title: Add Extension Discovery, Config, and Loader
created: 2026-05-14
profile: pi-codex-5-5
---

# Add Extension Discovery, Config, and Loader

## Problem / Motivation

Native eforge extensions have a typed SDK and examples, but there is no runtime path that discovers, configures, loads, validates, or reports them. Users can write TypeScript extension modules, but eforge cannot yet see them, determine scope/provenance, apply deterministic precedence, or explain diagnostics.

Affected users: extension authors, agents building `/eforge:extend` workflows, and downstream features that need loaded registrations for event hooks, policy gates, profile routing, input adapters, reviewer perspectives, and validation providers.

Why now: EXTEND_01 completed the SDK contract. EXTEND_02 is the critical foundation required before any extension capability can execute safely or be managed by CLI/daemon/Pi/Claude surfaces.

Context:
- Source context: Schaake OS epic `971571bb-be7c-4a0a-b266-da8a9b251858`, status `in_progress`, priority `critical`; depends on EXTEND_01 (`@eforge-build/extension-sdk`) and has downstream extension capability epics.
- Roadmap alignment: `docs/roadmap.md` lists Native TypeScript extensions as a platform direction. The preferred rollout in `docs/prd/typescript-extensibility.md` places "Extension SDK + loader with scoped discovery and config" immediately after TypeBox schema unification and before typed event runtime/manager commands.

Existing foundation verified by file inspection:
- `packages/extension-sdk/` exists and exports the public TypeScript contract (`EforgeExtensionAPI`, factory type, hook/context types, event pattern helpers, TypeBox helpers). Runtime notes in `packages/extension-sdk/src/api.ts` and `docs/extensions.md` say most capabilities are typed contracts only today.
- `docs/extensions.md` already defines the three extension scopes: user `~/.config/eforge/extensions/`, project/team `eforge/extensions/`, and project-local `.eforge/extensions/`, with precedence `project-local > project-team > user`.
- `@eforge-build/scopes` already owns canonical scope names/directories and helpers: `getScopeDirectory()`, `resolveNamedSet()`, and `resolveLayeredSingletons()`. This should be reused rather than reimplementing scope precedence.
- `packages/engine/src/config.ts` already has layered `config.yaml` loading and a `plugins` config shape with `enabled/include/exclude/paths`. This is probably the nearest existing pattern, but native eforge extensions should use an `extensions` section rather than being conflated with host plugins/Pi extensions.
- Pi harness extension discovery exists separately in `packages/engine/src/harnesses/pi-extensions.ts` with include/exclude/paths semantics for Pi extensions. It is useful as a semantic reference only; native eforge extensions are a different concept and should not live under harness-specific Pi config.
- Daemon/CLI/client route conventions are centralized through `@eforge-build/client` (`API_ROUTES`, typed API helper files) and `packages/monitor/src/server.ts`; AGENTS.md forbids inline `/api/...` literals outside that route contract.
- Existing examples in `examples/extensions/` type-check against the SDK but are not loaded at runtime yet.

Profile signal:
- Recommended profile: **Excursion**.
- Rationale: this is a cross-package feature touching engine config/loading, scopes, daemon/client/CLI observability, tests, and docs, but it is still one cohesive foundation layer. A single planner should be able to enumerate the implementation sequence and dependencies without delegated module planning. Expedition is not warranted unless the implementation expands into full extension manager/scaffold/test/replay tooling.

## Goal

Add the native eforge extension foundation: scoped discovery, configuration, loading/validation, registration capture, diagnostics, and provenance visibility. This enables downstream extension capability epics without yet implementing full runtime semantics for every capability type.

## Approach

Early assumptions/unknowns:
- The loader can initially focus on discovery, loading/validation, registration capture, diagnostics, and provenance visibility; full hook execution semantics may be limited to non-mutating event hook dispatch only if needed by downstream EXTEND_03/04 epics.
- The TS loading strategy needs a project decision. Recommended plan below chooses support for `.js/.mjs` direct imports and `.ts/.mts` source loading through a small runtime loader dependency/cache, with clear diagnostics.
- Trust behavior for committed project extensions needs to be documented now, but full hash-based trust enforcement may be deferred unless cheap to implement in this slice.

Key design decisions:
1. **Use top-level `extensions`, not `plugins` or `pi.extensions`.**
   - Native eforge extensions are configured under `extensions:` in `eforge/config.yaml` layers.
   - Rationale: `plugins` currently means Claude Code plugin loading, and `agents.tiers.*.pi.extensions` means Pi harness extensions. Native eforge extensions are engine/daemon lifecycle modules and must remain conceptually separate.

2. **Config shape mirrors known include/exclude/path semantics but adds eforge-specific trust.**
   ```yaml
   extensions:
     enabled: true
     include: [build-notifier]
     exclude: [experimental-router]
     paths:
       - ./tools/my-extension.ts
     trustProjectExtensions: false
   ```
   - `enabled: false` disables all native extension discovery/loading, including explicit paths.
   - `include` is a whitelist for auto-discovered named extensions.
   - `exclude` is a blacklist for auto-discovered named extensions after include filtering.
   - `paths` are explicit modules/directories and are not filtered by include/exclude.
   - `trustProjectExtensions` may be adjusted during implementation, but should be the coarse MVP trust gate for committed `eforge/extensions/` modules. Default should be conservative and documented.

3. **Deterministic discovery uses extension names and scope provenance.**
   - Auto-discovered names come from file basename without extension or directory basename.
   - Supported layouts should be explicit and small: single files (`*.ts`, `*.mts`, `*.js`, `*.mjs`) and optionally directories with `package.json` `exports`/`main` or `index.{ts,mts,js,mjs}`.
   - For same-name auto-discovered entries, highest-precedence scope wins and lower scopes are reported as shadows.
   - Explicit path name collisions are diagnostics errors rather than silent shadowing.

4. **Loading strategy: support source TypeScript plus JavaScript.**
   - Support `.ts/.mts` extension source and `.js/.mjs` built modules in the first loader slice.
   - Recommended implementation: direct dynamic `import()` for JS/MJS; use a small loader dependency such as `jiti` or equivalent for TS/MTS source so extension authors do not need a manual build step.
   - Rationale: the roadmap explicitly calls these native TypeScript extensions, examples are TypeScript, and requiring precompiled JS would undermine the authoring UX. Loader diagnostics must state exactly which strategy handled the file.

5. **Registration capture before capability execution.**
   - Loader invokes the default factory with a recording API that stores `onEvent`, `onAgentRun`, `beforePlanMerge`, profile router, input source, reviewer perspective, validation provider, and tool registrations.
   - Unsupported-yet capability registrations are allowed and visible in the registry, but downstream execution remains gated by later epics.
   - Invalid registration inputs, such as unsupported event pattern type, missing handler function, or duplicate contributed names where applicable, produce path-specific diagnostics.

6. **Failure policy is visible and non-catastrophic by default.**
   - A single extension load failure should mark that extension as `error` and report diagnostics, not crash all builds by default.
   - Config/validation tooling should return non-zero or `valid:false` for load errors.
   - If actual event hook dispatch is included, event hook failures should be logged/emitted and should not mutate build success, matching shell hook behavior and SDK docs.

7. **Trust model is documented now; hash trust can be deferred.**
   - User and project-local extensions are assumed to be user-controlled and can load when enabled.
   - Project/team extensions are committed code and should require explicit opt-in/trust before execution.
   - For EXTEND_02, a documented config gate is acceptable; hash-based trust prompts/stores can be a downstream enhancement if not required by this epic.

8. **Tooling surface exposes provenance.**
   - List/show responses should include: `name`, `scope`, `path`, `source` (`auto`/`explicit`), `status` (`loaded`/`disabled`/`excluded`/`untrusted`/`error`), `shadows`, registration summary counts, and diagnostics.
   - This satisfies the epic requirement without needing the full future extension manager command set.

Likely implementation areas:
- `packages/engine/src/config.ts`
  - Add `extensionConfigSchema` and exported `ExtensionConfig` type.
  - Add `extensions` to `PartialEforgeConfig`, `EforgeConfig`, `DEFAULT_CONFIG`, `resolveConfig()`, and `mergePartialConfigs()`.
  - Ensure array semantics are explicit: `include`/`exclude`/`paths` replace by higher-precedence config layer, while scalar trust/enabled settings merge shallowly.

- New engine module(s), likely `packages/engine/src/extensions/*`
  - Discovery/resolution using `@eforge-build/scopes` directory helpers or a new generic helper if named-set file support is too narrow.
  - Types for `ResolvedExtension`, provenance, shadow chain, diagnostics, load status, and captured registrations.
  - Loader implementation for `.ts/.mts` and `.js/.mjs` modules.
  - Recording implementation of `EforgeExtensionAPI` that validates and stores registrations without requiring downstream hook runtimes yet.

- `packages/engine/src/eforge.ts` and/or `packages/engine/src/hooks.ts`
  - Optionally wire loaded non-blocking event hook registrations through middleware analogous to shell `withHooks()` if this slice includes phase-1 event hook dispatch.
  - At minimum expose load/registry diagnostics from engine creation or utility functions without disrupting existing build flow.

- `packages/client/src/routes.ts`, `packages/client/src/types.ts`, and a new `packages/client/src/api/extension.ts`
  - Add typed route constants and response shapes for daemon extension list/validate/show as needed.
  - Follow AGENTS.md route-contract discipline; do not inline `/api/...` literals in consumers.

- `packages/monitor/src/server.ts`
  - Add daemon handlers that call shared engine extension discovery/loader helpers and construct wire responses from named projection types.

- `packages/eforge/src/cli/index.ts` and possibly MCP proxy/Pi integration packages
  - Add minimal `eforge extension list` / `validate` commands if tooling visibility is implemented as CLI commands.
  - If MCP/Pi tools are exposed, keep `eforge-plugin/` and `packages/pi-eforge/` in sync per AGENTS.md.

- Documentation
  - Update `docs/extensions.md`, `docs/extensions-api.md`, `docs/config.md`, and probably `README.md` with runtime support, config, trust, examples, and limitations.
  - Update example comments in `examples/extensions/` once loading is real.

- Tests
  - Add unit tests under `test/` for discovery/config/loader behavior.
  - Update config tests (`test/config.test.ts` or a new logical test file) for schema/default/merge validation.
  - Existing `test/extension-sdk-example.test.ts` remains the SDK surface smoke test; new tests should exercise actual runtime loading with temporary extension files.

Evidence:
- Scope helpers are in `packages/scopes/src/{scope,dirs,named-set,layered-singleton}.ts`.
- Existing config loading/merge is in `packages/engine/src/config.ts`.
- Existing shell event hook middleware and glob semantics are in `packages/engine/src/hooks.ts`.
- Current runtime SDK API exists in `packages/extension-sdk/src/api.ts` and examples in `examples/extensions/`.
- Daemon route contract is centralized in `packages/client/src/routes.ts`; config/profile API helpers show current conventions.

Assumptions and validation:

| Assumption | Evidence / validation performed | Confidence | Cost to validate further | Validation path | Impact if wrong |
|------------|----------------------------------|------------|--------------------------|-----------------|-----------------|
| EXTEND_01 SDK package is present and usable as the loader target. | Verified `packages/extension-sdk/package.json`, `packages/extension-sdk/src/api.ts`, `context.ts`, and SDK tests/examples. | high | low | Run `pnpm --filter @eforge-build/extension-sdk type-check` and SDK tests. | Loader would need to wait for SDK completion or adjust factory API. |
| `@eforge-build/scopes` should be reused for extension scope directories/precedence. | Verified `packages/scopes/src/dirs.ts`, `scope.ts`, `named-set.ts`, `layered-singleton.ts`; AGENTS.md says scope/path lookup lives there. | high | low | Add discovery tests that assert exact precedence and paths. | Reimplementing scope lookup would create drift from profiles/playbooks. |
| Native extension config should be top-level `extensions`, not existing `plugins` or `pi.extensions`. | Verified `plugins` currently feeds Claude Code plugin loading in `eforge.ts`; `pi.extensions` is nested under Pi harness config in `config.ts`; docs distinguish native eforge extensions from host plugins. | high | low | Add config schema test rejecting/accepting intended keys and update docs. | Users could confuse native eforge extensions with host-surface plugins, causing incorrect behavior. |
| Supporting TypeScript source at runtime is required for the intended UX. | Roadmap/PRD repeatedly says native TypeScript extensions; examples are `.ts`; open question asks loader strategy. | high | medium | Confirm dependency choice (`jiti` or equivalent) with a spike and test loading temp `.ts` files under Node >=22. | If TS source is not supported, generated extensions would need a build step and docs/examples would be misleading. |
| A small loader dependency such as `jiti` is acceptable in the engine package. | No existing `jiti` dependency found; project already uses bundled deps and Node >=22. This is a recommendation, not a verified project preference. | medium | low | Add dependency in a branch and run `pnpm build`, `pnpm type-check`, loader tests; or choose another loader during implementation if better. | Loader implementation may need to switch to transform/cache or built-JS-only support. |
| Full hash-based trust is not required in EXTEND_02 as long as committed project extension trust behavior is documented and coarse-gated. | Epic acceptance says trust/security behavior documented, not fully enforced with hashes; PRD lists hash prompts as "consider". | medium | low | Confirm with user if strict trust enforcement is desired now; otherwise document deferral. | If strict trust is required now, scope expands to trust store, hashing, commands, and mutation UX. |
| Minimal list/validate tooling is sufficient for "provenance visible to CLI/daemon tooling". | Epic wording asks provenance visibility, while full manager commands are a later roadmap item in the PRD. | medium | low | Implement list/validate first and verify acceptance with user/review; add show if trivial. | If full CLI manager is expected, scope expands to new/enable/disable/promote/demote/reload. |
| Full execution of all registered capability types is out of scope for this loader epic. | Downstream dependents exist; PRD orders loader before typed event runtime/manager and later capability phases. Docs currently mark most runtime support as future. | high | low | Keep registry capture separate from dispatch; tests assert capture rather than behavior for unsupported capability types. | Trying to implement all capability semantics now would make the epic too broad and risky. |

No low-confidence/high-impact assumption remains unresolved. The most material medium-confidence choices are loader dependency and minimal trust/tooling scope; both have low-cost validation paths and can be adjusted during implementation without changing the overall architecture.

## Scope

In scope:
- Add a top-level native eforge extension config section, distinct from host `plugins` and tier-local `pi.extensions`.
- Discover extension modules from all three canonical scopes:
  - user: `~/.config/eforge/extensions/`
  - project/team: `eforge/extensions/`
  - project-local: `.eforge/extensions/`
- Apply deterministic precedence: project-local shadows project/team, project/team shadows user for the same extension name; preserve shadow metadata in list output.
- Support config controls: global enable/disable, include whitelist, exclude blacklist, and explicit paths.
- Implement a loader that imports supported JS/TS extension modules, verifies the default factory shape, invokes the factory with a recording `EforgeExtensionAPI`, and captures registered hooks/capabilities in a registry object for future runtimes.
- Report diagnostics clearly: discovery errors, unsupported files, load/import failures, invalid default exports, registration validation failures, duplicate explicit names, trust skips, and warnings.
- Expose provenance/status to tooling via daemon/client/CLI surfaces, at minimum a list/validate-style view that can show name, path, scope, source kind, load status, diagnostics, and shadows.
- Document configuration, supported file/layout conventions, TS/JS loading strategy, trust/security behavior, and the distinction from Pi extensions/Claude plugins/profile toolbelts.
- Add tests for discovery precedence, include/exclude/paths behavior, loader diagnostics, factory invocation/registration capture, and trust handling.

Out of scope:
- Full `/eforge:extend` scaffold/test/replay workflow.
- Promotion/demotion/trust command UX beyond minimal visibility/validation unless needed for the trust model.
- Runtime semantics for blocking policy gates, profile routing, input transformers, reviewer perspectives, validation providers, or custom tools.
- General-purpose package installation from registries.
- Redefining profile toolbelts or MCP filtering semantics.

## Acceptance Criteria

- Config supports native eforge extensions via a documented top-level `extensions` section with `enabled`, `include`, `exclude`, and `paths` controls.
- Discovery supports user `~/.config/eforge/extensions/`, project/team `eforge/extensions/`, and project-local `.eforge/extensions/` locations.
- Discovery precedence is deterministic: project-local > project/team > user; shadowed lower-precedence entries are reported in tooling output.
- Include/exclude filters apply deterministically to auto-discovered named extensions; explicit `paths` are handled separately and are not filtered by include/exclude.
- Loader supports the chosen TS/JS strategy: `.ts/.mts` source modules and `.js/.mjs` modules load successfully in tests, and unsupported formats produce clear diagnostics.
- Loader validates module entrypoints: default export must be an `EforgeExtensionFactory`-compatible function; invalid exports are reported with path-specific errors.
- Loader invokes factories with a recording `EforgeExtensionAPI` and returns a registry/provenance object summarizing registered capabilities.
- Extension provenance is visible to CLI/daemon tooling: name, path, scope, source kind, status, shadows, diagnostics, and registration summary are exposed.
- Extension load errors and trust skips are visible; one bad extension does not silently disappear.
- Trust/security behavior for committed project/team extensions is documented, including default behavior, opt-in mechanism, and non-sandboxed execution warning.
- Docs distinguish native eforge extensions from Pi extensions, Claude Code plugins, shell hooks, playbooks, and profile toolbelts.
- Tests cover config schema/default/merge behavior, discovery precedence, include/exclude/paths, explicit path collisions, trust skips, loader success/failure, and factory registration capture.
- `pnpm type-check` and relevant `pnpm test` suites pass.
