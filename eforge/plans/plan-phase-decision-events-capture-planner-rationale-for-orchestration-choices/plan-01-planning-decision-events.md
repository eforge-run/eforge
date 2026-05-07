---
id: plan-01-planning-decision-events
name: "Planning decision events: wire, engine, and UI"
branch: plan-phase-decision-events-capture-planner-rationale-for-orchestration-choices/plan-01-planning-decision-events
---

# Planning decision events: wire, engine, and UI

## Architecture Context

Build-phase decisions shipped at API v26 via `BuildDecisionSchema` (discriminated union over 7 kinds, each with `rationale: string`), emitted through `emitBuildDecision`/`emitBuildDecisionForPlan` in `packages/engine/src/decisions.ts` (single-source helper guarded by a grep gate at `test/decision-helper-discipline.test.ts`), reduced into `decisions: Record<string, BuildDecision[]>` at `packages/monitor-ui/src/lib/reducer.ts:104`, and rendered by `DecisionTimeline` in `packages/monitor-ui/src/components/pipeline/decision-timeline.tsx`.

This plan mirrors that pattern for the planner: a new `planning:decision` event variant covering planner rationale for per-plan build/review overrides, plan-set shape, and per-role agent-tier tuning. The existing `planning:pipeline.rationale` (composer defaults) stays as-is — the new events cover *additional* planner choices below the composer's defaults.

Key constraints:
- Wire protocol owned by `@eforge-build/client` (see AGENTS.md). Bump `DAEMON_API_VERSION` 26 → 27.
- Single-emission helper file with grep gate (extends existing `decisions.ts` discipline, not a sibling file).
- `EforgeEvent` is a discriminated union over `type`; the reducer in `packages/monitor-ui/src/lib/reducer/index.ts` enforces compile-time exhaustiveness — every new variant must either appear in `handlerRegistry` or `IGNORED_EVENT_TYPES`.
- Schemas are single-source-of-truth: `EforgeEvent` is derived via `z.infer<typeof EforgeEventSchema>`. Don't add types separately.
- Do NOT edit `CHANGELOG.md` (managed by release flow). The api-version.ts changelog comment is the right place for the version bump note.
- Monitor UI uses shadcn/ui components — do not introduce custom UI primitives.

## Implementation

### Overview

Add a `planning:decision` event variant carrying a discriminated `PlanningDecision` payload (4 V1 kinds) and surface it in the monitor UI in three layers:

1. **Wire protocol** (`@eforge-build/client`): new schema, new event variant, new registry entry, version bump.
2. **Engine** (`packages/engine`): extend orchestration/plan-set submission schemas with optional rationale fields; thread composer defaults to the planner; emit four decisions immediately before `planning:complete`; update `planner.md` prompt; remove the roadmap bullet.
3. **Monitor UI** (`packages/monitor-ui`): widen the `decisions` slice to a union, add a planning-phase event handler with `'__run__'` sentinel routing for run-scoped decisions, extend `DecisionTimeline` with planning-phase color and tooltip summaries, render `decisions['__run__']` as a header band above per-plan rows in `thread-pipeline.tsx`.

### Key Decisions

1. **Single emission helper file (`decisions.ts`) for both phases** — one grep gate, one discipline. The header comment must be updated to cover both `plan:build:decision` and `planning:decision`.
2. **Sibling rationale fields in plan/orchestration schemas** — `buildRationale`/`reviewRationale` live on each `orchestrationPlanSchema` entry; `planSetShapeRationale` is a top-level field on `planSetSubmissionSchema`. Optional for back-compat (AC-7).
3. **Sentinel key `'__run__'` for run-scoped decisions in the UI** — single slice, single handler, single component. The `'__run__'` literal must be documented at the slice's type comment so future readers know it's reserved.
4. **Engine-side diff computation for `per-plan-review-override`** — engine has both override + default in scope; computing once is cheaper than recomputing in the UI per render.
5. **Don't emit override decisions when no override exists** — "I used the default" is not interesting; the composer's `planning:pipeline.rationale` already covers default reasoning.
6. **Per-plan kind ordering: build → review → agent-tier-tuning roles** (AC-4). Across plans, planner iterates plans in their declaration order. `plan-set-shape` always emits first (run-scoped), before any per-plan event.
7. **`agent-tier-tuning` carries `source: 'plan'`** — reserves the field for future tier-fallback sources without a schema break. V1 always emits `'plan'`.

## Scope

### In Scope

**Wire protocol** (`@eforge-build/client`):
- `PlanningDecisionSchema`: discriminated union over 4 V1 kinds, each with required `rationale: string`:
  - `per-plan-review-override` — `{ planId, override, default, diff: string[] }`
  - `per-plan-build-override` — `{ planId, override, default }`
  - `plan-set-shape` — `{ planCount, plans: Array<{ id, dependsOn }> }` (run-scoped, no `planId`)
  - `agent-tier-tuning` — `{ planId, role, effort?, thinking?, source: 'plan' }`
- New `EforgeEvent` variant: `{ type: 'planning:decision', timestamp, planId?, decision: PlanningDecision }`. `planId` is required for all kinds except `plan-set-shape`.
- `event-registry.ts` entry mirroring `plan:build:decision` (scope='session', persist=false, summary function).
- `DAEMON_API_VERSION` bump 26 → 27 with changelog one-liner.

**Engine** (`packages/engine`):
- Extend `orchestrationPlanSchema` with optional `buildRationale: string` and `reviewRationale: string`.
- Extend `planSetSubmissionSchema` with optional top-level `planSetShapeRationale: string`.
- Add `emitPlanningDecision(decision, planId?)` to `decisions.ts`. Update file header comment to cover both event variants. Validates via `PlanningDecisionSchema.parse`.
- Extend `PlannerOptions` with `defaultBuild` and `defaultReview` (the pipeline composer's defaults). Thread them from `compile-stages.ts:runPlannerAttempt` (where `ctx.pipeline.defaultBuild`/`defaultReview` is in scope) into the `runPlanner` call.
- In `planner.ts`, immediately before yielding `planning:complete` in the `captured.planSet` branch (~line 306–347), emit (in this order):
  1. `plan-set-shape` — once per submission, when `planSetShapeRationale` is provided
  2. For each plan in declaration order:
     - `per-plan-build-override` — when `frontmatter.build` differs from the threaded `defaultBuild` AND `buildRationale` is provided
     - `per-plan-review-override` — when `frontmatter.review` differs from threaded `defaultReview` AND `reviewRationale` is provided. Compute `diff: string[]` engine-side (e.g., `['strategy: auto → parallel', 'maxRounds: 1 → 3']`).
     - `agent-tier-tuning` — one per role in `frontmatter.agents` that carries non-empty `rationale` (and at least one of `effort`/`thinking`). Emit `source: 'plan'`.
  - Skip emission when no override exists for a given dimension (AC-6).
- Update `prompts/planner.md` orchestration.yaml documentation (~line 389–432): require `buildRationale`/`reviewRationale` whenever the corresponding override is set; require `planSetShapeRationale` once per submission; include one example showing filled fields (AC-8).
- Remove the `Plan-phase decision events with planner-supplied rationale` bullet from `docs/roadmap.md` line 20 under Orchestrator Intelligence (AC-14).

**Monitor UI** (`packages/monitor-ui`):
- Define `Decision = BuildDecision | PlanningDecision` and widen `decisions` slice value type to `Decision[]`. Document the `'__run__'` sentinel key at the slice's type comment in `reducer.ts:104`.
- Add `handlePlanningDecision` to `lib/reducer/handle-decisions.ts`. Routing: `decision.kind === 'plan-set-shape'` → key `'__run__'`; all other kinds → `event.planId` (which is required for those by schema).
- Register `handlePlanningDecision` in `lib/reducer/index.ts` `handlerRegistry`.
- Update reset path in `reducer.ts:147` (no shape change — value type stays `{}`).
- Extend `DecisionTimeline` (`components/pipeline/decision-timeline.tsx`):
  - Widen prop type to `Decision[]`.
  - Extend `getPipClass` to map planning-phase kinds (`per-plan-review-override`, `per-plan-build-override`, `plan-set-shape`, `agent-tier-tuning`) to a teal/green color family (visually distinct from the build-phase blue/amber/red/purple).
  - Extend `decisionSummary` with kind-specific tooltip strings:
    - `per-plan-review-override` → display the precomputed `diff` array, joined.
    - `per-plan-build-override` → e.g., `build: <override summary>` (compact stage list change).
    - `plan-set-shape` → e.g., `shape: N plans (M edges)` derived from `plans[].dependsOn` length.
    - `agent-tier-tuning` → e.g., `<role>: effort=<v> thinking=<v>` (omit absent fields).
  - Click-to-sheet behavior unchanged — full payload JSON.
- In `components/pipeline/thread-pipeline.tsx`, render `decisions['__run__']` (when present and non-empty) as a header band/timeline above the per-plan rows. Reuse `DecisionTimeline` for the band.

**Tests:**
- Extend `test/decisions.test.ts` with schema-parse cases per planning-decision kind: well-formed for each of the 4 kinds, plus at least one Zod-rejected malformed case per kind (e.g., missing `rationale`, missing required kind-specific field, wrong literal for `kind`).
- Extend `test/decision-helper-discipline.test.ts` `FORBIDDEN_PATTERNS` with both quote variants of `type: 'planning:decision'` and `type: "planning:decision"`. Allowed file remains `packages/engine/src/decisions.ts`. The grep gate must continue to pass with zero hits in the rest of the codebase.
- Add `test/planner-decision-emission.test.ts` (or extend `test/agent-wiring.test.ts`) using `StubHarness`: feed a synthesized plan-set submission through the planner with one plan carrying a build override, another with a review override, and a third with `agents.reviewer.{effort,thinking,rationale}`, plus a top-level `planSetShapeRationale`. Assert event sequence: `plan-set-shape` → per-plan events in declaration order (build → review → agent-tier-tuning) → `planning:complete`. Cover AC-4, AC-5, AC-6.
- Extend `packages/monitor-ui/src/lib/reducer/__tests__/handle-decisions.test.ts` with cases: each of the 4 kinds; `plan-set-shape` lands under `'__run__'`; other kinds key by `event.planId`; existing build-phase test cases continue to pass against the widened type.

### Out of Scope

- Migrating `planning:pipeline.rationale` to `planning:decision` (different concept; composer defaults vs. per-plan overrides).
- Adaptive reviewer respawn (separate roadmap item that consumes this scaffolding).
- Module-planner / architecture-review / cohesion-review decision events.
- Pi extension (`packages/pi-eforge`) and plugin (`eforge-plugin/`) parity. Verified by grep: zero hits for `BuildDecision`/`plan:build:decision`/`DecisionTimeline` in either today, so adding `planning:decision` rendering is a follow-up if desired.
- Editing `CHANGELOG.md` (managed by release flow).

## Files

### Create

- `test/planner-decision-emission.test.ts` — `StubHarness` integration test asserting the planner's `planning:decision` emission sequence (AC-4, AC-5, AC-6). May be folded into `test/agent-wiring.test.ts` if logical-unit grouping suggests it; new file is fine.

### Modify

**Wire protocol** (`packages/client/src/`):
- `events.schemas.ts` — add `PlanningDecisionSchema` near `BuildDecisionSchema` (~line 360, just below the build-decision union, so related shapes are co-located). Add `planning:decision` event variant in the planning section of `EforgeEventVariantsSchema` (~line 475). Re-export `PlanningDecision` and `PlanningDecisionSchema` from the package's public exports (mirror `BuildDecision`/`BuildDecisionSchema` exports).
- `event-registry.ts` — add a `'planning:decision'` entry mirroring the existing `'plan:build:decision'` registration (~line 591): `scope: 'session'`, `persist: false`, summary function returning a string like `Planning decision (${e.decision.kind})${e.planId ? ' for ' + e.planId : ''}`.
- `api-version.ts` — bump `DAEMON_API_VERSION` from 26 to 27 and add a changelog one-liner: `v27: adds planning:decision event variant for planner rationale capture`.

**Engine** (`packages/engine/src/`):
- `schemas.ts` — extend `orchestrationPlanSchema` (line 480 area) with `buildRationale: z.string().optional()` and `reviewRationale: z.string().optional()`. Extend `planSetSubmissionSchema` (line 487 area) with top-level `planSetShapeRationale: z.string().optional()`. Both must use `.describe()` annotations so YAML schema generation surfaces them in the planner prompt.
- `decisions.ts` — add `emitPlanningDecision(decision: PlanningDecision, planId?: string): PlanningDecisionEvent` mirroring the existing build helpers. Validate via `PlanningDecisionSchema.parse`. Update the file header docstring (lines 1–9) to cover both event variants and to document that the grep gate enforces zero direct yields of either `plan:build:decision` or `planning:decision` outside this file. Re-export `PlanningDecision` type alongside `BuildDecision`.
- `agents/planner.ts` — extend `PlannerOptions` (line 16) with optional `defaultBuild?: BuildPipelineSpec` and `defaultReview?: ReviewConfig` (use the existing types from `@eforge-build/client` / engine — match what `ctx.pipeline.defaultBuild`/`defaultReview` carries). Inside the `captured.planSet` branch (line 306), immediately before the `planning:complete` yield (line 341), emit the four decision kinds in the order specified above. Use `emitPlanningDecision` for every emission. Compute the review `diff: string[]` inline (small helper acceptable, kept local). For `agent-tier-tuning`, iterate `frontmatter.agents` keys with stable ordering (e.g., the order roles are declared in `agentTuningSchema`/the plan file).
- `pipeline/stages/compile-stages.ts` — at the `runPlanner`/`runPlannerAttempt` call site (~line 52, also referenced at lines 226–230, 254), pass `defaultBuild: ctx.pipeline.defaultBuild` and `defaultReview: ctx.pipeline.defaultReview` into the options object. Confirm via type-check that `ctx.pipeline` carries these fields after composition.
- `prompts/planner.md` — in the orchestration.yaml documentation section (~line 389–432), document the new fields:
  - `buildRationale` and `reviewRationale` are siblings of `build`/`review` on each plan entry; **required whenever the corresponding override is set**.
  - `planSetShapeRationale` is a top-level field on the submission; **required once per submission** (i.e., the planner must always justify the chosen plan count and `dependsOn` topology).
  - Add one worked example showing a plan with both a `review` override and a filled `reviewRationale`, plus an `agents.reviewer.rationale` filled out — demonstrating filled fields end-to-end (AC-8).

**Monitor UI** (`packages/monitor-ui/src/`):
- `lib/reducer.ts` — line 104: change `decisions: Record<string, BuildDecision[]>` to `decisions: Record<string, Decision[]>` where `Decision = BuildDecision | PlanningDecision`. Add a JSDoc comment above the field explaining: "Keyed by planId. The sentinel key `'__run__'` is reserved for run-scoped decisions (e.g., `plan-set-shape`) that have no associated planId." Update the reset path (line 147) so the literal `decisions: {}` continues to type-check against the new value type (no shape change required).
- `lib/reducer/handle-decisions.ts` — add `handlePlanningDecision(state, event: Extract<EforgeEvent, { type: 'planning:decision' }>)` that returns a partial slice update routing `event.decision.kind === 'plan-set-shape'` to `decisions['__run__']` and all other kinds to `decisions[event.planId]` (use a non-null assertion or narrow via the discriminator — the schema guarantees `planId` for non-shape kinds). Mirror the immutable spread pattern used by `handlePlanBuildDecision`.
- `lib/reducer/index.ts` — register `'planning:decision': handlePlanningDecision` in `handlerRegistry` (mirror `'plan:build:decision'` line 128). Confirm the compile-time exhaustiveness check (line 306–315) passes — `'planning:decision'` is now a key in the registry.
- `components/pipeline/decision-timeline.tsx` — widen prop type from `BuildDecision[]` to `Decision[]`. Extend `getPipClass` (line 10) with a teal/green color family for the four planning-phase kinds — pick semantically distinct shades (e.g., teal for shape, green for tuning, emerald for build override, cyan for review override; finalize palette during implement). Extend `decisionSummary` (line 32) with kind-specific tooltip text per the bullets above. Click-to-sheet behavior unchanged (the existing JSON-dump path handles arbitrary payloads).
- `components/pipeline/thread-pipeline.tsx` — when `decisions['__run__']` is present and non-empty, render it as a header band above the per-plan rows. Reuse the existing `DecisionTimeline` component (passing the `'__run__'` array). Use shadcn primitives for any container styling — do not introduce custom UI primitives.

**Tests:**
- `test/decisions.test.ts` — append schema-parse cases for `PlanningDecisionSchema`: well-formed payload + at least one Zod-rejected malformed case per kind (4 kinds → minimum 8 new cases). Use the existing `BuildDecisionSchema` test layout as the template.
- `test/decision-helper-discipline.test.ts` — extend `FORBIDDEN_PATTERNS` (line 38–41) with both quote variants for `type: 'planning:decision'`. Verify the grep gate runs with zero hits across `packages/` + `test/` (excluding `packages/engine/src/decisions.ts` and test files).
- `packages/monitor-ui/src/lib/reducer/__tests__/handle-decisions.test.ts` — extend with cases for each planning-decision kind. Specifically assert: `plan-set-shape` lands under `decisions['__run__']`; other kinds key by `event.planId`; the slice preserves existing build-phase entries when planning decisions arrive (no cross-key clobber); the slice now type-checks against the widened union.

**Docs:**
- `docs/roadmap.md` line 20 — remove the `Plan-phase decision events with planner-supplied rationale` bullet from the Orchestrator Intelligence section (AC-14). Leave surrounding bullets intact.

## Verification

- [ ] `pnpm type-check` passes from the merge worktree root with zero errors (covers AC-9 widened reducer type, AC-10 widened component prop type, AC-1/AC-2 wire-protocol additions, AC-3 helper signature, and the reducer's compile-time exhaustiveness check).
- [ ] `pnpm test` passes with all new and existing tests green. Specifically: schema parse cases for all 4 planning-decision kinds (AC-1); grep-gate zero hits outside `decisions.ts` (AC-3); planner emission sequence test asserts ordering `plan-set-shape` → per-plan `build` → per-plan `review` → per-plan `agent-tier-tuning` → `planning:complete` for the multi-override fixture (AC-4); single `agent-tier-tuning` decision emitted with `role: 'reviewer'` and verbatim rationale for the AC-5 fixture; zero `planning:decision` events emitted for a plan with no overrides (AC-6); existing submissions parse without the new optional fields (AC-7); reducer routing test confirms `'__run__'` sentinel for `plan-set-shape` and `event.planId` for others (AC-9).
- [ ] `pnpm build` succeeds for all workspace packages; the bundled CLI at `packages/eforge/dist/cli.js` builds without errors (AC-12).
- [ ] Grep `rg "type: ['\"]planning:decision['\"]" packages test --glob '!**/decisions.ts' --glob '!**/*.test.ts'` returns zero hits (grep-gate sanity check that mirrors the test).
- [ ] `prompts/planner.md` contains documentation for `buildRationale`, `reviewRationale`, and `planSetShapeRationale`, plus one filled-fields example (AC-8).
- [ ] `DAEMON_API_VERSION` is `27` in `packages/client/src/api-version.ts` with a `v27:` changelog entry (AC-2).
- [ ] `event-registry.ts` contains a `'planning:decision'` entry with `scope: 'session'`, `persist: false`, and a summary function (AC-2).
- [ ] `decisions['__run__']` renders as a header band above per-plan rows in `thread-pipeline.tsx` using `DecisionTimeline` (AC-11).
- [ ] `DecisionTimeline` renders all 4 planning-phase kinds in a teal/green color family with kind-specific tooltip summaries; click-to-sheet still opens with full JSON payload (AC-10).
- [ ] `docs/roadmap.md` no longer contains the `Plan-phase decision events with planner-supplied rationale` bullet (AC-14).
- [ ] The reducer's `decisions` slice JSDoc documents the `'__run__'` sentinel reservation.
- [ ] No `CHANGELOG.md` modifications (release flow owns it).
- [ ] No new custom UI primitives introduced in `monitor-ui` — header band uses shadcn components.
