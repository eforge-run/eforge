---
title: Fix Review Cycle and Add PRD Validation
created: 2026-03-31
status: pending
---

# Fix Review Cycle and Add PRD Validation

## Problem / Motivation

The eforge build pipeline silently "succeeded" 3 times without implementing anything. Root cause investigation revealed two bugs and one missing feature:

- **Bug 1 - Reviewer can't see the code.** The reviewer and parallel-reviewer run with `tools: 'none'` (reviewer.ts:152, parallel-reviewer.ts:176), but the prompt (reviewer.md) tells them to `git diff`, read files, and write fixes. They hallucinate the review from the plan content instead of the actual implementation. This is why the reviewer referenced line numbers that don't exist in the actual file.

- **Bug 2 - Review-fixer works around a broken reviewer.** The review-fixer (tools: 'coding') exists because the reviewer can't write fixes. But the review-fixer receives issues from a reviewer that never saw the real code, so it correctly detects mismatches and skips them as "architectural changes." The original design intent was for the reviewer to directly implement fixes.

- **Missing feature - No PRD-level validation.** Post-merge validation only runs generic commands (type-check, test, build). There's no check that the completed work actually satisfies the original PRD.

## Goal

Fix the review cycle so reviewers actually inspect real code and write fixes directly, eliminate the redundant review-fixer stage, and add a final PRD validation gate that confirms the build output satisfies the original requirements.

## Approach

### Part 1: Give the reviewer tools

Change `tools: 'none'` to `tools: 'coding'` so the reviewer can actually execute the instructions in its prompt.

**`src/engine/agents/reviewer.ts`** (line 152):
```typescript
// Before:
tools: 'none'
// After:
tools: 'coding'
```

**`src/engine/agents/parallel-reviewer.ts`** (line 176):
```typescript
// Before:
tools: 'none'
// After:
tools: 'coding'
```

No prompt changes needed - reviewer.md already instructs the agent to run `git diff`, read files, and write fixes directly. The prompt was written for a reviewer with tools; the code just never gave them.

#### Remove review-fix from review-cycle

With the reviewer writing fixes directly (unstaged), the review-fixer is redundant in the review cycle. The evaluator (line 1180) just checks `hasUnstagedChanges()` - it doesn't care who wrote them.

**`src/engine/pipeline.ts`**:
- `review-cycle` (line 1210-1233): Remove `yield* reviewFixStageInner(ctx)`, cycle becomes: review → filter issues → evaluate
- `test-cycle` (line 1360-1377): Remove `yield* reviewFixStageInner(ctx)`, cycle becomes: test → evaluate. The tester now writes fixes directly.
- Delete the registered `review-fix` build stage (line 1124-1126)
- Delete the registered `test-fix` build stage (line 1356-1358)
- Delete `reviewFixStageInner` function (line 1128-1170) - no longer used by anything

**Delete `src/engine/agents/review-fixer.ts`** - No consumers remain.

**Delete `src/engine/prompts/review-fixer.md`** - No consumers remain.

**`src/engine/prompts/tester.md`** - Add instructions for the tester to also write fixes for production issues it discovers (unstaged, same pattern as reviewer). The tester already has `tools: 'coding'` and already fixes test bugs - extend this to production bugs.

**`src/engine/prompts/planner.md`** and **`src/engine/prompts/module-planner.md`** - Update the composite stage documentation:
- `review-cycle` expands to `[review, evaluate]` (was `[review, review-fix, evaluate]`)

**`CLAUDE.md`** - Update the build stages list to reflect the new expansion.

#### What this fixes

The reviewer will now:
1. Actually run `git diff baseBranch...HEAD` to see what files changed
2. Read the actual implementation files (not hallucinate from the plan)
3. Compare the implementation against the plan requirements
4. Catch when planned files weren't modified (the `.claude/` SDK permission failure)
5. Write fixes directly as unstaged changes (as the prompt always intended)

### Part 2: Final PRD validation (always-on)

After all plans merge and generic validation passes, run an agent that compares the original PRD against the full worktree diff. Simple: PRD + diff as input, agent decides pass/fail.

#### New files

**`src/engine/agents/prd-validator.ts`** - Agent runner following the validation-fixer pattern:
- Receives: `prdContent` (string), `diff` (string), `cwd`
- Runs with `tools: 'coding'`, `maxTurns: 15` (read-only analysis, may want to inspect files)
- Parses structured JSON output for gaps
- Yields `prd_validation:start` and `prd_validation:complete`

**`src/engine/prompts/prd-validator.md`** - Prompt template:
- Receives `{{prd}}` and `{{diff}}`
- Instructs agent to check each PRD requirement against the diff
- Output JSON: `{ "gaps": [] }` or `{ "gaps": [{ "requirement": "...", "explanation": "..." }] }`
- Focus on substantive gaps, not minor wording differences

#### Type changes

**`src/engine/events.ts`**:
- Add `'prd-validator'` to `AgentRole` union
- Add:
  ```typescript
  export interface PrdValidationGap {
    requirement: string;
    explanation: string;
  }
  ```
- Add events to `EforgeEvent`:
  ```typescript
  | { type: 'prd_validation:start' }
  | { type: 'prd_validation:complete'; passed: boolean; gaps: PrdValidationGap[] }
  ```

**`src/engine/config.ts`** - Add `'prd-validator'` to `AGENT_ROLES`.

#### Orchestrator wiring

**`src/engine/orchestrator.ts`**:
- Add type:
  ```typescript
  export type PrdValidator = (cwd: string) => AsyncGenerator<EforgeEvent>;
  ```
- Add `prdValidator?: PrdValidator` to `OrchestratorOptions`
- Pass through to `PhaseContext`
- In `execute()` (line 142-143), insert between validate and finalize:
  ```typescript
  if ((state.status as string) !== 'failed') yield* validate(ctx);
  if ((state.status as string) !== 'failed' && ctx.prdValidator) yield* prdValidate(ctx);
  if ((state.status as string) !== 'failed') yield* finalize(ctx);
  ```

**`src/engine/orchestrator/phases.ts`**:
- Add `prdValidator?: PrdValidator` to `PhaseContext`
- Add `prdValidate()` function - yields events from `ctx.prdValidator(mergeWorktreePath)`

**`src/engine/eforge.ts`** - In `build()` (~line 560):
- Create `prdValidator` closure - the PRD file always exists (written during enqueue/format phase at `eforge/queue/<name>.md`):
  - Read PRD from disk at `options.prdFilePath`
  - Build diff via `git diff baseBranch...HEAD` (truncated at 80K chars)
  - Wrap `runPrdValidator()` with tracing
- Pass to Orchestrator constructor
- In event consumer loop (line 577-598), handle `prd_validation:complete`:
  ```typescript
  if (event.type === 'prd_validation:complete' && !event.passed) {
    status = 'failed';
    summary = `PRD validation found ${event.gaps.length} gap(s)`;
  }
  ```

#### Behavior

- Runs after post-merge validation commands pass, before `finalize()`
- PRD file always exists (written during enqueue/format)
- Gaps found = build fails, finalize skipped (won't merge to baseBranch)
- Agent errors are non-fatal (if agent crashes, build continues)
- No retry loop - this is a final pass/fail gate

### Part 3: Monitor UI updates

**`src/monitor/ui/src/components/pipeline/thread-pipeline.tsx`**:
- Remove `'review-fixer'` from `AGENT_TO_STAGE` mapping (line 72)
- Update `review-cycle` expansion from `['review', 'review-fix', 'evaluate']` to `['review', 'evaluate']` (line 197)
- Update `test-cycle` expansion similarly if present
- Add `'prd-validator'` agent mapping if PRD validation should appear as a pipeline phase

**`src/monitor/ui/src/components/timeline/event-card.tsx`**:
- Add `prd_validation:start` and `prd_validation:complete` cases to `eventSummary()` switch
- Add `prd_validation:complete` detail view showing gaps when `passed: false`

## Scope

### In scope

| File | Change |
|------|--------|
| `src/engine/agents/reviewer.ts` | `tools: 'none'` -> `tools: 'coding'` |
| `src/engine/agents/parallel-reviewer.ts` | `tools: 'none'` -> `tools: 'coding'` |
| `src/engine/agents/review-fixer.ts` | **Delete** |
| `src/engine/prompts/review-fixer.md` | **Delete** |
| `src/engine/pipeline.ts` | Remove review-fix/test-fix from cycles, delete stages + `reviewFixStageInner` |
| `src/engine/prompts/tester.md` | Add instructions to write fixes for production issues (unstaged) |
| `src/engine/prompts/planner.md` | Update review-cycle and test-cycle expansion docs |
| `src/engine/prompts/module-planner.md` | Update review-cycle and test-cycle expansion docs |
| `CLAUDE.md` | Update composite stage expansions |
| `src/engine/agents/prd-validator.ts` | **New** - agent runner |
| `src/engine/prompts/prd-validator.md` | **New** - agent prompt |
| `src/engine/events.ts` | Add `PrdValidationGap`, `prd_validation:*` events, `'prd-validator'` role, remove `'review-fixer'` role |
| `src/engine/config.ts` | Add `'prd-validator'`, remove `'review-fixer'` from `AGENT_ROLES` |
| `src/engine/orchestrator.ts` | Add `PrdValidator` type, wire into execute flow |
| `src/engine/orchestrator/phases.ts` | Add `prdValidator` to PhaseContext, add `prdValidate()` |
| `src/engine/eforge.ts` | Create prdValidator closure, pass to Orchestrator, handle events |
| `src/monitor/ui/src/components/pipeline/thread-pipeline.tsx` | Remove review-fixer mapping, update cycle expansions |
| `src/monitor/ui/src/components/timeline/event-card.tsx` | Add `prd_validation:*` summaries and details |

### Out of scope

N/A

## Acceptance Criteria

1. `pnpm type-check` passes.
2. `pnpm test` passes.
3. Reviewer tools change: run a build where the builder fails to modify a file - the reviewer should now catch it because it can actually read the file and see it's unchanged.
4. PRD validator: agent wiring test via StubBackend confirms events flow (start, complete with gaps/no gaps).
5. PRD validator integration: on a successful build with a PRD, `prd_validation:complete` event is emitted with `passed: true`.
