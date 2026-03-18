---
title: Remove `plan:scope` event, replace "complete" signal with `plan:skip`
created: 2026-03-18
status: pending
---

## Problem / Motivation

`plan:scope` and `plan:profile` communicate overlapping information using the same EEE vocabulary, which causes confusion (e.g., "scope: errand, profile: excursion"). Profile selection already conveys the planner's complexity judgment in its rationale. With custom profiles beyond the built-in EEE set, scope becomes actively misleading. No pipeline logic depends on scope independently of profile - except one special case: `assessment === 'complete'` triggers an early exit when work is already implemented.

## Goal

Remove the `plan:scope` event entirely and replace the "already complete" early-exit signal with a new, purpose-built `plan:skip` event.

## Approach

1. **Add `plan:skip` event type** (`{ type: 'plan:skip'; reason: string }`) to the event union in `src/engine/events.ts`. Remove `SCOPE_ASSESSMENTS` constant, `ScopeAssessment` type, and the `plan:scope` variant.

2. **Replace XML parsing** in `src/engine/agents/common.ts`:
   - Remove `ScopeDeclaration` interface (lines 82-85), `VALID_ASSESSMENTS` set (line 87), `parseScopeBlock()` function (lines 154-165), and related imports (lines 6-7).
   - Add `parseSkipBlock(text: string): string | null` - parses `<skip>reason</skip>` XML.

3. **Update planner agent** (`src/engine/agents/planner.ts`):
   - Remove `scopeEmitted` flag (line 203) and all `plan:scope` emission logic (lines 228-233).
   - Remove fallback that derives `plan:scope` from profile name (lines 270-278).
   - Remove `SCOPE_ASSESSMENTS`, `ScopeAssessment`, `parseScopeBlock` imports (lines 5-6).
   - Add `parseSkipBlock` import and emit `plan:skip` when planner outputs `<skip>` block.
   - Remove scope reference from `formatProfileGenerationSection` (line 108).

4. **Update planner prompt** (`src/engine/prompts/planner.md`):
   - Remove all `<scope>` block instructions (lines 45, 54, 69, 103, 118-124, 128).
   - Replace with `<skip>` block instruction: "If the source is fully implemented (zero gaps), emit `<skip>reason</skip>` and do NOT write any plan files."
   - Remove "mode must match scope assessment" (line 331) - mode is informational, derived from profile.
   - Keep profile selection instructions intact.

5. **Remove from pipeline context** (`src/engine/pipeline.ts`):
   - Remove `scopeAssessment` field from `PipelineContext` (line 68) and `ScopeAssessment` import (line 23).
   - Remove scope tracking in planner stage (lines 376-378).
   - Simplify expedition check (line 407): replace `ctx.scopeAssessment === 'expedition' && ctx.expeditionModules.length > 0` with just `ctx.expeditionModules.length > 0`.
   - Remove hardcoded `plan:scope` emission in prd-passthrough stage (line 320).

6. **Update CLI** (`src/cli/index.ts`):
   - Replace `scopeComplete` flag (line 294) with `skipReason` string.
   - Replace `plan:scope`/`complete` check (lines 334-335) with `plan:skip` check.
   - Update early-return logic (lines 347-349) to use `skipReason`.
   - Update exit code logic (line 397) to use `skipReason`.

7. **Update CLI display** (`src/cli/display.ts`, lines 116-126):
   - Remove `plan:scope` case from `renderEvent()`.
   - Add `plan:skip` case (render with dim color + reason).

8. **Update monitor UI**:
   - `src/monitor/ui/src/lib/types.ts` (line 13): Remove `ScopeAssessment` import.
   - `src/monitor/ui/src/components/timeline/event-card.tsx` (lines 24, 36): Remove `plan:scope` from event type classification and summary handler. Add `plan:skip` classification (info) and summary: `"Skipped — {reason}"`.
   - `src/monitor/mock-server.ts`: Replace mock `plan:scope` events with `plan:skip` where assessment was `complete`; remove the rest.

9. **Remove `ScopeAssessment` export** from `src/engine/index.ts` (line 20).

10. **Update tests**:
    - `test/agent-wiring.test.ts`: Remove 3 scope-related tests (lines 37-51, 258-277, 301-315). Add test: planner emits `<skip>` block → `plan:skip` event.
    - `test/xml-parsers.test.ts`: Remove `parseScopeBlock` describe block and import. Add `parseSkipBlock` tests.
    - `test/session.test.ts` (lines 115-127): Update "generator returns early" test to use `plan:skip` instead of `plan:scope`/`complete`.
    - `test/pipeline.test.ts`: Remove `ScopeAssessment` import and `scopeAssessment` pipeline context test.

## Scope

**In scope:**
- Removing `plan:scope` event type, `SCOPE_ASSESSMENTS` constant, `ScopeAssessment` type, `ScopeDeclaration` interface, `parseScopeBlock()` function, and all related imports/exports
- Adding `plan:skip` event type with `reason: string` field
- Adding `parseSkipBlock()` XML parser
- Updating planner agent and prompt to use `<skip>` instead of `<scope>`
- Updating pipeline context to remove `scopeAssessment` field and simplify expedition check
- Updating CLI early-exit logic from `scopeComplete` flag to `skipReason` string
- Updating CLI display, monitor UI event card, monitor mock server
- Updating all affected tests

**Out of scope:**
- Changes to profile selection logic (kept intact)
- Changes to any other event types
- Changes to the builder, reviewer, or other non-planner agents

## Acceptance Criteria

- `pnpm type-check` passes
- `pnpm test` passes
- `pnpm build` clean
- No references to `ScopeAssessment`, `SCOPE_ASSESSMENTS`, `parseScopeBlock`, `ScopeDeclaration`, `scopeEmitted`, `scopeComplete`, or `plan:scope` remain in `src/` or `test/`
- `plan:skip` event type exists in the `EforgeEvent` union with `reason: string` field
- `parseSkipBlock` correctly parses `<skip>reason</skip>` XML and returns the reason string (or null)
- CLI exits early (code 0) on `plan:skip`
- Planner prompt instructs `<skip>` for already-implemented work (no plan files written)
- Monitor UI renders `plan:skip` events with info classification and `"Skipped — {reason}"` summary
