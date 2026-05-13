---
id: plan-03-engine-schemas-and-custom-tools
name: Migrate Engine Structured-Output Schemas and Custom-Tool Contracts to TypeBox
branch: aggressively-migrate-eforge-owned-schemas-to-typebox/plan-03-engine-schemas-and-custom-tools
agents:
  builder:
    effort: xhigh
    rationale: Multi-package refactor touching schemas, harness interfaces, two
      backend adapters (Pi and Claude SDK), four submission agents, and all
      engine tests for those agents; the CustomTool inputSchema type swap
      requires careful adapter design.
  reviewer:
    effort: high
    rationale: Adapter correctness at third-party SDK boundaries (Claude SDK tool()
      registration and Pi AgentTool.parameters) is subtle and easy to get wrong.
---

# Migrate Engine Structured-Output Schemas and Custom-Tool Contracts to TypeBox

## Architecture Context

Three changes that must land together because the `CustomTool.inputSchema` type swap cascades through all four submission agents (planner, plan-reviewer, architecture-reviewer, cohesion-reviewer) and both harness backends (Pi and Claude SDK):

1. **Engine structured-output schemas** (`packages/engine/src/schemas.ts`) become TypeBox-authored. `getSchemaYaml()` consumes TypeBox `TSchema` directly - no more `z.toJSONSchema()` intermediate step - because TypeBox schemas are JSON Schema natively.
2. **Custom tool contract** (`packages/engine/src/harness.ts`) changes `CustomTool.inputSchema` from `z.ZodObject<z.ZodRawShape>` to a TypeBox `TObject` (`import type { TObject } from '@sinclair/typebox'`).
3. **Harness adapters** translate the new TypeBox `inputSchema` to each backend:
   - **Pi** (`packages/engine/src/harnesses/pi.ts`): passes the TypeBox schema directly as `AgentTool.parameters`. Removes the existing `z.toJSONSchema(ct.inputSchema) -> jsonSchemaToTypeBox(...)` round-trip.
   - **Claude SDK** (`packages/engine/src/harnesses/claude-sdk.ts`): converts the TypeBox `TObject` to a Zod raw shape via a new local adapter `typeboxObjectToZodRawShape(schema)` before passing it to the SDK's `tool()` helper. This adapter is the explicit third-party compatibility surface per the source PRD's boundary policy.

Four submission agents call `.safeParse(input)` on schemas defined in `schemas.ts`; they migrate to `safeParseWithSchema` from `@eforge-build/client`. `packages/engine/src/plan.ts` and `packages/engine/src/agents/common.ts` use `z.record`, `z.array`, and `z.prettifyError` to compose validators around `agentTuningSchema` and `buildStageSpecSchema` from `schemas.ts`; they migrate to TypeBox composition (`Type.Record`, `Type.Array`) and `formatSchemaError` from `@eforge-build/client`.

The daemon MCP proxy (`packages/eforge/src/cli/mcp-tool-factory.ts`, `packages/eforge/src/cli/mcp-proxy.ts`) is **out of scope for this plan** - those tools are not eforge-owned domain schemas, they are tool-argument schemas at the MCP SDK boundary. They stay Zod-shaped for now and remain on the discipline-test allowlist.

`packages/engine/src/config.ts`, `packages/engine/src/prd-queue.ts`, `packages/input/src/*.ts` are also out of scope for this plan - they migrate in a follow-up PRD.

## Implementation

### Overview

Rewrite `packages/engine/src/schemas.ts` in TypeBox. Change `CustomTool.inputSchema` to TypeBox `TObject`. Add a Claude-SDK adapter (`typeboxObjectToZodRawShape`) inside `packages/engine/src/harnesses/claude-sdk.ts`. Simplify the Pi harness to pass the TypeBox schema through directly. Update all four submission agents to use eforge-owned parse helpers. Update engine plan.ts and agents/common.ts to TypeBox composition. Update affected tests. Update `docs/roadmap.md` and `docs/prd/typescript-extensibility.md` to reflect the new schema policy.

### Key Decisions

1. **`getSchemaYaml` rewrite**: replaces the Zod-flavored implementation with a TypeBox-flavored one that re-uses `getSchemaYaml` from `@eforge-build/client/schema-utils` (plan-01). The engine's local function becomes a thin re-export or is removed in favor of importing the shared helper.
2. **CustomTool type**: `inputSchema: TObject<TProperties>`. The `.shape` access in claude-sdk.ts becomes `inputSchema.properties` traversal in the adapter.
3. **Claude SDK adapter location**: `typeboxObjectToZodRawShape` lives inside `packages/engine/src/harnesses/claude-sdk.ts` (an explicit adapter file). It is the ONLY place under `packages/engine/src/` that imports Zod after this plan, and it must be added to the discipline-test allowlist with a comment explaining why.
4. **Adapter scope**: `typeboxObjectToZodRawShape` only needs to handle the TypeBox kinds eforge actually uses in its submission tools - `TObject`, `TString`, `TNumber`, `TInteger`, `TBoolean`, `TArray`, `TLiteral`, `TUnion`, `TOptional`, `TRecord`. Unknown kinds throw. Keep it minimal so future maintenance reviews can reason about it.
5. **Pi simplification**: in `pi.ts`, the existing path inside `if (options.customTools && options.customTools.length > 0)` no longer dynamic-imports `jsonSchemaToTypeBox` or calls `z.toJSONSchema(ct.inputSchema)`. It assigns `parameters: ct.inputSchema` directly. The `jsonSchemaToTypeBox` helper in `pi-mcp-bridge.ts` stays - it is still needed for external MCP tool conversion.
6. **Submission schema migration**: `planSetSubmissionSchema`, `architectureSubmissionSchema`, `planReviewSubmissionSchema`, `cohesionReviewSubmissionSchema`, `architectureReviewSubmissionSchema`, `pipelineCompositionSchema`, and every supporting schema (`reviewIssueSchema`, `evaluationVerdictSchema`, `recoveryVerdictSchema`, `stalenessVerdictSchema`, `clarificationQuestionSchema`, `expeditionModuleSchema`, `agentTuningSchema`, `shardScopeSchema`, `planFileFrontmatterSchema`, `testIssueSchema`) become TypeBox. `.describe(...)` becomes `Type.String({ description: '...' })` etc. or the `description` option on the TypeBox builder.
7. **`.superRefine` cross-field checks**: `planSetSubmissionSchema` and `architectureSubmissionSchema` use `.superRefine` for duplicate-ID, dangling-dependency, and cycle-detection checks. TypeBox has no superRefine equivalent; the checks move to a post-parse helper (e.g. `validatePlanSetSubmission(parsed)`) called by the planner agent right after `safeParseWithSchema`. Result type stays the same shape (`{ success, data, error }`) so callsites change minimally.
8. **`agentTuningSchema` shard refine**: `shardScopeSchema.refine(...)` (require `roots` or `files`) also moves to a post-parse helper.
9. **Docs**: `docs/roadmap.md` updates the TypeBox bullet from "needs a dedicated scoping session" to a concrete statement that TypeBox is canonical for eforge-owned schemas. `docs/prd/typescript-extensibility.md` clarifies that extension SDK uses TypeBox because the wider codebase is migrating to TypeBox, not merely because Pi does.
10. **Dependency hygiene**: `zod` stays in `packages/engine/package.json` because `config.ts`, `prd-queue.ts`, `plan.ts` (until this plan's edits), and `claude-sdk.ts` (the adapter) still need it. We do **not** remove `zod` from engine in this plan.
11. **Discipline test tightening**: `test/zod-import-allowlist.test.ts` removes `packages/engine/src/schemas.ts`, `packages/engine/src/harness.ts`, `packages/engine/src/harnesses/pi.ts`, `packages/engine/src/plan.ts`, `packages/engine/src/agents/common.ts`, `packages/engine/src/agents/planner.ts`, `packages/engine/src/agents/plan-reviewer.ts`, `packages/engine/src/agents/architecture-reviewer.ts`, and `packages/engine/src/agents/cohesion-reviewer.ts` from the allowlist. Allowlist retains: `config.ts`, `prd-queue.ts`, `harnesses/claude-sdk.ts` (with adapter rationale comment), `eforge/src/cli/mcp-proxy.ts`, `eforge/src/cli/mcp-tool-factory.ts`, and the two input package files.

## Scope

### In Scope
- Rewrite `packages/engine/src/schemas.ts` in TypeBox while preserving every schema name, every field, every optional/required marker, and every existing description string
- Move `.superRefine(...)` checks (`planSetSubmissionSchema`, `architectureSubmissionSchema`) and `.refine(...)` checks (`shardScopeSchema`) to exported post-parse validator helpers: `validatePlanSetSubmission`, `validateArchitectureSubmission`, `validateShardScope`. Each returns `SafeParseResult<T>` from `@eforge-build/client/schema-utils`
- Replace local `getSchemaYaml` in `schemas.ts` with calls to the shared helper from `@eforge-build/client`
- Change `CustomTool.inputSchema` in `packages/engine/src/harness.ts` from `z.ZodObject<z.ZodRawShape>` to `TObject` (import from `@sinclair/typebox`)
- Simplify the custom-tool conversion path in `packages/engine/src/harnesses/pi.ts` to pass `ct.inputSchema` directly into `ToolDefinition.parameters`. Remove the dynamic import of `jsonSchemaToTypeBox` and the `z.toJSONSchema(ct.inputSchema)` call. Remove the now-unused `import { z } from 'zod/v4'` from `pi.ts`
- Add `typeboxObjectToZodRawShape(schema: TObject): ZodRawShape` adapter inside `packages/engine/src/harnesses/claude-sdk.ts` covering at least `TObject`, `TString`, `TNumber`, `TInteger`, `TBoolean`, `TArray`, `TLiteral`, `TUnion`, `TOptional`, `TRecord`. Replace `ct.inputSchema.shape` with `typeboxObjectToZodRawShape(ct.inputSchema)` at the `tool(...)` callsite
- Migrate every `.safeParse(input)` call on a `schemas.ts` schema in `packages/engine/src/agents/planner.ts`, `plan-reviewer.ts`, `architecture-reviewer.ts`, and `cohesion-reviewer.ts` to `safeParseWithSchema(schema, input)` from `@eforge-build/client`. Replace any `.parse` calls similarly. After the post-parse validator helpers run, callsites that previously relied on `.superRefine` should call the helper to surface the cross-field errors
- Migrate `packages/engine/src/plan.ts` Zod-composition over `agentTuningSchema` / `buildStageSpecSchema` to TypeBox (`Type.Record`, `Type.Array`) and replace `z.prettifyError` with `formatSchemaError`
- Migrate `packages/engine/src/agents/common.ts` `buildConfigSchema.safeParse(parsed)` to `safeParseWithSchema(buildConfigSchema, parsed)` and switch the local schema definition to TypeBox where it references `schemas.ts` schemas (keep config-specific schemas in Zod if they originate from config.ts to respect the plan boundary)
- Update affected tests: `test/schemas.test.ts`, `test/submission-schemas.test.ts`, `test/plan-writers.test.ts`, `test/recovery.test.ts`, `test/plan-review-fix-application.test.ts`, `test/sharded-implement-stage.test.ts`, `test/reviewer-verify.test.ts`, `test/parallel-reviewer-perspective-validation.test.ts` to call `safeParseWithSchema` instead of `.safeParse`
- Update `docs/roadmap.md`: rewrite the TypeBox bullet from "needs a dedicated scoping session - previously punted on" to a concrete statement: "TypeBox is canonical for eforge-owned domain schemas; Zod is isolated to third-party SDK compatibility adapters"
- Update `docs/prd/typescript-extensibility.md`: clarify in the "TypeBox for public schemas" section and the "TypeBox schema unification" prerequisite that the migration is in progress, with the first slice (this plan plus plan-01 and plan-02) covering client wire schemas, engine structured output, and custom-tool contracts. Note that config, input artifact, and MCP proxy schemas remain Zod for now
- Tighten the discipline-test allowlist: remove `schemas.ts`, `harness.ts`, `harnesses/pi.ts`, `plan.ts`, `agents/common.ts`, `agents/planner.ts`, `agents/plan-reviewer.ts`, `agents/architecture-reviewer.ts`, `agents/cohesion-reviewer.ts`. Add a comment explaining that `harnesses/claude-sdk.ts` remains on the allowlist because it contains the explicit TypeBox-to-Zod adapter

### Out of Scope
- Migrating `packages/engine/src/config.ts` (defer to follow-up PRD; involves `.partial()`, `.passthrough()`, `.superRefine`, legacy-key diagnostics)
- Migrating `packages/engine/src/prd-queue.ts`
- Migrating `packages/input/src/playbook.ts` and `packages/input/src/session-plan.ts`
- Migrating `packages/eforge/src/cli/mcp-tool-factory.ts` and `packages/eforge/src/cli/mcp-proxy.ts` (MCP SDK adapter surface, not eforge domain schemas)
- Removing `zod` from any package's `package.json`
- Changing prompt YAML content beyond what naturally falls out of TypeBox's JSON-schema rendering - schema YAML outputs should remain semantically equivalent (test that the schema text rendered by `getSchemaYaml` still describes the same fields with the same descriptions; minor key-ordering differences are acceptable)

## Files

### Modify
- `packages/engine/src/schemas.ts` - rewrite all schemas in TypeBox; replace `.superRefine`/`.refine` with exported post-parse validators; replace local `getSchemaYaml` with import from `@eforge-build/client`
- `packages/engine/src/harness.ts` - change `CustomTool.inputSchema` to TypeBox `TObject`; remove `import type { z } from 'zod/v4'`
- `packages/engine/src/harnesses/pi.ts` - pass `ct.inputSchema` directly as `parameters`; drop `z.toJSONSchema` + `jsonSchemaToTypeBox` round-trip; drop the `import { z } from 'zod/v4'` line
- `packages/engine/src/harnesses/claude-sdk.ts` - add `typeboxObjectToZodRawShape` adapter; replace `ct.inputSchema.shape` with `typeboxObjectToZodRawShape(ct.inputSchema)`; add an `import { z } from 'zod'` and a header comment explaining the adapter exists to satisfy the Claude Agent SDK's Zod-shape registration requirement
- `packages/engine/src/agents/planner.ts` - replace `planSetSubmissionSchema.safeParse(input)` and `architectureSubmissionSchema.safeParse(input)` with `safeParseWithSchema` + the new validator helpers
- `packages/engine/src/agents/plan-reviewer.ts` - migrate `planReviewSubmissionSchema.safeParse` callsites
- `packages/engine/src/agents/architecture-reviewer.ts` - migrate `architectureReviewSubmissionSchema.safeParse` callsites
- `packages/engine/src/agents/cohesion-reviewer.ts` - migrate `cohesionReviewSubmissionSchema.safeParse` callsites
- `packages/engine/src/agents/common.ts` - migrate `buildConfigSchema.safeParse` to `safeParseWithSchema` (preserve config-side Zod schemas if `buildConfigSchema` is defined in config.ts; otherwise migrate the local one to TypeBox)
- `packages/engine/src/plan.ts` - replace `z.record(z.string(), agentTuningSchema)` and `z.array(buildStageSpecSchema)` with `Type.Record(Type.String(), agentTuningSchema)` and `Type.Array(buildStageSpecSchema)`; replace `z.prettifyError(...)` with `formatSchemaError(...)` from `@eforge-build/client`; replace `safeParse` calls with `safeParseWithSchema`
- `test/schemas.test.ts` - update to call `safeParseWithSchema` and the new post-parse validators
- `test/submission-schemas.test.ts` - same
- `test/plan-writers.test.ts` - same
- `test/recovery.test.ts` - same
- `test/plan-review-fix-application.test.ts` - same
- `test/sharded-implement-stage.test.ts` - same
- `test/reviewer-verify.test.ts` - same
- `test/parallel-reviewer-perspective-validation.test.ts` - same
- `test/zod-import-allowlist.test.ts` - tighten allowlist as listed above
- `docs/roadmap.md` - update the TypeBox bullet to the new policy statement
- `docs/prd/typescript-extensibility.md` - update the TypeBox schema unification section to reflect first-slice completion

## Verification

- [ ] `packages/engine/src/schemas.ts` contains zero `from 'zod` import statements
- [ ] `packages/engine/src/harness.ts` contains zero `from 'zod` import statements
- [ ] `packages/engine/src/harnesses/pi.ts` contains zero `from 'zod` import statements
- [ ] `packages/engine/src/harnesses/claude-sdk.ts` contains exactly one `from 'zod'` import statement, accompanied by a header comment explaining the adapter
- [ ] `CustomTool.inputSchema` is typed as `TObject` (from `@sinclair/typebox`) in `packages/engine/src/harness.ts`
- [ ] `typeboxObjectToZodRawShape` exists in `packages/engine/src/harnesses/claude-sdk.ts` and handles all of `TObject`, `TString`, `TNumber`, `TInteger`, `TBoolean`, `TArray`, `TLiteral`, `TUnion`, `TOptional`, `TRecord`; unknown kinds throw with a clear error message
- [ ] `packages/engine/src/harnesses/pi.ts` no longer calls `z.toJSONSchema(ct.inputSchema)` and no longer dynamically imports `jsonSchemaToTypeBox` for engine custom tools (`grep -n 'z.toJSONSchema\|jsonSchemaToTypeBox' packages/engine/src/harnesses/pi.ts` returns no matches)
- [ ] All four submission agents (`planner.ts`, `plan-reviewer.ts`, `architecture-reviewer.ts`, `cohesion-reviewer.ts`) call `safeParseWithSchema` instead of `.safeParse` on schemas defined in `schemas.ts`
- [ ] Post-parse validator helpers `validatePlanSetSubmission`, `validateArchitectureSubmission`, `validateShardScope` are exported from `schemas.ts` and invoked by the planner / shard parsing path to preserve cross-field error coverage (duplicate IDs, dangling deps, cycles, shard `roots`/`files` requirement)
- [ ] `test/schemas.test.ts` passes - every existing assertion about valid/invalid inputs holds under TypeBox
- [ ] `test/submission-schemas.test.ts` passes - duplicate-ID, dangling-dependency, and cycle-detection tests cover the post-parse validators
- [ ] `test/plan-writers.test.ts`, `test/recovery.test.ts`, `test/plan-review-fix-application.test.ts`, `test/sharded-implement-stage.test.ts`, `test/reviewer-verify.test.ts`, `test/parallel-reviewer-perspective-validation.test.ts` all pass without `.safeParse` calls on schemas defined in `schemas.ts`
- [ ] Discipline test `test/zod-import-allowlist.test.ts` rejects a fresh `from 'zod` import added under any of: `packages/engine/src/schemas.ts`, `harness.ts`, `harnesses/pi.ts`, `plan.ts`, `agents/common.ts`, `agents/planner.ts`, `agents/plan-reviewer.ts`, `agents/architecture-reviewer.ts`, `agents/cohesion-reviewer.ts`
- [ ] `docs/roadmap.md` no longer contains the phrase "needs a dedicated scoping session" in the TypeBox bullet and instead states TypeBox is canonical for eforge-owned schemas
- [ ] `docs/prd/typescript-extensibility.md` reflects the first-slice scope (client events + engine structured output + custom-tool contracts migrated; config + input + MCP proxy deferred)
- [ ] `pnpm --filter @eforge-build/engine type-check` exits 0
- [ ] `pnpm --filter @eforge-build/eforge type-check` exits 0
- [ ] `pnpm test` from the repo root exits 0
- [ ] `pnpm build` from the repo root exits 0
- [ ] An end-to-end smoke test of the planner submission flow (already covered by `test/planner-submission.test.ts` and `test/submission-schemas.test.ts`) passes - submitted plan sets round-trip through `safeParseWithSchema` + post-parse validators and reach the orchestrator with the same fields they had under Zod
- [ ] Pi custom-tool registration test (existing `test/agent-wiring.test.ts` or similar that exercises `customTools`) passes - `AgentTool.parameters` is the TypeBox schema directly
- [ ] Claude SDK custom-tool registration test passes - `tool(name, desc, zodRawShape, handler)` receives a valid Zod raw shape from `typeboxObjectToZodRawShape`
