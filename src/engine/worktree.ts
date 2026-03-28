/**
 * Git worktree lifecycle management.
 * Pure functions wrapping `git worktree` commands — create, remove, merge, cleanup.
 * Worktrees live in a sibling directory per ADR-004.
 */

import { execFile } from 'node:child_process';
import { basename, resolve, join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { promisify } from 'node:util';

import { retryOnLock } from './git.js';

const exec = promisify(execFile);

/**
 * Compute the worktree base directory for a plan set.
 * Per ADR-004: ../{project}-{setName}-worktrees/
 */
export function computeWorktreeBase(repoRoot: string, setName: string): string {
  const project = basename(repoRoot);
  return resolve(repoRoot, '..', `${project}-${setName}-worktrees`);
}

/**
 * Create a git worktree for a plan branch.
 * Creates a new branch from baseBranch, or checks out an existing branch (resume).
 * Returns the worktree path.
 */
export async function createWorktree(
  repoRoot: string,
  worktreeBase: string,
  branch: string,
  baseBranch: string,
): Promise<string> {
  const worktreePath = join(worktreeBase, branch.replace(/\//g, '-'));
  await mkdir(worktreeBase, { recursive: true });

  try {
    // New branch from baseBranch
    await exec('git', ['worktree', 'add', '-b', branch, worktreePath, baseBranch], {
      cwd: repoRoot,
    });
  } catch {
    // Branch may already exist (resume scenario) — checkout existing
    await exec('git', ['worktree', 'add', worktreePath, branch], {
      cwd: repoRoot,
    });
  }

  return worktreePath;
}

/**
 * Remove a git worktree and its directory.
 */
export async function removeWorktree(repoRoot: string, worktreePath: string): Promise<void> {
  try {
    await exec('git', ['worktree', 'remove', worktreePath, '--force'], {
      cwd: repoRoot,
    });
  } catch {
    // Worktree may already be removed — force cleanup
    await rm(worktreePath, { recursive: true, force: true });
    await exec('git', ['worktree', 'prune'], { cwd: repoRoot });
  }
}

/**
 * Information about a merge conflict, provided to the MergeResolver callback.
 */
export interface MergeConflictInfo {
  /** Branch being merged in */
  branch: string;
  /** Target branch (e.g., main) */
  baseBranch: string;
  /** List of files with conflicts */
  conflictedFiles: string[];
  /** Full diff showing conflict markers for each file */
  conflictDiff: string;
  /** Name of the plan whose branch is being merged */
  planName?: string;
  /** Summary of what the plan being merged intended to accomplish */
  planSummary?: string;
  /** Name of a plan that already merged and may have caused the conflict */
  otherPlanName?: string;
  /** Summary of the other plan's intent */
  otherPlanSummary?: string;
}

/**
 * Callback that attempts to resolve merge conflicts.
 * Called with conflict details; should resolve files in the cwd and stage them.
 * Returns true if resolution succeeded (all conflicts resolved and staged),
 * false if it couldn't resolve.
 */
export type MergeResolver = (
  cwd: string,
  conflict: MergeConflictInfo,
) => Promise<boolean>;

/**
 * Gather conflict information from the current merge state.
 */
async function gatherConflictInfo(
  cwd: string,
  branch: string,
  baseBranch: string,
): Promise<MergeConflictInfo | null> {
  try {
    const { stdout: conflictOutput } = await exec(
      'git', ['diff', '--name-only', '--diff-filter=U'],
      { cwd },
    );
    const conflictedFiles = conflictOutput.trim().split('\n').filter(Boolean);

    if (conflictedFiles.length === 0) return null;

    // Get the full diff with conflict markers
    let conflictDiff = '';
    try {
      const { stdout } = await exec('git', ['diff'], { cwd });
      conflictDiff = stdout;
    } catch {
      // Non-critical
    }

    return { branch, baseBranch, conflictedFiles, conflictDiff };
  } catch {
    return null;
  }
}

/**
 * Merge a branch into the base branch using --squash.
 * Produces a single commit on baseBranch containing all worktree changes.
 * On conflict, invokes the optional mergeResolver callback to attempt resolution.
 * If no resolver or resolution fails, aborts the merge and re-throws.
 *
 * @param cwd - Working directory for git operations (may be a merge worktree, not the repo root)
 */
export async function mergeWorktree(
  cwd: string,
  branch: string,
  baseBranch: string,
  commitMessage: string,
  mergeResolver?: MergeResolver,
): Promise<void> {
  await retryOnLock(() => exec('git', ['checkout', baseBranch], { cwd }), cwd);
  try {
    await retryOnLock(() => exec('git', ['merge', '--squash', branch], { cwd }), cwd);
    await retryOnLock(() => exec('git', ['commit', '-m', commitMessage], { cwd }), cwd);
  } catch (err) {
    // Attempt resolution via callback if provided
    if (mergeResolver) {
      try {
        const conflictInfo = await gatherConflictInfo(cwd, branch, baseBranch);
        if (conflictInfo) {
          const resolved = await mergeResolver(cwd, conflictInfo);
          if (resolved) {
            // Verify no remaining conflicts
            try {
              const { stdout } = await exec(
                'git', ['diff', '--name-only', '--diff-filter=U'],
                { cwd },
              );
              if (stdout.trim().length === 0) {
                // All conflicts resolved — commit the squash-merge
                await retryOnLock(() => exec('git', ['commit', '-m', commitMessage], { cwd }), cwd);
                return;
              }
            } catch {
              // Fall through to abort
            }
          }
        }
      } catch {
        // Resolver failed — fall through to abort
      }
    }

    try {
      await retryOnLock(() => exec('git', ['reset', '--merge'], { cwd }), cwd);
    } catch {
      // Best-effort reset
    }
    throw err;
  }
}

/**
 * Create a merge worktree at `{worktreeBase}/__merge__`.
 * The merge worktree hosts the feature branch where plan merges and validation happen,
 * keeping the user's `repoRoot` untouched throughout the build.
 *
 * On resume, if the branch already exists, checks out the existing branch.
 * Returns the path to the merge worktree.
 */
export async function createMergeWorktree(
  repoRoot: string,
  worktreeBase: string,
  featureBranch: string,
  baseBranch: string,
): Promise<string> {
  const mergeWorktreePath = join(worktreeBase, '__merge__');
  await mkdir(worktreeBase, { recursive: true });

  try {
    // Create a new feature branch from baseBranch in a worktree
    await exec('git', ['worktree', 'add', '-b', featureBranch, mergeWorktreePath, baseBranch], {
      cwd: repoRoot,
    });
  } catch {
    // Branch may already exist (resume scenario) — try checking out existing branch
    try {
      await exec('git', ['worktree', 'add', mergeWorktreePath, featureBranch], {
        cwd: repoRoot,
      });
    } catch {
      // Worktree may already exist at that path (resume after crash) — verify it's valid
      try {
        await exec('git', ['rev-parse', '--verify', featureBranch], { cwd: repoRoot });
        // Branch exists; the worktree path may already be registered — return it as-is
      } catch {
        throw new Error(`Failed to create merge worktree for branch '${featureBranch}'`);
      }
    }
  }

  return mergeWorktreePath;
}

/**
 * Merge the feature branch into baseBranch in the user's repoRoot
 * using `git merge --ff-only`. This updates the ref and working tree
 * atomically without switching branches.
 *
 * Falls back to a detached-worktree merge when fast-forward is not possible:
 * creates a temporary worktree, performs the merge there, and updates the
 * baseBranch ref via `git update-ref`.
 */
export async function mergeFeatureBranchToBase(
  repoRoot: string,
  featureBranch: string,
  baseBranch: string,
  worktreeBase: string,
): Promise<string> {
  // Guard: verify we're on the expected base branch to avoid merging into the wrong target
  const { stdout: currentBranchRaw } = await exec('git', ['branch', '--show-current'], { cwd: repoRoot });
  const currentBranch = currentBranchRaw.trim();
  if (currentBranch !== baseBranch) {
    throw new Error(
      `Cannot merge ${featureBranch}: expected repoRoot to be on '${baseBranch}' but found '${currentBranch}'`,
    );
  }

  try {
    // Fast-forward: update baseBranch ref to point at featureBranch HEAD
    await exec('git', ['merge', '--ff-only', featureBranch], { cwd: repoRoot });
    const { stdout: shaOut } = await exec('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });
    return shaOut.trim();
  } catch {
    // Non-fast-forward: use a temporary detached worktree for the merge
    const tmpMergePath = join(worktreeBase, '__final-merge__');
    try {
      // Create a temporary worktree on baseBranch
      await mkdir(worktreeBase, { recursive: true });
      try {
        await exec('git', ['worktree', 'add', '--detach', tmpMergePath, baseBranch], { cwd: repoRoot });
      } catch {
        // Worktree may already exist from a previous failed attempt
        await rm(tmpMergePath, { recursive: true, force: true });
        await exec('git', ['worktree', 'prune'], { cwd: repoRoot });
        await exec('git', ['worktree', 'add', '--detach', tmpMergePath, baseBranch], { cwd: repoRoot });
      }

      // Merge feature branch into baseBranch in the temporary worktree
      const { ATTRIBUTION } = await import('./git.js');
      await exec('git', ['merge', featureBranch, '-m', `Merge ${featureBranch} into ${baseBranch}\n\n${ATTRIBUTION}`], { cwd: tmpMergePath });

      // Get the resulting commit SHA
      const { stdout: shaOut } = await exec('git', ['rev-parse', 'HEAD'], { cwd: tmpMergePath });
      const commitSha = shaOut.trim();

      // Update the baseBranch ref in the main repo to point at the merge commit
      await exec('git', ['update-ref', `refs/heads/${baseBranch}`, commitSha], { cwd: repoRoot });

      // Reset the working tree to match the updated ref
      await exec('git', ['reset', '--hard', 'HEAD'], { cwd: repoRoot });

      return commitSha;
    } finally {
      // Cleanup the temporary merge worktree — wrapped defensively to avoid masking original errors
      try {
        await exec('git', ['worktree', 'remove', tmpMergePath, '--force'], { cwd: repoRoot });
      } catch {
        try {
          await rm(tmpMergePath, { recursive: true, force: true });
          await exec('git', ['worktree', 'prune'], { cwd: repoRoot }).catch(() => {});
        } catch {
          // Cleanup failed — don't mask the original error
        }
      }
    }
  }
}

/**
 * Cleanup all worktrees: prune git metadata and remove the base directory.
 */
export async function cleanupWorktrees(repoRoot: string, worktreeBase: string): Promise<void> {
  await exec('git', ['worktree', 'prune'], { cwd: repoRoot });
  await rm(worktreeBase, { recursive: true, force: true });
}
