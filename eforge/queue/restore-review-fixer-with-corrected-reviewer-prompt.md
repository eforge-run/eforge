---
title: Restore Review Fixer with Corrected Reviewer Prompt
created: 2026-03-31
status: pending
---

# Restore Review Fixer with Corrected Reviewer Prompt

## Problem / Motivation

The current build (`fix-review-cycle-and-add-prd-validation`) removed the review-fixer agent and has reviewers write fixes directly. This works for single reviewers but breaks with **parallel reviewers** - multiple perspective reviewers running concurrently on the same worktree will clobber each other's file edits.

The review fixer exists to **serialize fix application**: all reviewers complete (read-only), issues are aggregated, then one agent applies fixes. The real bug was that reviewers ran with `tools: 'none'` (couldn't read the codebase) and the prompt told them to write fixes (which they couldn't do).

## Goal

Restore the review-fixer agent as the serialized fix-application step in the review cycle, and correct the reviewer prompt so reviewers only identify issues (never write fixes), preserving safe parallel execution.

## Approach

The build has completed and merged to main. The correction is implemented directly on main - restoring the review fixer for the review cycle only, with the corrected reviewer prompt.

### 1. Fix reviewer prompt (`src/engine/prompts/reviewer.md`)

- Remove the "Fix Instructions" and "Fix Criteria" sections (lines 52-68) that tell reviewers to write fixes.
- Replace with instructions to **describe the fix** in the issue output but NOT write it to disk.
- The `<fix>` element in the XML output should describe the recommended fix (so the review fixer can use it) but the reviewer should not touch any files.
- Remove from Constraints: the `git add`/`git commit` warnings about fixes (lines 103-104) since reviewer no longer writes fixes.
- Keep: `tools: 'coding'` in `reviewer.ts` and `parallel-reviewer.ts` (reviewer needs to read files, run git diff).

### 2. Restore review-fixer agent (`src/engine/agents/review-fixer.ts`)

- Restore from main branch (88 lines).
- The agent receives aggregated `ReviewIssue[]` from parallel reviewers, runs with `tools: 'coding'`, applies minimal fixes, never stages or commits.
- Yields `build:review:fix:start` and `build:review:fix:complete`.
- Source: `git show main:src/engine/agents/review-fixer.ts`

### 3. Restore review-fixer prompt (`src/engine/prompts/review-fixer.md`)

- Restore from main branch (26 lines).
- Source: `git show main:src/engine/prompts/review-fixer.md`

### 4. Restore review-fix stage in pipeline (`src/engine/pipeline.ts`)

- Restore `import { runReviewFixer }`.
- Restore `'review-fixer': 'max'` in `AGENT_MODEL_CLASSES`.
- Restore `reviewFixStageInner()` function and `registerBuildStage('review-fix', ...)`.
- Restore review-cycle to: `review -> filter issues -> review-fix -> evaluate`.

### 5. Restore review-fixer role in types/config

- `src/engine/events.ts`: Add `'review-fixer'` back to `AgentRole` union.
- `src/engine/config.ts`: Add `'review-fixer'` back to `AGENT_ROLES`.
- `src/engine/index.ts`: Re-export `runReviewFixer`.

### 6. Update documentation

- `CLAUDE.md`: `review-cycle` expands to `[review, review-fix, evaluate]` (revert).
- `src/engine/prompts/planner.md`: Update composite stage docs.
- `src/engine/prompts/module-planner.md`: Update composite stage docs.
- Monitor UI: Restore `'review-fixer'` in `AGENT_COLORS` and `AGENT_TO_STAGE` in `src/monitor/ui/src/components/pipeline/thread-pipeline.tsx`.

### 7. Restore tests

- Restore review-fixer related tests in `test/parallel-reviewer.test.ts`.
- Update tests to reflect reviewer no longer writing fixes.

### Key files to modify

| File | Change |
|------|--------|
| `src/engine/prompts/reviewer.md` | Remove fix-writing instructions, keep issue identification |
| `src/engine/agents/review-fixer.ts` | Restore from main |
| `src/engine/prompts/review-fixer.md` | Restore from main |
| `src/engine/pipeline.ts` | Restore review-fix stage and reviewFixStageInner |
| `src/engine/events.ts` | Add `'review-fixer'` to AgentRole |
| `src/engine/config.ts` | Add `'review-fixer'` to AGENT_ROLES |
| `src/engine/index.ts` | Re-export runReviewFixer |
| `CLAUDE.md` | Update review-cycle expansion |
| `src/engine/prompts/planner.md` | Update composite stage docs |
| `src/engine/prompts/module-planner.md` | Update composite stage docs |
| `src/monitor/ui/src/components/pipeline/thread-pipeline.tsx` | Restore review-fixer mappings |

## Scope

**In scope:**

- Restoring the review-fixer agent, prompt, pipeline stage, types, config, and exports
- Correcting the reviewer prompt to only identify issues (not write fixes)
- Updating documentation and monitor UI to reflect review-fixer restoration
- Restoring and updating review-fixer related tests

**Out of scope:**

- `test-fix` stage - the tester runs serially and writes fixes directly, so `test-cycle` stays as `[test, evaluate]`
- Changes to tester behavior or test cycle

## Acceptance Criteria

1. `pnpm type-check` passes.
2. `pnpm test` passes.
3. `reviewer.md` no longer contains fix-writing instructions ("Fix Instructions" and "Fix Criteria" sections removed).
4. Review-cycle in `pipeline.ts` is `[review, review-fix, evaluate]`.
5. Test-cycle stays as `[test, evaluate]` (tester runs serially, no test-fix stage).
6. `review-fixer.ts`, `review-fixer.md` are restored.
7. `'review-fixer'` is present in `AgentRole` union, `AGENT_ROLES`, and re-exported from `src/engine/index.ts`.
8. Monitor UI includes `review-fixer` in `AGENT_COLORS` and `AGENT_TO_STAGE`.
9. Documentation (`CLAUDE.md`, `planner.md`, `module-planner.md`) reflects the restored `review-cycle` expansion.
