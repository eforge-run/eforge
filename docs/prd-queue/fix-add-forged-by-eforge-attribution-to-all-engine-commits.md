---
title: Fix: Add "Forged by eforge" attribution to all engine commits
created: 2026-03-18
status: running
---

## Problem / Motivation

All commits made by eforge should include the attribution line `Forged by eforge https://eforge.run`. Agent prompts and the orchestrator squash-merge already include it, but 7 engine-level commit sites are missing the attribution. This creates inconsistency - some eforge commits are properly attributed while others are not.

## Goal

Ensure every commit eforge makes includes the `Forged by eforge https://eforge.run` attribution line, using a shared helper to eliminate duplication and prevent future omissions.

## Approach

Add a shared `forgeCommit` helper that wraps `git commit` and always appends the attribution. All commit sites call through this helper instead of raw `exec('git', ['commit', ...])`.

**New helper** in `src/engine/git.ts`:

```typescript
const ATTRIBUTION = 'Forged by eforge https://eforge.run';

export async function forgeCommit(
  cwd: string,
  message: string,
  paths?: string[],
): Promise<void> {
  const fullMessage = `${message}\n\n${ATTRIBUTION}`;
  const args = ['commit', '-m', fullMessage];
  if (paths?.length) args.push('--', ...paths);
  await exec('git', args, { cwd });
}
```

Replace all 7 raw `exec('git', ['commit', ...])` calls with `forgeCommit()`. The orchestrator squash-merge (already correct) should also migrate to this helper for consistency.

## Scope

**In scope:**

Files to modify:

1. `src/engine/git.ts` (new) - `forgeCommit` helper with `ATTRIBUTION` constant
2. `src/engine/eforge.ts` - 4 commits → `forgeCommit()`
   - Line 274: enqueue PRD commit
   - Line 209: plan artifacts (no plan-review-cycle path)
   - Line 565: stale PRD auto-revision commit
   - Line 703: cleanup commit (remove plan files + PRD)
3. `src/engine/pipeline.ts` - 2 commits → `forgeCommit()`
   - Line 908: post-parallel-group auto-commit
   - Line 933: `commitPlanArtifacts()` function
4. `src/engine/prd-queue.ts` - 1 commit → `forgeCommit()`
   - Line 291: remove completed PRD commit
5. `src/engine/orchestrator.ts` - squash-merge commit (line 379) → `forgeCommit()`

**Out of scope (already correct, no changes needed):**

- `src/engine/worktree.ts:148,165` - uses `commitMessage` param from orchestrator (already has attribution)
- Agent prompts: `builder.md`, `evaluator.md`, `plan-evaluator.md`, `cohesion-evaluator.md`, `validation-fixer.md` (all have attribution instructions)

## Acceptance Criteria

- [ ] A `forgeCommit` helper exists in `src/engine/git.ts` that appends `Forged by eforge https://eforge.run` to every commit message
- [ ] All 7 previously-missing commit sites use `forgeCommit()` instead of raw `exec('git', ['commit', ...])`
- [ ] The orchestrator squash-merge commit also uses `forgeCommit()` for consistency
- [ ] `pnpm type-check` passes
- [ ] `pnpm test` passes
- [ ] Grepping for all `git.*commit` calls in `src/engine/` confirms each one includes the attribution (or receives it via parameter from a site that does)
