/**
 * WorktreeManager — owns worktree lifecycle: creation, tracking, merging, and cleanup.
 * Wraps worktree-ops.ts pure functions with stateful tracking via a ManagedWorktree map.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { existsSync } from 'node:fs';

import {
  createWorktree,
  removeWorktree,
  mergeWorktree,
  mergeFeatureBranchToBase,
  recoverDriftedWorktree,
  cleanupWorktrees,
  type MergeResolver,
} from './worktree-ops.js';
import { ATTRIBUTION } from './git.js';
import type { EforgeState, ReconciliationReport } from './events.js';

const exec = promisify(execFile);

/** Status of a managed worktree. */
export type WorktreeStatus = 'active' | 'merged' | 'removed';

/** Type of managed worktree. */
export type WorktreeType = 'plan' | 'merge';

/** Tracking record for a worktree managed by WorktreeManager. */
export interface ManagedWorktree {
  type: WorktreeType;
  planId?: string;
  path: string;
  branch: string;
  status: WorktreeStatus;
  /** True if the plan was built directly on the merge worktree (no dedicated worktree). */
  builtOnMerge: boolean;
}

/** Result of cleanupAll() - reports what happened during cleanup. */
export interface CleanupReport {
  /** Worktrees that were cleanly removed. */
  removed: string[];
  /** Worktrees that required fallback force removal. */
  fallback: string[];
  /** Worktrees that failed to remove entirely. */
  failed: string[];
}

export class WorktreeManager {
  private readonly repoRoot: string;
  private readonly worktreeBase: string;
  private readonly featureBranch: string;
  private readonly mergeWorktreePath: string;
  private readonly worktrees = new Map<string, ManagedWorktree>();

  constructor(opts: {
    repoRoot: string;
    worktreeBase: string;
    featureBranch: string;
    mergeWorktreePath: string;
  }) {
    this.repoRoot = opts.repoRoot;
    this.worktreeBase = opts.worktreeBase;
    this.featureBranch = opts.featureBranch;
    this.mergeWorktreePath = opts.mergeWorktreePath;
  }

  /**
   * Acquire a worktree for a plan. When `needsPlanWorktrees` is false
   * (maxConcurrency=1), returns the merge worktree path and records the plan
   * as `builtOnMerge: true`. When true, creates a dedicated worktree.
   */
  async acquireForPlan(
    planId: string,
    branch: string,
    needsPlanWorktrees: boolean,
  ): Promise<string> {
    if (needsPlanWorktrees) {
      const worktreePath = await createWorktree(
        this.repoRoot,
        this.worktreeBase,
        branch,
        this.featureBranch,
      );
      this.worktrees.set(planId, {
        type: 'plan',
        planId,
        path: worktreePath,
        branch,
        status: 'active',
        builtOnMerge: false,
      });
      return worktreePath;
    }

    // No concurrent plans - build directly on the merge worktree
    this.worktrees.set(planId, {
      type: 'plan',
      planId,
      path: this.mergeWorktreePath,
      branch,
      status: 'active',
      builtOnMerge: true,
    });
    return this.mergeWorktreePath;
  }

  /**
   * Release a plan's worktree after build completes or fails.
   * For dedicated worktrees, removes the worktree. For merge worktree plans, no-op.
   */
  async releaseForPlan(planId: string): Promise<void> {
    const managed = this.worktrees.get(planId);
    if (!managed || managed.builtOnMerge) return;

    try {
      await removeWorktree(this.repoRoot, managed.path);
      managed.status = 'removed';
    } catch {
      // Best-effort worktree cleanup
    }
  }

  /**
   * Check if a plan was built directly on the merge worktree.
   */
  isBuiltOnMerge(planId: string): boolean {
    return this.worktrees.get(planId)?.builtOnMerge ?? false;
  }

  /**
   * Merge a completed plan into the feature branch.
   * For `builtOnMerge` plans, recovers from branch drift (commits already on featureBranch).
   * For dedicated worktree plans, performs a squash merge.
   *
   * Returns the commit SHA after merge.
   */
  async mergePlan(
    planId: string,
    plan: { id: string; name: string; branch: string },
    opts: {
      mode?: string;
      mergeResolver?: MergeResolver;
      recentlyMergedIds?: string[];
      planMap?: Map<string, { name: string }>;
    } = {},
  ): Promise<string> {
    const managed = this.worktrees.get(planId);
    const prefix = opts.mode === 'errand' ? 'fix' : 'feat';
    const commitMessage = `${prefix}(${plan.id}): ${plan.name}\n\n${ATTRIBUTION}`;

    if (managed?.builtOnMerge) {
      // Plan built directly on the merge worktree - commits already on featureBranch.
      // Recover from any branch drift first, then capture HEAD SHA.
      await recoverDriftedWorktree(this.mergeWorktreePath, this.featureBranch, commitMessage);

      const { stdout: shaOut } = await exec('git', ['rev-parse', 'HEAD'], { cwd: this.mergeWorktreePath });
      if (managed) managed.status = 'merged';
      return shaOut.trim();
    }

    // Dedicated worktree plan - squash merge into featureBranch
    // Wrap mergeResolver to inject plan context into MergeConflictInfo
    const baseResolver = opts.mergeResolver;
    const contextResolver: MergeResolver | undefined = baseResolver
      ? async (cwd, conflict) => {
          conflict.planName = plan.name;

          // Find the most recently merged plan as the likely conflict source
          if (opts.recentlyMergedIds && opts.recentlyMergedIds.length > 0 && opts.planMap) {
            const lastMergedId = opts.recentlyMergedIds[opts.recentlyMergedIds.length - 1];
            const otherPlan = opts.planMap.get(lastMergedId);
            if (otherPlan) {
              conflict.otherPlanName = otherPlan.name;
            }
          }

          return baseResolver(cwd, conflict);
        }
      : undefined;

    await mergeWorktree(this.mergeWorktreePath, plan.branch, this.featureBranch, commitMessage, contextResolver);

    // Capture the squash-merge commit SHA
    const { stdout: shaOut } = await exec('git', ['rev-parse', 'HEAD'], { cwd: this.mergeWorktreePath });

    // Best-effort branch deletion - squash merges leave branches "unmerged" so use -D (force)
    try {
      await exec('git', ['branch', '-D', plan.branch], { cwd: this.repoRoot });
    } catch {
      // Branch may already be deleted or never created
    }

    if (managed) managed.status = 'merged';
    return shaOut.trim();
  }

  /**
   * Merge the feature branch into baseBranch in the user's repoRoot.
   * Delegates to mergeFeatureBranchToBase from worktree-ops.
   */
  async mergeToBase(baseBranch: string, commitMessage: string, mergeResolver?: MergeResolver): Promise<string> {
    return mergeFeatureBranchToBase(
      this.repoRoot,
      this.featureBranch,
      baseBranch,
      commitMessage,
      mergeResolver,
    );
  }

  /**
   * Reconcile persisted state with the actual filesystem and git state.
   * Checks that worktrees referenced in state actually exist and are on the
   * correct branches. Missing or corrupt worktrees have their worktreePath
   * cleared so they'll be re-created on retry.
   */
  async reconcile(state: EforgeState): Promise<ReconciliationReport> {
    const report: ReconciliationReport = {
      valid: [],
      missing: [],
      corrupt: [],
      cleared: [],
    };

    // Check the merge worktree
    const mergeWtPath = state.mergeWorktreePath;
    if (mergeWtPath) {
      if (!existsSync(mergeWtPath)) {
        report.missing.push('__merge__');
        report.cleared.push('__merge__');
        state.mergeWorktreePath = undefined;
      } else {
        try {
          const { stdout } = await exec('git', ['branch', '--show-current'], { cwd: mergeWtPath });
          const currentBranch = stdout.trim();
          if (currentBranch !== this.featureBranch) {
            report.corrupt.push('__merge__');
            report.cleared.push('__merge__');
            try { await removeWorktree(this.repoRoot, mergeWtPath); } catch { /* best-effort */ }
            state.mergeWorktreePath = undefined;
          } else {
            report.valid.push('__merge__');
          }
        } catch {
          report.corrupt.push('__merge__');
          report.cleared.push('__merge__');
          try { await removeWorktree(this.repoRoot, mergeWtPath); } catch { /* best-effort */ }
          state.mergeWorktreePath = undefined;
        }
      }
    }

    // Check each plan's worktree
    for (const [planId, planState] of Object.entries(state.plans)) {
      const wtPath = planState.worktreePath;
      if (!wtPath) continue;

      if (!existsSync(wtPath)) {
        report.missing.push(planId);
        report.cleared.push(planId);
        planState.worktreePath = undefined;
        this.worktrees.delete(planId);
        if (planState.status === 'running') {
          planState.status = 'pending';
        }
        continue;
      }

      try {
        const { stdout } = await exec('git', ['branch', '--show-current'], { cwd: wtPath });
        const currentBranch = stdout.trim();
        if (currentBranch !== planState.branch) {
          report.corrupt.push(planId);
          report.cleared.push(planId);
          try { await removeWorktree(this.repoRoot, wtPath); } catch { /* best-effort */ }
          planState.worktreePath = undefined;
          if (planState.status === 'running') {
            planState.status = 'pending';
          }
        } else {
          report.valid.push(planId);
          if (!this.worktrees.has(planId)) {
            this.worktrees.set(planId, {
              type: 'plan',
              planId,
              path: wtPath,
              branch: planState.branch!,
              status: 'active',
              builtOnMerge: false,
            });
          }
        }
      } catch {
        report.corrupt.push(planId);
        report.cleared.push(planId);
        try { await removeWorktree(this.repoRoot, wtPath); } catch { /* best-effort */ }
        planState.worktreePath = undefined;
        if (planState.status === 'running') {
          planState.status = 'pending';
        }
      }
    }

    return report;
  }

  /**
   * Cleanup all managed worktrees and the worktree base directory.
   * Returns a structured CleanupReport.
   */
  async cleanupAll(): Promise<CleanupReport> {
    const report: CleanupReport = {
      removed: [],
      fallback: [],
      failed: [],
    };

    // Remove the merge worktree first
    try {
      const result = await removeWorktree(this.repoRoot, this.mergeWorktreePath);
      if (result.fallback) {
        report.fallback.push(this.mergeWorktreePath);
      } else {
        report.removed.push(this.mergeWorktreePath);
      }
    } catch {
      report.failed.push(this.mergeWorktreePath);
    }

    // Remove any remaining active plan worktrees
    for (const [, managed] of this.worktrees) {
      if (managed.status !== 'active' || managed.builtOnMerge) continue;

      try {
        const result = await removeWorktree(this.repoRoot, managed.path);
        managed.status = 'removed';
        if (result.fallback) {
          report.fallback.push(managed.path);
        } else {
          report.removed.push(managed.path);
        }
      } catch {
        report.failed.push(managed.path);
      }
    }

    // Prune git metadata and remove the base directory
    try {
      await cleanupWorktrees(this.repoRoot, this.worktreeBase);
    } catch {
      // Best-effort cleanup
    }

    return report;
  }
}
