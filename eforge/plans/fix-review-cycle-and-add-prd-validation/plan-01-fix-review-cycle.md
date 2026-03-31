---
id: plan-01-fix-review-cycle
name: Fix Review Cycle - Give Reviewer Tools and Remove Review-Fixer
dependsOn: []
branch: fix-review-cycle-and-add-prd-validation/fix-review-cycle
---

# Fix Review Cycle - Give Reviewer Tools and Remove Review-Fixer

## Architecture Context

The reviewer and parallel-reviewer agents run with `tools: 'none'`, but their prompt (`reviewer.md`) instructs them to `git diff`, read files, and write fixes. This disconnect means they hallucinate reviews from plan content rather than inspecting actual code. The review-fixer agent exists as a workaround - it receives issues from a reviewer that never saw the real code, detects mismatches, and skips them. Fixing this requires giving the reviewer tools and removing the now-redundant review-fixer stage from the pipeline.

## Implementation

### Overview

1. Change `tools: 'none'` to `tools: 'coding'` in both reviewer agents so they can execute their prompt instructions
2. Remove the review-fixer stage from review-cycle and test-cycle composites in pipeline.ts
3. Delete the review-fixer agent and prompt files
4. Remove `'review-fixer'` from the AgentRole type union and AGENT_ROLES array
5. Remove the review-fixer export from the engine barrel file
6. Update monitor UI to reflect the simplified pipeline
7. Update prompt documentation for planner and module-planner to reflect new composite expansions
8. Update CLAUDE.md to reflect the new stage expansions
9. Update test files that reference review-fixer or review-fix stages
10. Update mock-server.ts to remove review-fixer agent run

### Key Decisions

1. **Reviewer gets `tools: 'coding'`** - The reviewer prompt already contains instructions for reading files, running git diff, and writing fixes. No prompt changes needed - only the tools setting was wrong.
2. **review-cycle becomes `[review, evaluate]`** - With the reviewer writing fixes directly (unstaged), the review-fixer stage is redundant. The evaluator checks `hasUnstagedChanges()` regardless of who wrote them.
3. **test-cycle becomes `[test, evaluate]`** - Same reasoning. The tester already has `tools: 'coding'` and fixes test bugs. Extending it to also fix production issues (unstaged) follows the same pattern.
4. **Tester prompt updated** - Add instructions for the tester to write fixes for production issues as unstaged changes, matching the reviewer pattern.

## Scope

### In Scope
- Changing reviewer and parallel-reviewer tools from `'none'` to `'coding'`
- Deleting `src/engine/agents/review-fixer.ts` and `src/engine/prompts/review-fixer.md`
- Removing `reviewFixStageInner` function and registered `review-fix`/`test-fix` stages from pipeline.ts
- Simplifying review-cycle and test-cycle composite stage loops in pipeline.ts
- Removing `'review-fixer'` from AgentRole union in events.ts
- Removing `'review-fixer'` from AGENT_ROLES in config.ts
- Removing review-fixer exports from `src/engine/index.ts`
- Updating `src/engine/prompts/tester.md` with production fix instructions
- Updating `src/engine/prompts/planner.md` composite stage documentation
- Updating `src/engine/prompts/module-planner.md` composite stage documentation
- Updating `CLAUDE.md` build stages list
- Updating `src/monitor/ui/src/components/pipeline/thread-pipeline.tsx` (remove review-fixer mapping, update cycle expansions)
- Updating `src/monitor/mock-server.ts` (remove review-fixer agent run)
- Updating test files that reference review-fix or review-fixer

### Out of Scope
- PRD validation feature (plan-02)
- Changes to the reviewer prompt itself (reviewer.md already has correct instructions)
- Changes to the evaluator logic

## Files

### Delete
- `src/engine/agents/review-fixer.ts` - No longer needed; reviewer writes fixes directly
- `src/engine/prompts/review-fixer.md` - No longer needed

### Modify
- `src/engine/agents/reviewer.ts` - Change `tools: 'none'` to `tools: 'coding'`
- `src/engine/agents/parallel-reviewer.ts` - Change `tools: 'none'` to `tools: 'coding'`
- `src/engine/pipeline.ts` - Remove `reviewFixStageInner`, remove registered `review-fix`/`test-fix` stages, simplify review-cycle to `[review, evaluate]` and test-cycle to `[test, evaluate]`
- `src/engine/events.ts` - Remove `'review-fixer'` from AgentRole union
- `src/engine/config.ts` - Remove `'review-fixer'` from AGENT_ROLES array
- `src/engine/index.ts` - Remove review-fixer exports
- `src/engine/prompts/tester.md` - Add instructions to write fixes for production issues as unstaged changes
- `src/engine/prompts/planner.md` - Update review-cycle expansion from `[review, review-fix, evaluate]` to `[review, evaluate]`, update test-cycle from `[test, test-fix, evaluate]` to `[test, evaluate]`, remove `review-fix` and `test-fix` from available stages
- `src/engine/prompts/module-planner.md` - Same composite stage documentation updates as planner.md
- `CLAUDE.md` - Update build stages list: review-cycle expands to `[review, evaluate]`, test-cycle expands to `[test, evaluate]`, remove `review-fix` and `test-fix` from stage lists
- `src/monitor/ui/src/components/pipeline/thread-pipeline.tsx` - Remove `'review-fixer'` from AGENT_TO_STAGE mapping, update COMPOSITE_STAGES: review-cycle to `['review', 'evaluate']`, test-cycle to `['test', 'evaluate']`
- `src/monitor/mock-server.ts` - Remove the `insertAgentRun` call for `'review-fixer'`
- `test/pipeline.test.ts` - Update tests that reference review-fix or test-fix stages
- `test/parallel-reviewer.test.ts` - Update tests that reference review-fixer
- `test/worktree-integration.test.ts` - Update references to review-fixer or review-fix stages
- `test/plan-complete-depends-on.test.ts` - Update references to review-fix or test-fix stages

## Verification

- [ ] `pnpm type-check` exits with code 0
- [ ] `pnpm test` exits with code 0
- [ ] `grep -r "tools: 'none'" src/engine/agents/reviewer.ts src/engine/agents/parallel-reviewer.ts` returns no matches
- [ ] `grep -r "tools: 'coding'" src/engine/agents/reviewer.ts src/engine/agents/parallel-reviewer.ts` returns 2 matches
- [ ] `src/engine/agents/review-fixer.ts` does not exist on disk
- [ ] `src/engine/prompts/review-fixer.md` does not exist on disk
- [ ] `grep -r "review-fixer" src/engine/` returns no matches (only test files may reference it in comments)
- [ ] `grep "reviewFixStageInner" src/engine/pipeline.ts` returns no matches
- [ ] COMPOSITE_STAGES in thread-pipeline.tsx maps review-cycle to `['review', 'evaluate']`
