---
title: Aggressively Migrate eforge-Owned Schemas to TypeBox
created: 2026-05-13
profile: claude-sdk-4-7
---

# Aggressively Migrate eforge-Owned Schemas to TypeBox

## Problem / Motivation

The eforge codebase currently authors its domain schemas in Zod, but Zod is not the best architectural fit for several cross-boundary concerns:

- `docs/roadmap.md` explicitly lists **Schema library unification on TypeBox** under Integration & Maturity, noting TypeBox's JSON Schema-native shape, Pi dependency alignment, and the need for a dedicated scoping session before committing.
- `docs/prd/typescript-extensibility.md` proposes TypeBox for public extension schemas and lists TypeBox unification/shared tool registry as a prerequisite for the extension SDK.
- `packages/client/src/events.schemas.ts` is the current daemon wire-protocol schema source of truth and is Zod-authored; public event types are derived with `z.infer`, and tests call `EforgeEventSchema.safeParse`.
- `packages/engine/src/schemas.ts` is Zod-authored and already converts schemas to JSON Schema via `z.toJSONSchema()` for prompt documentation. This is a strong TypeBox migration candidate because TypeBox schemas are JSON Schema natively.
- `packages/engine/src/config.ts`, `packages/input/src/playbook.ts`, `packages/input/src/session-plan.ts`, `packages/engine/src/prd-queue.ts`, and `packages/eforge/src/cli/mcp-proxy.ts` use Zod for runtime validation and inferred types.
- `packages/pi-eforge/extensions/eforge/index.ts` already uses TypeBox for Pi extension tool parameter schemas.
- `packages/engine/src/harnesses/pi.ts` currently converts custom tool Zod schemas with `z.toJSONSchema()` before converting them into TypeBox for Pi tools.
- `packages/engine/src/harnesses/claude-sdk.ts` and `packages/eforge/src/cli/mcp-tool-factory.ts` are third-party SDK boundary points that currently expect Zod-shaped schemas (`tool(..., ct.inputSchema.shape, ...)` and `server.tool(..., schema, ...)`).
- Package dependencies confirm Zod is direct in `@eforge-build/client`, `@eforge-build/engine`, `@eforge-build/eforge`, and `@eforge-build/input`; TypeBox is direct in `@eforge-build/engine` and a Pi peer dependency in `@eforge-build/pi-eforge`.

Current conclusion:

- The clean target is not necessarily "zero Zod in the lockfile" because upstream SDKs and provider packages already depend on Zod. The cleaner architectural target is: **no eforge-owned domain schema is authored in Zod; Zod appears only inside explicit compatibility adapters where an external SDK requires it**.
- The riskiest migrations are `@eforge-build/client` event schemas and `packages/engine/src/config.ts` because they have broad downstream usage and custom validation/default behavior.
- The highest-leverage migration candidates are client event schemas, engine structured-output schemas, and custom tool schemas because they directly influence extension SDK contracts, Pi alignment, prompt schema generation, and daemon wire contracts.

Early assumptions / unknowns:

- Assumption: TypeBox can represent all existing eforge wire schemas without changing JSON wire shape. Confidence: medium-high; validation path is parity tests over current event fixtures and snapshot samples.
- Assumption: TypeBox validation/error helpers can replace current Zod `.safeParse()` and `z.prettifyError()` ergonomics without harming user-facing error quality. Confidence: medium; validation path is a small shared schema utility spike.
- Assumption: third-party SDK boundaries can be isolated behind TypeBox-to-Zod or TypeBox-to-MCP adapters without leaking Zod back into domain schemas. Confidence: medium; validation path is a custom tool adapter spike against Claude SDK and MCP registration.

## Goal

Aggressively migrate eforge-owned domain schemas to TypeBox as the canonical schema authoring system, keeping Zod only as a third-party adapter implementation detail at explicit SDK boundaries. This unifies the schema language across daemon wire contracts, structured agent outputs, custom tool definitions, Pi integration, and future extension SDK work, while preserving existing JSON wire shapes.

## Approach

### Canonical authoring format

- **TypeBox is canonical for eforge-owned domain schemas.** TypeBox is JSON Schema-native, aligns with Pi tool parameters, and is a better public contract language for extension schemas, daemon wire schemas, and prompt-schema generation.
- This does **not** require removing transitive Zod dependencies.

### Boundary policy

- **Zod only in explicit third-party compatibility adapters.** Claude SDK and MCP SDK paths currently accept or expect Zod-shaped tool schemas. Those constraints should not dictate eforge's domain schema source of truth.
- Adapter files should be named and localized so future code review can reject new Zod domain schemas.

### Public validation API

- **Eforge-owned parse helpers, not validator-library methods.** Consumers should call `safeParseEforgeEvent` or generic `safeParseWithSchema`, not `.safeParse()` on an exported schema object. This makes future validator implementation changes less disruptive.

### Migration order (optimized for architectural leverage)

1. Shared TypeBox validation/error/schema utility layer.
2. `@eforge-build/client` event/wire schemas.
3. `packages/engine/src/schemas.ts` structured output and prompt schema generation.
4. Custom tool contracts and harness adapters.
5. Input/PRD schemas.
6. Config schemas last.

### Wire-shape parity

- **Mandatory.** Even if public TypeScript validation APIs break, daemon/client JSON payloads should not drift accidentally.

### Architectural changes

- `@eforge-build/client` should move from exporting Zod schemas as public validator objects to exporting TypeBox schemas plus eforge-owned parse helpers. This decouples consumers from Zod-specific APIs.
- A shared schema utility module/package should become the normalization point for validation, safe-parse result shape, error formatting, schema-to-YAML generation, and potentially compiled validator caching.
- Engine agent custom tools should change from `CustomTool.inputSchema: z.ZodObject<...>` to a TypeBox schema type. Harnesses then adapt that schema to each backend:
  - **Pi:** pass TypeBox schema directly as `AgentTool.parameters`.
  - **Claude SDK:** use an adapter if the SDK still requires Zod-shaped tool input definitions.
  - **MCP proxy:** use a TypeBox-to-MCP/Zod compatibility adapter if `server.tool` still requires Zod raw shapes.
- `packages/engine/src/harnesses/pi-mcp-bridge.ts` may remain a JSON Schema -> TypeBox bridge for external MCP tools, but engine-internal custom tools should no longer take the Zod -> JSON Schema -> TypeBox path.
- Extension SDK schema contracts should be TypeBox-native from the start and should reuse the same parse/error helpers where practical.

### Public API impact

- `EforgeEventSchema.safeParse(...)` and `z.infer<typeof EforgeEventSchema>` will be replaced by TypeBox `Static<typeof EforgeEventSchema>` and helper functions such as `safeParseEforgeEvent(...)` / `parseEforgeEvent(...)`.
- Tests and internal callers that currently use `.safeParse()` need migration.

### Wire impact

- Intended wire impact is none. TypeBox migration should preserve JSON payload shapes unless a deliberate cleanup is separately identified and versioned.

### Process impact

- Because event schemas are the daemon wire-protocol source of truth, this migration should include broad parity tests and should bump `DAEMON_API_VERSION` only if wire shapes change, not merely because implementation schema libraries changed.

### Recommended decisions for the first build

- Implement only the first coherent slice: schema utility + client events + engine structured output + custom-tool adapter spike. Leave config/input follow-up unless migration proves safely mechanical.
- Change `@eforge-build/client` exported schema names to TypeBox immediately rather than dual-exporting Zod and TypeBox. Replace direct schema-method usage with eforge-owned helpers.
- Add a grep/discipline test banning domain-schema Zod imports outside explicit adapter files once adapters exist.

### Profile signal

Recommended eforge profile: **excursion**.

- Architecture-level and cross-cutting, but a cohesive migration with a clear sequence and central schema utility foundation.
- A single planner can enumerate the phases, dependencies, and impacted files without needing delegated module planners.
- It should not be an errand because it touches public wire schemas, harness adapters, tests, and docs.
- It should not be an expedition unless implementation scope is expanded to migrate every schema category, including config and all integration package duplication, in one build.

Recommended build strategy: enqueue the **first implementation slice** only: schema utility foundation, client event schema migration, engine structured-output schema migration, and custom-tool schema adapter spike. Leave full config/input migration as follow-up unless the builder finds it is safely mechanical.

### Risks and mitigations

- **Adapter complexity risk:** Claude SDK and MCP SDK may make TypeBox-first custom tools awkward if they require Zod at registration boundaries. *Mitigation:* isolate adapters and spike custom tool registration early.
- **Wire-shape drift risk:** Zod and TypeBox may differ on optional fields, passthrough/unknown keys, intersections, unions, default handling, and nullable semantics. *Mitigation:* parity tests over existing event fixtures and representative invalid payloads.
- **Error quality regression:** `z.prettifyError()` currently provides readable config errors. TypeBox errors may need formatting work. *Mitigation:* build shared error formatter before migrating config.
- **Scope creep risk:** Attempting client, engine structured output, config, input, MCP tools, Pi extension duplication, and extension SDK in one build may be too large. *Mitigation:* split into phases with architecture guardrails.
- **Config migration risk:** Config validation includes legacy-key diagnostics and partial merge semantics. *Mitigation:* migrate config last or as a separate PRD.
- **Test churn risk:** Many tests call `.safeParse()` directly. *Mitigation:* introduce stable parse helper API first and migrate tests mechanically.
- **Partial migration confusion:** During migration there may be both TypeBox and Zod schemas. *Mitigation:* document policy and add an allowlist-based grep test for remaining Zod imports.
- **Dependency duplication risk:** Both Zod and TypeBox may remain in some packages during transition. *Mitigation:* treat this as acceptable temporarily; optimize for source-of-truth cleanup, not immediate dependency minimization.

### Assumptions and validation

| Assumption | Evidence / validation performed | Confidence | Cost to validate further | Validation path | Impact if wrong |
|------------|----------------------------------|------------|--------------------------|-----------------|-----------------|
| Breaking public package schema APIs is acceptable. | User stated they are the only known user and prefer aggressive cleanup over compatibility. | high | low | Reconfirm only if this plan will be shared with other users before implementation. | If wrong, client schema migration needs dual exports and compatibility shims. |
| TypeBox can represent current daemon event schemas without wire-shape changes. | Reviewed `packages/client/src/events.schemas.ts`; schemas are mostly structural objects, literals, unions, records, arrays, optionals. | medium-high | medium | Port client schemas and run parity tests against current valid/invalid event fixtures. | Wire drift could break daemon/monitor/CLI event handling. |
| TypeBox helpers can replace `.safeParse()` ergonomics across code/tests. | TypeBox exposes `Value` and `TypeCompiler`; helper layer can normalize results. Not yet implemented in repo. | medium | low-medium | Spike `safeParseWithSchema`, `parseWithSchema`, and error formatting with representative schemas. | Migration becomes noisy or error quality regresses. |
| Claude SDK custom tools can be adapted from TypeBox schemas without leaking Zod into domain schemas. | Current `packages/engine/src/harnesses/claude-sdk.ts` uses `tool(..., ct.inputSchema.shape, ...)`, which is Zod-specific. | medium | medium | Build TypeBox-to-Zod adapter or investigate lower-level Claude SDK/MCP registration that accepts JSON Schema. | Custom tools block full TypeBox migration or require retained Zod adapter. |
| MCP proxy tool schemas can be migrated or adapted from TypeBox. | Current `packages/eforge/src/cli/mcp-tool-factory.ts` is explicitly Zod raw-shape based around `server.tool`. | medium | medium | Test MCP SDK lower-level tool registration or TypeBox-to-Zod adapter. | CLI/MCP tools remain a Zod island longer than desired. |
| Config schema migration should be delayed. | Reviewed `packages/engine/src/config.ts`; it uses defaults, partials, passthrough, legacy diagnostics, and custom validation. | high | low | Scope config as a later phase unless the first build has extra capacity. | Trying to migrate config too early may balloon scope and increase regression risk. |
| Direct TypeBox schemas will simplify prompt schema YAML generation. | `packages/engine/src/schemas.ts` currently calls `z.toJSONSchema()` then strips internal keys. | high | low | Port `getSchemaYaml` to stringify TypeBox JSON schema directly and compare snapshots. | If TypeBox schema shape is noisier, prompts may need cleanup filtering. |

No low-confidence / high-impact assumption is currently unresolved, but two medium-confidence/high-impact adapter assumptions should be validated in the first implementation slice before attempting full codebase migration.

## Scope

### In scope

- Establish a shared TypeBox schema utility layer with eforge-owned parse/safe-parse/error-format helpers so callers do not depend on a validator library API such as `.safeParse()`.
- Migrate `@eforge-build/client` daemon/event wire schemas from Zod to TypeBox while preserving JSON wire shapes.
- Migrate `packages/engine/src/schemas.ts` structured-output schemas to TypeBox and remove `z.toJSONSchema()` prompt-schema conversion.
- Define TypeBox-first custom tool schema contracts for future extension SDK work and adapt them to Pi, Claude SDK, and MCP as needed.
- Migrate input artifact schemas (`@eforge-build/input`) and PRD/frontmatter schemas after the utility layer is proven.
- Migrate engine config schemas last or in a dedicated later plan because config uses defaults, passthrough parsing, legacy-key diagnostics, and custom validation.
- Isolate any remaining Zod use behind explicit compatibility adapters required by third-party APIs.
- Update tests from library-specific `.safeParse()` assertions to eforge-owned parse helpers.
- Update docs/roadmap and TypeScript extensibility docs to reflect the adopted schema policy.

### Impacted code areas (evidence-backed)

- `packages/client/src/events.schemas.ts`
  - Current Zod source of truth for event/wire schemas.
  - Tests under `packages/client/src/__tests__/events-schemas.test.ts` call `.safeParse()` and need migration to parse helpers.
  - `packages/monitor/src/server.ts` calls `EforgeEventSchema.safeParse(parsed)` and will need helper migration.
- `packages/engine/src/schemas.ts`
  - Current Zod source for structured agent outputs, plan submission schemas, review fixes, architecture submissions, pipeline composition, and prompt schema YAML.
  - Uses `z.toJSONSchema()` in `getSchemaYaml`; TypeBox should make this direct.
  - Many tests under `test/schemas.test.ts`, `test/submission-schemas.test.ts`, `test/plan-writers.test.ts`, `test/recovery.test.ts`, and related review tests call `.safeParse()`.
- `packages/engine/src/harness.ts`
  - `CustomTool.inputSchema` is typed as `z.ZodObject<z.ZodRawShape>` and needs to become TypeBox/TSchema based.
- `packages/engine/src/harnesses/pi.ts`
  - Current custom tool path converts Zod to JSON Schema and then to TypeBox. Should accept TypeBox directly for engine custom tools.
- `packages/engine/src/harnesses/claude-sdk.ts`
  - Current custom tool registration passes `ct.inputSchema.shape` into Claude SDK `tool(...)`. Needs adapter or alternate registration path.
- `packages/eforge/src/cli/mcp-tool-factory.ts` and `packages/eforge/src/cli/mcp-proxy.ts`
  - MCP tool schemas are currently Zod raw shapes. Depending on SDK limitations, these may need a TypeBox-to-Zod adapter or a lower-level MCP registration route.
- `packages/input/src/playbook.ts`, `packages/input/src/session-plan.ts`, `packages/engine/src/prd-queue.ts`
  - Smaller schema migration candidates after the core pattern is established.
- `packages/engine/src/config.ts`
  - Large and complex migration area. Uses `.default()`, `.partial()`, `.passthrough()`, `.superRefine()`, `z.prettifyError()`, legacy-key hints, and inferred config types. Best handled after helper layer and event/structured-output migrations.
- `packages/pi-eforge/extensions/eforge/index.ts`
  - Already TypeBox-authored for Pi tools. Could later consume shared TypeBox schemas to reduce duplication.
- Package manifests / lockfile
  - `zod` direct dependencies should be removed package-by-package once no domain schemas remain in that package, except packages that contain explicit adapter code.
  - `@sinclair/typebox` should become direct dependency where TypeBox schemas are authored.

### Validation impact

- Update tests from `.safeParse()` to eforge-owned helpers.
- Add schema parity tests for representative existing valid/invalid payloads, especially daemon events and structured agent submissions.
- Add grep/discipline test to prevent new domain-schema Zod imports outside adapter allowlist.

### Documentation impact

- `docs/roadmap.md`
  - Update the TypeBox roadmap item from an open/scoping question to a concrete direction once this plan is accepted.
  - Suggested wording: TypeBox is canonical for eforge-owned schemas; Zod is isolated to third-party adapters.
- `docs/prd/typescript-extensibility.md`
  - Update extension SDK schema policy to align with the aggressive migration direction.
  - Clarify that extension SDK uses TypeBox because the broader codebase is moving to TypeBox, not merely because Pi does.
- Future `docs/extensions.md` / `docs/extensions-api.md`
  - Should show TypeBox-first examples and eforge parse/helper utilities.
- README / configuration docs may be affected only if user-facing config validation error output changes materially.

Assumption: no immediate end-user CLI behavior docs need changing unless validation error formatting changes. Confidence: medium; validation path is to compare CLI/config error snapshots during migration.

### Out of scope / not primary goal

- Eliminating Zod from the lockfile or transitive dependencies.
- Changing daemon JSON wire shapes.
- Building the full extension SDK in this migration; this work creates prerequisites and schema policy.
- Rewriting unrelated validation behavior or config semantics beyond what is required for TypeBox parity.

Assumption: breaking package-level schema API changes are acceptable because the user is currently the only known user. Confidence: high; user stated this explicitly in conversation.

## Acceptance Criteria

### For the first implementation slice

- A shared TypeBox schema utility exists with eforge-owned parse/safe-parse/error-format helpers and tests.
- `@eforge-build/client` event/wire schemas are authored in TypeBox, with `EforgeEvent` and related types derived via `Static<typeof ...>` or equivalent TypeBox typing.
- Public Zod-specific schema usage such as `EforgeEventSchema.safeParse(...)` is replaced by eforge-owned helpers, e.g. `safeParseEforgeEvent(...)`.
- Existing daemon event JSON wire shapes are preserved; parity tests cover representative valid and invalid events.
- `packages/monitor/src/server.ts` and client tests no longer depend on Zod schema methods for event validation.
- `packages/engine/src/schemas.ts` structured-output schemas are TypeBox-authored and prompt schema YAML generation no longer uses `z.toJSONSchema()`.
- Engine custom tool schema contracts are TypeBox-first, and Pi custom tool execution no longer requires Zod -> JSON Schema -> TypeBox conversion.
- Any remaining Zod usage is isolated in explicit adapter files or documented as a temporary migration holdout.
- `pnpm type-check` and `pnpm test` pass.
- Docs/roadmap and TypeScript extensibility docs reflect the chosen schema policy.

### For the broader migration to be considered complete

- No eforge-owned domain schema source of truth is authored in Zod.
- Direct `zod` dependencies are removed from packages that no longer need Zod except packages containing explicit compatibility adapters.
- A grep/discipline test prevents new domain-schema Zod imports outside the adapter allowlist.
- Config/input schema migrations preserve current user-facing behavior or document intentional changes.
