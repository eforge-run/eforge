---
id: plan-02-client-events
name: Migrate @eforge-build/client Event/Wire Schemas to TypeBox
branch: aggressively-migrate-eforge-owned-schemas-to-typebox/plan-02-client-events
agents:
  builder:
    effort: xhigh
    rationale: Large mechanical migration of the daemon wire-protocol source of
      truth with a parity-test requirement; one missed optional/required marker
      silently drifts the JSON contract.
  reviewer:
    effort: high
    rationale: Reviewer must verify TypeBox optional/union/literal markers produce
      the same JSON acceptance set as the original Zod schemas.
---

# Migrate @eforge-build/client Event/Wire Schemas to TypeBox

## Architecture Context

`packages/client/src/events.schemas.ts` is the daemon SSE wire-protocol source of truth. `EforgeEvent` is currently derived via `z.infer<typeof EforgeEventSchema>`; `packages/monitor/src/server.ts` calls `EforgeEventSchema.safeParse(...)` to validate every incoming SSE payload before persisting it. This plan rewrites the file in TypeBox, derives `EforgeEvent` via `Static<typeof EforgeEventSchema>`, and replaces public Zod schema-method usage with eforge-owned parse helpers from `@eforge-build/client/schema-utils` (introduced in plan-01).

The wire-shape contract is **mandatory unchanged**. Parity tests over representative valid and invalid events guard against accidental drift. `DAEMON_API_VERSION` is **not** bumped because the JSON wire payloads are intentionally identical.

Claim: the user is the only known user of `@eforge-build/client`, so this plan deliberately breaks the public TypeScript schema API (`EforgeEventSchema.safeParse(...)` no longer works) rather than maintaining dual exports. New helper `safeParseEforgeEvent(value)` replaces it.

## Implementation

### Overview

Replace every `z.object`, `z.literal`, `z.enum`, `z.union`, `z.array`, `z.record`, `z.discriminatedUnion`, `z.string`, `z.number`, `z.boolean`, `z.unknown`, and `.optional()` / `.nullable()` / `.passthrough()` call site in `events.schemas.ts` with the TypeBox equivalent (`Type.Object`, `Type.Literal`, `Type.Union(Type.Literal(...))`, `Type.Union`, `Type.Array`, `Type.Record`, `Type.String`, `Type.Number`, `Type.Boolean`, `Type.Unknown`, `Type.Optional`, `Type.Union([Type.Null(), ...])`, etc.). Discriminated unions become `Type.Union` of `Type.Object` variants - TypeBox's discriminated-union ergonomics are looser than Zod's but `Value.Check` still works correctly for our use cases.

Update every consumer that imported `EforgeEventSchema` as a validator object to call `safeParseEforgeEvent` instead.

### Key Decisions

1. **Single export name kept**: `EforgeEventSchema` remains the export name, but is now a `TSchema` rather than a `ZodType`. Tests no longer call `.safeParse()` on it directly.
2. **New helpers in events module**: `safeParseEforgeEvent(value)` and `parseEforgeEvent(value)` wrap `safeParseWithSchema(EforgeEventSchema, value)` / `parseWithSchema(EforgeEventSchema, value)`. Same shape for `DaemonStreamSnapshotSchema` and `SessionStreamSnapshotSchema`: `safeParseDaemonStreamSnapshot`, `safeParseSessionStreamSnapshot`.
3. **Types via `Static<>`**: every existing `z.infer<typeof X>` becomes `Static<typeof X>`. Type names (`EforgeEvent`, `PlanState`, `AgentResultData`, etc.) stay identical so downstream code does not change.
4. **Envelope composition**: `EforgeEventSchema = EventEnvelopeSchema.and(EforgeEventVariantsSchema)` becomes `Type.Intersect([EventEnvelopeSchema, EforgeEventVariantsSchema])`.
5. **Optional vs required**: every Zod field with `.optional()` becomes `Type.Optional(...)`. Every required field stays required. This is the highest-risk translation step and is what the parity tests guard.
6. **Passthrough handling**: Zod uses `z.object({}).passthrough()` for thinking-config fields. TypeBox equivalent is `Type.Object({}, { additionalProperties: true })` or `Type.Unknown()` depending on how the field is consumed. Use `Type.Record(Type.String(), Type.Unknown())` where the field's contents are not introspected; otherwise prefer `Type.Object({}, { additionalProperties: true })`.
7. **Discriminated unions**: `z.discriminatedUnion('type', [...])` becomes `Type.Union([...])`. `Value.Check` walks every variant; the runtime performance hit is acceptable for SSE-rate validation.
8. **Dependency removal**: `zod` is removed from `packages/client/package.json` after the migration. The discipline-test allowlist drops every `packages/client/src/**` entry.

## Scope

### In Scope
- Rewrite `packages/client/src/events.schemas.ts` in TypeBox while preserving every variant, every field, and every optional/required marker
- Replace `z.infer<typeof X>` with `Static<typeof X>` for every type alias in the file
- Add `safeParseEforgeEvent`, `parseEforgeEvent`, `safeParseDaemonStreamSnapshot`, `safeParseSessionStreamSnapshot` helpers (use `safeParseWithSchema` / `parseWithSchema` from plan-01)
- Update `packages/monitor/src/server.ts` to call `safeParseEforgeEvent(parsed)` instead of `EforgeEventSchema.safeParse(parsed)`
- Update `packages/client/src/__tests__/events-schemas.test.ts` to use the new helpers and to validate the same valid/invalid examples
- Add `packages/client/src/__tests__/events-wire-parity.test.ts`: a fixture-driven parity test that exercises at least one representative payload per discriminant variant (use the existing event fixtures already present in tests) and confirms both:
  - All known-good payloads `Value.Check` as `true`
  - A small set of known-bad payloads (missing required field, wrong literal, extra unexpected discriminant) `Value.Check` as `false` with a useful `formatSchemaError` message
- Remove `zod` from `packages/client/package.json` dependencies
- Tighten the discipline test allowlist in `test/zod-import-allowlist.test.ts` so that `packages/client/src/**` is no longer permitted to import Zod (failing if any sneak in)

### Out of Scope
- Wire payload changes (intentional zero JSON drift)
- Bumping `DAEMON_API_VERSION` (no wire breakage)
- Migrating `packages/engine/src/schemas.ts` (plan-03)
- Migrating `packages/engine/src/config.ts` or input schemas
- Removing Zod from any other package than `@eforge-build/client`

## Files

### Create
- `packages/client/src/__tests__/events-wire-parity.test.ts` - representative valid/invalid payload parity tests

### Modify
- `packages/client/src/events.schemas.ts` - rewrite from Zod to TypeBox; add `safeParseEforgeEvent` / `parseEforgeEvent` / `safeParseDaemonStreamSnapshot` / `safeParseSessionStreamSnapshot`
- `packages/client/src/events.ts` - re-export the new helpers alongside existing event-type exports
- `packages/client/src/index.ts` - add `safeParseEforgeEvent`, `parseEforgeEvent`, `safeParseDaemonStreamSnapshot`, `safeParseSessionStreamSnapshot` to the public exports; keep `EforgeEventSchema` exported (as a TypeBox `TSchema` now)
- `packages/client/src/__tests__/events-schemas.test.ts` - replace `.safeParse()` calls with `safeParseEforgeEvent`
- `packages/client/package.json` - remove `zod` from `dependencies`
- `packages/monitor/src/server.ts` - replace `EforgeEventSchema.safeParse(parsed)` with `safeParseEforgeEvent(parsed)` (matching the existing result-shape access pattern: `result.success` / `result.data` / `result.error`)
- `test/zod-import-allowlist.test.ts` - remove `packages/client/src/**` entries from the allowlist
- `pnpm-lock.yaml` - regenerated by `pnpm install` after removing client's `zod` dep

## Verification

- [ ] `packages/client/src/events.schemas.ts` contains zero `from 'zod` import statements
- [ ] `packages/client/package.json` lists `@sinclair/typebox` in dependencies and no longer lists `zod`
- [ ] `EforgeEventSchema` is exported as a TypeBox `TSchema` (verifiable via `EforgeEventSchema[Symbol.for('TypeBox.Kind')]` returning a defined value, or via `Value.Check(EforgeEventSchema, ...)` working)
- [ ] `type EforgeEvent` resolves identically to its prior Zod-inferred shape (verify by constructing every discriminant variant in a type-only test and confirming each assigns to `EforgeEvent`)
- [ ] Every existing valid event fixture in `events-schemas.test.ts` passes `safeParseEforgeEvent` with `success: true`
- [ ] Every existing invalid event fixture in `events-schemas.test.ts` fails `safeParseEforgeEvent` with `success: false` and a non-empty `error.message`
- [ ] `events-wire-parity.test.ts` covers at least one valid payload per discriminant variant and at least three categories of invalid payloads (missing required field, wrong literal, unknown discriminant)
- [ ] `packages/monitor/src/server.ts` no longer references `EforgeEventSchema.safeParse` (`grep -n 'EforgeEventSchema.safeParse' packages/monitor/src/server.ts` returns no matches)
- [ ] `packages/monitor/src/server.ts` calls `safeParseEforgeEvent` from `@eforge-build/client` and uses `result.success` / `result.data` / `result.error` identically to the previous code path (no behavior change for the persisted event record)
- [ ] Discipline test in `test/zod-import-allowlist.test.ts` fails if a new `from 'zod` import is added under `packages/client/src/**`
- [ ] `pnpm --filter @eforge-build/client type-check` exits 0
- [ ] `pnpm --filter @eforge-build/monitor type-check` exits 0
- [ ] `pnpm --filter @eforge-build/client test` exits 0
- [ ] `pnpm test` from the repo root exits 0
- [ ] `DAEMON_API_VERSION` constant in `packages/client/src/api-version.ts` is unchanged from main
