---
title: Fix PRD queue files not deleted in cleanup commit
created: 2026-03-31
status: pending
---

# Fix PRD queue files not deleted in cleanup commit

## Problem / Motivation

After a build completes and merges to main, PRD files from `eforge/queue/` appear as unstaged deletions. The cleanup commit successfully removes plan files (`eforge/plans/`) but silently fails to remove the PRD file.

**Root cause**: `prd.filePath` is an absolute path (e.g., `/Users/mark/projects/eforge/eforge/queue/fix-xxx.md`) because `prd-queue.ts:128` uses `resolve()`. The cleanup runs in the merge worktree (a sibling directory), so `git rm -f -- /absolute/main/repo/path` fails because the path is outside the worktree. The `-f` flag and catch blocks swallow the error. The fallback `rm()` deletes the file from the main repo's filesystem, but the deletion is never staged in the worktree - so the cleanup commit doesn't include it.

Meanwhile, `cleanupOutputDir` (`eforge/plans`) is a relative path, so it resolves correctly within any worktree. The fix is to make `cleanupPrdFilePath` relative too.

## Goal

Ensure the PRD file in `eforge/queue/` is properly staged and included in the cleanup commit after a build merges to main, leaving no unstaged deletions in `git status`.

## Approach

### 1. `src/engine/eforge.ts` - Convert to relative path (primary fix)

**Line 11**: Add `relative` to the `node:path` import:
```typescript
import { relative, resolve } from 'node:path';
```

**Line 672**: Convert absolute `prdFilePath` to repo-relative before passing to orchestrator:
```typescript
cleanupPrdFilePath: options.prdFilePath ? relative(cwd, options.prdFilePath) : undefined,
```

This produces `eforge/queue/fix-xxx.md` - a relative path that resolves correctly in any worktree of the same repo.

### 2. `src/engine/cleanup.ts` - Resolve dirname against cwd (secondary hardening)

**Lines 50-51**: The `dirname()` call on the PRD path should resolve against `cwd` so the empty-directory check operates in the correct working tree:
```typescript
// Before:
const prdDir = dirname(prdFilePath);
// After:
const prdDir = resolve(cwd, dirname(prdFilePath));
```

No other changes needed in this file - `resolve` is already imported.

### Why other `prdFilePath` uses are unaffected

- **Line 612** (`readFile(resolve(cwd, options.prdFilePath!))`): Uses `options.prdFilePath` before the conversion at line 672
- **Line 868** (`prdFilePath: prd.filePath`): Sets the original absolute path; conversion happens downstream
- **Line 888** (`updatePrdStatus(prd.filePath, ...)`): Uses `prd.filePath` directly, not `options.prdFilePath`

## Scope

**In scope:**
- Converting `cleanupPrdFilePath` from absolute to repo-relative in `src/engine/eforge.ts`
- Hardening `dirname()` resolution against `cwd` in `src/engine/cleanup.ts`

**Out of scope:**
- Changes to `prd-queue.ts` or how `prd.filePath` is originally resolved
- Changes to other `prdFilePath` consumers (lines 612, 868, 888) which operate correctly with the existing absolute path
- Changes to plan file (`eforge/plans/`) cleanup, which already works correctly

## Acceptance Criteria

- `pnpm build` compiles without errors
- `pnpm test` passes all existing tests
- End-to-end: enqueue a PRD, let it build, and verify `git status` shows no unstaged deletions after the merge
- The cleanup commit includes the deletion of the PRD file from `eforge/queue/`
- Plan file cleanup (`eforge/plans/`) continues to work as before
