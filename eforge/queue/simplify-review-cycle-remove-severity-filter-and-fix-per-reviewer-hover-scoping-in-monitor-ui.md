---
title: Simplify review cycle: remove severity filter and fix per-reviewer hover scoping in monitor UI
created: 2026-05-07
---

# Simplify review cycle: remove severity filter and fix per-reviewer hover scoping in monitor UI

## Problem / Motivation

Two related cleanups in the review cycle, bundled because they share files and review-mental-model:

**Item 1: Severity filter is dead weight.** `filterIssuesBySeverity` in `packages/engine/src/pipeline/misc.ts:57-66` filters reviewer-reported issues against the optional `autoAcceptBelow` config field (`'suggestion' | 'warning'`). When unset (default in `DEFAULT_REVIEW`, `packages/engine/src/config.ts:431-436`), it short-circuits and passes all issues through. The cycle stage uses the filtered list to decide early termination (`packages/engine/src/pipeline/stages/build-stages.ts:570-572`). Default is unset; nobody uses the opt-in. "What counts as worth fixing" belongs in reviewer prompts, not engine config. Removing it tightens the surface and makes the cycle's termination clearer ("reviewers reported zero issues" vs. "post-filter zero").

**Item 2: Per-reviewer hover shows merged totals (bug).** `packages/monitor-ui/src/components/pipeline/plan-row.tsx:321-323` displays the full per-plan issue array for *every* reviewer thread:

```tsx
{REVIEW_AGENTS.has(thread.agent) && issues && issues.length > 0 && (
  <IssuesSummary issues={issues} />
)}
```

`issues` here is `reviewIssues[planId]` — the merged-and-deduped set from `plan:build:review:complete`. So if three perspectives ran (`code`, `security`, `api`), all three reviewer hovers show the same combined totals.

Data already available: `plan:build:review:parallel:perspective:complete` event carries `{ planId, perspective, issues: ReviewIssue[] }` (`packages/client/src/events.schemas.ts:559-564`). Reducer currently does not handle this event for issue tracking — it only stores the merged set on `plan:build:review:complete` (`packages/monitor-ui/src/lib/reducer/handle-plan-build.ts:94-97`).

**All references found for severity filter** (8 source locations + 3 tests):
- `packages/client/src/events.schemas.ts:88` — `autoAcceptBelow` on `ReviewProfileConfig` Zod schema
- `packages/client/src/types.ts:81` — TS type
- `packages/engine/src/config.ts:104` — `AUTO_ACCEPT` enum tuple
- `packages/engine/src/config.ts:113` — Zod field in tier/profile config
- `packages/engine/src/schemas.ts:460` — second Zod field (likely PRD frontmatter or session plan)
- `packages/engine/src/pipeline/misc.ts:51-66` — `filterIssuesBySeverity` function (delete)
- `packages/engine/src/pipeline/stages/build-stages.ts:565,570` — cycle stage uses filtered list
- `packages/monitor-ui/src/components/plans/build-config.tsx:61-63` — UI displays the config field
- `test/review-strategy-wiring.test.ts:18,25,37` — three tests covering the filter behavior

**Keep**: `SEVERITY_ORDER` map in `packages/client/src/events.schemas.ts:1064-1068` — still used by `parallel-reviewer.ts` dedup (highest-severity-wins) and by `review-fixer.ts` for sort order.

**Fixer hover** — Fixer addresses the merged-and-deduped set (output of dedup in `parallel-reviewer.ts:213-218`). The current `reviewIssues[planId]` is correct for the fixer hover; only reviewer hovers need the per-perspective scope.

**Multi-round wrinkle** — `maxRounds > 1` would overwrite prior rounds in the per-perspective map. Default is 1, so this is not load-bearing today. Could note as a follow-up if multi-round usage grows.

**Roadmap alignment** — Both items are in `docs/roadmap.md` under "Orchestrator Intelligence" (added in this conversation). Bundling them ships the review-cycle cleanup as one excursion.

## Goal

Ship two related review-cycle cleanups as one excursion: (1) remove the unused `autoAcceptBelow` severity filter from config, schema, engine pipeline, monitor UI, and tests; (2) fix the monitor UI so each reviewer's hover shows only that reviewer's perspective-scoped issues, while the fixer hover continues to show the merged-and-deduped set.

## Approach

**No schema change needed for hover scoping.** Solution path: extend reducer to track issues per `(planId, perspective)` from the `plan:build:review:parallel:perspective:complete` event; UI keys per-reviewer hover by `thread.perspective` (already available — see line 304-308 in plan-row.tsx).

### Patterns to follow

- `handlePlanBuildReviewPerspectiveError` (`handle-plan-build.ts:122`) is the closest analogue for the new handler — both maintain a `Record<string, Record<string, T>>` shape indexed by `(planId, perspective)`.
- `handlePlanBuildReviewComplete` (line 94) shows the simpler `reviewIssues` map pattern for reference.
- Reducer reset cases (lines 142, 148-149 of `reducer.ts`) enumerate fields by hand — easy to miss the new field on reset, breaking idempotence. Add explicitly to both.
- `forgeCommit` for engine commits per AGENTS.md convention. Plugin version bump in `eforge-plugin/.claude-plugin/plugin.json` is **not** needed (no plugin-facing change).

### Shared utilities reused

- `SEVERITY_ORDER` map (kept) at `packages/client/src/events.schemas.ts:1064` — still imported by `parallel-reviewer.ts` (dedup) and `review-fixer.ts` (sort). Verify the import on `pipeline/misc.ts:7` becomes unused after deletion and remove it.

### Dependency relationships

- `pipelineReviewProfileConfigSchema` is bound `z.ZodType<ReviewProfileConfig>`. Once the client type drops `autoAcceptBelow`, the engine schema can keep it without type error (Zod accepts extras unless `.strict()`), but for cleanliness drop both in the same change.
- `client` → `engine` → `monitor-ui` is the build order; deletions ripple in that direction. No reverse dependencies.

### Existing test coverage

- `test/review-strategy-wiring.test.ts` covers the filter behavior we're removing — three tests deleted.
- `packages/monitor-ui/src/lib/reducer/__tests__/handle-plan-build.test.ts` has perspective-error coverage but no perspective-complete coverage; we add one test.
- No existing test covers the per-reviewer hover render in `plan-row.tsx` (the bug). Component-level rendering test is not part of the existing test surface for this file — leaving it at reducer-level coverage.

### Files changed — severity filter removal

| File | Change |
|---|---|
| `packages/client/src/events.schemas.ts` (line 88) | Drop `autoAcceptBelow` field from `ReviewProfileConfig` Zod object |
| `packages/client/src/types.ts` (line 81) | Drop `autoAcceptBelow?` from TS type |
| `packages/engine/src/config.ts` (line 104) | Delete `AUTO_ACCEPT` enum tuple |
| `packages/engine/src/config.ts` (line 113) | Drop `autoAcceptBelow` Zod field |
| `packages/engine/src/schemas.ts` (line 460) | Drop `autoAcceptBelow` from pipeline composer mirror schema |
| `packages/engine/src/pipeline/misc.ts` (lines 50-66) | Delete `filterIssuesBySeverity`; drop now-unused `SEVERITY_ORDER` import on line 7 if it falls out |
| `packages/engine/src/pipeline/stages/build-stages.ts` (line 37) | Drop `filterIssuesBySeverity` import |
| `packages/engine/src/pipeline/stages/build-stages.ts` (lines 565, 570-572) | Drop `autoAcceptBelow` extraction; replace `const { filtered } = filterIssuesBySeverity(...); ctx.reviewIssues = filtered; if (filtered.length === 0) break;` with `if (ctx.reviewIssues.length === 0) break;` |
| `packages/monitor-ui/src/components/plans/build-config.tsx` (lines 61-63) | Drop the `{review.autoAcceptBelow && (...)}` display block |
| `test/review-strategy-wiring.test.ts` (lines 18, 25, 37) | Remove the three filter-behavior `it` blocks; drop unused imports |

### Files changed — per-reviewer hover scoping

| File | Change |
|---|---|
| `packages/monitor-ui/src/lib/reducer.ts` | Extend `RunState` (line 74) with `reviewIssuesByPerspective: Record<string, Record<string, ReviewIssue[]>>` (planId → perspective → issues). Add `reviewIssuesByPerspective: {}` to `initialRunState` (line 104) AND to the explicit-reset object literals on lines 142 and 148-149 (the reducer enumerates fields by hand on reset paths) |
| `packages/monitor-ui/src/lib/reducer/handle-plan-build.ts` | Add `handlePlanBuildReviewPerspectiveComplete: EventHandler<'plan:build:review:parallel:perspective:complete'>` following the pattern of `handlePlanBuildReviewPerspectiveError` (line 122): nested-record update keyed by `(planId, perspective)` |
| `packages/monitor-ui/src/lib/reducer/index.ts` (lines 31, 116) | Import the new handler and register it under `'plan:build:review:parallel:perspective:complete'` in the registry map. Remove the entry from the "known but unhandled" list around line 201-202 if present |
| `packages/monitor-ui/src/app.tsx` (line 265) | Pass `runState.reviewIssuesByPerspective` to `<ThreadPipeline>` |
| `packages/monitor-ui/src/components/pipeline/thread-pipeline.tsx` (lines 16, 25, 182) | Add `reviewIssuesByPerspective?: Record<string, Record<string, ReviewIssue[]>>` to `ThreadPipelineProps`; propagate to `PlanRow` |
| `packages/monitor-ui/src/components/pipeline/plan-row.tsx` (lines 23-45, 321-323) | Add `issuesByPerspective?: Record<string, ReviewIssue[]>` to `PlanRowProps`. In the hover render, for reviewer threads with `thread.perspective`, look up `issuesByPerspective?.[thread.perspective] ?? []`; for the fixer or perspective-less reviewers, fall back to the current `issues` prop |
| `packages/monitor-ui/src/lib/reducer/__tests__/handle-plan-build.test.ts` | Add a test: `'plan:build:review:parallel:perspective:complete' stores issues keyed by (planId, perspective)`. Pattern from the perspective-error tests at lines 201-238 |

### Profile Signal

**Recommended: Excursion**

Rationale:
- Touches three packages (`client`, `engine`, `monitor-ui`) and ~13 files, but the change shape is uniform and low-risk: most of the work is mechanical deletion (severity filter) plus one targeted reducer extension + UI prop wiring (hover scoping).
- A single planner session can enumerate all plans, file changes, and cross-package ordering with quality. No module-level architectural planning required.
- No subplans need delegated planning. The two items naturally split into two plans (filter-removal, hover-scoping) but both are within the planner's grasp in one cohesive session.
- Not Errand: too many files and the hover-scoping introduces a new reducer state field, so plan review adds value.
- Not Expedition: no shared foundation that demands separate architecture review; no module planners needed; cross-cutting only in the trivial sense of "deletes touch multiple packages."

## Scope

### In scope

**Severity filter removal**
- Delete `autoAcceptBelow` field from `ReviewProfileConfig` (Zod schema + TS type) in `@eforge-build/client`
- Delete `autoAcceptBelow` field from the engine's pipeline composer mirror schema (`packages/engine/src/schemas.ts`)
- Delete `autoAcceptBelow` field from the engine's tier/profile config schema (`packages/engine/src/config.ts`) and the `AUTO_ACCEPT` enum tuple
- Delete `filterIssuesBySeverity` from `packages/engine/src/pipeline/misc.ts` (and the now-unused `SEVERITY_ORDER` import there if it falls out)
- Simplify `reviewCycleStage` termination in `packages/engine/src/pipeline/stages/build-stages.ts`: drop the filter call; break when `ctx.reviewIssues.length === 0`
- Remove the `auto-accept: …` line in the monitor UI build-config display
- Remove the three filter-specific tests from `test/review-strategy-wiring.test.ts`

**Per-reviewer hover scoping**
- Extend monitor UI reducer to handle `plan:build:review:parallel:perspective:complete` and store issues keyed by `(planId, perspective)` in a new state field (`reviewIssuesByPerspective`)
- Update `plan-row.tsx` so reviewer threads pass perspective-scoped issues to `IssuesSummary`; fall back to current behavior for the fixer thread
- Add a regression test in the reducer test suite covering the per-perspective state shape

### Out of scope

- Adding a `perspective` field to `ReviewIssue` (not needed — the perspective-complete event already carries it)
- Per-round tracking when `maxRounds > 1` (default is 1; multi-round overwrite is a known wrinkle, not a regression)
- Adaptive reviewer respawn (separate roadmap item)
- Changes to the fixer's hover content (current merged set is correct for the fixer)
- Changes to `SEVERITY_ORDER` itself (still used by parallel-reviewer dedup and review-fixer sort)
- Changes to reviewer prompts (where the "is this worth fixing" decision now lives — separate concern)
- Migration logic for users with `autoAcceptBelow` set in existing config files (rip-it-out clean per project's no-backwards-compat-cruft stance; user is sole consumer)

### Natural boundary

Three packages: `@eforge-build/client` (schema/types), `engine` (config + pipeline + stage), `monitor-ui` (reducer + plan-row component). Three tests deleted, one reducer test added.

## Acceptance Criteria

### Severity filter removal

- `grep -rn 'autoAcceptBelow' packages/ test/ eforge-plugin/ --include='*.ts' --include='*.tsx'` returns zero hits
- `grep -rn 'AUTO_ACCEPT\b' packages/engine/src/` returns zero hits
- `grep -rn 'filterIssuesBySeverity' packages/` returns zero hits
- `test/review-strategy-wiring.test.ts` no longer contains the three filter-behavior `it` blocks (`returns all issues when autoAcceptBelow is undefined`, `auto-accepts suggestion issues when autoAcceptBelow is "suggestion"`, `auto-accepts warning and suggestion issues when autoAcceptBelow is "warning"`); the file either continues to exist with other tests intact or is deleted entirely if those were its only contents
- The `reviewCycleStage` in `packages/engine/src/pipeline/stages/build-stages.ts` terminates the loop when `ctx.reviewIssues.length === 0` (no filter helper invoked)
- The monitor UI build-config component no longer renders the `auto-accept: …` line; hovering a build with no `autoAcceptBelow` set shows the same content as before this change

### Per-reviewer hover scoping

- `RunState.reviewIssuesByPerspective: Record<string, Record<string, ReviewIssue[]>>` exists in `packages/monitor-ui/src/lib/reducer.ts` and appears in `initialRunState` plus both reset paths (lines 142, 148-149)
- A new handler is registered under `'plan:build:review:parallel:perspective:complete'` in `packages/monitor-ui/src/lib/reducer/index.ts`; the entry is no longer in any "known but unhandled" list
- A new test in `packages/monitor-ui/src/lib/reducer/__tests__/handle-plan-build.test.ts` verifies that `plan:build:review:parallel:perspective:complete` writes issues into `reviewIssuesByPerspective[planId][perspective]` and preserves issues for other plans / other perspectives
- Manual UI verification: open the monitor UI on a completed build that ran multiple reviewer perspectives in parallel. Hovering each reviewer node shows ONLY that perspective's issue counts (e.g. code-reviewer hover shows code's critical/warning/suggestion only, security-reviewer hover shows security's only). Hovering the fixer node shows the merged-and-deduped totals as before this change
- A reviewer thread without a `perspective` field (single-strategy fallback path in `runParallelReview`) falls back to the merged `issues` prop with no rendering regression

### Build & test gates

- `pnpm type-check` passes across all workspace packages
- `pnpm test` passes (vitest)
- `pnpm build` succeeds across all workspace packages
- No new ESLint warnings introduced
- All forged commits use `forgeCommit()` per AGENTS.md convention
