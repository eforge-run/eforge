---
id: plan-01-remove-severity-filter
name: Remove autoAcceptBelow severity filter from config, schema, engine, UI,
  and tests
branch: simplify-review-cycle-remove-severity-filter-and-fix-per-reviewer-hover-scoping-in-monitor-ui/plan-01-remove-severity-filter
---

---
id: plan-01-remove-severity-filter
name: Remove autoAcceptBelow severity filter from config, schema, engine, UI, and tests
depends_on: []
---

# Remove autoAcceptBelow severity filter

## Architecture Context

The `autoAcceptBelow` field on `ReviewProfileConfig` is an opt-in severity filter applied via `filterIssuesBySeverity` in `packages/engine/src/pipeline/misc.ts`. When unset (the default in `DEFAULT_REVIEW`), it short-circuits and passes all issues through. The `reviewCycleStage` in `packages/engine/src/pipeline/stages/build-stages.ts` uses the filtered list to decide early termination. Per the source PRD: nobody uses the opt-in, the default is unset, and 'what counts as worth fixing' belongs in reviewer prompts not engine config. Removing it tightens the surface and makes the cycle's termination clearer ("reviewers reported zero issues" vs. "post-filter zero").

`SEVERITY_ORDER` (`packages/client/src/events.schemas.ts:1064-1068`) is still used by `parallel-reviewer.ts` (dedup, highest-severity-wins) and `review-fixer.ts` (sort order) — keep it. Only its incidental import in `pipeline/misc.ts` falls out.

Per the project's no-backwards-compat-cruft stance (user is sole consumer), no migration logic is provided for users with `autoAcceptBelow` set in existing config files.

## Implementation

### Overview

Mechanical deletion across three packages plus one test file. The change rolls in dependency order: `client` types first, then `engine` config + schema + pipeline, then `monitor-ui` build-config display, then test cleanup. All edits are subtractive — no new code beyond simplified replacement at the cycle termination check.

### Key Decisions

1. **Drop the field everywhere in one plan.** `pipelineReviewProfileConfigSchema` (engine) is bound `z.ZodType<ReviewProfileConfig>` (client). Splitting across plans would create a transient type mismatch in mid-merge state. Single plan, one commit boundary.
2. **Replace filtered-list termination with raw-list termination.** The cycle stage today does `const { filtered } = filterIssuesBySeverity(...); ctx.reviewIssues = filtered; if (filtered.length === 0) break;`. Replacement: `if (ctx.reviewIssues.length === 0) break;`. The unfiltered `ctx.reviewIssues` is already the merged-and-deduped set output by the parallel reviewer.
3. **Delete the three filter-behavior tests, keep the rest of the file.** `test/review-strategy-wiring.test.ts` covers strategy wiring beyond the filter tests; surgical removal of the three `it` blocks plus any newly-unused imports.
4. **No plugin version bump.** No plugin-facing change (no CLI command, MCP tool, or skill behavior changes). Per AGENTS.md the bump is conditional on plugin changes.

## Scope

### In Scope

- Remove `autoAcceptBelow` field from `ReviewProfileConfig` Zod schema in `packages/client/src/events.schemas.ts`
- Remove `autoAcceptBelow?` field from the matching TS type in `packages/client/src/types.ts`
- Remove `AUTO_ACCEPT` enum tuple and `autoAcceptBelow` Zod field from `packages/engine/src/config.ts`
- Remove `autoAcceptBelow` field from the pipeline composer mirror schema in `packages/engine/src/schemas.ts`
- Delete `filterIssuesBySeverity` function from `packages/engine/src/pipeline/misc.ts` and remove its now-unused `SEVERITY_ORDER` import on line 7 if no other reference remains in that file
- Simplify `reviewCycleStage` termination in `packages/engine/src/pipeline/stages/build-stages.ts` (drop import, drop config extraction, replace filter call with raw-length check)
- Remove the `auto-accept: …` display block in `packages/monitor-ui/src/components/plans/build-config.tsx`
- Delete the three filter-behavior `it` blocks from `test/review-strategy-wiring.test.ts` and drop any imports they exclusively used

### Out of Scope

- Migration logic for users with `autoAcceptBelow` set in existing config files (rip-it-out clean per project policy)
- Changes to `SEVERITY_ORDER` itself (still used by parallel-reviewer dedup and review-fixer sort)
- Changes to reviewer prompts (the new home for the "is this worth fixing" decision — separate concern, not in this PRD)
- Per-reviewer hover scoping (handled in plan-02)
- Plugin version bump (no plugin-facing change)

## Files

### Modify

- `packages/client/src/events.schemas.ts` — drop `autoAcceptBelow` field from `ReviewProfileConfigSchema` (currently line 88)
- `packages/client/src/types.ts` — drop `autoAcceptBelow?` field from the `ReviewProfileConfig` TS type (currently line 81)
- `packages/engine/src/config.ts` — delete the `AUTO_ACCEPT` enum tuple (currently line 104) and the `autoAcceptBelow` Zod field on the tier/profile config (currently line 113); leave `DEFAULT_REVIEW` (lines 431-436) intact other than removing the field if present
- `packages/engine/src/schemas.ts` — drop `autoAcceptBelow` field from `pipelineReviewProfileConfigSchema` (currently line 460)
- `packages/engine/src/pipeline/misc.ts` — delete the `filterIssuesBySeverity` function (currently lines 50-66, including the JSDoc); remove the `SEVERITY_ORDER` import on line 7 if it becomes unused after the deletion (verify by inspecting other references in the file)
- `packages/engine/src/pipeline/stages/build-stages.ts` — drop the `filterIssuesBySeverity` import (currently line 37); inside `reviewCycleStage`, drop the `autoAcceptBelow` extraction (currently line 565); replace the filter call + assignment + length check (currently lines 570-572) with a single `if (ctx.reviewIssues.length === 0) break;`
- `packages/monitor-ui/src/components/plans/build-config.tsx` — delete the `{review.autoAcceptBelow && (...)}` block (currently lines 61-63); leave the rest of the review-config rendering intact
- `test/review-strategy-wiring.test.ts` — remove the three filter-behavior `it` blocks (`returns all issues when autoAcceptBelow is undefined`, `auto-accepts suggestion issues when autoAcceptBelow is "suggestion"`, `auto-accepts warning and suggestion issues when autoAcceptBelow is "warning"`); drop any `import { filterIssuesBySeverity }` or related helpers that are no longer referenced; if those were the only tests in the file, delete the file outright

## Verification

- [ ] `grep -rn 'autoAcceptBelow' packages/ test/ eforge-plugin/ --include='*.ts' --include='*.tsx'` returns zero hits
- [ ] `grep -rn 'AUTO_ACCEPT\b' packages/engine/src/` returns zero hits
- [ ] `grep -rn 'filterIssuesBySeverity' packages/` returns zero hits
- [ ] `test/review-strategy-wiring.test.ts` no longer contains any `it` block whose title starts with `returns all issues when autoAcceptBelow`, `auto-accepts suggestion issues`, or `auto-accepts warning and suggestion issues`; the file either remains with other tests intact or is deleted entirely
- [ ] In `packages/engine/src/pipeline/stages/build-stages.ts`, the `reviewCycleStage` terminates the loop with `if (ctx.reviewIssues.length === 0) break;` and contains no `filterIssuesBySeverity` call, no `autoAcceptBelow` reference, and no `filterIssuesBySeverity` import
- [ ] `grep -n 'SEVERITY_ORDER' packages/client/src/events.schemas.ts` still finds the constant (lines 1064-1068 region) — it must not be deleted; `grep -rn 'SEVERITY_ORDER' packages/engine/src/` still shows uses in `parallel-reviewer.ts` and `review-fixer.ts`
- [ ] In `packages/monitor-ui/src/components/plans/build-config.tsx`, no JSX block references `review.autoAcceptBelow`
- [ ] `pnpm type-check` exits 0
- [ ] `pnpm test` exits 0
- [ ] `pnpm build` exits 0
- [ ] The implementation commit is produced via `forgeCommit()` per AGENTS.md convention
