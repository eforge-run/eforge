---
id: plan-01-remove-scope-add-skip
name: Remove plan:scope event, replace complete signal with plan:skip
depends_on: []
branch: remove-plan-scope-event-replace-complete-signal-with-plan-skip/remove-scope-add-skip
---

# Remove plan:scope event, replace complete signal with plan:skip

## Architecture Context

`plan:scope` and `plan:profile` communicate overlapping information. Profile selection already conveys the planner's complexity judgment. With custom profiles beyond built-in EEE names, scope becomes misleading. The only unique behavior scope provides is the `assessment === 'complete'` early-exit signal - which deserves its own purpose-built event.

## Implementation

### Overview

Remove `plan:scope` event type and all supporting infrastructure (`ScopeAssessment` type, `SCOPE_ASSESSMENTS` constant, `ScopeDeclaration` interface, `parseScopeBlock()` function). Add a new `plan:skip` event with a `reason` string field and `parseSkipBlock()` parser. Update all consumers: planner agent, pipeline, CLI, monitor UI, and tests.

### Key Decisions

1. `plan:skip` carries only `reason: string` - no assessment vocabulary, just a human-readable explanation of why planning was skipped. This is simpler and more extensible than the old `assessment === 'complete'` check.
2. The expedition check in `pipeline.ts` simplifies from `ctx.scopeAssessment === 'expedition' && ctx.expeditionModules.length > 0` to just `ctx.expeditionModules.length > 0` - the module list is already the ground truth for expedition mode.
3. The `prd-passthrough` compile stage drops its hardcoded `plan:scope` emission entirely - it was informational and profile emission already covers that.
4. The `formatProfileGenerationSection` reference to scope (line 108: "still emit the `<scope>` block") is removed since scope blocks no longer exist.

## Scope

### In Scope
- Remove `plan:scope` from `EforgeEvent` union, `SCOPE_ASSESSMENTS`, `ScopeAssessment` type
- Remove `ScopeDeclaration`, `VALID_ASSESSMENTS`, `parseScopeBlock()` from `agents/common.ts`
- Add `plan:skip` event type (`{ type: 'plan:skip'; reason: string }`) to event union
- Add `parseSkipBlock()` to `agents/common.ts`
- Update planner agent: remove scope emission logic, add skip emission logic
- Update planner prompt: replace `<scope>` instructions with `<skip>` instructions
- Update pipeline: remove `scopeAssessment` from `PipelineContext`, simplify expedition check
- Update CLI: replace `scopeComplete` with `skipReason`, handle `plan:skip`
- Update CLI display: remove `plan:scope` case, add `plan:skip` case
- Update monitor event-card: reclassify and add summary for `plan:skip`
- Update monitor mock-server: replace `plan:scope` mock events
- Update monitor types: remove `ScopeAssessment` import
- Remove `ScopeAssessment` export from `src/engine/index.ts`
- Update all affected tests

### Out of Scope
- Profile selection logic (unchanged)
- Other event types
- Non-planner agents

## Files

### Modify
- `src/engine/events.ts` - Remove `SCOPE_ASSESSMENTS`, `ScopeAssessment`, `plan:scope` from union. Add `plan:skip` event variant.
- `src/engine/agents/common.ts` - Remove `ScopeDeclaration`, `VALID_ASSESSMENTS`, `parseScopeBlock()`, related imports. Add `parseSkipBlock()`.
- `src/engine/agents/planner.ts` - Remove `scopeEmitted` flag, `plan:scope` emission, fallback scope derivation from profile name, `SCOPE_ASSESSMENTS`/`ScopeAssessment`/`parseScopeBlock` imports. Add `parseSkipBlock` import and `plan:skip` emission.
- `src/engine/prompts/planner.md` - Remove all `<scope>` block instructions (lines 45, 54, 69, 103, 118-124, 128). Add `<skip>` block instruction for already-implemented work. Remove "mode must match scope assessment" if present.
- `src/engine/pipeline.ts` - Remove `ScopeAssessment` import, `scopeAssessment` from `PipelineContext`, scope tracking in planner stage (lines 376-378), hardcoded `plan:scope` in prd-passthrough (line 320). Simplify expedition check (line 407) to `ctx.expeditionModules.length > 0`.
- `src/cli/index.ts` - Replace `scopeComplete` flag with `skipReason` string. Replace `plan:scope`/`complete` check with `plan:skip` check. Update early-return and exit code logic.
- `src/cli/display.ts` - Remove `plan:scope` case from `renderEvent()`. Add `plan:skip` case rendering with dim color and reason.
- `src/monitor/ui/src/lib/types.ts` - Remove `ScopeAssessment` import from engine events re-export.
- `src/monitor/ui/src/components/timeline/event-card.tsx` - Remove `plan:scope` from `classifyEvent` info list and `eventSummary`. Add `plan:skip` classification (info) and summary `"Skipped - {reason}"`.
- `src/monitor/mock-server.ts` - Replace mock `plan:scope` events: remove all `plan:scope` insertions. Where assessment was `complete`, replace with `plan:skip` event; otherwise remove the line.
- `src/engine/index.ts` - Remove `ScopeAssessment` from type re-exports (line 20). `parseScopeBlock` is not currently re-exported, so no removal needed. Add `parseSkipBlock` to value re-exports on line 48.
- `test/agent-wiring.test.ts` - Remove "detects scope assessment" test (lines 37-51), "emits both plan:profile and plan:scope" test (lines 258-278), "emits only plan:scope when no profile block" test (lines 301-318). Add test: planner emits `<skip>` block -> `plan:skip` event.
- `test/xml-parsers.test.ts` - Remove `parseScopeBlock` describe block and import. Add `parseSkipBlock` tests (valid parse, null for no block, null for empty reason).
- `test/session.test.ts` - Update "generator returns early (scope-complete)" test (lines 115-130) to use `plan:skip` instead of `plan:scope`/`complete`.
- `test/pipeline.test.ts` - Remove `ScopeAssessment` import and `scopeAssessment` pipeline context test.

## Verification

- [ ] `pnpm type-check` exits with code 0
- [ ] `pnpm test` exits with code 0
- [ ] `pnpm build` exits with code 0
- [ ] `grep -r 'ScopeAssessment\|SCOPE_ASSESSMENTS\|parseScopeBlock\|ScopeDeclaration\|scopeEmitted\|scopeComplete\|plan:scope' src/ test/` returns zero matches
- [ ] `grep -r 'plan:skip' src/engine/events.ts` returns the new event variant with `reason: string`
- [ ] `grep -r 'parseSkipBlock' src/engine/agents/common.ts` returns the new parser function
- [ ] CLI `plan:skip` case in `display.ts` renders with `chalk.dim` and includes the reason string
- [ ] Monitor `event-card.tsx` classifies `plan:skip` as `info` and renders summary `"Skipped — {reason}"`
