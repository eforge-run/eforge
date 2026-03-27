---
id: plan-01-source-changes
name: Builder max turns reduction and planner continuation source changes
dependsOn: []
branch: builder-max-turns-reduction-and-planner-continuation-handoff/source-changes
---

# Builder max turns reduction and planner continuation source changes

## Architecture Context

This plan adds a continuation/handoff mechanism to the planner agent, mirroring the existing builder continuation pattern in `implementStage`. The builder's max turns is reduced from 75 to 50 since continuations now handle longer tasks. All source changes are in this plan; tests follow in plan-02.

## Implementation

### Overview

Seven coordinated changes across 5 source files:
1. Add `plan:continuation` event type to the discriminated union
2. Add `continuationContext` support to the planner agent
3. Add `{{continuation_context}}` template variable to the planner prompt
4. Reduce builder max turns from 75 to 50 and add `AGENT_MAX_CONTINUATIONS_DEFAULTS` with `planner: 2`
5. Wrap `plannerStage` in a continuation loop (modeled on `implementStage`)
6. Harden `commitPlanArtifacts` to handle already-committed artifacts
7. Add `plan:continuation` CLI display handler

### Key Decisions

1. **Planner gets 2 max continuations (3 total attempts at 30 turns each = 90 turns)** - fewer than builder's default 3 because planning is less iterative than implementation. The `AGENT_MAX_CONTINUATIONS_DEFAULTS` map mirrors the existing `AGENT_MAX_TURNS_DEFAULTS` pattern.

2. **Continuation context lists existing plan file names + frontmatter summaries** - unlike the builder which uses a git diff, the planner writes files to disk so "checkpointing" means committing whatever plan files exist. The continuation context tells the restarted planner what plans are already written so it avoids redoing work.

3. **Prior clarifications are NOT preserved across continuation boundaries** - this is acceptable because any answers that influenced already-written plans are reflected in those plan files. The restarted planner sees the plan files and can infer context.

4. **`commitPlanArtifacts` hardened with a `git diff --cached --name-only` guard** - prevents "nothing to commit" errors when the same artifacts are already committed from a previous continuation checkpoint.

5. **Error detection uses `failedError.includes('error_max_turns')` pattern** - same approach as the builder's `implementStage`, matching the error string from the backend.

## Scope

### In Scope
- Adding `plan:continuation` event type to `EforgeEvent` union in `events.ts`
- Adding `continuationContext` option to `PlannerOptions` and formatting it into the prompt in `planner.ts`
- Adding `{{continuation_context}}` template variable to `planner.md` prompt
- Reducing `builder` from 75 to 50 in `AGENT_MAX_TURNS_DEFAULTS`
- Adding `AGENT_MAX_CONTINUATIONS_DEFAULTS` map with `planner: 2`
- Adding continuation loop to `plannerStage` in `pipeline.ts`
- Hardening `commitPlanArtifacts` to check for staged changes before committing
- Adding `plan:continuation` case to the exhaustive switch in `display.ts`

### Out of Scope
- Changing the planner's per-attempt max turns (remains 30)
- Changing the builder's continuation mechanism or max continuations
- Preserving prior clarifications across continuation boundaries
- Tests (handled in plan-02)

## Files

### Modify
- `src/engine/events.ts` - Add `| { type: 'plan:continuation'; attempt: number; maxContinuations: number }` to the `EforgeEvent` union, in the "Planning" section after `plan:progress`
- `src/engine/agents/planner.ts` - Add optional `continuationContext` to `PlannerOptions` interface with `{ attempt: number; maxContinuations: number; existingPlans: string }`. In `runPlanner`, format continuation context text (when provided) and include it in the `loadPrompt` call via a new `continuation_context` template variable. The continuation context should be formatted as a markdown section titled "## Continuation Context" explaining the attempt number and listing existing plans, with instruction "Do NOT redo any of the completed work below."
- `src/engine/prompts/planner.md` - Add `{{continuation_context}}` template variable after `{{priorClarifications}}` (line 11). When populated, it appears as a "Continuation Context" section between prior clarifications and the plan set info.
- `src/engine/pipeline.ts` - Four changes:
  1. Change `builder: 75` to `builder: 50` in `AGENT_MAX_TURNS_DEFAULTS` (line 229)
  2. Add `const AGENT_MAX_CONTINUATIONS_DEFAULTS: Partial<Record<AgentRole, number>> = { planner: 2 };` alongside the existing defaults map
  3. Wrap the `plannerStage` (line 386) in a continuation loop: resolve `maxContinuations` from `AGENT_MAX_CONTINUATIONS_DEFAULTS` (default 0 for roles without an entry), loop `for (let attempt = 0; attempt <= maxContinuations; attempt++)`, catch `error_max_turns` from the backend, scan `plans/{planSetName}/` for existing .md files, commit them via hardened `commitPlanArtifacts`, build continuation context listing existing plan files, yield `plan:continuation` event, and retry with continuation context injected into `runPlanner` options
  4. Harden `commitPlanArtifacts` to check `git diff --cached --name-only` before committing - if stdout is empty after `git add`, skip the `forgeCommit` call
- `src/cli/display.ts` - Add `case 'plan:continuation':` handler in the exhaustive switch, near the planning section. Update the compile spinner text: `s.text = 'Planning - continuing (attempt ${event.attempt}/${event.maxContinuations})'` using the `'plan'` spinner key (not `'compile'` - the planner uses the `'plan'` spinner).

## Verification

- [ ] `pnpm type-check` passes with no errors
- [ ] `pnpm build` compiles to `dist/cli.js` without errors
- [ ] `AGENT_MAX_TURNS_DEFAULTS.builder` equals 50
- [ ] `AGENT_MAX_CONTINUATIONS_DEFAULTS.planner` equals 2
- [ ] `plan:continuation` event type exists in the `EforgeEvent` union and includes `attempt` and `maxContinuations` fields
- [ ] `PlannerOptions` interface includes optional `continuationContext` with `attempt`, `maxContinuations`, and `existingPlans` fields
- [ ] `planner.md` prompt contains `{{continuation_context}}` template variable
- [ ] `commitPlanArtifacts` checks for staged changes before calling `forgeCommit`
- [ ] `display.ts` exhaustive switch handles `plan:continuation` without hitting the `never` default
- [ ] `plannerStage` catches `error_max_turns` errors and retries with continuation context up to `maxContinuations` times
