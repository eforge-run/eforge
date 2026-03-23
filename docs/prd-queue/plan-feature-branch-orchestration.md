---
title: Plan: Feature Branch Orchestration
created: 2026-03-23
status: pending
---

# Feature Branch Orchestration

## Problem / Motivation

Currently, the orchestrator squash-merges each plan directly to `baseBranch` (main) as it completes. If plan 2 of 3 fails, plan 1's changes are already on main — leaving it in a partially-implemented state. This makes reverts messy and leaves main dirty on failures.

## Goal

Merge plans to a feature branch first, then fast-forward merge the feature branch to main only after ALL plans and validation pass. Main stays pristine until everything succeeds, and individual plan commits are preserved.

## Approach

### 1. Create feature branch at build start

**File**: `src/engine/orchestrator.ts`

In the `build()` method, before the main scheduling loop (around line 234), create the feature branch:

```typescript
const featureBranch = `eforge/${config.name}`;
await exec('git', ['checkout', '-b', featureBranch, config.baseBranch], { cwd: repoRoot });
await exec('git', ['checkout', config.baseBranch], { cwd: repoRoot }); // return to baseBranch
```

Store `featureBranch` in `EforgeState` for resume support.

### 2. Merge plans to feature branch instead of baseBranch

**File**: `src/engine/orchestrator.ts` — merge loop (lines 402-447)

Change the `mergeWorktree` call (line 429):

```typescript
// Before:
await mergeWorktree(repoRoot, plan.branch, config.baseBranch, commitMessage, contextResolver);

// After:
await mergeWorktree(repoRoot, plan.branch, featureBranch, commitMessage, contextResolver);
```

The `mergeWorktree` function in `worktree.ts:140-187` already takes `baseBranch` as a parameter — it checks out that branch and squash-merges the plan branch into it. No changes needed to `mergeWorktree` itself.

### 3. Run validation on feature branch

**File**: `src/engine/orchestrator.ts` — validation section (lines 482-546)

Validation already runs in the main repo with whatever branch is checked out. Since plans merge to the feature branch, the repo will be on the feature branch during validation. Ensure we're on the feature branch before validation:

```typescript
await exec('git', ['checkout', featureBranch], { cwd: repoRoot });
```

No other changes needed — validation commands run in cwd, which is the repo root.

### 4. Final merge: feature branch → baseBranch

**File**: `src/engine/orchestrator.ts` — after validation passes (after line ~546)

New phase after successful validation:

```typescript
// Fast-forward merge feature branch to baseBranch
yield { type: 'merge:finalize:start' };
await exec('git', ['checkout', config.baseBranch], { cwd: repoRoot });
try {
  await exec('git', ['merge', '--ff-only', featureBranch], { cwd: repoRoot });
} catch {
  // Fast-forward not possible (main advanced during build) — regular merge
  await exec('git', ['merge', featureBranch, '-m', `Merge eforge/${config.name}`], { cwd: repoRoot });
}
// Delete feature branch
await exec('git', ['branch', '-D', featureBranch], { cwd: repoRoot });
yield { type: 'merge:finalize:complete' };
```

### 5. Handle failure: leave main untouched

**File**: `src/engine/orchestrator.ts` — error handling and finally block

On build failure (any plan fails or validation fails):
- Do NOT merge feature branch to baseBranch
- Checkout baseBranch to leave repo in clean state: `git checkout config.baseBranch`
- Feature branch stays for inspection (or optionally delete it)
- Emit event: `{ type: 'merge:finalize:skipped', reason: 'build-failed' }`

In the finally block (lines 552-570), ensure we're back on baseBranch:

```typescript
await exec('git', ['checkout', config.baseBranch], { cwd: repoRoot });
```

### 6. Add events for feature branch lifecycle

**File**: `src/engine/events.ts`

Add new event types:

```typescript
| { type: 'merge:finalize:start' }
| { type: 'merge:finalize:complete' }
| { type: 'merge:finalize:skipped'; reason: string }
```

### 7. Update EforgeState for resume support

**File**: `src/engine/events.ts` — `EforgeState` interface (line ~57)

Add `featureBranch?: string` to `EforgeState`. On resume, if the feature branch exists, reuse it instead of creating a new one.

### 8. Errand optimization (single plan)

For errands (single plan, no dependencies), the feature branch is still created for consistency but the overhead is trivial (one extra branch + one fast-forward merge). Keep the flow uniform.

## Scope

**In scope:**
- Feature branch creation (`eforge/{set-name}`) at build start
- Redirecting plan merges from baseBranch to the feature branch
- Running validation on the feature branch
- Fast-forward (or regular) merge of the feature branch to baseBranch after all plans and validation pass
- Failure handling: leaving main untouched when any plan or validation fails
- New `merge:finalize:*` event types
- `featureBranch` field in `EforgeState` for resume support
- Uniform flow for errands (single-plan builds still use a feature branch)

**Files to modify:**

| File | Change |
|------|--------|
| `src/engine/orchestrator.ts` | Create feature branch, merge to it, final ff-merge to baseBranch, failure handling |
| `src/engine/events.ts` | Add `merge:finalize:*` events, `featureBranch` to `EforgeState` |

**Out of scope:**
- N/A

## Acceptance Criteria

1. `pnpm build` completes with no type errors.
2. `pnpm test` — all existing tests pass.
3. Run a multi-plan build (excursion) and verify:
   - Feature branch `eforge/{set-name}` is created at build start.
   - Plan commits appear on the feature branch during build.
   - Main is untouched until all plans and validation pass.
   - After success, main has all plan commits (fast-forward merge).
   - Feature branch is deleted after merge.
4. Simulate a failure (e.g., force a plan to fail) and verify main is untouched.
5. Monitor dashboard: verify `merge:finalize:*` events display correctly.
