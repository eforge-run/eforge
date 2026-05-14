---
id: plan-01-extension-sdk
name: Extension SDK package, example, and docs
branch: extend-01-extension-api-design-sdk-package/plan-01-extension-sdk
agents:
  reviewer:
    effort: high
    rationale: Public API surface that later loader/runtime epics depend on;
      reviewer must validate type stability, dependency direction (no engine
      internals), TypeBox alignment, and the toolbelt-vs-extension boundary.
---

# Extension SDK package, example, and docs

## Architecture Context

This plan delivers the EXTEND_01 foundation slice of the Native TypeScript Extensions roadmap. It introduces a new public workspace package, `@eforge-build/extension-sdk` (at `packages/extension-sdk/`), that defines the stable, type-first API surface extension authors will consume. Later epics will add the runtime loader, CLI/daemon management commands, `/eforge:extend` skills, event-hook execution, and policy-gate enforcement on top of this contract; none of that runtime behavior is built here.

The SDK is positioned as a peer of `@eforge-build/client` and `@eforge-build/scopes`: small, public, Apache-2.0, ESM, Node 22, built with `tsup`, type-checked with `tsc --noEmit`. It depends only on `@eforge-build/client` (for canonical event types and TypeBox schema utilities) and `@sinclair/typebox`. It must not depend on the engine, monitor, monitor-ui, CLI, Pi, or provider SDKs - that constraint is the single most important architectural invariant of this plan.

Event wire shapes are owned by `packages/client/src/events.schemas.ts` (TypeBox source of truth, with `EforgeEvent` derived via `Static<typeof EforgeEventSchema>`). The SDK re-exports `EforgeEvent` and related types from `@eforge-build/client` rather than redefining them; redefining event shapes anywhere else violates project discipline.

The event pattern matcher (`compilePattern` / `matchesPattern`) already exists in `packages/engine/src/hooks.ts`. The SDK must not import from the engine; instead, it ports the same glob semantics (`*` matches across `:`, regex-special characters escaped) into a small, self-contained helper so shell-hook and TypeScript-hook authors share one mental model.

The internal `CustomTool` shape in `packages/engine/src/harness.ts` (`{ name, description, inputSchema: TObject, handler }`) informs - but is not directly re-exported as - the public extension tool type. The SDK defines its own narrower public surface so the engine remains free to evolve internal fields without breaking extension authors.

The public API design decisions are codified in the source PRD and the broader `docs/prd/typescript-extensibility.md`:

- Factory-style default export: `export default function extension(eforge: EforgeExtensionAPI) { ... }`, plus a `defineEforgeExtension()` helper for inference.
- Registration methods on `EforgeExtensionAPI`: `onEvent`, `onAgentRun`, `beforePlanMerge` (and other policy-gate placeholders), `registerProfileRouter`, `registerInputSource`, `registerReviewerPerspective`, `registerValidationProvider`. Each is a typed registration contract; this slice ships **types only**, not runtime dispatchers.
- Policy decisions are discriminated unions: `{ decision: 'allow' } | { decision: 'block', reason: string } | { decision: 'require-approval', reason: string }`. The `modify` variant is reserved only for hook families that explicitly allow mutation and must be labelled as future-shaped.
- Event hook returns are non-blocking (`void | Promise<void>`); only policy gates return decisions.
- TypeBox is the public schema language. The SDK exposes `Type` and `TSchema`/`TObject` types either by re-export or by documenting the exact `@sinclair/typebox` import. Zod must not appear in the public surface.
- Capabilities whose runtime is not yet implemented are still defined as compile-time contracts; docs and example comments must label runtime status (`Phase 1: typed event hooks` is the only one with a clear runtime intent in this slice, and even that is not wired up here).

Validation pipeline (root scripts): `pnpm -r build`, `pnpm -r type-check`, `pnpm test` (vitest). The new package picks up `build` and `type-check` automatically via `pnpm -r`; the example's type-check needs an explicit hook (vitest test or dedicated tsconfig include) because example files live outside any package's `src/`.

## Implementation

### Overview

Create `packages/extension-sdk/` with full package scaffolding (package.json, tsconfig.json, tsup.config.ts, src/, README.md), define the public TypeScript API across focused source files, ship a minimal compile-checked example under `examples/extensions/`, wire the example into validation, update `tsconfig.base.json` path aliases and `vitest.config.ts` aliases so internal/test consumers resolve to source, and author `docs/extensions.md` (conceptual guide) + `docs/extensions-api.md` (API reference).

### Key Decisions

1. **One package, dedicated boundary.** Implement as `packages/extension-sdk/` published as `@eforge-build/extension-sdk` rather than tacking exports onto `@eforge-build/client`. Rationale: extension authors get a single, discoverable import path; the client remains focused on daemon/SSE wire concerns; future templates and `/eforge:extend` skills can point to one canonical package. Trade-off: one more workspace package, but the conventions are mechanical (copy `packages/scopes/` shape).

2. **Re-export event types from `@eforge-build/client`, never redefine.** The SDK's `events` module re-exports `EforgeEvent`, `EforgeEventSchema`, `safeParseEforgeEvent`, `AgentRole`, and the discriminant string constants from the client. The SDK adds pattern helpers and `EventOfType<T>` mapped types on top, but the wire shapes themselves stay in `packages/client/src/events.schemas.ts`. This preserves the project's single-source-of-truth rule.

3. **TypeBox is the only schema language exposed.** The SDK re-exports `Type` and the type-level `TSchema`, `TObject`, `Static` from `@sinclair/typebox` so authors do not need to add their own TypeBox dependency to write a tool. The SDK does not depend on Zod and the public surface never references it. Adapter notes in docs can mention Zod-at-third-party boundaries, but the SDK itself is TypeBox-only.

4. **Policy decisions are discriminated unions, not booleans.** Define `PolicyDecision` as `{ decision: 'allow' } | { decision: 'block'; reason: string } | { decision: 'require-approval'; reason: string }`. A `modify` variant is **not** introduced in this slice because no hook family in scope here intentionally allows mutation - documenting it now would invite ambiguous mutation contracts. Docs note this as a future-shaped extension point.

5. **Event pattern semantics mirror shell hooks.** The SDK's pattern helper produces a `RegExp` using the same algorithm as `packages/engine/src/hooks.ts::compilePattern` (`*` matches across `:`). The helper is ported (not imported) so the SDK stays engine-independent. A 1:1 behavioural parity test guards against drift.

6. **Extension-contributed tools are a public, narrower type.** Define `ExtensionTool<TInput extends TObject = TObject>` with `name`, `description`, `inputSchema: TInput`, `handler: (input: Static<TInput>) => Promise<string> | string`. Internally, the engine's `CustomTool` from `harness.ts` is a superset; the engine can adapt extension tools when runtime loading lands, but the public type stays narrow.

7. **Capabilities are typed contracts, not implementations.** `onAgentRun`, `beforePlanMerge`, `registerProfileRouter`, `registerInputSource`, `registerReviewerPerspective`, `registerValidationProvider` are declared on `EforgeExtensionAPI` with full typed signatures. Their runtime status is documented in `docs/extensions-api.md` under a 'Runtime support' column: only the SDK shape is delivered in this epic.

8. **`defineEforgeExtension()` is a no-op identity helper for inference.** It accepts `(factory: EforgeExtensionFactory) => factory` so authors who prefer named-export style get parameter inference without runtime cost. The default-export factory form is also supported and is the form used in the canonical example.

9. **Example lives in `examples/extensions/` at repo root and is compile-checked via a vitest type-import test.** `examples/extensions/minimal-event-logger.ts` imports from `@eforge-build/extension-sdk` and subscribes to a typed event. A small test file at `test/extension-sdk-example.test.ts` imports the example (forcing type-check) and asserts the SDK barrel exports the documented surface. This keeps the example wired into root validation without introducing a separate workspace package or a parallel tsconfig.

10. **No daemon, route, or wire changes.** The SDK does not touch `packages/client/src/routes.ts`, the daemon, SSE shapes, or the API version. If a reviewer detects an attempt to add a route or bump `DAEMON_API_VERSION`, that is a scope violation.

11. **TypeBox dependency hygiene.** Declare `@sinclair/typebox` as a regular `dependency` of the SDK (matching `@eforge-build/client`) and `@eforge-build/client` as a `dependency` with `workspace:*`. Dev dependencies match `packages/scopes/`: `@types/node`, `tsup`, `typescript`.

## Scope

### In Scope
- New workspace package `packages/extension-sdk/` published as `@eforge-build/extension-sdk` (version `0.7.12` to match the rest of the workspace), Apache-2.0, ESM, Node 22, tsup build, `tsc --noEmit` type-check, `dist/` exports with types.
- Public TypeScript API across these source files:
  - `src/index.ts` - barrel re-exports for all public names.
  - `src/api.ts` - `EforgeExtensionAPI`, `EforgeExtensionFactory`, `defineEforgeExtension`, registration method signatures.
  - `src/context.ts` - `EforgeExtensionContext`, `ExtensionLogger`, `ExtensionExecApi`, and per-hook context shapes (`EventHookContext`, `AgentRunContext`, `PolicyGateContext`).
  - `src/hooks.ts` - hook handler/result types: event hook return (`void | Promise<void>`), `PolicyDecision` discriminated union, `AgentRunAugmentation` (`{ promptAppend?, tools?, allowedTools?, disallowedTools? }`), `ProfileRouterResult`, `InputSourceAdapter`, `ReviewerPerspectiveSpec`, `ValidationProviderSpec`.
  - `src/tools.ts` - `ExtensionTool<TInput>` definition type plus `defineExtensionTool()` identity helper for inference.
  - `src/patterns.ts` - `EventPattern` type alias, `compileEventPattern()`, `matchesEventPattern()`, ported from engine hook semantics.
  - `src/events.ts` - re-exports `EforgeEvent`, `EforgeEventSchema`, `AgentRole`, `safeParseEforgeEvent` from `@eforge-build/client`, plus an `EventOfType<T extends EforgeEvent['type']> = Extract<EforgeEvent, { type: T }>` mapped type.
  - `src/schema.ts` - re-exports `Type`, and re-exports `TSchema`, `TObject`, `Static` as types from `@sinclair/typebox`.
- `packages/extension-sdk/README.md` - one-page overview that mirrors the public site doc.
- `examples/extensions/minimal-event-logger.ts` - default-export factory that subscribes to `plan:build:failed` and logs through `ctx.logger`. Demonstrates typed event narrowing via `EventOfType`.
- `examples/extensions/protected-paths.ts` - second example using `eforge.beforePlanMerge` and returning a `PolicyDecision` discriminated union, demonstrating the policy-gate type surface (clearly labelled in comments as a type-level contract; runtime not yet wired).
- `examples/extensions/README.md` - brief description of each example and how validation runs (`pnpm type-check`, `pnpm test`).
- `test/extension-sdk-example.test.ts` - vitest test that:
  - imports the example modules (forcing TypeScript to type-check them through the vitest pipeline),
  - asserts that `@eforge-build/extension-sdk` exposes every named export listed in the acceptance criteria,
  - exercises `matchesEventPattern` against shell-hook parity cases (`plan:build:*` matches `plan:build:complete`, `*:complete` matches `plan:build:complete`, exact match wins, regex special chars do not leak).
- `tsconfig.base.json` - add path aliases for `@eforge-build/extension-sdk` and `@eforge-build/extension-sdk/*` pointing at `packages/extension-sdk/src/`. Insert directly after the existing `@eforge-build/scopes/*` entry.
- `vitest.config.ts` - add a resolve alias for `@eforge-build/extension-sdk` (bare and subpath) pointing at the SDK source so the example test resolves without a built `dist/`.
- `docs/extensions.md` - conceptual guide: what extensions are, scopes (`~/.config/eforge/extensions/`, `eforge/extensions/`, `.eforge/extensions/`), relationship to shell hooks/playbooks/profiles/toolbelts, factory entrypoint, SDK status, runtime-readiness table, trust/security caveat for future runtime loading, minimal example walkthrough.
- `docs/extensions-api.md` - API reference: registration methods on `EforgeExtensionAPI`, context types, hook result types, `PolicyDecision`, `ExtensionTool` + TypeBox schema usage, `EventPattern` glob semantics, runtime-support column for each capability, explicit toolbelt-vs-extension boundary section.

### Out of Scope
- Runtime extension discovery, loading, sandboxing, or execution. No `jiti`, no module loader, no `.eforge/extensions/` scanner.
- CLI/daemon commands (`eforge extension list/new/validate/test/enable/disable/promote/demote/reload`). No daemon HTTP routes, no MCP tools, no Pi/Claude Code skills.
- `/eforge:extend` skill in `eforge-plugin/` or `packages/pi-eforge/`.
- Trust prompts, hash-based provenance, or `eforge extension trust` plumbing.
- Event-replay test runner.
- Wiring extension hooks into any engine pipeline stage, policy gate, profile router, input transformer, or reviewer dispatcher.
- Reworking profile toolbelt runtime behavior (already shipped per `docs/roadmap.md`).
- Changes to `packages/client/src/routes.ts`, daemon SSE wire shapes, or `DAEMON_API_VERSION`.
- Updating web site nav (`web/lib/nav.ts`) - the repo-root `docs/hooks.md` precedent shows root docs can land without site-nav additions in this slice. Touching `web/lib/nav.ts` is left to a follow-up that ships the runtime.
- Updating `eforge-plugin/` or `packages/pi-eforge/` skill manifests - no consumer-facing skill is added here.

## Files

### Create

- `packages/extension-sdk/package.json` - copy structure from `packages/scopes/package.json`. Name `@eforge-build/extension-sdk`, version `0.7.12`, license Apache-2.0, type module, exports `.` -> `dist/index.js` + `dist/index.d.ts`, files `dist/`, engines node `>=22`, scripts `build: tsup`, `type-check: tsc --noEmit`. Dependencies: `@eforge-build/client: workspace:*`, `@sinclair/typebox: ^0.34.49`. DevDependencies: `@types/node: ^25.7.0`, `tsup: ^8.5.1`, `typescript: ^5.9.3`. Author `Schaake Solutions LLC`, repository url `git+https://github.com/eforge-build/eforge.git`, homepage `https://eforge.build`, publishConfig `{ access: public }`.
- `packages/extension-sdk/tsconfig.json` - copy `packages/scopes/tsconfig.json` verbatim (target ES2022, module ESNext, moduleResolution bundler, strict, declaration, outDir/declarationDir dist, include `src/**/*`).
- `packages/extension-sdk/tsup.config.ts` - copy `packages/scopes/tsup.config.ts` (single entry `src/index.ts`, esm, dts, target node22, clean).
- `packages/extension-sdk/README.md` - one-page summary mirroring `docs/extensions.md` with install/import snippets and a link to the canonical docs.
- `packages/extension-sdk/src/index.ts` - barrel exports of everything listed under In Scope.
- `packages/extension-sdk/src/api.ts` - `EforgeExtensionAPI` interface (with `onEvent`, `onAgentRun`, `beforePlanMerge`, `registerProfileRouter`, `registerInputSource`, `registerReviewerPerspective`, `registerValidationProvider`), `EforgeExtensionFactory = (api: EforgeExtensionAPI) => void | Promise<void>`, `defineEforgeExtension(factory)` identity helper.
- `packages/extension-sdk/src/context.ts` - `EforgeExtensionContext` (logger, exec, state/config placeholders typed but documented as non-runtime), narrower per-hook contexts (`EventHookContext`, `AgentRunContext` carrying `{ role, tier, profile, planId?, changedFiles? }`, `PolicyGateContext` carrying `{ planId, diff }` with `ExtensionDiff = { files: Array<{ path: string; status: 'added'|'modified'|'deleted'|'renamed' }> }`).
- `packages/extension-sdk/src/hooks.ts` - `EventHookHandler<T extends EforgeEvent['type']>`, `PolicyDecision` discriminated union, `PolicyGateHandler`, `AgentRunHandler`, `AgentRunAugmentation`, `ProfileRouterSpec`, `ProfileRouterResult`, `InputSourceAdapter`, `ReviewerPerspectiveSpec`, `ValidationProviderSpec`.
- `packages/extension-sdk/src/tools.ts` - `ExtensionTool<TInput extends TObject = TObject>` interface, `defineExtensionTool<TInput>(tool: ExtensionTool<TInput>): ExtensionTool<TInput>` identity helper.
- `packages/extension-sdk/src/patterns.ts` - `EventPattern` type alias (string), `compileEventPattern(pattern: string): RegExp`, `matchesEventPattern(pattern: string, eventType: string): boolean`. Algorithm: split on `*`, escape regex specials in each segment, join with `.*`, anchor with `^...$`. Mirror `packages/engine/src/hooks.ts::compilePattern` exactly.
- `packages/extension-sdk/src/events.ts` - re-export `EforgeEvent`, `EforgeEventSchema`, `AgentRole`, `safeParseEforgeEvent` from `@eforge-build/client`; declare `EventOfType<TType extends EforgeEvent['type']> = Extract<EforgeEvent, { type: TType }>`.
- `packages/extension-sdk/src/schema.ts` - `export { Type } from '@sinclair/typebox';` and `export type { TSchema, TObject, Static } from '@sinclair/typebox';`.
- `examples/extensions/minimal-event-logger.ts` - default-export factory that calls `eforge.onEvent('plan:build:failed', async (event, ctx) => { ctx.logger.warn(\`Plan failed: ${event.planId}\`); })`. Uses `EventOfType<'plan:build:failed'>` in a type annotation comment or assertion to demonstrate narrowing.
- `examples/extensions/protected-paths.ts` - default-export factory that calls `eforge.beforePlanMerge` and returns a `PolicyDecision`. Comment header notes runtime is not yet wired.
- `examples/extensions/README.md` - short intro listing each example and the validation commands (`pnpm -r build`, `pnpm -r type-check`, `pnpm test`).
- `test/extension-sdk-example.test.ts` - vitest suite covering:
  1. SDK barrel surface (every documented export is defined and is a value or type as expected).
  2. `matchesEventPattern` parity with shell-hook semantics for at least these cases: exact match, `plan:build:*` matches `plan:build:complete`, `*:complete` matches multiple types, `*` matches any, regex special chars in patterns do not leak (e.g. `plan.build:start` is a literal dot, not a wildcard).
  3. `compileEventPattern` produces an anchored RegExp.
  4. Imports `examples/extensions/minimal-event-logger.ts` and `examples/extensions/protected-paths.ts` to force type-check.
- `docs/extensions.md` - conceptual author guide. Sections: What is an extension; Scopes table (user/project/project-local); Relationship to shell hooks/playbooks/profiles/toolbelts; Minimal example (factory + event hook); Schema language (TypeBox-only); Runtime support today vs. future (table); Trust/security caveat; Where to read the API reference.
- `docs/extensions-api.md` - API reference. Sections: Entrypoint (default-export factory + `defineEforgeExtension`); `EforgeExtensionAPI` methods with full signatures; Context types; Hook result types and `PolicyDecision`; Event types and `EventPattern` glob semantics with a parity table against shell hooks; TypeBox schema usage with `defineExtensionTool`; Runtime support status per capability (table with columns `Capability`, `Type contract today`, `Runtime today`, `Planned epic`); Toolbelt-vs-extension boundary section.

### Modify

- `tsconfig.base.json` - inside the `paths` object, add `"@eforge-build/extension-sdk": ["./packages/extension-sdk/src/index.ts"]` and `"@eforge-build/extension-sdk/*": ["./packages/extension-sdk/src/*"]`. Place these entries adjacent to the existing `@eforge-build/scopes/*` entry so the alphabetical-ish grouping is preserved.
- `vitest.config.ts` - in the `resolve.alias` array, add `{ find: /^@eforge-build\/extension-sdk\/(.*)$/, replacement: resolve(root, 'packages/extension-sdk/src/$1') }` and `{ find: '@eforge-build/extension-sdk', replacement: resolve(root, 'packages/extension-sdk/src/index.ts') }`. Place adjacent to the existing `@eforge-build/scopes` alias entries. The existing `test.include` already covers `test/**/*.test.ts`, so the new example test is picked up without an include change.

### Do not modify

- `packages/client/src/events.schemas.ts` and any other file in `packages/client/src/` - event wire shapes stay owned by the client.
- `packages/engine/src/hooks.ts` - shell-hook semantics stay in the engine. The SDK ports the algorithm; it does not import or re-export from the engine.
- `packages/engine/src/harness.ts` - the engine's `CustomTool` stays internal.
- `packages/client/src/routes.ts`, `packages/client/src/api-version.ts` - no daemon API changes.
- `web/lib/nav.ts`, `web/content/docs/*` - root `docs/*.md` files (like `docs/hooks.md`) currently land without web-nav updates; deferring the public-site nav update is intentional and noted in the source's evidence gaps.
- `eforge-plugin/.claude-plugin/plugin.json` and `packages/pi-eforge/package.json` - no consumer-facing skill/CLI surface ships here, so neither version bumps.
- `CHANGELOG.md` - release flow owns it.

## Verification

- [ ] `packages/extension-sdk/package.json` exists with name `@eforge-build/extension-sdk`, license `Apache-2.0`, `type: module`, `engines.node: >=22`, and dependencies that include only `@eforge-build/client: workspace:*` and `@sinclair/typebox` plus the `@types/node` + `tsup` + `typescript` dev dependencies.
- [ ] `grep -R "@eforge-build/engine" packages/extension-sdk/` returns zero matches.
- [ ] `grep -R "@eforge-build/monitor" packages/extension-sdk/` returns zero matches.
- [ ] `grep -R "zod" packages/extension-sdk/src/` returns zero matches.
- [ ] `packages/extension-sdk/src/index.ts` re-exports each of: `EforgeExtensionAPI`, `EforgeExtensionFactory`, `defineEforgeExtension`, `EforgeExtensionContext`, `EventHookContext`, `EventHookHandler`, `EventOfType`, `EventPattern`, `compileEventPattern`, `matchesEventPattern`, `PolicyDecision`, `PolicyGateContext`, `PolicyGateHandler`, `AgentRunContext`, `AgentRunHandler`, `AgentRunAugmentation`, `ExtensionTool`, `defineExtensionTool`, `ProfileRouterSpec`, `ProfileRouterResult`, `InputSourceAdapter`, `ReviewerPerspectiveSpec`, `ValidationProviderSpec`, `EforgeEvent`, `EforgeEventSchema`, `safeParseEforgeEvent`, `AgentRole`, `Type`, `TSchema`, `TObject`, `Static`. Asserted by the example test's barrel-surface check.
- [ ] `packages/extension-sdk/src/events.ts` re-exports event types from `@eforge-build/client` (no `Type.Union(...)` or other event-shape definitions appear anywhere under `packages/extension-sdk/src/`).
- [ ] `pnpm --filter @eforge-build/extension-sdk build` exits 0 and produces `packages/extension-sdk/dist/index.js` plus `dist/index.d.ts`.
- [ ] `pnpm --filter @eforge-build/extension-sdk type-check` exits 0.
- [ ] `pnpm -r type-check` exits 0 (covers the SDK and the rest of the workspace; the example is type-checked by being imported in `test/extension-sdk-example.test.ts`).
- [ ] `pnpm test` exits 0 with `test/extension-sdk-example.test.ts` reporting at least: barrel-surface assertion passes; the four `matchesEventPattern` parity cases pass; `compileEventPattern` returns an anchored RegExp.
- [ ] `examples/extensions/minimal-event-logger.ts` imports only from `@eforge-build/extension-sdk` (no engine, monitor, client, or relative imports outside the example directory).
- [ ] `examples/extensions/protected-paths.ts` returns a `PolicyDecision` whose `decision` field is `'allow'` or `'block'` in the demonstrated branches and includes a comment header labelling runtime as not yet wired.
- [ ] `docs/extensions.md` exists and contains a Scopes table, a Runtime-support table, a Trust/security section, and a Minimal example code block that compiles against the documented SDK exports (visually consistent with `examples/extensions/minimal-event-logger.ts`).
- [ ] `docs/extensions-api.md` exists and contains: an entrypoint section, an `EforgeExtensionAPI` method reference, a Runtime support column for each capability, an event-pattern parity section, and a Toolbelt-vs-extension boundary section.
- [ ] `tsconfig.base.json` `paths` block contains entries for both `@eforge-build/extension-sdk` and `@eforge-build/extension-sdk/*`.
- [ ] `vitest.config.ts` `resolve.alias` array contains both the bare and subpath alias entries for `@eforge-build/extension-sdk`.
- [ ] `git diff` shows zero modifications to `packages/client/src/routes.ts`, `packages/client/src/api-version.ts`, any file under `packages/engine/src/`, `eforge-plugin/.claude-plugin/plugin.json`, `packages/pi-eforge/package.json`, and `CHANGELOG.md`.
