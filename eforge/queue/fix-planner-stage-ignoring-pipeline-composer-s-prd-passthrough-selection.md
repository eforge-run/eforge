---
title: Fix planner stage ignoring pipeline-composer's prd-passthrough selection
created: 2026-04-04
---

# Fix planner stage ignoring pipeline-composer's prd-passthrough selection

## Problem / Motivation

When the pipeline-composer correctly selects `prd-passthrough` as the compile pipeline, the planner stage ignores that decision and unconditionally runs the full LLM planner. This happens because the planner stage is both the default compile entry point and the host for the pipeline-composer - when the composer decides work should use `prd-passthrough` instead, there is no mechanism for the planner stage to abort itself and delegate.

The validated buggy flow:

1. Default compile pipeline is `['planner', 'plan-review-cycle']` (`eforge.ts:257`)
2. `runCompilePipeline` starts executing stage index 0: `'planner'` (`pipeline.ts:1995-2006`)
3. Inside the planner stage, `composePipeline()` runs (`pipeline.ts:771-793`)
4. Composer correctly returns `compile: ["prd-passthrough"]` - the model chose the right path
5. `ctx.pipeline.compile` is updated to `["prd-passthrough"]` (`pipeline.ts:784-790`)
6. **BUG**: No conditional check after the composer loop. Code proceeds directly to `runPlanner()` at line 835 regardless of the composer's decision
7. The LLM planner runs unnecessarily (wasting tokens/time), and depending on the model, may or may not produce plan files
8. After the planner stage completes, `runCompilePipeline` increments `i` from 0 to 1
9. `ctx.pipeline.compile` is now `["prd-passthrough"]` (length 1), so `while (1 < 1)` exits
10. **`prd-passthrough` never executes** - its `writePlanArtifacts()` never runs
11. Build phase hits ENOENT on `orchestration.yaml`

This wastes tokens/time on the unnecessary planner run and then causes the build to fail entirely because `orchestration.yaml` is never created.

## Goal

When the pipeline-composer selects `prd-passthrough`, the planner stage should respect that decision - skip the LLM planner, ensure the `prd-passthrough` stage executes, and produce a valid `orchestration.yaml` so the build phase succeeds.

## Approach

After `composePipeline()` completes at `pipeline.ts:793`, add a guard: if `ctx.pipeline.compile` no longer includes `'planner'`, the planner stage should return early and let `runCompilePipeline` pick up the new stages.

The key design decision is the loop reset: `runCompilePipeline` needs to reset `i = 0` when it detects that the compile stages changed, or alternatively the planner stage runs `prd-passthrough` internally before returning.

### Critical files

- `src/engine/pipeline.ts:763-924` - planner stage (fix goes after line 793)
- `src/engine/pipeline.ts:1988-2010` - `runCompilePipeline` loop (may need index reset)
- `src/engine/pipeline.ts:707-761` - prd-passthrough stage
- `src/engine/agents/planner.ts:66-206` - `runPlanner` function
- `src/engine/agents/pipeline-composer.ts:75-154` - `composePipeline`
- `src/engine/eforge.ts:255-261` - default pipeline

### Non-issue: prompt robustness

The original assessment suggested the planner prompt should explicitly mention tools. This is **wrong** - tools are harness-specific backend implementation details and must never be referenced in prompts. The weaker model correctly chose `prd-passthrough`; the failure was the engine ignoring that choice.

## Scope

### In scope

- Adding a guard in the planner stage to return early when the composer selects a pipeline that doesn't include `planner`
- Ensuring `runCompilePipeline` correctly executes the new compile stages (e.g., index reset)
- Test coverage for the composer-to-passthrough path

### Out of scope

- Modifying planner or composer prompts
- Adding tool references to prompts
- Changes to the `prd-passthrough` stage logic itself
- Changes to the build phase

## Acceptance Criteria

- A test exists that runs the planner stage with a composer that returns `compile: ["prd-passthrough"]` and verifies that `prd-passthrough`'s `writePlanArtifacts()` executes
- An eforge build with a simple PRD that should trigger `prd-passthrough` completes successfully and produces a valid `orchestration.yaml`
- `pnpm test` passes with no regressions
- The LLM planner does not run when the composer selects `prd-passthrough`
