---
title: Plan-phase decision events: capture planner rationale for orchestration choices
created: 2026-05-07
---

# Plan-phase decision events: capture planner rationale for orchestration choices

## Problem / Motivation

Build-phase decisions shipped at API v26: `BuildDecisionSchema` (discriminated union over 7 `kind`s, each carrying `rationale: string`) is emitted via `emitBuildDecision`/`emitBuildDecisionForPlan` in `packages/engine/src/decisions.ts` (single-source helper guarded by a grep gate in `test/decision-helper-discipline.test.ts`), reduced into `decisions: Record<string, BuildDecision[]>` at `packages/monitor-ui/src/lib/reducer.ts:104`, and rendered by `DecisionTimeline` at `packages/monitor-ui/src/components/pipeline/decision-timeline.tsx` (color-coded pip dots → tooltip → click-to-sheet).

This excursion mirrors that pattern for plan-phase decisions: a new `planning:decision` event variant capturing why the planner picked per-plan overrides.

The only existing plan-time rationale today is the pipeline-composer's `planning:pipeline.rationale` — one string covering the whole composition's defaults. That stays as-is. The new events cover *additional* planner choices below the composer's defaults.

The planner makes choices today — per-plan `build`/`review` overrides, plan-set shape (count + dependsOn), per-role `agents.{role}` tuning — with no structured rationale on the wire. The free-form `agentTuningSchema.rationale` string is required by prompt but lives only in plan files; the rest is in the planner's head and discarded after `planning:complete`.

Consequences: builds that diverge from defaults are debugged by re-reading plan files and guessing intent; sessions can't be audited for cost/quality reasoning; the next roadmap item (adaptive reviewer respawn) needs decision-event scaffolding as its rollout debug surface.

## Goal

Introduce a `planning:decision` event variant that captures planner rationale for per-plan build/review overrides, plan-set shape, and per-role agent-tier tuning, and surface those decisions in the monitor UI alongside existing build-phase decisions.

## Approach

**Wire protocol** (`@eforge-build/client`):
- New `PlanningDecisionSchema` (discriminated union, 4 V1 kinds, each `rationale: string` + kind-specific fields):
  - `per-plan-review-override` — `{ planId, override, default, diff: string[] }`
  - `per-plan-build-override` — `{ planId, override, default }`
  - `plan-set-shape` — `{ planCount, plans: Array<{ id, dependsOn }> }` (run-scoped, no planId)
  - `agent-tier-tuning` — `{ planId, role, effort?, thinking?, source: 'plan' }`
- New event variant `{ type: 'planning:decision', timestamp, planId?, decision: PlanningDecision }`. `planId` optional only for `plan-set-shape`.
- Bump `DAEMON_API_VERSION` 26 → 27.

**Engine** (`packages/engine`):
- Extend `orchestrationPlanSchema` with optional sibling `buildRationale: string`, `reviewRationale: string`.
- Extend `planSetSubmissionSchema` with optional top-level `planSetShapeRationale: string`.
- Add `emitPlanningDecision` to `decisions.ts` (same file, same grep gate).
- Emit four decisions in `planner.ts` immediately before `planning:complete`. `defaultBuild`/`defaultReview` are threaded through `PlannerOptions` from `compile-stages.ts:runPlannerAttempt` (which has `ctx.pipeline.defaultBuild`/`defaultReview` in scope from the composer).
- Update `prompts/planner.md`: require rationale fields whenever the corresponding override is set; require `planSetShapeRationale` once per submission.

**Monitor UI** (`packages/monitor-ui`):
- Widen `decisions` slice value type to `Decision[] = BuildDecision | PlanningDecision`. Run-scoped decisions land under sentinel key `'__run__'`.
- Add `handlePlanningDecision` event handler.
- Extend `DecisionTimeline`'s `getPipClass` and `decisionSummary` for the four new kinds (planning-phase color family: teal/green).
- Render `decisions['__run__']` as a header band above per-plan rows in `thread-pipeline.tsx`.

### Code Impact

**Files:**

`packages/client/src/`:
- `events.schemas.ts` — add `PlanningDecisionSchema` near `BuildDecisionSchema` (~line 360); add `planning:decision` variant in the planning section (~line 475).
- `event-registry.ts` — registry entry mirroring `plan:build:decision` (~line 591).
- `api-version.ts` — bump to 27 with changelog one-liner.

`packages/engine/src/`:
- `schemas.ts` — extend `orchestrationPlanSchema` (line 480) and `planSetSubmissionSchema` (line 487) per Scope.
- `decisions.ts` — add `emitPlanningDecision(decision, planId?)`; update header comment to cover both event variants.
- `agents/planner.ts` — extend `PlannerOptions` with `defaultBuild`/`defaultReview`; emit four decisions before `planning:complete` in the `captured.planSet` branch (~line 306–347).
- `pipeline/stages/compile-stages.ts` — pass `defaultBuild`/`defaultReview` from `ctx.pipeline` to `runPlanner` options at the call site (~line 52).
- `prompts/planner.md` — document new rationale fields in the orchestration.yaml section (~line 389–432); add submission requirement for `planSetShapeRationale`.

`packages/monitor-ui/src/`:
- `lib/reducer.ts` — widen `decisions` value type; update reset path (~line 147).
- `lib/reducer/handle-decisions.ts` — add `handlePlanningDecision`; route `plan-set-shape` to `'__run__'`, others to `event.planId`.
- `lib/reducer/index.ts` — register `handlePlanningDecision`.
- `components/pipeline/decision-timeline.tsx` — extend `getPipClass`/`decisionSummary`; widen prop type to `Decision[]`.
- `components/pipeline/thread-pipeline.tsx` — render `decisions['__run__']` header above per-plan rows.

**Tests:**
- `test/decisions.test.ts` — schema parse cases per kind (well-formed + at least one Zod-rejected malformed case per kind).
- `test/decision-helper-discipline.test.ts` — extend grep gate to forbid direct `{ type: 'planning:decision', ... }` yields outside `decisions.ts`.
- New `test/planner-decision-emission.test.ts` (or extend `test/agent-wiring.test.ts`) — `StubHarness` integration test asserting event sequence.
- `packages/monitor-ui/src/lib/reducer/__tests__/handle-decisions.test.ts` — extend with cases per kind, including `plan-set-shape` landing under `'__run__'`.

**Patterns to follow:**
- Single-emission-helper file with grep gate (`decisions.ts` precedent).
- Discriminated-union event payloads (`BuildDecisionSchema` precedent).
- Wire-protocol owned by `@eforge-build/client`.

### Design Decisions

- **D1. Event variant name `planning:decision`.** Mirrors `plan:build:decision`; fits `planning:*` namespace; matches roadmap entry.
- **D2. Sibling rationale fields (`buildRationale`, `reviewRationale`) in orchestration.yaml.** User-selected. Lives next to the choice it explains; minimum schema churn (two optional strings per plan).
- **D3. Single `decisions.ts` for both phases (not a sibling file).** One grep gate, one discipline. File header updated to cover both event variants.
- **D4. Emit from `planner.ts` with defaults threaded through `PlannerOptions`.** The wrapper alternative (intercept `planning:complete` in `compile-stages.ts`) was rejected because `planning:complete` doesn't carry the rationale fields or `agents` frontmatter — the wrapper would have to broaden the public event payload or re-read just-written files. Threading two fields is cleaner.
- **D5. Reuse `decisions` slice with sentinel key `'__run__'` for run-scoped decisions.** User-selected. Single slice, one handler, one component. Document the sentinel at the slice's type comment so future readers know it's reserved.
- **D6. Extend `DecisionTimeline` (not a sibling component).** New planning-phase color family (teal/green) keeps the two phases visually distinguishable in one timeline. `plan-set-shape` renders as a header band above per-plan rows.
- **D7. Carry `override`, `default`, and computed `diff: string[]` on `per-plan-review-override`.** Engine has both in scope; computing once is cheaper than recomputing in the UI per render. The diff string drives the tooltip; full `override`/`default` populate the click-to-sheet view.
- **D8. Don't emit override decisions when no override exists.** "I used the default" is not interesting; the composer's `planning:pipeline.rationale` already covers default reasoning.
- **D9. API version bump 26 → 27.** Standard convention for new event variant.

### Assumptions And Validation

| # | Assumption | Confidence | Validation path | Impact if wrong |
|---|---|---|---|---|
| A1 | Composer's `defaultBuild`/`defaultReview` reach the planner via `PlannerOptions` threading. | High — verified in `compile-stages.ts:45–95, 226–230, 254`: ctx.pipeline is populated by composer before `runPlanner` invocation. | n/a (resolved during planning). | Low. |
| A2 | Planner reliably fills new rationale fields when prompted. | Medium-High — precedent: `agentTuningSchema.rationale` (schemas.ts:250) is already prompted and reliably filled today. | Smoke-test on a real excursion (AC-13). | If skipped, Zod parse fails — surfaces as a hard error rather than silent drift. May choose to make rationale optional with a runtime warning instead. |
| A3 | Sentinel key `'__run__'` doesn't collide with any real planId convention. | Medium — planIds are kebab-case slugs (`plan-01-auth`); double-underscore prefix is conventional for reserved keys. | Try implementation; if collision, switch to a separate `runDecisions` slice. | Low — refactor isolated to reducer + thread-pipeline render. |
| A4 | Diff field on `per-plan-review-override` is best computed engine-side. | High — engine has override+default in scope; UI does not. | n/a. | Low — could move to UI later. |
| A5 | Pi extension and plugin need no parallel work. | High — verified by grep: zero hits for `BuildDecision`/`plan:build:decision`/`DecisionTimeline` in either. | n/a. | Low — Pi parity is a follow-up. |
| A6 | `planning:pipeline.rationale` does NOT migrate. | Medium — different concept (composer defaults vs. per-plan overrides). | n/a. | Low — could revisit in a follow-up. |

### Profile Signal

**Excursion.** Single planner can enumerate the full changeset (Code Impact lists ~12 files across 3 packages, all tightly coupled around one wire contract). Plan review adds value because the schema design has real choices (kind discriminator granularity, sentinel-key reducer convention, diff-field placement). No subsystem requires its own planner — the four decision kinds are siblings, not delegated modules.

## Scope

### In scope

**Wire protocol** (`@eforge-build/client`):
- New `PlanningDecisionSchema` (discriminated union, 4 V1 kinds, each `rationale: string` + kind-specific fields):
  - `per-plan-review-override` — `{ planId, override, default, diff: string[] }`
  - `per-plan-build-override` — `{ planId, override, default }`
  - `plan-set-shape` — `{ planCount, plans: Array<{ id, dependsOn }> }` (run-scoped, no planId)
  - `agent-tier-tuning` — `{ planId, role, effort?, thinking?, source: 'plan' }`
- New event variant `{ type: 'planning:decision', timestamp, planId?, decision: PlanningDecision }`. `planId` optional only for `plan-set-shape`.
- Bump `DAEMON_API_VERSION` 26 → 27.

**Engine** (`packages/engine`):
- Extend `orchestrationPlanSchema` with optional sibling `buildRationale: string`, `reviewRationale: string`.
- Extend `planSetSubmissionSchema` with optional top-level `planSetShapeRationale: string`.
- Add `emitPlanningDecision` to `decisions.ts` (same file, same grep gate).
- Emit four decisions in `planner.ts` immediately before `planning:complete`. `defaultBuild`/`defaultReview` are threaded through `PlannerOptions` from `compile-stages.ts:runPlannerAttempt` (which has `ctx.pipeline.defaultBuild`/`defaultReview` in scope from the composer).
- Update `prompts/planner.md`: require rationale fields whenever the corresponding override is set; require `planSetShapeRationale` once per submission.

**Monitor UI** (`packages/monitor-ui`):
- Widen `decisions` slice value type to `Decision[] = BuildDecision | PlanningDecision`. Run-scoped decisions land under sentinel key `'__run__'`.
- Add `handlePlanningDecision` event handler.
- Extend `DecisionTimeline`'s `getPipClass` and `decisionSummary` for the four new kinds (planning-phase color family: teal/green).
- Render `decisions['__run__']` as a header band above per-plan rows in `thread-pipeline.tsx`.

### Out of scope

- Migrating `planning:pipeline.rationale` to a `planning:decision` event.
- Adaptive reviewer respawn (separate roadmap item that consumes this).
- Module-planner / architecture-review / cohesion-review decision events (follow-ups).
- Pi extension and plugin parity (verified by grep: neither renders build-phase decisions today; follow-up if desired).

## Acceptance Criteria

### Wire protocol
- AC-1: `PlanningDecisionSchema` is a discriminated union over the four V1 `kind`s, each with `rationale: string`. `EforgeEvent` includes `{ type: 'planning:decision', timestamp, planId?, decision: PlanningDecision }`. `planId` is required for all kinds except `plan-set-shape`.
- AC-2: `event-registry.ts` has a `planning:decision` entry. `DAEMON_API_VERSION` is `27` with a changelog one-liner.

### Engine
- AC-3: `decisions.ts` exports `emitPlanningDecision`; validates via `PlanningDecisionSchema.parse`. Grep-gate test in `decision-helper-discipline.test.ts` forbids direct `{ type: 'planning:decision', ... }` yields outside the file.
- AC-4: For a plan-set submission with `planSetShapeRationale`, `buildRationale` on plan A, and `reviewRationale` on plan B, the planner yields exactly: `plan-set-shape` → `per-plan-build-override` (plan A) → `per-plan-review-override` (plan B), then `planning:complete`. (Per-plan kind order: build → review → agent-tier-tuning roles.)
- AC-5: A plan with `agents.reviewer.{effort,thinking,rationale}` produces one `agent-tier-tuning` decision with `role: 'reviewer'` and the rationale verbatim.
- AC-6: A plan with no overrides produces no `planning:decision` events for that plan.
- AC-7: `orchestrationPlanSchema` and `planSetSubmissionSchema` parse existing submissions without the new fields (back-compat).
- AC-8: `planner.md` instructs the planner to fill the rationale fields whenever the corresponding override is set, with one example demonstrating filled fields.

### Monitor UI
- AC-9: Reducer's `decisions` slice contains both `BuildDecision` and `PlanningDecision`. `handlePlanningDecision` routes `plan-set-shape` to `'__run__'` and other kinds to `event.planId`.
- AC-10: `DecisionTimeline` accepts `Decision[]`, renders the four new kinds in a planning-phase color family (teal/green) with kind-specific tooltip summaries. Click-to-sheet behavior unchanged.
- AC-11: `thread-pipeline.tsx` renders `decisions['__run__']` as a header band above per-plan rows.

### Verification
- AC-12: `pnpm test`, `pnpm type-check`, `pnpm build` all pass.
- AC-13: Smoke-test: an excursion with at least one per-plan build/review override and one per-plan agent-tier override produces visible decision pips for all four kinds in the monitor UI; tooltips show rationale; click expands payload JSON.
- AC-14: `docs/roadmap.md`'s "Plan-phase decision events" bullet under "Orchestrator Intelligence" is removed.
