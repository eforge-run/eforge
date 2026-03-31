---
id: plan-02-prd-validation
name: Add PRD Validation Gate
dependsOn:
  - plan-01-fix-review-cycle
branch: fix-review-cycle-and-add-prd-validation/prd-validation
---

# Add PRD Validation Gate

## Architecture Context

Post-merge validation currently runs only generic commands (type-check, test, build). There is no check that the completed work actually satisfies the original PRD requirements. This plan adds a final PRD validation gate that runs after post-merge validation passes and before finalize. An agent compares the original PRD against the full worktree diff and reports gaps.

This plan depends on plan-01 because both modify `src/engine/events.ts` and `src/engine/config.ts` (plan-01 removes `'review-fixer'`, this plan adds `'prd-validator'`).

## Implementation

### Overview

1. Create a new PRD validator agent (`src/engine/agents/prd-validator.ts`) that receives PRD content and a git diff, then outputs structured gap analysis
2. Create the agent prompt (`src/engine/prompts/prd-validator.md`)
3. Add `'prd-validator'` to the AgentRole union and AGENT_ROLES array
4. Add `PrdValidationGap` interface and `prd_validation:start`/`prd_validation:complete` events to events.ts
5. Wire the validator into the orchestrator between validate and finalize
6. Create the prdValidator closure in `eforge.ts` build() method
7. Add event rendering in the monitor UI

### Key Decisions

1. **Always-on gate** - PRD validation runs on every build that has a PRD file. No config toggle needed - the agent is cheap and the value is high.
2. **Runs after post-merge validation** - Generic validation (type-check, tests) catches structural issues. PRD validation catches semantic gaps. Running them in sequence avoids wasting agent time on a broken build.
3. **Agent errors are non-fatal** - If the PRD validator agent crashes, the build continues. This prevents a flaky validation from blocking otherwise-correct builds.
4. **No retry loop** - This is a final pass/fail gate, not an iterative fix cycle. Gaps found means the build fails and the user must investigate.
5. **80K char diff truncation** - Large diffs are truncated to fit within context limits while still providing enough signal for gap analysis.
6. **Follows validation-fixer pattern** - The agent runner structure mirrors `runValidationFixer()` for consistency.

## Scope

### In Scope
- New PRD validator agent runner and prompt
- New event types for PRD validation
- Orchestrator wiring between validate and finalize phases
- Build method closure creation and event handling in eforge.ts
- Monitor UI rendering for PRD validation events
- Agent wiring test via StubBackend

### Out of Scope
- Configuration toggle for PRD validation (always-on by design)
- Retry/fix loop for PRD validation gaps
- PRD validation during compile phase

## Files

### Create
- `src/engine/agents/prd-validator.ts` - Agent runner: receives prdContent (string) and diff (string), runs with `tools: 'coding'` and `maxTurns: 15`, parses structured JSON output for gaps, yields `prd_validation:start` and `prd_validation:complete` events. Follow the pattern from validation-fixer.ts.
- `src/engine/prompts/prd-validator.md` - Prompt template with `{{prd}}` and `{{diff}}` placeholders. Instructs the agent to check each PRD requirement against the diff. Output JSON: `{ "gaps": [] }` or `{ "gaps": [{ "requirement": "...", "explanation": "..." }] }`. Focus on substantive gaps, not minor wording differences.

### Modify
- `test/agent-wiring.test.ts` - Add PRD validator wiring tests using StubBackend: verify `prd_validation:start` and `prd_validation:complete` events flow correctly for both pass (no gaps) and fail (gaps found) cases.
- `src/engine/events.ts` - Add `'prd-validator'` to the AgentRole union type. Add `PrdValidationGap` interface with `requirement: string` and `explanation: string` fields. Add `{ type: 'prd_validation:start' }` and `{ type: 'prd_validation:complete'; passed: boolean; gaps: PrdValidationGap[] }` to the EforgeEvent union.
- `src/engine/config.ts` - Add `'prd-validator'` to the AGENT_ROLES array.
- `src/engine/orchestrator.ts` - Add `PrdValidator` type: `(cwd: string) => AsyncGenerator<EforgeEvent>`. Add `prdValidator?: PrdValidator` to OrchestratorOptions. Pass through to PhaseContext construction. In `execute()`, insert `prdValidate(ctx)` call between validate and finalize (guarded by state not being 'failed' and ctx.prdValidator existing).
- `src/engine/orchestrator/phases.ts` - Add `prdValidator?: PrdValidator` to PhaseContext interface. Add `prdValidate()` async generator function that yields events from `ctx.prdValidator(ctx.mergeWorktreePath)`. Guard with state check.
- `src/engine/eforge.ts` - In `build()` method, create a `prdValidator` closure that: reads PRD from `options.prdFilePath`, builds diff via `git diff baseBranch...HEAD` (truncated at 80K chars), wraps `runPrdValidator()` with tracing. Pass to Orchestrator constructor. In the event consumer loop, handle `prd_validation:complete`: if `!event.passed`, set status to 'failed' and summary to gap count.
- `src/engine/index.ts` - Add exports for `runPrdValidator` and `PrdValidatorOptions` from `./agents/prd-validator.js`.
- `src/monitor/ui/src/components/timeline/event-card.tsx` - Add `prd_validation:start` case to `eventSummary()` returning "PRD Validation started". Add `prd_validation:complete` case returning "PRD Validation: passed" or "PRD Validation: {N} gap(s) found". Add detail view for `prd_validation:complete` showing gap requirements and explanations when `passed: false`.
- `src/monitor/ui/src/components/pipeline/thread-pipeline.tsx` - Add `'prd-validator': 'prd-validation'` to AGENT_TO_STAGE mapping so PRD validation appears as a pipeline phase.

## Verification

- [ ] `pnpm type-check` exits with code 0
- [ ] `pnpm test` exits with code 0
- [ ] `src/engine/agents/prd-validator.ts` exists and exports `runPrdValidator`
- [ ] `src/engine/prompts/prd-validator.md` exists and contains `{{prd}}` and `{{diff}}` placeholders
- [ ] `grep "'prd-validator'" src/engine/events.ts` returns a match in the AgentRole union
- [ ] `grep "'prd-validator'" src/engine/config.ts` returns a match in AGENT_ROLES
- [ ] `grep "prdValidator" src/engine/orchestrator.ts` returns matches for the type definition and option field
- [ ] `grep "prdValidate" src/engine/orchestrator/phases.ts` returns matches for the function definition
- [ ] `grep "prd_validation" src/monitor/ui/src/components/timeline/event-card.tsx` returns matches for both start and complete events
