---
id: plan-02-fix-per-reviewer-hover-scoping
name: Scope per-reviewer hover to perspective-specific issues in monitor UI
branch: simplify-review-cycle-remove-severity-filter-and-fix-per-reviewer-hover-scoping-in-monitor-ui/plan-02-fix-per-reviewer-hover-scoping
---

---
id: plan-02-fix-per-reviewer-hover-scoping
name: Scope per-reviewer hover to perspective-specific issues in monitor UI
depends_on: [plan-01-remove-severity-filter]
---

# Scope per-reviewer hover to perspective-specific issues

## Architecture Context

In `packages/monitor-ui/src/components/pipeline/plan-row.tsx:321-323`, every reviewer thread renders `<IssuesSummary issues={issues} />` against the merged-and-deduped per-plan issue set (`reviewIssues[planId]`, populated on `plan:build:review:complete`). When three perspectives ran (e.g. `code`, `security`, `api`), all three reviewer hovers show the same combined totals — that's the bug.

The data needed to fix this is already on the wire: `plan:build:review:parallel:perspective:complete` carries `{ planId, perspective, issues: ReviewIssue[] }` (`packages/client/src/events.schemas.ts:559-564`). Today the reducer does not handle this event for issue tracking — it only stores the merged set on `plan:build:review:complete`.

The pattern is a direct analogue of `handlePlanBuildReviewPerspectiveError` (`handle-plan-build.ts:122`): both maintain a `Record<string, Record<string, T>>` shape keyed by `(planId, perspective)`. The reducer reset paths in `reducer.ts` (lines 142, 148-149) enumerate fields by hand — easy to miss the new field; both must be updated.

The **fixer** thread should keep its current behavior (merged-and-deduped totals from `reviewIssues[planId]`) — the fixer addresses the merged set. Only **reviewer** threads with a `perspective` get the per-perspective lookup. A reviewer thread without `perspective` (single-strategy fallback) falls back to the merged set.

Multi-round caveat: when `maxRounds > 1`, later rounds would overwrite the per-perspective entry. Default is 1, so this is not load-bearing today; out of scope per the PRD.

This plan depends on plan-01 only to avoid potential merge conflicts on `events.schemas.ts` (plan-01 deletes a field there; this plan imports `ReviewIssue` from the same file but does not modify it). Sequencing prevents transient type mismatches.

## Implementation

### Overview

Four edits compose the fix:
1. **Reducer state** — add `reviewIssuesByPerspective: Record<string, Record<string, ReviewIssue[]>>` to `RunState`, `initialRunState`, and both reset paths.
2. **Reducer handler** — add `handlePlanBuildReviewPerspectiveComplete` modeled on `handlePlanBuildReviewPerspectiveError`; register it in the handler map and remove from any "known but unhandled" list.
3. **Prop wiring** — propagate the new map from `app.tsx` through `ThreadPipeline` to `PlanRow`.
4. **Per-reviewer hover render** — in `plan-row.tsx`, when a thread is a reviewer with `thread.perspective`, look up `issuesByPerspective?.[thread.perspective] ?? []`; otherwise fall back to the existing merged `issues` prop.
5. **Test** — add a reducer test that the new event populates `reviewIssuesByPerspective[planId][perspective]` and preserves entries for other plans / other perspectives.

### Key Decisions

1. **No schema change.** The wire event already carries `perspective` and `issues`. No new event variant is needed and `ReviewIssue` does not need a `perspective` field.
2. **Mirror the perspective-error handler exactly.** `handlePlanBuildReviewPerspectiveError` already does the `(planId, perspective)` two-level update with field preservation for other plans and other perspectives. The new handler is a direct adaptation.
3. **Fixer keeps the merged set.** The fixer addresses merged-and-deduped issues (output of dedup in `parallel-reviewer.ts:213-218`). The current `reviewIssues[planId]` is correct for the fixer; only reviewer threads with a `perspective` get the new lookup.
4. **Explicit reset on both paths.** `reducer.ts:142` and `:148-149` enumerate fields by hand; missing the new field on either path silently breaks idempotence (state leaks across run boundaries). Add to both, in the same shape as adjacent fields.
5. **Single new test, no rendering test.** Component-level rendering tests are not part of the existing test surface for `plan-row.tsx`; the bug is provably fixed by reducer-level coverage of the new state plus manual UI verification, per the PRD.

## Scope

### In Scope

- Extend `RunState` in `packages/monitor-ui/src/lib/reducer.ts` with `reviewIssuesByPerspective: Record<string, Record<string, ReviewIssue[]>>`
- Initialize the field in `initialRunState` (around line 104) and add it to both reset paths (around lines 142 and 148-149) using the same shape as adjacent fields
- Add `handlePlanBuildReviewPerspectiveComplete: EventHandler<'plan:build:review:parallel:perspective:complete'>` to `packages/monitor-ui/src/lib/reducer/handle-plan-build.ts`, modeled on `handlePlanBuildReviewPerspectiveError`
- Register the new handler in the registry map in `packages/monitor-ui/src/lib/reducer/index.ts` (import around line 31, registration around line 116); if a "known but unhandled" list contains this event name (around lines 201-202), remove it
- Pass `runState.reviewIssuesByPerspective` from `packages/monitor-ui/src/app.tsx` (around line 265) into `<ThreadPipeline>` as a new prop
- Add `reviewIssuesByPerspective?: Record<string, Record<string, ReviewIssue[]>>` to `ThreadPipelineProps` in `packages/monitor-ui/src/components/pipeline/thread-pipeline.tsx` (around lines 16, 25) and forward it to `<PlanRow>` (around line 182)
- Add `issuesByPerspective?: Record<string, ReviewIssue[]>` to `PlanRowProps` in `packages/monitor-ui/src/components/pipeline/plan-row.tsx` (around lines 23-45). In the hover render (around lines 321-323), when the thread is a reviewer (`REVIEW_AGENTS.has(thread.agent)`) AND has `thread.perspective`, render `<IssuesSummary issues={issuesByPerspective?.[thread.perspective] ?? []} />`; otherwise (fixer or perspective-less reviewer fallback) keep the current `<IssuesSummary issues={issues} />` behavior. Only render when the resolved issues array has length > 0, matching the current guard
- Add a test in `packages/monitor-ui/src/lib/reducer/__tests__/handle-plan-build.test.ts` named `'plan:build:review:parallel:perspective:complete' stores issues keyed by (planId, perspective)`. It must verify: (a) the event writes issues into `reviewIssuesByPerspective[planId][perspective]`; (b) entries for other plans are preserved; (c) entries for other perspectives on the same plan are preserved. Pattern from the perspective-error tests around lines 201-238

### Out of Scope

- Adding a `perspective` field to `ReviewIssue` (the wire event already carries it on the envelope)
- Per-round tracking when `maxRounds > 1` (default is 1; multi-round overwrite is a known wrinkle, not a regression)
- Adaptive reviewer respawn (separate roadmap item)
- Changes to fixer hover content (current merged set is correct for the fixer)
- Changes to `SEVERITY_ORDER` (still used by parallel-reviewer and review-fixer)
- Component-level rendering tests for `plan-row.tsx`
- Plugin version bump (no plugin-facing change)

## Files

### Modify

- `packages/monitor-ui/src/lib/reducer.ts` — add `reviewIssuesByPerspective: Record<string, Record<string, ReviewIssue[]>>` to the `RunState` type (around line 74); add `reviewIssuesByPerspective: {}` to `initialRunState` (around line 104); add `reviewIssuesByPerspective: {}` to both explicit-reset object literals (around lines 142 and 148-149) using the same shape as adjacent reset fields. Import `ReviewIssue` from `@eforge-build/client` if not already imported in this file
- `packages/monitor-ui/src/lib/reducer/handle-plan-build.ts` — add `handlePlanBuildReviewPerspectiveComplete: EventHandler<'plan:build:review:parallel:perspective:complete'>`. Implementation: read `payload.planId`, `payload.perspective`, `payload.issues`; return the prior state with `reviewIssuesByPerspective` updated as `{ ...prior.reviewIssuesByPerspective, [planId]: { ...(prior.reviewIssuesByPerspective[planId] ?? {}), [perspective]: issues } }`. Mirror the structural pattern of `handlePlanBuildReviewPerspectiveError` (around line 122)
- `packages/monitor-ui/src/lib/reducer/index.ts` — import the new handler (around line 31); register it under the key `'plan:build:review:parallel:perspective:complete'` in the handler registry (around line 116); if the event name appears in any "known but unhandled" allowlist around lines 201-202, remove it
- `packages/monitor-ui/src/app.tsx` — at the `<ThreadPipeline>` invocation site (around line 265), add `reviewIssuesByPerspective={runState.reviewIssuesByPerspective}`
- `packages/monitor-ui/src/components/pipeline/thread-pipeline.tsx` — add `reviewIssuesByPerspective?: Record<string, Record<string, ReviewIssue[]>>` to `ThreadPipelineProps` (around line 16); destructure it in the component signature (around line 25); forward `issuesByPerspective={reviewIssuesByPerspective?.[planId]}` to `<PlanRow>` (around line 182). Import `ReviewIssue` from `@eforge-build/client` if not already imported
- `packages/monitor-ui/src/components/pipeline/plan-row.tsx` — add `issuesByPerspective?: Record<string, ReviewIssue[]>` to `PlanRowProps` (around lines 23-45); destructure it in the component signature; in the reviewer-hover JSX block (around lines 321-323), replace the unconditional `<IssuesSummary issues={issues} />` with logic that, for reviewer threads with `thread.perspective`, uses `const resolvedIssues = issuesByPerspective?.[thread.perspective] ?? [];` and renders `<IssuesSummary issues={resolvedIssues} />` only when `resolvedIssues.length > 0`; for the fixer or perspective-less reviewers, keep the existing `<IssuesSummary issues={issues} />` guarded by `issues && issues.length > 0`
- `packages/monitor-ui/src/lib/reducer/__tests__/handle-plan-build.test.ts` — add a new `it` block titled `'plan:build:review:parallel:perspective:complete' stores issues keyed by (planId, perspective)`. Construct two payloads: (a) `{ planId: 'p1', perspective: 'code', issues: [<one critical issue>] }`; (b) `{ planId: 'p1', perspective: 'security', issues: [<one warning issue>] }`; (c) `{ planId: 'p2', perspective: 'code', issues: [<one suggestion issue>] }`. Apply them in sequence and assert: `state.reviewIssuesByPerspective.p1.code` matches (a)'s issues; `state.reviewIssuesByPerspective.p1.security` matches (b)'s issues; `state.reviewIssuesByPerspective.p2.code` matches (c)'s issues; the existing `p1.code` entry survives after the `p1.security` write. Pattern from the perspective-error tests around lines 201-238

## Verification

- [ ] `grep -n 'reviewIssuesByPerspective' packages/monitor-ui/src/lib/reducer.ts` shows the field declared in `RunState`, set in `initialRunState`, and present in both reset blocks (three or more matches)
- [ ] `grep -n 'plan:build:review:parallel:perspective:complete' packages/monitor-ui/src/lib/reducer/index.ts` shows the registry registration
- [ ] No `'plan:build:review:parallel:perspective:complete'` entry remains in any "known but unhandled" list in `packages/monitor-ui/src/lib/reducer/index.ts`
- [ ] `handlePlanBuildReviewPerspectiveComplete` is exported from `packages/monitor-ui/src/lib/reducer/handle-plan-build.ts`
- [ ] `packages/monitor-ui/src/app.tsx` passes `reviewIssuesByPerspective={runState.reviewIssuesByPerspective}` to `<ThreadPipeline>`
- [ ] `packages/monitor-ui/src/components/pipeline/thread-pipeline.tsx` declares `reviewIssuesByPerspective?: Record<string, Record<string, ReviewIssue[]>>` in `ThreadPipelineProps` and forwards `issuesByPerspective={reviewIssuesByPerspective?.[planId]}` to `<PlanRow>`
- [ ] `packages/monitor-ui/src/components/pipeline/plan-row.tsx` declares `issuesByPerspective?: Record<string, ReviewIssue[]>` in `PlanRowProps`; the reviewer-hover JSX uses `issuesByPerspective?.[thread.perspective]` when `thread.perspective` is set; the fixer / perspective-less branch continues to read from the `issues` prop
- [ ] The new test in `packages/monitor-ui/src/lib/reducer/__tests__/handle-plan-build.test.ts` is titled exactly `'plan:build:review:parallel:perspective:complete' stores issues keyed by (planId, perspective)`, applies three perspective-complete events across two plans and two perspectives, and asserts that all three nested entries are present after the third dispatch (proving preservation across writes)
- [ ] The test file's existing perspective-error tests (around lines 201-238) still pass without modification
- [ ] `pnpm type-check` exits 0
- [ ] `pnpm test` exits 0 (vitest runs the new test plus all existing reducer tests)
- [ ] `pnpm build` exits 0
- [ ] The implementation commit is produced via `forgeCommit()` per AGENTS.md convention
