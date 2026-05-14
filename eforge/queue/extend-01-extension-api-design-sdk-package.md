---
title: EXTEND_01: Extension API design + SDK package
created: 2026-05-14
profile: claude-sdk-4-7
---

# EXTEND_01: Extension API design + SDK package

## Problem / Motivation

The Native TypeScript Extensions roadmap (under Extensibility in `docs/roadmap.md`) needs a stable public API/SDK boundary before later epics can build runtime loading, CLI/daemon management, event-hook execution, or assisted authoring on top of it. Today there is no `packages/extension-sdk/`, no `examples/extensions/`, and no `docs/extensions.md` or `docs/extensions-api.md`. Without a dedicated SDK package, extension authors would need to discover engine/client internals, and there is a risk of:

- Duplicating event wire shapes outside the canonical source-of-truth (`packages/client/src/events.schemas.ts`).
- Leaking engine internals (`BuildStageContext`, internal agent config, `CustomTool`) into the public surface.
- Confusing behavioral TypeScript extensions with declarative profile toolbelts (which already shipped and select project MCP servers).
- Drifting away from the TypeBox schema unification direction.

Schaake OS epic `ee830c73-4b0d-43aa-b289-6d19b36c7eef` frames this as a critical, in-progress foundation epic for `docs/prd/typescript-extensibility.md`. Acceptance requires a public SDK package or equivalent exports, public extension/context/hook-result types, a compiling minimal example, TypeBox-compatible public schema direction, and an explicit boundary between behavioral extensions and declarative profile toolbelts.

## Goal

Deliver the EXTEND_01 foundation slice of the Native TypeScript Extensions roadmap by introducing a public, type-first `@eforge-build/extension-sdk` package (with a minimal compiling example and supporting docs) that defines the stable extension API surface later loader, CLI, daemon, and integration epics will depend on - without implementing runtime extension execution.

## Approach

Classification: **architecture / deep** change. Confidence: high. Recommended profile: **Excursion** - cohesive multi-file public API/package/docs change with architectural implications, but a single planner can enumerate package, types, examples, docs, and validation steps without delegated module planners. Not **Errand** (public SDK boundary and future compatibility need review). Not **Expedition** (runtime loader, CLI/daemon manager, Pi/Claude integration, and policy-gate execution are explicitly out of scope for this slice).

### New public boundary

- Introduce `@eforge-build/extension-sdk` as the public import surface for extension authors. Keeps extension authoring types separate from internal engine modules and lets later runtime/manager work depend on a stable contract.
- The SDK is **type-first**. It can export small runtime helpers where useful (pattern matching, define-extension helper, schema helpers), but must not pull in engine runtime behavior or daemon lifecycle logic.

### Dependency direction

- SDK may depend on `@eforge-build/client` for canonical event types/schemas (`EforgeEvent`, `EforgeEventSchema`, `safeParseEforgeEvent`, constants). Preserves the project rule that wire event shapes are co-located in `packages/client/src/events.schemas.ts`.
- SDK may depend on `@sinclair/typebox` and re-export TypeBox-related helper types/functions. Must not define duplicate event schemas.
- Engine/daemon runtime may later depend on the SDK for shared hook contracts, but this epic should avoid introducing circular dependencies or forcing engine internals into the public API.

### Type/API layering

- Public extension contracts should model future capabilities without implementing them yet. Later loader/runtime code can consume registered descriptors from the SDK shape.
- Keep public types stable and intentionally narrower than internal objects. Example: expose `ExtensionAgentRunContext` with role/tier/profile/plan/file metadata, not the full internal `BuildStageContext`.
- Represent hook registrations declaratively enough for validation/testing later: event pattern + handler, policy gate name + handler, agent role/tier predicate + handler, tool definition + TypeBox schema.

### Tool surface boundary

- Toolbelts remain declarative profile configuration for selecting project MCP servers.
- SDK tool definitions represent extension-contributed custom tools; they are separate from toolbelt-selected MCP tools and engine-internal custom tools.
- Documentation must preserve the effective tool surface model: engine-internal tools + profile/toolbelt-selected project MCP tools + extension-contributed custom tools - explicit allow/disallow filters.

### No operational/deployment impact in this slice

- No daemon API version bump should be needed unless runtime APIs are accidentally changed. This epic should not change daemon HTTP routes or SSE wire shapes.
- No monitor UI changes required unless docs generation or package metadata surfaces packages automatically.
- Existing shell hooks continue unchanged; TypeScript event hooks are a new future-facing API contract.

### Design decisions

1. **Create a dedicated SDK package rather than adding exports to `@eforge-build/client`.**
   - Decision: implement `packages/extension-sdk/` as `@eforge-build/extension-sdk`.
   - Rationale: the epic explicitly names an SDK package; extension author imports should not have to discover engine/client internals; future templates/docs can point to one package.
   - Trade-off: one more workspace package, but it creates a clean public boundary.

2. **Reuse client event types/schemas; do not duplicate event wire shapes.**
   - Decision: SDK exports/re-exports event-related types from `@eforge-build/client` and adds pattern/helper types around them.
   - Rationale: project convention says `packages/client/src/events.schemas.ts` is the wire-protocol source of truth and direct event-shape definitions elsewhere are forbidden.

3. **TypeBox is the public schema language.**
   - Decision: extension tool/config/schema helpers accept TypeBox `TSchema`/`TObject` and derive TypeScript types with TypeBox `Static` where needed.
   - Rationale: roadmap and PRD make TypeBox canonical for eforge-owned schemas; existing custom tools already use TypeBox `TObject` in `packages/engine/src/harness.ts`.
   - Boundary: do not expose Zod as an extension-author dependency.

4. **Factory-style extension entrypoint.**
   - Decision: document/support a default export shaped like `export default function extension(eforge: EforgeExtensionAPI) { ... }`, plus optionally a `defineEforgeExtension()` helper for type inference.
   - Rationale: matches the PRD and is agent-friendly for generated extensions.

5. **Model runtime-inactive capabilities as typed registration contracts.**
   - Decision: include interfaces for event hooks, agent run augmentation, policy gates, input transformers, profile routers, reviewer perspectives, and validation providers only where the contract is useful and clearly documented as API surface; do not imply all are runtime-supported today.
   - Rationale: later epics can wire runtime support incrementally while extension authors and examples compile against the intended public shape.
   - Caveat: docs/examples must label which capabilities are supported now vs. future if runtime support is absent.

6. **Policy hooks return explicit decisions.**
   - Decision: define `PolicyDecision`/gate result types with discriminated unions such as `allow`, `block`, `require-approval`, and possibly `modify` only for hook families that intentionally allow mutation.
   - Rationale: PRD guardrail requires no hidden mutation and strict behavior for blocking hooks.

7. **Event patterns use existing glob semantics.**
   - Decision: expose event pattern types/helpers compatible with shell hook patterns (`*` matches across `:`), while keeping event-specific type narrowing best-effort.
   - Rationale: avoids inventing a second event-pattern language and makes migration from shell hooks understandable.

8. **Examples must be compile-checked.**
   - Decision: add a minimal example extension and wire it into type-check/build validation, either through a package-local example tsconfig or workspace test/type-check coverage.
   - Rationale: acceptance explicitly says a minimal example compiles against the SDK.

9. **Keep SDK dependency footprint small.**
   - Decision: depend only on `@eforge-build/client`, `@sinclair/typebox`, and necessary dev tooling. Avoid engine/monitor/CLI dependencies.
   - Rationale: extension authors should get stable types without pulling implementation internals or provider SDKs.

### Code impact

Likely files/directories to add:

- `packages/extension-sdk/package.json` - package metadata, `exports`, scripts, dependencies.
- `packages/extension-sdk/tsconfig.json` - extends root/base tsconfig or mirrors package conventions.
- `packages/extension-sdk/tsup.config.ts` - ESM + DTS build config.
- `packages/extension-sdk/src/index.ts` - public exports.
- `packages/extension-sdk/src/api.ts` or similar - `EforgeExtensionAPI`, registration methods, extension factory types.
- `packages/extension-sdk/src/context.ts` - extension contexts/logging/exec/state/config surfaces as type contracts.
- `packages/extension-sdk/src/hooks.ts` - event hook, agent hook, policy gate, input transformer, profile router, reviewer/validation provider result types.
- `packages/extension-sdk/src/tools.ts` - TypeBox-backed extension tool definition helper/types.
- `packages/extension-sdk/src/patterns.ts` - event pattern type/helper and/or runtime matcher compatible with shell hooks.
- `packages/extension-sdk/src/testing.ts` (optional in this slice) - minimal event replay/test harness type placeholders if acceptance/docs require helper types, without full daemon replay implementation.
- `examples/extensions/minimal-event-logger.ts` or a package-local `examples/` equivalent - minimal compiling extension.
- `examples/extensions/tsconfig.json` or test fixture config - ensures examples type-check.
- `docs/extensions-api.md` and/or `docs/extensions.md` - public API direction, TypeBox schema guidance, toolbelt boundary. The broader PRD names both files as required docs; this epic can create initial docs for SDK authoring.

Likely files to modify:

- `package.json` root devDependencies may need `@eforge-build/extension-sdk: workspace:*` if examples are compiled from root; otherwise workspace package inclusion through `packages/*` is automatic.
- `tsconfig.base.json` path aliases should add `@eforge-build/extension-sdk` and maybe subpath aliases if internal workspace imports need source resolution.
- `README.md` or docs index/manifest only if required by docs-gen/site nav conventions; validate by checking docs-gen manifests before editing.
- Potential generated docs artifacts if `pnpm docs:generate` expects docs/nav updates.

Existing patterns to follow:

- `packages/scopes/` is a small public package with simple `src/index.ts`, `tsup`, ESM, Node 22, and publish metadata.
- `packages/client/` shows how TypeBox schema helpers and event exports are organized.
- `packages/engine/src/harness.ts` contains an internal `CustomTool` shape that can inform public extension tool types, but direct import from engine should be avoided.
- `packages/engine/src/hooks.ts` contains the current glob event pattern matcher; SDK can mirror or extract compatible semantics.

Validation commands:

- `pnpm --filter @eforge-build/extension-sdk build`
- `pnpm --filter @eforge-build/extension-sdk type-check`
- `pnpm type-check`
- `pnpm build` if time permits; root build should include the new workspace package.

Evidence gaps:

- Need to inspect docs-gen/nav conventions before deciding whether to add extension docs to generated/public docs navigation. This is low-cost during implementation.

### Documentation impact

Docs to add/update:

- `docs/extensions.md` - conceptual author guide: what extensions are, scopes/future loading model, current SDK status, relationship to shell hooks/playbooks/session plans/profiles/toolbelts, trust warning, and minimal example.
- `docs/extensions-api.md` - API reference-style document for `@eforge-build/extension-sdk`: extension entrypoint, API registration methods, context types, hook result types, TypeBox schema helpers, event patterns, and runtime-support status per extension point.
- `examples/extensions/README.md` (optional but useful) - how to type-check/run examples and what each demonstrates.
- Existing `docs/prd/typescript-extensibility.md` likely should remain as design/roadmap context, not be rewritten as shipped docs. If implementation materially changes API direction, update only the relevant API examples/status notes.
- If docs navigation is curated (web/docs manifest or docs-gen manifest), add the new docs to navigation so they are discoverable.

Documentation requirements from the epic/PRD:

- Make TypeBox-compatible schema direction explicit.
- Explicitly distinguish behavioral TypeScript extensions from declarative profile toolbelts.
- Make clear that extensions execute arbitrary TypeScript with user permissions once runtime loading exists; this SDK slice may only define types/examples, but docs should not understate future trust implications.
- Label runtime status honestly: SDK/API contracts now; loader/manager/execution in later epics unless this implementation chooses to include more.

No docs impact expected:

- Profile toolbelt docs should only need a cross-reference if at all. Avoid changing shipped toolbelt behavior or restating it inconsistently.

### Risks

- **Over-promising runtime support.** The SDK can define contracts for future hooks before runtime execution exists. Docs/examples must clearly distinguish compile-time API shape from implemented runtime behavior.
- **Event type drift.** Defining event shapes in the SDK would violate the client schema source-of-truth rule. Mitigation: re-export from `@eforge-build/client`.
- **Leaking engine internals.** It is tempting to export `BuildStageContext`, internal agent config, or `CustomTool` directly from engine. Mitigation: define small public types in SDK and keep engine as a future consumer, not an SDK dependency.
- **Ambiguous mutation contracts.** Policy gates/input transformers can mutate or block behavior later. Mitigation: use discriminated result types and document which hooks can modify behavior.
- **Toolbelt confusion.** Users may think extensions are another way to configure MCP server bundles. Mitigation: docs and API naming should keep extension-contributed custom tools distinct from profile toolbelts.
- **TypeBox ergonomics.** TypeBox is less familiar to some extension authors than Zod. Mitigation: provide helper functions and examples with inferred `Static` types.
- **Example compile coverage.** An example that is not type-checked can silently rot. Mitigation: wire example type-checking into package/root validation.
- **Package/versioning churn.** Adding a published package requires correct metadata and workspace references. Mitigation: copy conventions from `packages/scopes` / `packages/client` and do not bump unrelated Pi package version.
- **Docs nav drift.** Adding docs without nav/site integration may hide them. Mitigation: inspect docs-gen/web docs conventions during implementation.

### Context evidence

- Schaake OS epic `ee830c73-4b0d-43aa-b289-6d19b36c7eef` frames this as a critical, in-progress foundation epic for `docs/prd/typescript-extensibility.md`. Acceptance requires a public SDK package or equivalent exports, public extension/context/hook-result types, a compiling minimal example, TypeBox-compatible public schema direction, and an explicit boundary between behavioral extensions and declarative profile toolbelts.
- `docs/roadmap.md` lists **Native TypeScript extensions** under Extensibility and says the rollout starts with typed event hooks and depends on/aligns with TypeBox schema unification. It also says profile toolbelts runtime filtering has shipped, which means this plan should avoid reopening toolbelt implementation.
- `docs/prd/typescript-extensibility.md` defines the broader expedition: scoped discovery, `/eforge:extend`, CLI/daemon management, typed event hooks, agent context/tool extensions, policy gates, input transformers, limited stage-like APIs, examples, security/trust, and event replay testing. This epic is specifically the SDK/API design slice, not the runtime loader/manager.
- Current package layout is pnpm workspace packages under `packages/*`; existing public packages use `tsup`, ESM, `dist` exports, Node 22, Apache-2.0 metadata, and workspace dependencies. There is currently no `packages/extension-sdk/`, no `examples/extensions/`, and no `docs/extensions.md` or `docs/extensions-api.md`.
- Existing TypeBox evidence: `packages/client/src/events.schemas.ts` is the canonical wire event schema source, derives `EforgeEvent`, and exports `EforgeEventSchema`, `safeParseEforgeEvent`, event constants, and related types through `packages/client/src/events.ts` / `index.ts`. `packages/client/src/schema-utils.ts` provides TypeBox-backed parse/safe-parse/YAML helpers.
- Existing engine extension-adjacent APIs: `packages/engine/src/hooks.ts` implements shell event hooks with glob-style patterns and non-blocking execution; `packages/engine/src/harness.ts` defines `CustomTool` with a TypeBox `TObject` schema and `AgentRunOptions` fields for prompt/tool/allowlist additions. These are useful patterns but should not be imported directly by public extension authors unless deliberately re-exported through the SDK.
- Toolbelt boundary evidence: `docs/prd/profile-toolbelts.md` and engine comments define toolbelts as declarative MCP server bundles selected by profile tiers. They must stay separate from imperative TypeScript extensions; extension-contributed custom tools are a distinct tool-surface category and toolbelt filtering applies only to project MCP servers from `.mcp.json`.

### Assumptions and validation

| Assumption | Evidence / validation performed | Confidence | Cost to validate further | Validation path | Impact if wrong |
|---|---|---:|---:|---|---|
| This epic is the SDK/API design slice, not runtime loader/CLI/daemon management. | Epic title/acceptance focuses on SDK package/API/minimal example/docs. `docs/prd/typescript-extensibility.md` lists loader, CLI/daemon manager, `/eforge:extend`, event runtime, and test runner as broader/later roadmap items. | high | low | Confirm with user/epic owner if they wanted runtime execution included. | Scope could be too small if runtime was expected, or too large if runtime creeps in. |
| `@eforge-build/extension-sdk` should be a dedicated package. | Epic acceptance says package exists or equivalent; PRD explicitly lists `packages/extension-sdk/`; workspace already supports `packages/*`. | high | low | Implement package or document equivalent rationale. | Public import path changes; examples/docs may need adjustment. |
| SDK should reuse `@eforge-build/client` event types/schemas. | Project instructions and `packages/client/src/events.schemas.ts` say event shapes are co-located and derived from TypeBox there. | high | low | Type-check SDK imports/re-exports from client. | Duplicate event types could drift and violate project discipline. |
| Public schemas should be TypeBox-compatible. | Epic acceptance, roadmap TypeBox unification item, `packages/client/src/schema-utils.ts`, and engine custom tool shape all point to TypeBox. | high | low | Ensure SDK exports TypeBox helpers/types and docs state direction. | Extension API could fight current migration and require later breaking changes. |
| Minimal example can be compile-checked without runtime loader. | Acceptance says example compiles, not that it runs; no `packages/extension-sdk` or loader currently exists. | high | low | Add example tsconfig/package script and run type-check. | If runtime demonstration is expected, this plan under-delivers. |
| Docs should be added even if runtime is not implemented. | PRD lists `docs/extensions.md`, `docs/extensions-api.md`, examples, and SDK as required docs/examples. | medium-high | low | Inspect docs nav/docs-gen and include docs where appropriate. | Users may not find the SDK or may misunderstand runtime availability. |
| No daemon API version bump is required. | Scope avoids HTTP/SSE route shape changes; client wire shapes are reused. | high | low | Check diff for route/API changes before completion. | If runtime routes sneak in, versioning/client contract work may be needed. |
| Engine should not be a dependency of the SDK. | Architecture rule restricts provider SDK imports to engine harnesses; public SDK should not pull runtime internals. | high | low | Check `packages/extension-sdk/package.json` dependencies/import graph. | SDK becomes unstable/heavy and exposes implementation details. |

Assumption review: no low-confidence/high-impact assumptions remain. The highest-impact assumptions (scope limited to SDK/API, event reuse from client, TypeBox direction) are directly supported by the epic, PRD, and repository conventions. Runtime-support ambiguity is mitigated by acceptance criteria requiring documentation to label compile-time contracts vs. currently implemented behavior.

## Scope

Implement the EXTEND_01 foundation slice for the Native TypeScript Extensions roadmap.

### In scope

- Add a new public workspace package, preferably `packages/extension-sdk/` published as `@eforge-build/extension-sdk`, following existing package conventions (`type: module`, Node 22, `tsup`, `dist` exports, Apache-2.0 metadata, workspace build/type-check scripts).
- Define and export the public TypeScript API surface extension authors will import:
  - `EforgeExtensionAPI` factory/registration interface.
  - `EforgeExtensionContext` and narrower hook contexts for event hooks, agent-run hooks, policy gates, input transformers, reviewer/validation-like extension points where appropriate as type contracts.
  - Hook handler/result types, including non-blocking event hook returns and explicit policy decisions (`allow`, `block`, optionally future-shaped `require-approval`/`modify` if documented as non-runtime-ready).
  - Typed event pattern helpers that reuse `EforgeEvent` from `@eforge-build/client` and existing glob-style semantics from shell hooks.
  - TypeBox-compatible schema helper exports/types for extension tools/config contracts.
- Provide a minimal example extension that compiles against the SDK. At minimum, include an event logger or protected path policy example under a new `examples/extensions/` area or equivalent package-local examples directory that is covered by type-check/build.
- Document the public schema direction: extension schemas are TypeBox/JSON-Schema-compatible; Zod is not part of the public extension authoring surface except at third-party SDK adapter boundaries.
- Document API boundaries that keep behavioral extensions separate from declarative profile toolbelts.
- Update workspace configuration/path aliases/package dependencies so `pnpm build` and `pnpm type-check` include the SDK.

### Out of scope

- Runtime extension discovery/loading/execution.
- CLI/daemon commands such as `eforge extension list/new/validate/test/reload`.
- `/eforge:extend` Pi/Claude Code skills or MCP/native tools.
- Trust prompts, enable/disable state, event replay runner, and daemon reload plumbing.
- Actual policy gate enforcement, profile routing execution, custom reviewer integration, input-source runtime integration, or custom validation provider execution.
- Reworking shipped profile toolbelt runtime behavior.

Roadmap relation: this is the SDK/API foundation that later epics can consume for loader, event-hook runtime, management commands, and assisted extension authoring.

## Acceptance Criteria

Implementation is complete when:

1. A public SDK package exists as `@eforge-build/extension-sdk` (or a clearly justified equivalent public export surface) and is included in the pnpm workspace build/type-check flow.
2. The SDK exports at least:
   - `EforgeExtensionAPI`.
   - Extension factory/definition types.
   - `EforgeExtensionContext` and hook-specific context/result types.
   - Typed event hook registration types and event pattern helpers.
   - Policy gate decision/result types.
   - Agent context/tool augmentation types.
   - TypeBox-compatible schema/helper types for extension tools/config.
   - Event types re-exported from `@eforge-build/client` rather than duplicated.
3. A minimal example extension compiles against the SDK in CI/local validation. The example should demonstrate importing `EforgeExtensionAPI` or `defineEforgeExtension`, subscribing to an event, and using typed event/context values.
4. Public documentation explains:
   - Extension entrypoint shape and basic API usage.
   - TypeBox as the public schema direction.
   - Which API capabilities are compile-time contracts vs. runtime-supported today.
   - The boundary between behavioral TypeScript extensions and declarative profile toolbelts.
   - Security/trust caveat for future runtime-loaded TypeScript.
5. Existing event schema source-of-truth discipline is preserved: no duplicate `EforgeEvent` shape definitions outside `packages/client/src/events.schemas.ts`.
6. The SDK has no dependency on engine provider SDKs or monitor/CLI internals.
7. Validation passes for the new package and example:
   - `pnpm --filter @eforge-build/extension-sdk build`
   - `pnpm --filter @eforge-build/extension-sdk type-check`
   - root `pnpm type-check` or documented equivalent.
8. If docs/nav generation is affected, generated docs checks are updated or documented as unchanged.
