---
title: Refactor Worktree Management
created: 2026-03-30
status: pending
---

# Refactor Worktree Management

## Problem / Motivation

The git worktree management system (`worktree.ts` + `orchestrator.ts`) has accumulated complexity through incremental fixes (branch drift recovery, lock contention retry, stale state handling, non-FF merge fallback). Specific pain points:

1. **Monolithic `execute()` method** (orchestrator.ts:278-740) - 460+ lines with 7 levels of nesting, 22+ catch blocks (most silently swallowed). Scheduling, worktree lifecycle, merging, validation, finalization, and cleanup are all interleaved in one giant async generator.

2. **No worktree ownership** - worktree creation happens in the orchestrator, removal happens in two places (after plan completion AND in the finally block), merge logic depends on which worktree type was used, and cleanup uses three separate patterns. Nobody "owns" the worktree lifecycle.

3. **Silent error swallowing** - 19 try/catch blocks in worktree.ts, most catch blocks empty. When cleanup fails, there's no record of what failed or why. When `createMergeWorktree` falls through three levels, you can't tell which path it took.

4. **Resume doesn't validate filesystem** - on resume, the code resets running plans to pending but never checks whether the worktrees actually exist or are on the correct branches. The `reconcile` step is missing.

5. **Two merge paths hidden behind a Set** - plans built on the merge worktree need drift recovery; plans with their own worktrees need squash merge. This is tracked via `builtOnMergeWorktree.has(planId)` deep in the merge section, along with ad-hoc state tracking (`builtOnMergeWorktree` Set, `recentlyMergedIds` array, `failedMerges` Set).

This makes it hard to debug failures, reason about resume correctness, and add new capabilities.

## Goal

Extract worktree lifecycle into a `WorktreeManager` class that owns creation, tracking, merging, and cleanup. Decompose the monolithic `execute()` into phase functions. Add transition guards to plan status changes. The result: a ~30 line orchestrator coordinator, deterministic cleanup with structured reporting, and validated resume.

## Approach

**No state machine library** - the plan lifecycle is a simple linear progression (`pending -> running -> completed -> merged`) with one failure path. The complexity is in the side effects at each transition, not the transitions themselves.

### New file structure

```
src/engine/
  worktree-ops.ts       (renamed from worktree.ts - pure git operations, same functions)
  worktree-manager.ts   (NEW - WorktreeManager class)
  orchestrator.ts        (slimmed - thin coordinator calling phases)
  orchestrator/
    phases.ts           (NEW - phase functions: execute, validate, finalize, cleanup)
    plan-lifecycle.ts   (NEW - guarded plan status transitions)
  git.ts                (unchanged)
  state.ts              (unchanged)
  concurrency.ts        (unchanged)
  events.ts             (minor: add cleanup-related events)
```

### WorktreeManager (`worktree-manager.ts`)

Owns the full lifecycle of all worktrees. Tracks what was created so cleanup is deterministic.

```typescript
interface ManagedWorktree {
  type: 'merge' | 'plan';
  planId?: string;
  path: string;
  branch: string;
  status: 'active' | 'removed';
  builtOnMerge: boolean; // true when plan used merge worktree directly
}

class WorktreeManager {
  private tracked = new Map<string, ManagedWorktree>();

  // Plan worktree lifecycle - encapsulates the needsPlanWorktrees decision
  acquireForPlan(planId, branch): Promise<string>
  releaseForPlan(planId): Promise<void>

  // Merge operations - encapsulates the two merge paths
  mergePlan(planId, commitMessage, mergeContext?, resolver?): Promise<string>
  mergeToBase(resolver?): Promise<string>

  // Resume validation - the missing piece
  reconcile(persistedState): Promise<ReconciliationReport>

  // Deterministic cleanup - replaces three scattered patterns
  cleanupAll(): Promise<CleanupReport>
}
```

Key encapsulations:
- `acquireForPlan()` returns the merge worktree path when concurrency=1, creates a new plan worktree otherwise. Caller doesn't need to know.
- `mergePlan()` checks whether the plan built on the merge worktree and dispatches to drift recovery or squash merge. Eliminates the `builtOnMergeWorktree` Set from the orchestrator.
- `cleanupAll()` iterates `tracked` and removes everything it created. Returns a report of what succeeded and what failed instead of silently swallowing errors.

### Plan Lifecycle Guards (`orchestrator/plan-lifecycle.ts`)

Replace the 7 scattered `updatePlanStatus()` calls with a guarded transition function:

```typescript
const VALID_TRANSITIONS = {
  pending:   ['running', 'blocked'],
  running:   ['completed', 'failed'],
  completed: ['merged', 'failed'],    // failed = merge failure
  merged:    [],                       // terminal
  failed:    ['pending'],              // resume only
  blocked:   ['pending'],              // resume unblock only
};

function transitionPlan(state, planId, to, metadata?): void
// Throws on invalid transition, updates state atomically
```

### Phase Functions (`orchestrator/phases.ts`)

Break `execute()` into focused async generators:

```typescript
// Scheduling + plan execution + inline merges
async function* executePlans(ctx, worktreeManager): AsyncGenerator<EforgeEvent>

// Post-merge validation with retry/fix cycle
async function* validate(ctx): AsyncGenerator<EforgeEvent>

// Feature branch -> base branch merge
async function* finalize(ctx, worktreeManager): AsyncGenerator<EforgeEvent>
```

### Slimmed Orchestrator

```typescript
async *execute(config): AsyncGenerator<EforgeEvent> {
  const ctx = this.buildContext(config);
  const wm = new WorktreeManager({...});

  try {
    yield* executePlans(ctx, wm);
    yield* validate(ctx);
    yield* finalize(ctx, wm);
  } finally {
    const report = await wm.cleanupAll();
    // yield cleanup events from report
    saveState(ctx.stateDir, ctx.state);
  }
}
```

~30 lines instead of 460.

### Error handling improvement

Replace silent catches with structured returns in `worktree-ops.ts`:

```typescript
// Before (worktree.ts:57-67):
async function removeWorktree(repoRoot, path) {
  try { await exec('git', ['worktree', 'remove', path, '--force'], ...); }
  catch { await rm(path, ...); await exec('git', ['worktree', 'prune'], ...); }
}

// After:
async function removeWorktree(repoRoot, path): Promise<{ removed: boolean; fallback: boolean }> {
  try {
    await exec('git', ['worktree', 'remove', path, '--force'], ...);
    return { removed: true, fallback: false };
  } catch {
    await rm(path, ...);
    await exec('git', ['worktree', 'prune'], ...);
    return { removed: true, fallback: true };
  }
}
```

The `WorktreeManager` uses these structured results to build its `CleanupReport`.

### Migration: 4 incremental PRs

**PR 1: Plan lifecycle guards**
- Create `src/engine/orchestrator/plan-lifecycle.ts`
- Replace all `updatePlanStatus()` calls in orchestrator with `transitionPlan()`
- Add tests for valid/invalid transitions
- Zero behavioral change

**PR 1.5: Worktree integration test baseline** (prerequisite for PR 2)
- Create `test/worktree-integration.test.ts`
- Tests exercise the full worktree lifecycle using real git repos:
  - Create merge worktree, verify feature branch exists
  - Create plan worktree branched from feature branch, make commits, squash merge back
  - Create plan on merge worktree directly (concurrency=1 path), verify drift recovery
  - Multi-plan: two plans in parallel worktrees, merge both, verify commit history
  - Cleanup: verify all worktrees removed, all plan branches deleted, worktree base dir gone
  - Resume scenario: create worktree, simulate crash (leave worktree in place), re-create
  - Error case: merge conflict between two plans (overlapping file edits)
- Uses `useTempDir` from `test/test-tmpdir.ts` for isolated git repos
- This test runs against the current code and must pass before PR 2 begins

**PR 2: WorktreeManager**
- Rename `worktree.ts` -> `worktree-ops.ts`, update imports (4 files: `orchestrator.ts`, `eforge.ts`, `engine/index.ts`, `agents/merge-conflict-resolver.ts`)
- Create `worktree-manager.ts`
- Replace direct worktree function calls in orchestrator with manager methods
- Remove `builtOnMergeWorktree` Set, three cleanup patterns, merge path branching from orchestrator
- **Dead code cleanup**: Un-export worktree-ops functions that are now only called by WorktreeManager (`createWorktree`, `removeWorktree`, `mergeWorktree`, `recoverDriftedWorktree`, `cleanupWorktrees`). Remove their re-exports from `engine/index.ts` - external consumers should use WorktreeManager. Keep `MergeConflictInfo` and `MergeResolver` types exported (used by agents and eforge.ts).
- Add tests for manager using real git repos (same pattern as `worktree-drift.test.ts`)

**PR 3: Phase decomposition**
- Create `src/engine/orchestrator/phases.ts`
- Extract `executePlans()`, `validate()`, `finalize()` from `execute()`
- Slim `execute()` to ~30 line coordinator
- **Dead code cleanup**: Move `propagateFailure`, `shouldSkipMerge`, `resumeState`, and `computeMaxConcurrency` out of `orchestrator.ts` into the modules that use them (`phases.ts` and `plan-lifecycle.ts`). These are currently exported from `orchestrator.ts` but only used internally - after decomposition they become implementation details of the phase/lifecycle modules. Update `engine/index.ts` if any were re-exported.
- Integration test: capture event stream before/after, verify identical

**PR 4: Resume reconciliation**
- Add `WorktreeManager.reconcile()` method
- Call on resume to validate filesystem state matches persisted state
- Add integration tests for resume with missing/corrupt worktrees

## Scope

**In scope:**
- Extracting worktree lifecycle into `WorktreeManager` class
- Decomposing `execute()` into phase functions
- Adding guarded plan status transitions
- Replacing silent error swallowing with structured returns and cleanup reports
- Adding resume reconciliation (filesystem validation against persisted state)
- Renaming `worktree.ts` to `worktree-ops.ts`
- Dead code cleanup: un-exporting internal worktree-ops functions, relocating helper functions to their consuming modules
- Integration test baseline for worktree lifecycle
- New tests for each extracted module

**Out of scope:**
- Adding a state machine library
- Changing the plan lifecycle states themselves (`pending -> running -> completed -> merged` with failure path remains the same)
- Changes to `git.ts`, `state.ts`, `concurrency.ts`

**Critical files:**
- `src/engine/orchestrator.ts` (751 lines) - decomposed across PRs 1-3
- `src/engine/worktree.ts` (407 lines) - renamed + wrapped in PR 2
- `src/engine/events.ts` - PlanState/EforgeState types (minor additions)
- `src/engine/eforge.ts` - constructs orchestrator (import updates)
- `src/engine/index.ts` - re-exports (import updates)
- `test/orchestration-logic.test.ts` - regression baseline
- `test/worktree-drift.test.ts` - drift recovery tests (move to manager tests)

## Acceptance Criteria

After each PR:
1. `pnpm type-check` passes
2. `pnpm test` passes (all existing tests)
3. New tests exist for the extracted module

PR-specific criteria:

- **PR 1**: All `updatePlanStatus()` calls replaced with `transitionPlan()`. Tests cover valid and invalid transitions. Zero behavioral change.
- **PR 1.5**: `test/worktree-integration.test.ts` passes against the current code, covering: merge worktree creation, plan worktree squash merge, concurrency=1 drift recovery path, multi-plan parallel worktrees, full cleanup verification, resume/crash simulation, and merge conflict error case.
- **PR 2**: `WorktreeManager` owns all worktree creation, tracking, merging, and cleanup. `builtOnMergeWorktree` Set, three cleanup patterns, and merge path branching removed from orchestrator. Worktree-ops functions only called by WorktreeManager are un-exported. `MergeConflictInfo` and `MergeResolver` types remain exported.
- **PR 3**: `execute()` reduced to ~30 line coordinator calling `executePlans()`, `validate()`, `finalize()`. Helper functions (`propagateFailure`, `shouldSkipMerge`, `resumeState`, `computeMaxConcurrency`) relocated to consuming modules. Integration test verifies event stream is identical before/after decomposition.
- **PR 4**: `WorktreeManager.reconcile()` validates filesystem state matches persisted state on resume. Integration tests cover resume with missing worktrees and resume with corrupt worktrees. Manual test of resume with killed process mid-build passes.
