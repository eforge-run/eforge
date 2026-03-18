---
title: Plan: Add "Forged by eforge" attribution to all commits
created: 2026-03-18
status: pending
---

## Problem / Motivation

Commits created by eforge are indistinguishable from manually-authored commits in git history. There is no attribution indicating that eforge produced them, making it difficult to identify automated work when reviewing logs, auditing changes, or filtering commits.

## Goal

Every commit created by eforge - whether executed by an agent via prompt instructions or programmatically by the orchestrator - should include the attribution line `Forged by eforge https://eforge.run` so they are identifiable in git history.

## Approach

There are **6 commit points** across prompt files and TypeScript code that need updating:

### Prompt files (agent-executed commits)

These files contain shell `git commit -m` instructions that agents execute directly. Update each to use a multi-line commit message so the attribution appears after a blank line:

1. **`src/engine/prompts/builder.md`** (line 53)
   - Current: `git add -A && git commit -m "feat({{plan_id}}): {{plan_name}}"`
   - Target:
     ```
     git add -A && git commit -m "feat({{plan_id}}): {{plan_name}}

     Forged by eforge https://eforge.run"
     ```

2. **`src/engine/prompts/evaluator.md`** (line 195)
   - Current: `git add -A && git commit -m "feat({{plan_id}}): {{plan_name}}"`
   - Same change as #1

3. **`src/engine/prompts/validation-fixer.md`** (line 29)
   - Current: `git add -u && git commit -m "fix: resolve validation failures"`
   - Target:
     ```
     git add -u && git commit -m "fix: resolve validation failures

     Forged by eforge https://eforge.run"
     ```

4. **`src/engine/prompts/cohesion-evaluator.md`** (line 150)
   - Current: `git add plans/{{plan_set_name}}/ && git commit -m "plan({{plan_set_name}}): planning artifacts"`
   - Target:
     ```
     git add plans/{{plan_set_name}}/ && git commit -m "plan({{plan_set_name}}): planning artifacts

     Forged by eforge https://eforge.run"
     ```

5. **`src/engine/prompts/plan-evaluator.md`** (line 150)
   - Current: `git add plans/{{plan_set_name}}/ && git commit -m "plan({{plan_set_name}}): planning artifacts"`
   - Same change as #4

### TypeScript code (programmatic commits)

6. **`src/engine/orchestrator.ts`** (lines 378-380)
   - Current: `` `${prefix}(${plan.id}): ${plan.name}` ``
   - Target: `` `${prefix}(${plan.id}): ${plan.name}\n\nForged by eforge https://eforge.run` ``
   - Git accepts `\n` in `-m` arguments, so this works without format changes.

7. **`src/engine/worktree.ts`** (lines 148, 165) uses the `commitMessage` parameter passed from the orchestrator, so it inherits the change from #6 automatically. **No modification needed.**

## Scope

**In scope:**
- All 5 prompt files containing `git commit -m` instructions
- The `orchestrator.ts` commit message template literal
- Ensuring the attribution appears on its own line after a blank line (standard git trailer format)

**Out of scope:**
- `src/engine/worktree.ts` - inherits the commit message from the orchestrator, no direct change needed
- Any other commit-adjacent logic (hooks, signing, etc.)
- Changing commit message prefixes or structure beyond adding the attribution line

## Acceptance Criteria

- `pnpm build` succeeds with no errors
- `pnpm test` passes with no regressions
- Every `git commit -m` instruction in prompt files (`src/engine/prompts/`) includes `Forged by eforge https://eforge.run` after a blank line in the commit message
- The programmatic commit message in `src/engine/orchestrator.ts` includes `\n\nForged by eforge https://eforge.run`
- The attribution line appears as a separate paragraph in the commit body (blank line between subject and attribution), following standard git message conventions
