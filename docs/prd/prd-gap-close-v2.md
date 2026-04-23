---
title: "Smart PRD Gap Closer: Assess, Plan, Build"
scope: excursion
depends_on: []
---

# Smart PRD Gap Closer: Assess, Plan, Build

## Problem / Motivation

The initial gap-closer implementation (from the prior build) provides basic plumbing: when PRD validation finds gaps, a simple fixer agent attempts to close them in one shot. This is insufficient for real-world gaps, especially in expeditions where entire requirements may be missed. A 30-turn one-shot agent can't handle significant gaps, and there's no way to know upfront whether fix-forward is even viable.

The gap closer needs to be smarter: assess the scope of remaining work, decide whether fix-forward is viable, generate a targeted plan, and execute it through the existing build infrastructure (builder with continuation/handoff + review cycle) rather than a bespoke fixer.

## Goal

Replace the simple gap-closer agent with a multi-stage gap-close pipeline that:

1. Assesses completion percentage and gap complexity to decide if fix-forward is viable
2. Generates a targeted fix plan from the identified gaps
3. Executes that plan through existing build stages (implement with continuation support, review-fix cycle)
4. Appears as a distinct swimlane in the monitor UI
5. Re-runs post-merge validation before finalizing

## Approach

### 1. Enhance PRD validator output with scope assessment

Extend the PRD validator's structured JSON output to include completion estimate and per-gap complexity:

```json
{
  "completionPercent": 85,
  "gaps": [
    {
      "requirement": "...",
      "explanation": "...",
      "complexity": "trivial|moderate|significant"
    }
  ]
}
```

Update the `PrdValidationGap` type in `src/engine/events.ts` to include the optional `complexity` field. Update the PRD validator prompt (`src/engine/prompts/prd-validator.md`) to request this additional output. Update the `parseGaps` function in `src/engine/agents/prd-validator.ts` to extract `completionPercent` and `complexity`.

Add `completionPercent` to the `prd_validation:complete` event type.

### 2. Viability gate in `prdValidate` phase

In `src/engine/orchestrator/phases.ts`, after PRD validation returns gaps, check the `completionPercent`:

- Below 75%: fail immediately - too much remaining work for a fix-forward pass. Emit a clear message explaining why.
- 75% and above: proceed with gap closing.

The threshold should be configurable via `OrchestratorOptions` (with a sensible default of 75).

### 3. Replace simple gap-closer with plan-based execution

Instead of running a single fixer agent, the gap-close phase should:

**a) Generate a fix plan** - A lightweight agent call that takes the PRD + gaps + current codebase state and produces a plan file (markdown) scoped to just the gaps. This reuses the plan file format so it can be fed into existing build stages. The agent prompt should be in `src/engine/prompts/gap-closer.md` (replacing the simple fixer prompt from the prior build).

**b) Execute through existing build stages** - Construct a `BuildStageContext` pointing at the merge worktree and run the plan through:
  - `implement` stage (which has continuation/handoff logic, `maxTurns: 50`, checkpointing via `AGENT_MAX_CONTINUATIONS_DEFAULTS`)
  - `review-fix` cycle (blind review + fix pass)

Use `planId: 'gap-close'` for all emitted build events so the monitor can render a distinct swimlane.

**c) Re-run post-merge validation** - After the gap-close build stages complete, re-run validation commands (type-check, tests) via the existing `validate` phase.

### 4. Monitor UI swimlane

The gap-close work should appear as a distinct swimlane in the monitor timeline:

- Use `planId: 'gap-close'` in all `build:*` events - the existing monitor event routing groups by `planId`, so this creates a swimlane automatically
- Label it distinctly (e.g., "PRD Gap Close") rather than showing a plan filename
- Position it after all other plan swimlanes in the timeline
- Show the PRD validation assessment (completion %, gap count) in the timeline before the swimlane appears

In `src/monitor/ui/src/components/timeline/event-card.tsx`:
- Handle `prd_validation:complete` to show completion percentage and gap summary
- Handle `gap_close:start` / `gap_close:complete` events
- Recognize `planId: 'gap-close'` for distinct labeling

### 5. CLI display

In `src/cli/display.ts`:
- Show completion percentage in the PRD validation result (e.g., "PRD Validation: 85% complete, 3 gap(s) found")
- Show gap complexity breakdown
- Display gap-close build progress using existing build event handlers (they already handle `build:implement:start`, etc. by planId)

### 6. Event types

Update `src/engine/events.ts`:
- Add `completionPercent` to `prd_validation:complete` event
- Add optional `complexity` field to `PrdValidationGap`
- Ensure `gap_close:start` and `gap_close:complete` events exist (from prior build)

### 7. Agent role and config

- Add `'gap-closer'` to `AGENT_ROLE_DEFAULTS` in `src/engine/pipeline/agent-config.ts` if a non-default `maxTurns` is needed for plan generation
- The implement stage already has its own `maxTurns: 50` and continuation logic, so the builder agent used during gap-close execution inherits those settings

## Scope

### In scope
- Enhanced PRD validator output (completion %, gap complexity)
- Viability gate with configurable threshold
- Plan generation from gaps
- Execution through existing implement + review-fix stages in merge worktree
- Monitor UI swimlane for gap-close work
- CLI display of assessment results
- Re-running post-merge validation after gap closing
- One attempt only (no recursive gap closing)

### Out of scope
- Re-running PRD validation after gap closing (one attempt only)
- User-interactive gap selection (auto-closes all viable gaps)
- Configurable build stages for gap closing (always implement + review-fix)
- Gap closing for builds without PRD validation enabled

## Acceptance Criteria

1. When PRD validation finds gaps with completionPercent >= 75, the gap closer generates a plan and executes it through implement + review-fix stages
2. When completionPercent < 75, the build fails immediately with a message explaining the gap scope
3. The gap-close work appears as a labeled "PRD Gap Close" swimlane in the monitor UI
4. The CLI displays completion percentage and gap complexity in PRD validation output
5. Post-merge validation re-runs after gap closing and determines final build success/failure
6. The builder agent during gap closing has continuation/handoff support (same as regular builds)
7. Gap closing only happens once per build (no re-entry)
8. `pnpm type-check` and `pnpm test` pass
