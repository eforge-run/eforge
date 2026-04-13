---
id: plan-01-remove-prd-passthrough
name: Remove prd-passthrough compile stage
depends_on: []
branch: remove-prd-passthrough-compile-stage/remove-prd-passthrough
---

# Remove prd-passthrough compile stage

## Architecture Context

The `prd-passthrough` compile stage was a non-LLM shortcut that converted PRDs directly into plan artifacts for errands. This bypassed the planner, which meant the planner's skip-detection logic (for already-implemented PRDs) never ran for errands. Prior work already made the planner handle errands gracefully (single simple plan, `plan:skip` for nothing-to-do). This plan removes the now-redundant `prd-passthrough` stage and all references to it.

## Implementation

### Overview

Delete the `prd-passthrough` stage registration from `pipeline.ts`, remove the `conflictsWith` reference from the planner stage, update a stale comment in pipeline restart logic, remove special-case UI handling, update docs, and fix all test fixtures.

### Key Decisions

1. `writePlanArtifacts()` in `plan.ts` is retained - it is used by `test/adopt.test.ts` and may serve future adopt/import workflows.
2. No changes needed to `pipeline-composer.md` - the stage registry table is auto-generated from registered stages, so `prd-passthrough` disappears automatically from the composer's catalog.

## Scope

### In Scope
- Delete `prd-passthrough` stage registration (lines 707-761 in `pipeline.ts`)
- Remove `conflictsWith: ['prd-passthrough']` from planner stage (line 769)
- Update stale comment referencing prd-passthrough in pipeline restart logic (line 2024)
- Remove special-case handling in monitor UI (`thread-pipeline.tsx` lines 581-583)
- Update `docs/architecture.md` (Mermaid diagram, stages table, errand profile description)
- Fix six test files that reference prd-passthrough

### Out of Scope
- Removing `writePlanArtifacts()` from `plan.ts`
- Changes to `pipeline-composer.md`
- Defensive changes in `planner.ts`, `eforge.ts`, prompt strengthening (already applied)

## Files

### Modify
- `packages/engine/src/pipeline.ts` - Delete prd-passthrough stage registration (lines 707-761), remove `conflictsWith: ['prd-passthrough']` from planner stage (line 769), update comment at line 2024
- `packages/monitor-ui/src/components/pipeline/thread-pipeline.tsx` - Remove prd-passthrough special-case handling (lines 581-583)
- `docs/architecture.md` - Remove prd-passthrough from Mermaid diagram (line 102), stages table (line 121), and errand profile description (line 146)
- `test/adopt.test.ts` - Change `compile: ['prd-passthrough']` to `compile: ['planner']` (line 14)
- `test/plan-parsing.test.ts` - Change `compile: ['prd-passthrough']` to `compile: ['planner']` (line 21)
- `test/plan-complete-depends-on.test.ts` - Change `compile: ['prd-passthrough']` to `compile: ['planner']` (line 8)
- `test/agent-wiring.test.ts` - Remove conflict detection test between planner and prd-passthrough (around line 802)
- `test/pipeline.test.ts` - Remove `'prd-passthrough'` from `builtinCompileStages` list and update count (line 154), remove specific prd-passthrough registry test (lines 727-729)
- `test/continuation.test.ts` - Change `- prd-passthrough` to `- planner` in YAML fixtures (lines 152, 197)

## Verification

- [ ] `pnpm type-check` exits 0
- [ ] `pnpm test` exits 0 with all tests passing
- [ ] `pnpm build` exits 0
- [ ] `grep -r 'prd-passthrough' packages/ test/ docs/` returns zero matches
- [ ] `writePlanArtifacts` function still exists in `packages/engine/src/plan.ts`
