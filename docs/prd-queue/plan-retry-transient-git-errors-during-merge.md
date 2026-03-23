---
title: Plan: Retry transient git errors during merge
created: 2026-03-23
status: pending
---

# Retry Transient Git Lock Errors During Merge

## Problem / Motivation

The eforge build for the monitor build-config feature failed at the merge step due to a stale `git index.lock` file — another process (likely Emacs/Magit) had the lock when eforge tried to commit the squash merge. The merge is currently treated as terminal on any error, with no retry logic. This is overly aggressive for transient lock contention that resolves in milliseconds.

The orchestrator's validation step already has retry logic (`maxValidationRetries`), but the merge step — which is equally susceptible to transient failures — has none. The same issue applies to `forgeCommit()`, used for plan artifact commits during compile.

## Goal

Add retry-with-backoff logic for transient git index lock errors in merge and commit operations, so that brief lock contention from external processes (editors, other git clients) no longer causes terminal build failures.

## Approach

1. **Extract a shared `retryOnLock` helper into `src/engine/git.ts`** (the natural home for git utilities) with three components:

   - `isLockError(err)` — detects errors whose message contains `index.lock` or `Unable to create` lock patterns
   - `removeStaleIndexLock(repoRoot)` — checks if `.git/index.lock` exists and removes it if stale (older than 5 seconds); a lock held by a live process shouldn't be that old for a simple git operation
   - `retryOnLock(fn, repoRoot, maxRetries?, delayMs?)` — retries up to 5 times with 500ms backoff (total max wait: ~2.5s); on retry, attempts stale lock removal; passes through non-lock errors immediately (merge conflicts, etc.)

   ```typescript
   import { stat, unlink } from 'node:fs/promises';

   function isLockError(err: unknown): boolean {
     const msg = (err as Error).message ?? '';
     return msg.includes('index.lock') || msg.includes('Unable to create') && msg.includes('.lock');
   }

   async function removeStaleIndexLock(repoRoot: string): Promise<boolean> {
     const lockPath = resolve(repoRoot, '.git', 'index.lock');
     try {
       const info = await stat(lockPath);
       if (Date.now() - info.mtimeMs > 5000) {
         await unlink(lockPath);
         return true;
       }
     } catch {
       // Lock doesn't exist or already removed
     }
     return false;
   }

   async function retryOnLock<T>(fn: () => Promise<T>, repoRoot: string, maxRetries = 5, delayMs = 500): Promise<T> {
     for (let attempt = 0; ; attempt++) {
       try {
         return await fn();
       } catch (err) {
         if (!isLockError(err) || attempt >= maxRetries) throw err;
         await removeStaleIndexLock(repoRoot);
         await new Promise(r => setTimeout(r, delayMs));
       }
     }
   }
   ```

2. **Wrap `forgeCommit()` in `src/engine/git.ts`** with `retryOnLock`:

   ```typescript
   export async function forgeCommit(cwd: string, message: string, paths?: string[]): Promise<void> {
     const fullMessage = `${message}\n\n${ATTRIBUTION}`;
     const args = ['commit', '-m', fullMessage];
     if (paths && paths.length > 0) {
       args.push('--', ...paths);
     }
     await retryOnLock(() => exec('git', args, { cwd }), cwd);
   }
   ```

3. **Wrap git operations in `mergeWorktree()` in `src/engine/worktree.ts`** by importing `retryOnLock` from `git.ts` and wrapping:
   - The `git checkout` call (line ~145)
   - The `git merge --squash` call (line ~148)
   - The `git commit` call (line ~165)
   - The conflict-resolution commit (line ~165)
   - The `git reset --merge` call (line ~179)

   ```typescript
   export async function mergeWorktree(...): Promise<void> {
     await retryOnLock(() => exec('git', ['checkout', baseBranch], { cwd: repoRoot }), repoRoot);
     try {
       await retryOnLock(() => exec('git', ['merge', '--squash', branch], { cwd: repoRoot }), repoRoot);
       await retryOnLock(() => exec('git', ['commit', '-m', commitMessage], { cwd: repoRoot }), repoRoot);
     } catch (err) {
       // ... existing merge resolver logic unchanged ...
     }
   }
   ```

## Scope

**In scope:**
- `retryOnLock` helper with lock detection, stale lock removal, and backoff retry
- Wrapping all git commit/checkout/merge/reset operations in `mergeWorktree()` with retry
- Wrapping `forgeCommit()` with retry
- Extracting shared retry utilities into `src/engine/git.ts` and importing in `worktree.ts`

**Out of scope:**
- Changes to existing merge conflict resolution logic
- Changes to validation retry logic (`maxValidationRetries`)
- Retry for non-lock git errors

**Files to modify:**

| File | Change |
|------|--------|
| `src/engine/git.ts` | Add `isLockError()`, `removeStaleIndexLock()`, `retryOnLock()`. Wrap `forgeCommit()` with retry. |
| `src/engine/worktree.ts` | Import `retryOnLock` from `git.ts`. Wrap all git operations in `mergeWorktree()` with retry. |

## Acceptance Criteria

- `pnpm build` completes with no type errors
- `pnpm test` passes all existing tests (667 tests)
- When a `.git/index.lock` file exists and is stale (older than 5 seconds), the retry logic removes it and the operation succeeds
- Lock errors are retried up to 5 times with 500ms backoff (~2.5s total max wait)
- Merge conflicts and other non-lock git errors fail immediately without retry
- Non-lock errors are passed through unmodified (no wrapping or transformation)
