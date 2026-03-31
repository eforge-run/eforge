---
id: plan-01-restore-review-fixer
name: Restore Review Fixer with Corrected Reviewer Prompt
dependsOn: []
branch: restore-review-fixer-with-corrected-reviewer-prompt/restore-review-fixer
---

# Restore Review Fixer with Corrected Reviewer Prompt

## Architecture Context

The review-fixer agent was removed in commit `6731a17` ("Fix Review Cycle - Give Reviewer Tools and Remove Review-Fixer"). The reviewer was changed to write fixes directly. This breaks parallel reviewers - multiple perspective reviewers running concurrently on the same worktree clobber each other's file edits. The review fixer serializes fix application: all reviewers complete (read-only), issues are aggregated, then one agent applies fixes.

The event types (`build:review:fix:start`, `build:review:fix:complete`) and CLI display handlers already exist in the codebase. The changes needed are: restore the agent + prompt files, add the role to type/config registries, wire the stage into the pipeline's review-cycle, correct the reviewer prompt, update documentation, and restore tests.

## Implementation

### Overview

Restore the review-fixer agent as the serialized fix-application step in the review cycle, correct the reviewer prompt so reviewers only identify issues (never write fixes), and update all references.

### Key Decisions

1. **Reviewer becomes read-only for fixes** - The reviewer keeps `tools: 'coding'` (needs to read files, run git diff) but the prompt is changed to describe recommended fixes in the `<fix>` element without writing to disk. This preserves safe parallel execution.
2. **Review-cycle becomes `[review, review-fix, evaluate]`** - The review-fixer agent runs between review and evaluate, applying fixes from aggregated issues. The evaluator then judges the fixer's unstaged changes.
3. **Restore from git history** - The `review-fixer.ts` and `review-fixer.md` files are restored from pre-deletion commit `6731a17^` with no modifications needed.
4. **Test-cycle unchanged** - The tester runs serially and writes fixes directly, so `test-cycle` stays as `[test, evaluate]`.

## Scope

### In Scope
- Restore `src/engine/agents/review-fixer.ts` from git history (commit `6731a17^`)
- Restore `src/engine/prompts/review-fixer.md` from git history (commit `6731a17^`)
- Add `'review-fixer'` to `AgentRole` union in `src/engine/events.ts`
- Add `'review-fixer'` to `AGENT_ROLES` array in `src/engine/config.ts`
- Add `'review-fixer': 'max'` to `AGENT_MODEL_CLASSES` in `src/engine/pipeline.ts`
- Import `runReviewFixer` and register `'review-fix'` build stage in `src/engine/pipeline.ts`
- Update review-cycle stage to: review -> filter issues -> review-fix -> evaluate
- Re-export `runReviewFixer` and `ReviewFixerOptions` from `src/engine/index.ts`
- Correct `src/engine/prompts/reviewer.md` - remove "Fix Instructions" and "Fix Criteria" sections, replace with instructions to describe fixes in `<fix>` element without writing to disk
- Update `CLAUDE.md` - `review-cycle` expands to `[review, review-fix, evaluate]`
- Update `src/engine/prompts/planner.md` - review-cycle expansion docs
- Update `src/engine/prompts/module-planner.md` - review-cycle expansion docs
- Add `'review-fixer'` to `AGENT_COLORS` and `AGENT_TO_STAGE` in monitor UI
- Restore review-fixer tests in `test/parallel-reviewer.test.ts`

### Out of Scope
- Changes to `test-cycle` - tester runs serially, no test-fix stage needed
- Changes to tester behavior

## Files

### Create
- `src/engine/agents/review-fixer.ts` - Restored review-fixer agent (from git history `6731a17^:src/engine/agents/review-fixer.ts`). Receives aggregated `ReviewIssue[]`, runs with `tools: 'coding'`, applies minimal fixes, never stages or commits. Yields `build:review:fix:start` and `build:review:fix:complete`.
- `src/engine/prompts/review-fixer.md` - Restored review-fixer prompt (from git history `6731a17^:src/engine/prompts/review-fixer.md`). Instructs fixer to apply minimal fixes from reviewer-identified issues.

### Modify
- `src/engine/events.ts` - Add `'review-fixer'` to `AgentRole` union type (line 10, insert into the union after `'reviewer'`)
- `src/engine/config.ts` - Add `'review-fixer'` to `AGENT_ROLES` array (line 15, insert after `'reviewer'`)
- `src/engine/pipeline.ts` - (1) Import `runReviewFixer` from `./agents/review-fixer.js`. (2) Add `'review-fixer': 'max'` to `AGENT_MODEL_CLASSES`. (3) Register a `'review-fix'` build stage that creates a tracing span, resolves agent config for `'review-fixer'`, calls `runReviewFixer` with aggregated issues, and yields its events. (4) Update the `review-cycle` stage (line 1161) to insert review-fix between the issue filter and evaluate steps: review -> filter -> review-fix -> evaluate.
- `src/engine/index.ts` - Add re-export: `export { runReviewFixer } from './agents/review-fixer.js'` and `export type { ReviewFixerOptions } from './agents/review-fixer.js'`
- `src/engine/prompts/reviewer.md` - Remove lines 52-68 ("Fix Instructions" and "Fix Criteria" sections). Replace with instructions that the reviewer must describe the recommended fix in the `<fix>` element but must NOT write changes to any files. Update the `<fix>` element description in Output Format to say it describes the recommended fix for the review-fixer agent. Remove lines 103-104 (`git add`/`git commit` constraints about fixes) since the reviewer no longer writes fixes. Add a constraint: "Do NOT write fixes to files - describe them in the <fix> element only".
- `src/engine/prompts/planner.md` - Update the review-cycle composite stage description from "expands to `[review, evaluate]`. The reviewer writes fixes directly as unstaged changes" to "expands to `[review, review-fix, evaluate]`. The reviewer identifies issues, the review-fixer applies fixes as unstaged changes".
- `src/engine/prompts/module-planner.md` - Update review-cycle description from "expands to `[review, evaluate]`" to "expands to `[review, review-fix, evaluate]`".
- `CLAUDE.md` - Update (1) Build stages list to include `review-fix`, (2) review-cycle expansion from `[review, evaluate]` to `[review, review-fix, evaluate]`, (3) review-cycle description, (4) Agent list to include Review Fixer.
- `src/monitor/ui/src/components/pipeline/thread-pipeline.tsx` - Add `'review-fixer'` entry to `AGENT_COLORS` (use `bg-green/30`, `border-green/50` to match other reviewer-family agents) and `AGENT_TO_STAGE` (map to `'review-fix'`).
- `test/parallel-reviewer.test.ts` - Restore the `runReviewFixer` import and the `describe('runReviewFixer', ...)` test block that was removed in commit `6731a17` (4 tests: emits fix start/complete events, runs with coding tools, uses review-fixer agent role, survives backend errors gracefully).

## Verification

- [ ] `pnpm type-check` exits with code 0
- [ ] `pnpm test` exits with code 0
- [ ] `src/engine/agents/review-fixer.ts` exists and exports `runReviewFixer`
- [ ] `src/engine/prompts/review-fixer.md` exists and contains `{{issues}}` template variable
- [ ] `src/engine/prompts/reviewer.md` does NOT contain the string "Fix Instructions" or "Fix Criteria"
- [ ] `src/engine/prompts/reviewer.md` contains "Do NOT write fixes to files"
- [ ] `AgentRole` in `events.ts` includes `'review-fixer'`
- [ ] `AGENT_ROLES` in `config.ts` includes `'review-fixer'`
- [ ] `AGENT_MODEL_CLASSES` in `pipeline.ts` includes `'review-fixer'`
- [ ] `review-cycle` build stage in `pipeline.ts` calls `reviewFixStageInner` between issue filtering and evaluate
- [ ] `AGENT_COLORS` in `thread-pipeline.tsx` includes `'review-fixer'`
- [ ] `AGENT_TO_STAGE` in `thread-pipeline.tsx` maps `'review-fixer'` to `'review-fix'`
- [ ] `CLAUDE.md` lists `review-fix` in build stages and review-cycle expands to `[review, review-fix, evaluate]`
- [ ] `planner.md` describes review-cycle as `[review, review-fix, evaluate]`
- [ ] `module-planner.md` describes review-cycle as `[review, review-fix, evaluate]`
- [ ] `test/parallel-reviewer.test.ts` contains `describe('runReviewFixer', ...)` with 4 tests
