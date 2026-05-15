---
id: plan-01-sdk-and-wire-contracts
name: Profile router SDK contracts, wire events, and recorder validation
branch: extend-09-usage-aware-profile-router/plan-01-sdk-and-wire-contracts
---

---
id: plan-01-sdk-and-wire-contracts
name: Profile router SDK contracts, wire events, and recorder validation
depends_on: []
---

# Profile router SDK contracts, wire events, and recorder validation

## Architecture Context

EXTEND_09 (`docs/prd/typescript-extensibility.md`) takes the already-captured but deferred `registerProfileRouter` capability and turns it into a real pre-build runtime feature. This plan lands the foundational typed contracts the runtime in plan-02 depends on:

- A build/queue-oriented `ProfileRouterContext` distinct from the role/tier-oriented `AgentRunContext` used by `onAgentRun`. The current `ProfileRouterSpec.resolve(ctx: AgentRunContext)` under-specifies queue inputs (PRD id/priority/source/workload, available profiles, usage/cooldown) so the canonical method must be a new `selectBuildProfile(ctx: ProfileRouterContext)`.
- A widened `ProfileRouterResult` that carries `reason` so the selection event can be human-readable.
- New typed wire events: `queue:profile:selected`, `queue:profile:router-failed`, `queue:profile:router-timeout`, `queue:profile:invalid-selection`, registered in the wire schema and event registry.
- A recorder update that accepts the canonical `selectBuildProfile` while continuing to accept the existing deprecated `resolve` shape so callers in `test/extension-loader.test.ts`, `test/extension-replay.test.ts`, and `test/extension-tooling-wiring.test.ts` continue to work.

Execution and scheduler integration are deliberately out of scope for this plan; plan-02 wires the runtime that emits these events. After this plan merges, `registerProfileRouter` still has no runtime effect, but the typed surface and on-the-wire schema are stable so plan-02 can implement against them without further churn.

The contracts here also unblock the example/docs work in plan-02, which advertises runtime support against the names introduced here.

## Implementation

### Overview

Widen the SDK profile router surface and corresponding engine-side mirror types; add build/queue routing context types and a usage-summary contract; add wire schemas and event-registry entries for the four new events; update the extension recorder to validate the new canonical shape while preserving back-compat for the deprecated `resolve` form.

### Key Decisions

1. **Introduce `selectBuildProfile(ctx: ProfileRouterContext)` as canonical; keep `resolve(ctx: AgentRunContext)` as deprecated compatibility.** Authors get the right context shape for queue routing. The recorder accepts either at registration time but normalizes to a single callable for plan-02's runtime. Validation requires `name: string` plus at least one of `selectBuildProfile` or `resolve` as a function. The duplicate-name diagnostic in `mergeRecorderState` is preserved.
2. **`ProfileRouterContext` is build/queue oriented and read-only.** It carries: PRD id, title, body (or `contentSummary` capped to ~4KB), priority, depends_on, current/base profile name, available profile summaries (name, scope, harness, description/whenToUse/tags from `ProfileMetadata`, toolbelt hint advisory only), a usage helper `usage.profile(name) -> ProfileUsageSummary`, plus the existing `logger`/`exec` from `EforgeExtensionContext`. No mutation of any field is permitted.
3. **`ProfileUsageSummary` is best-effort and explicitly carries unknown markers.** Fields: `lastUsedAt?: string`, `recentRunCount?: number`, `recentTokens?: { input?: number; output?: number; total?: number }`, `recentCostUsd?: number`, `recentQuotaErrors?: number`, `cooldownActive?: boolean`, `cooldownUntil?: string`, `nearLimit?: boolean`, `dataSource: 'event-history' | 'none'`. The contract documents that exact provider quota is not implied.
4. **`ProfileRouterResult` widens to carry `{ profile: string; reason?: string; confidence?: 'low' | 'medium' | 'high' }`.** `reason` flows into the `queue:profile:selected` event so users see why a build used a non-default profile.
5. **Wire events live under the `queue:profile:` prefix, not `extension:profile-router:`.** This matches the source PRD's preferred provenance namespace ("selection event is the source of truth for provenance") and keeps the event hierarchy with sibling `session:profile`. Diagnostic event names: `queue:profile:selected` (success), `queue:profile:router-failed` (handler threw), `queue:profile:router-timeout` (handler exceeded timeout), `queue:profile:invalid-selection` (returned profile name failed `loadProfile` scope lookup).
6. **All four new events are session-scoped, non-persistent** like existing `extension:agent-context:*` entries. They are diagnostic/provenance only and don't need to be replayed on reconnect.
7. **Engine mirror types in `packages/engine/src/extensions/types.ts` mirror but do not import from `@eforge-build/extension-sdk`.** This preserves the existing engine package boundary (the agent-context-runtime file documents the rationale). The router spec engine-side carries both optional `selectBuildProfile` and `resolve` callables.

## Scope

### In Scope

- Updating `ProfileRouterSpec`, `ProfileRouterResult`, and adding `ProfileRouterContext` + `ProfileUsageSummary` + `ProfileSummary` types in `packages/extension-sdk/src/hooks.ts` and `packages/extension-sdk/src/context.ts`.
- Re-exporting the new types from `packages/extension-sdk/src/index.ts`.
- Updating JSDoc on `registerProfileRouter` in `packages/extension-sdk/src/api.ts` to describe runtime support, fail-open semantics, sequential first-valid-wins evaluation, and the deprecation note for `resolve`.
- Mirroring updated router spec/context types in `packages/engine/src/extensions/types.ts` without importing SDK types.
- Updating `packages/engine/src/extensions/recorder.ts` to accept `{ name: string, selectBuildProfile: function, resolve?: function }` OR the deprecated `{ name: string, resolve: function }`; emitting an `extension:invalid-registration` diagnostic when neither callable is present.
- Adding `queue:profile:selected`, `queue:profile:router-failed`, `queue:profile:router-timeout`, `queue:profile:invalid-selection` schemas to `packages/client/src/events.schemas.ts`.
- Adding matching entries (with single-line `summary` functions) to `packages/client/src/event-registry.ts` so the exhaustiveness check passes.
- Updating `packages/extension-sdk/README.md` runtime-support row for `registerProfileRouter` and the SDK summary table to reference `selectBuildProfile`.
- Updating `docs/extensions-api.md` `registerProfileRouter` section signature and runtime-status sentence to reflect the new canonical shape and that pre-build runtime support lands with plan-02 (this plan only ships the contract; the example and runtime-support table flip happen in plan-02).
- Test coverage: extending `test/extension-loader.test.ts` to register a profile router with `selectBuildProfile` and confirm the registration is captured with `kind: 'profileRouter'` and the canonical callable normalized for the runtime; extending the same file with a deprecated-`resolve` form that still succeeds; adding a schema test in `packages/client/src/__tests__/events-schemas.test.ts` (or the existing test for wire parity) for each new event variant; extending `test/extension-sdk-example.test.ts` to type-check a stub `profile-router` extension that uses `selectBuildProfile` with the new context.

### Out of Scope

- Any runtime execution of profile routers (handled in plan-02).
- Scheduler / `QueueScheduler` changes.
- PRD frontmatter persistence helper.
- Monitor DB usage provider.
- `examples/extensions/profile-router.ts` (the canonical example file lives in plan-02 because it exercises the runtime).
- Active-marker behavior (untouched in both plans).

## Files

### Create

None.

### Modify

- `packages/extension-sdk/src/hooks.ts` — widen `ProfileRouterResult` to include optional `reason` and `confidence`; replace `ProfileRouterSpec` with `{ name: string; selectBuildProfile?: (ctx: ProfileRouterContext) => ...; resolve?: (ctx: AgentRunContext) => ...; }` and mark `resolve` `@deprecated`. Re-export `ProfileRouterContext` from `./context.js` for convenience.
- `packages/extension-sdk/src/context.ts` — add `ProfileSummary` (name, scope, harness, description, whenToUse, tags, toolbeltHint), `ProfileUsageSummary` (lastUsedAt, recentRunCount, recentTokens, recentCostUsd, recentQuotaErrors, cooldownActive, cooldownUntil, nearLimit, dataSource), and `ProfileRouterContext extends EforgeExtensionContext` carrying `prdId`, `prdTitle`, `prdBody?: string`, `prdContentSummary?: string`, `priority?: number`, `dependsOn: string[]`, `currentProfile: string | null`, `baseProfile: string | null`, `availableProfiles: ProfileSummary[]`, `usage: { profile(name: string): ProfileUsageSummary }`. Document that all fields are read-only and that `usage` returns `dataSource: 'none'` when no provider is wired.
- `packages/extension-sdk/src/api.ts` — update `registerProfileRouter` JSDoc to reflect canonical `selectBuildProfile` plus deprecated `resolve`, runtime semantics (sequential first-valid-wins, fail-open on throw/timeout/invalid, explicit PRD frontmatter overrides win, no active-marker mutation), and reference the `queue:profile:*` event family.
- `packages/extension-sdk/src/index.ts` — export `ProfileRouterContext`, `ProfileSummary`, `ProfileUsageSummary` from `./context.js`; types-only exports.
- `packages/extension-sdk/README.md` — flip the `registerProfileRouter(spec)` row's Runtime column from `Deferred` to `Yes (pre-build dispatch)` and add a one-line note that the canonical method is `selectBuildProfile`; this row reflects the contract shape that plan-02 wires up.
- `packages/engine/src/extensions/types.ts` — update `ProfileRouterSpec` to `{ name: string; selectBuildProfile?: ExtensionHandler; resolve?: ExtensionHandler }`; do not import SDK types.
- `packages/engine/src/extensions/recorder.ts` — update `registerProfileRouter` validation to require `name: string` plus at least one of `selectBuildProfile` or `resolve` (both functions when present); record the registration with both callables preserved so the runtime can pick the canonical one. Update the diagnostic message accordingly: `registerProfileRouter requires { name: string, selectBuildProfile: function } (or deprecated { resolve: function })`.
- `packages/client/src/events.schemas.ts` — add four event variants in a `// --- eforge:region plan-01-profile-router-events ---` block:
  - `queue:profile:selected` — `prdId`, `prdTitle?`, `profile` (string), `baseProfile` (string | null), `routerName`, `extensionName`, `extensionPath`, `reason?: string`, `confidence?: 'low'|'medium'|'high'`.
  - `queue:profile:router-failed` — `prdId`, `routerName`, `extensionName`, `extensionPath`, `message: string`, `stack?: string`.
  - `queue:profile:router-timeout` — `prdId`, `routerName`, `extensionName`, `extensionPath`, `timeoutMs: integer >= 0`.
  - `queue:profile:invalid-selection` — `prdId`, `routerName`, `extensionName`, `extensionPath`, `requestedProfile: string`, `reason: 'not-found' | 'load-error'`, `message: string`.
- `packages/client/src/event-registry.ts` — add registry entries for the four new events with `scope: 'session'`, `persist: false`, and concise `summary` functions (e.g. selected: `\`Queue routed ${e.prdId} to profile \"${e.profile}\" via ${e.extensionName}:${e.routerName}${e.reason ? \` (${e.reason})\` : ''}\``).
- `docs/extensions-api.md` — update the `registerProfileRouter(spec)` section: replace the signature example so `ProfileRouterSpec` shows `selectBuildProfile` as the canonical method with `resolve` marked deprecated; replace the `ProfileRouterResult` example to include `reason?` and `confidence?`; replace the runtime-status sentence with a note that pre-build runtime support is wired via the `queue:profile:*` event family (full runtime details land in the EXTEND_09 runtime change). Keep the runtime-support summary table row as `Deferred` here — that table flips in plan-02 alongside the runtime example.
- `test/extension-loader.test.ts` — add cases: (a) a `selectBuildProfile`-shaped router is captured under `registry.profileRouters[*]` with both callable shapes preserved; (b) a deprecated `resolve`-shaped router still registers without diagnostics; (c) a router with neither callable triggers an `extension:invalid-registration` diagnostic referencing `selectBuildProfile`.
- `test/extension-sdk-example.test.ts` — add a stub extension import path (or inline factory expression) that uses `selectBuildProfile` against `ProfileRouterContext`, exercising `prdId`, `availableProfiles`, and `usage.profile(...)` to confirm type inference compiles.
- `packages/client/src/__tests__/events-schemas.test.ts` — extend to validate each of the four new event payloads parses successfully with valid input and fails on missing required fields (one positive + one negative per event variant).

## Verification

- [ ] `pnpm --filter @eforge-build/extension-sdk type-check` passes; `ProfileRouterContext`, `ProfileUsageSummary`, `ProfileSummary` are exported from `@eforge-build/extension-sdk` and importable in `test/extension-sdk-example.test.ts`.
- [ ] `pnpm --filter @eforge-build/client type-check` passes; the `_Exhaustive` check in `packages/client/src/event-registry.ts` matches `EforgeEvent['type']` after the four `queue:profile:*` additions.
- [ ] `pnpm --filter @eforge-build/engine type-check` passes; engine-side `ProfileRouterSpec` mirror compiles against the recorder updates and existing extension-replay/projector consumers.
- [ ] `pnpm test test/extension-loader.test.ts` passes the three new cases (selectBuildProfile registers, deprecated resolve registers, both-missing emits `extension:invalid-registration`).
- [ ] `pnpm test test/extension-sdk-example.test.ts` passes including the new `selectBuildProfile` stub.
- [ ] `pnpm test packages/client/src/__tests__/events-schemas.test.ts` passes positive and negative parses for all four new events.
- [ ] `safeParseEforgeEvent` accepts a `queue:profile:selected` payload with all required fields and rejects one missing `routerName` (covered by the events-schemas test).
- [ ] `grep -r registerProfileRouter packages/extension-sdk/README.md docs/extensions-api.md` shows the canonical method is `selectBuildProfile` and `resolve` is marked deprecated; the `Deferred` text for `registerProfileRouter` in `packages/extension-sdk/README.md` row is replaced with the new wording.
- [ ] `pnpm test test/extension-replay.test.ts test/extension-tooling-wiring.test.ts` still passes — existing call sites using `{ name, resolve }` keep working.
- [ ] `pnpm type-check` passes at the workspace root.
