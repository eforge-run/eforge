---
id: plan-01-schema-utility
name: Shared TypeBox Schema Utility Layer
branch: aggressively-migrate-eforge-owned-schemas-to-typebox/plan-01-schema-utility
agents:
  builder:
    effort: high
    rationale: Foundation module whose design (helper signatures, error format, YAML
      stripping) cascades into the next two plans; getting the API shape right
      is more valuable than typical.
---

# Shared TypeBox Schema Utility Layer

## Architecture Context

This plan establishes the foundation for migrating eforge-owned domain schemas from Zod to TypeBox. Per the source PRD's boundary policy, eforge consumers must call eforge-owned parse helpers (e.g. `safeParseEforgeEvent`, `safeParseWithSchema`) instead of validator-library methods like `.safeParse()`, so future implementation swaps do not ripple through every callsite. TypeBox is canonical for eforge-owned schemas; Zod remains only inside explicit third-party SDK adapters.

The utility module lives in `@eforge-build/client` because client is the shared dependency for engine, monitor, pi-eforge, and eforge CLI, and client already owns event/wire schemas that the next plan migrates. `@sinclair/typebox` is added as a direct dependency of `@eforge-build/client`. This avoids creating a new workspace package for a small surface.

## Implementation

### Overview

Add a TypeBox-backed schema utility module to `@eforge-build/client` that exposes generic safe-parse / parse / error-format / schema-YAML helpers. No existing schemas are migrated in this plan - it provides the building blocks plan-02 and plan-03 will consume.

### Key Decisions

1. **Location**: utility lives in `@eforge-build/client` as `schema-utils.ts`, re-exported from the package root. Avoids a new workspace package while keeping the helpers reachable from every downstream package.
2. **Result shape**: `SafeParseResult<T> = { success: true; data: T } | { success: false; error: SchemaError }`. Closely mirrors Zod's familiar shape so consumer migration is mechanical. `SchemaError` wraps TypeBox `ValueError[]` plus a formatted message.
3. **Validation backend**: use TypeBox `Value.Check` + `Value.Errors` for ad-hoc validation (no precompiled cache yet to keep the first slice small). A compiled-validator cache may be added later if a profile shows it matters.
4. **Error formatting**: `formatSchemaError(error)` returns a multi-line human-readable string with `path: message` per error, matching the readability bar set by `z.prettifyError()`.
5. **Schema-to-YAML**: `getSchemaYaml(key, schema)` accepts a TypeBox `TSchema`, strips internal keys (`$id`, `$schema`, `~standard`, `static`, `params`, `kind`), and stringifies via `yaml`. Replaces the `z.toJSONSchema()` step in `packages/engine/src/schemas.ts`. Caches by `key` since schemas are static.
6. **Discipline test scaffolding**: include a placeholder grep-style test that asserts a specific allowlist file for Zod imports across `packages/`. The allowlist starts permissive (includes all files that still use Zod today) and tightens in plan-02 and plan-03.

## Scope

### In Scope
- New module `packages/client/src/schema-utils.ts` exporting:
  - `safeParseWithSchema<T extends TSchema>(schema: T, value: unknown): SafeParseResult<Static<T>>`
  - `parseWithSchema<T extends TSchema>(schema: T, value: unknown): Static<T>` (throws on failure)
  - `formatSchemaError(error: SchemaError): string`
  - `getSchemaYaml(key: string, schema: TSchema): string` (cached, strips internal keys)
  - `SafeParseResult<T>`, `SchemaError` type exports
- Public re-exports from `packages/client/src/index.ts`
- Add `@sinclair/typebox` to `packages/client/package.json` direct dependencies (pinned to the same range Pi already uses, e.g. `^0.34.49`)
- Unit tests in `packages/client/src/__tests__/schema-utils.test.ts` covering:
  - Successful parse round-trip with a simple TypeBox object schema
  - `safeParseWithSchema` returning `{ success: false, error }` for invalid input
  - `parseWithSchema` throwing for invalid input with the formatted message in the thrown error
  - `formatSchemaError` rendering multiple errors with path + message
  - `getSchemaYaml` producing the same YAML for two calls (cache hit)
  - `getSchemaYaml` stripping `$schema`, `~standard`, and TypeBox-internal symbols/keys
- Discipline test `test/zod-import-allowlist.test.ts` that:
  - Greps for `from 'zod` (with and without `/v4` suffix) across `packages/**/src/**/*.ts`
  - Asserts every match is in an explicit allowlist constant defined in the test file
  - Initial allowlist contains every file currently importing Zod, so the test passes today; plan-02 and plan-03 will remove entries as files migrate

### Out of Scope
- Migrating any existing Zod schemas (deferred to plan-02 and plan-03)
- Precompiled validator cache (`TypeCompiler.Compile`) - may be added later if profiling shows it matters
- Changing `packages/engine/src/schemas.ts`, `packages/client/src/events.schemas.ts`, or any consumer
- Removing the `zod` dependency from any package

## Files

### Create
- `packages/client/src/schema-utils.ts` - the TypeBox utility helpers and types
- `packages/client/src/__tests__/schema-utils.test.ts` - vitest coverage for the helpers
- `test/zod-import-allowlist.test.ts` - discipline test with initial allowlist of all current Zod-importing files

### Modify
- `packages/client/src/index.ts` - re-export the new helpers and types (`safeParseWithSchema`, `parseWithSchema`, `formatSchemaError`, `getSchemaYaml`, `SafeParseResult`, `SchemaError`)
- `packages/client/package.json` - add `@sinclair/typebox` direct dependency
- `pnpm-lock.yaml` - regenerated by `pnpm install` for the new client dependency

## Verification

- [ ] `pnpm install` succeeds and `@sinclair/typebox` is resolved as a direct dependency of `@eforge-build/client` (verify via `pnpm why @sinclair/typebox` showing client as an importer)
- [ ] `packages/client/src/schema-utils.ts` exports exactly: `safeParseWithSchema`, `parseWithSchema`, `formatSchemaError`, `getSchemaYaml`, `SafeParseResult`, `SchemaError`
- [ ] All six exports are reachable from `import { ... } from '@eforge-build/client'`
- [ ] `safeParseWithSchema` with a valid input returns `{ success: true, data }` where `data` is `Static<typeof schema>`-typed
- [ ] `safeParseWithSchema` with an invalid input returns `{ success: false, error }` where `error.message` is a non-empty multi-line string
- [ ] `parseWithSchema` throws an `Error` whose `message` matches `formatSchemaError(error)` for invalid input
- [ ] `getSchemaYaml('test-key', schema)` produces deterministic output across two invocations (cache hit returns the same string instance)
- [ ] `getSchemaYaml` output contains no keys named `$schema`, `~standard`, `kind`, or `static`
- [ ] Discipline test `test/zod-import-allowlist.test.ts` passes with an allowlist that exactly matches the set of files currently importing Zod under `packages/**/src/**/*.ts`
- [ ] `pnpm --filter @eforge-build/client type-check` exits 0
- [ ] `pnpm --filter @eforge-build/client test` exits 0
- [ ] `pnpm test` from the repo root exits 0 (all existing tests still pass)
