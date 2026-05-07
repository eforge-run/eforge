---
id: plan-01-decision-protocol-foundation
name: Decision-event wire protocol, engine helper, and reducer foundation
branch: orchestrator-decision-events-emit-typed-events-at-build-phase-orchestrator-decision-points-surface-in-monitor-ui/plan-01-decision-protocol-foundation
---

# Decision-event wire protocol, engine helper, and reducer foundation

## Architecture Context

This plan establishes the **typed surface** for orchestrator decision events. The work is foundational: every other change in this excursion (engine emission sites in plan-02, UI rendering in plan-02) consumes the schema, helper, and reducer slice introduced here.

Key constraint enforced by the codebase: `packages/monitor-ui/src/lib/reducer/index.ts` (lines 300-311) compile-time checks that every variant in `EforgeEvent['type']` is either in `handlerRegistry` or in `IGNORED_EVENT_TYPES`. That means the moment we add `plan:build:decision` to `EforgeEventSchema`, we must also register a handler (or ignore it). We register a handler. Putting it in IGNORED would have to be undone in plan-02 anyway and creates a transient state where a real event type is silently dropped.

The engine helper (`emitBuildDecision`) follows the same discipline as `forgeCommit` (engine commits) and `mutateState` (state mutations) per `AGENTS.md`: one entrypoint, grep-enforced, so emission shape can't drift across the seven decision sites that plan-02 wires.

Umbrella event shape was settled in PRD design-decisions section: `plan:build:decision` with an inner Zod discriminated union over `decision.kind`. Seven kinds: `review-strategy`, `perspectives-inferred`, `cycle-terminated`, `perspectives-respawned`, `evaluator-strictness`, `recovery-verdict`, `merge-conflict-resolution`. Top-level discriminator on `event.type` (existing pattern in `EforgeEventSchema`); inner discriminator on `decision.kind`. Zod `discriminatedUnion` supports nesting; `EforgeEvent` continues to derive via `z.infer`.

## Implementation

### Overview

1. Define `BuildDecisionSchema` (Zod discriminated union over `kind`) and append `plan:build:decision` as a new variant of `EforgeEventVariantsSchema` in `packages/client/src/events.schemas.ts`.
2. Re-export the inferred `BuildDecision` type from `packages/client/src/types.ts`.
3. Bump `DAEMON_API_VERSION` from 25 to 26 in `packages/client/src/api-version.ts` (wire-protocol change per AGENTS.md convention).
4. Add `emitBuildDecision(ctx, decision): EforgeEvent` to a new `packages/engine/src/decisions.ts`. It accepts a `BuildStageContext` (which exposes `planId`) and a typed `BuildDecision`, attaches `timestamp` and `planId`, and returns a fully-formed event object that satisfies `EforgeEvent`.
5. Add a `decisions: Record<string, BuildDecision[]>` slice to `RunState` in `packages/monitor-ui/src/lib/reducer.ts`, including initial-state and reset paths.
6. Add `handlePlanBuildDecision` in a new `packages/monitor-ui/src/lib/reducer/handle-decisions.ts`, mirroring the append-to-nested-record pattern used by `handlePlanBuildReviewPerspectiveComplete` (lines 135-146 of `handle-plan-build.ts`). Append the inner `decision` payload to `decisions[event.planId]`.
7. Register `'plan:build:decision'` in `handlerRegistry` (`packages/monitor-ui/src/lib/reducer/index.ts`). Confirm `_Exhaustive` still resolves to `true`. Do NOT add to `IGNORED_EVENT_TYPES`.
8. Add a Conventions bullet to `AGENTS.md` documenting the `emitBuildDecision` discipline.
9. Bump `eforge-plugin/.claude-plugin/plugin.json` from 0.23.3 to 0.23.4 (user-facing observability surface changes).
10. Tests: schema parses every kind, helper builds correct event shape, reducer appends per-plan and resets correctly.

### Key Decisions

1. **Umbrella event variant, inner discriminated union.** Decisions are conceptually one class of event. One handler, one render path, cheap to extend. (PRD Design Decision 1.)
2. **Closed schemas per kind.** No untyped metadata bag. Every `kind`'s payload is statically typed and Zod-validated.
3. **Always-emit semantics for `review-strategy` and `evaluator-strictness`.** Plan-02 emits these regardless of the chosen value, so consumers don't need to special-case absent decisions. This plan only enforces that the schema permits both `source: 'config' | 'auto-threshold'` for strategy and any value of `strictness` regardless of `source`.
4. **Helper grep gate.** The new convention bullet documents the rule; an actual grep-test (similar to the `mutateState` enforcement in AGENTS.md) is added in plan-02 once emission sites exist. This plan establishes the helper and the convention.
5. **Reducer registration over IGNORED listing.** Adding to `IGNORED_EVENT_TYPES` would silently drop real events; registering a working handler is the same effort and lights up the data path immediately.
6. **Plan-phase deferred.** `planning:decision` is not introduced. Slice is keyed by `planId` only.
7. **Recovery `prdId` vs `planId` reconciliation.** The new variant carries `planId` like every other `plan:build:*` event. Plan-02's recovery emission site will attribute the decision to the failing plan's `planId`. This plan only ensures the schema requires `planId`.

## Scope

### In Scope
- Wire-protocol schemas: `BuildDecisionSchema` and the `plan:build:decision` event variant.
- Re-export `BuildDecision` from `packages/client/src/types.ts`.
- Bump `DAEMON_API_VERSION` to 26.
- New `packages/engine/src/decisions.ts` with `emitBuildDecision(ctx, decision)`.
- `RunState.decisions` slice + initial state + reset paths.
- `handlePlanBuildDecision` handler + registry entry.
- Schema/helper tests at `test/decisions.test.ts` (project convention: tests at repo-root `test/`).
- Reducer-handler tests at `packages/monitor-ui/src/lib/reducer/__tests__/handle-decisions.test.ts` (project convention: UI uses `__tests__/` subdirs).
- AGENTS.md convention bullet.
- Plugin version bump.

### Out of Scope
- Engine emission at build-phase decision sites (plan-02).
- `DecisionTimeline` UI component (plan-02).
- `plan-row.tsx` and `app.tsx` wiring (plan-02).
- `test/agent-wiring.test.ts` integration extension (plan-02).
- `docs/roadmap.md` removal of build-phase bullet (plan-02, after the work lands).
- Plan-phase decision events (deferred follow-up).
- Pi extension code changes (passes through unknown events generically; verified at planning).
- Removing the grep-gate convention into a CI test - plan-02 adds the gate test once emission sites exist.

## Files

### Create
- `packages/engine/src/decisions.ts` — Exports `emitBuildDecision(ctx: BuildStageContext, decision: BuildDecision): EforgeEvent`. Accepts the typed inner-union value, attaches `timestamp: new Date().toISOString()` and `planId: ctx.planId`, returns `{ timestamp, type: 'plan:build:decision', planId, decision }`. Internally validates with `BuildDecisionSchema.parse(decision)` so production code throws on malformed payloads (matches the pattern in other emission helpers in the engine). Exports the `BuildDecision` type re-exported from `@eforge-build/client`.
- `packages/monitor-ui/src/lib/reducer/handle-decisions.ts` — Exports `handlePlanBuildDecision: EventHandler<'plan:build:decision'>`. Implementation: `return { decisions: { ...state.decisions, [planId]: [...(state.decisions[planId] ?? []), event.decision] } }`. Mirrors `handlePlanBuildReviewPerspectiveComplete` (`handle-plan-build.ts:135-146`).
- `test/decisions.test.ts` — Vitest tests covering: (a) `BuildDecisionSchema.parse` succeeds for every kind with all required fields populated; (b) `BuildDecisionSchema.parse` throws on unknown kind, missing `rationale`, malformed kind-specific fields; (c) `emitBuildDecision` returns an event whose `type === 'plan:build:decision'`, `planId === ctx.planId`, and `decision` round-trips through `BuildDecisionSchema.parse`; (d) calling with a malformed decision throws (Zod parse error). Build a minimal `BuildStageContext` stub inline (no mocks; cast through `unknown` per AGENTS.md test conventions).
- `packages/monitor-ui/src/lib/reducer/__tests__/handle-decisions.test.ts` — Vitest tests covering: (a) appends the decision payload to `state.decisions[planId]`; (b) preserves existing decisions for the same `planId`; (c) keys multiple plans independently (decisions on plan-A do not appear under plan-B); (d) returns a partial state slice that the reducer can shallow-merge.

### Modify
- `packages/client/src/events.schemas.ts` — Append `BuildDecisionSchema` near the existing event variants. Use `z.discriminatedUnion('kind', [ ... ])` with seven `z.object({ kind: z.literal(...), rationale: z.string(), ... })` members. Per-kind fields per PRD §Decision 2:
  - `review-strategy`: `strategy: z.enum(['single', 'parallel'])`, `source: z.enum(['config', 'auto-threshold'])`, `auto: z.object({ files: z.number(), lines: z.number(), threshold: z.object({ files: z.number(), lines: z.number() }) }).optional()`.
  - `perspectives-inferred`: `perspectives: z.array(ReviewPerspectiveSchema)`, `categories: z.array(z.string())`, `rules: z.array(z.string())`.
  - `cycle-terminated`: `round: z.number().int().nonnegative()`, `reason: z.enum(['no-issues', 'max-rounds'])`, `issuesRemaining: z.number().int().nonnegative()`.
  - `perspectives-respawned`: `round: z.number().int().nonnegative()`, `perspectives: z.array(ReviewPerspectiveSchema)`, `dropped: z.array(ReviewPerspectiveSchema)`.
  - `evaluator-strictness`: `strictness: z.enum(['strict', 'standard', 'lenient'])`, `source: z.enum(['config', 'default'])`.
  - `recovery-verdict`: `verdict: z.enum(['retry', 'split', 'abandon', 'manual'])`, `successorPrdId: z.string().optional()` (matches the existing `recovery:apply:complete` field name `successorPrdId` confirmed in events.schemas.ts:883-888 — do NOT use `successorPlanId`).
  - `merge-conflict-resolution`: `strategy: z.string()`, `files: z.array(z.string())`.
  Append a new variant to `EforgeEventVariantsSchema`: `z.object({ type: z.literal('plan:build:decision'), planId: z.string(), decision: BuildDecisionSchema })`. Export `BuildDecisionSchema` and the inferred type `BuildDecision = z.infer<typeof BuildDecisionSchema>` near the existing `EforgeEvent` type export. Confirm `EforgeEvent = z.infer<typeof EforgeEventSchema>` continues to type-narrow correctly (TypeScript will catch breakage). Use the existing `ReviewPerspectiveSchema` for perspective fields.
- `packages/client/src/types.ts` — Add `export type { BuildDecision } from './events.schemas';` alongside the existing `EforgeEvent` re-export so downstream packages can import `BuildDecision` from `@eforge-build/client` without reaching into `events.schemas`.
- `packages/client/src/api-version.ts` — `export const DAEMON_API_VERSION = 26;` (was 25). Wire-protocol change.
- `packages/monitor-ui/src/lib/reducer.ts` — Import `BuildDecision` from `@eforge-build/client`. Add `decisions: Record<string, BuildDecision[]>` to `RunState` (place near `reviewIssuesByPerspective` at ~line 102 to mirror the per-plan-keyed pattern). Add `decisions: {}` to the initial-state object at ~line 133. Verify the reset path used on `RESET` resets the slice (the existing `initialRunState` allocation is reused on reset per the explorer report at line 145).
- `packages/monitor-ui/src/lib/reducer/index.ts` — Import `handlePlanBuildDecision` from `./handle-decisions`. Add `'plan:build:decision': handlePlanBuildDecision` to `handlerRegistry`. Do not add `'plan:build:decision'` to `IGNORED_EVENT_TYPES` (it's not currently there - confirmed at planning). Confirm the `_Exhaustive` check at lines 300-311 still resolves to `true` (it must, by construction).
- `AGENTS.md` — Add a new bullet under the Conventions section (after the `mutateState` bullet which is the closest analog), styled to match existing bullets: "All engine code that emits `plan:build:decision` events must call `emitBuildDecision(ctx, decision)` from `packages/engine/src/decisions.ts`. Direct yields of `{ type: 'plan:build:decision', ... }` outside that file are forbidden — a grep gate (added in plan-02 alongside the emission sites) enforces zero hits."
- `eforge-plugin/.claude-plugin/plugin.json` — Bump `version` from `"0.23.3"` to `"0.23.4"`. AGENTS.md convention: any plugin-affecting change bumps the version. Decision events become a user-visible observability surface, even though plan-02 lights them up.

## Verification

- [ ] `BuildDecisionSchema` defined as `z.discriminatedUnion('kind', [...])` with all seven kinds; each member is a `z.object` with `kind: z.literal(...)`, `rationale: z.string()`, and the kind-specific fields listed under Files > Modify > events.schemas.ts.
- [ ] `EforgeEventVariantsSchema` includes a member matching `{ type: 'plan:build:decision', planId: string, decision: BuildDecision }`.
- [ ] `BuildDecision` is exported from `@eforge-build/client` (re-exported through `types.ts`); `import type { BuildDecision } from '@eforge-build/client'` resolves.
- [ ] `DAEMON_API_VERSION === 26` in `packages/client/src/api-version.ts`.
- [ ] `pnpm --filter @eforge-build/client type-check` passes.
- [ ] `packages/engine/src/decisions.ts` exports `emitBuildDecision`; the helper attaches `timestamp` and `planId: ctx.planId` and returns an object whose `type` is the literal `'plan:build:decision'`.
- [ ] `pnpm --filter @eforge-build/engine type-check` passes.
- [ ] `RunState.decisions: Record<string, BuildDecision[]>` exists in `packages/monitor-ui/src/lib/reducer.ts`; `initialRunState.decisions` equals `{}`; the reset path returns a state whose `decisions` field is `{}`.
- [ ] `handlerRegistry['plan:build:decision']` is bound to `handlePlanBuildDecision`; `IGNORED_EVENT_TYPES` does not contain `'plan:build:decision'`.
- [ ] `_Exhaustive` resolves to `true` (verified by `pnpm --filter @eforge-build/monitor-ui type-check` succeeding).
- [ ] `test/decisions.test.ts` passes: schema parses every kind, rejects unknown kinds and malformed payloads, helper attaches `timestamp` and `planId`, helper rejects malformed decisions via Zod parse.
- [ ] `packages/monitor-ui/src/lib/reducer/__tests__/handle-decisions.test.ts` passes: appends to `decisions[planId]`, preserves existing entries, keys plans independently.
- [ ] `pnpm test` passes (no regressions in existing tests).
- [ ] `pnpm type-check` passes across the workspace.
- [ ] `pnpm build` produces a clean bundle.
- [ ] AGENTS.md Conventions section contains a bullet documenting the `emitBuildDecision` discipline; bullet style matches existing convention bullets (lead-bold concept, then explanation).
- [ ] `eforge-plugin/.claude-plugin/plugin.json` `version` field equals `"0.23.4"`.
