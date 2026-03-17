/**
 * Git worktree lifecycle management.
 * Pure functions wrapping `git worktree` commands — create, remove, merge, cleanup.
 * Worktrees live in a sibling directory per ADR-004.
 */

import { execFile } from 'node:child_process';
import { basename, resolve, join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { promisify } from 'node:util';

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
 * Called with conflict details; should resolve files in the repo and stage them.
 * Returns true if resolution succeeded (all conflicts resolved and staged),
 * false if it couldn't resolve.
 */
export type MergeResolver = (
  repoRoot: string,
  conflict: MergeConflictInfo,
) => Promise<boolean>;

/**
 * Gather conflict information from the current merge state.
 */
async function gatherConflictInfo(
  repoRoot: string,
  branch: string,
  baseBranch: string,
): Promise<MergeConflictInfo | null> {
  try {
    const { stdout: conflictOutput } = await exec(
      'git', ['diff', '--name-only', '--diff-filter=U'],
      { cwd: repoRoot },
    );
    const conflictedFiles = conflictOutput.trim().split('\n').filter(Boolean);

    if (conflictedFiles.length === 0) return null;

    // Get the full diff with conflict markers
    let conflictDiff = '';
    try {
      const { stdout } = await exec('git', ['diff'], { cwd: repoRoot });
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
 * Merge a branch into the base branch using --no-ff.
 * On conflict, invokes the optional mergeResolver callback to attempt resolution.
 * If no resolver or resolution fails, aborts the merge and re-throws.
 */
export async function mergeWorktree(
  repoRoot: string,
  branch: string,
  baseBranch: string,
  mergeResolver?: MergeResolver,
): Promise<void> {
  await exec('git', ['checkout', baseBranch], { cwd: repoRoot });
  try {
    await exec(
      'git',
      ['merge', '--no-ff', branch, '-m', `Merge ${branch} into ${baseBranch}`],
      { cwd: repoRoot },
    );
  } catch (err) {
    // Attempt resolution via callback if provided
    if (mergeResolver) {
      try {
        const conflictInfo = await gatherConflictInfo(repoRoot, branch, baseBranch);
        if (conflictInfo) {
          const resolved = await mergeResolver(repoRoot, conflictInfo);
          if (resolved) {
            // Verify no remaining conflicts
            try {
              const { stdout } = await exec(
                'git', ['diff', '--name-only', '--diff-filter=U'],
                { cwd: repoRoot },
              );
              if (stdout.trim().length === 0) {
                // All conflicts resolved — complete the merge commit
                await exec('git', ['commit', '--no-edit'], { cwd: repoRoot });
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
      await exec('git', ['merge', '--abort'], { cwd: repoRoot });
    } catch {
      // Best-effort abort
    }
    throw err;
  }
}

/**
 * Cleanup all worktrees: prune git metadata and remove the base directory.
 */
export async function cleanupWorktrees(repoRoot: string, worktreeBase: string): Promise<void> {
  await exec('git', ['worktree', 'prune'], { cwd: repoRoot });
  await rm(worktreeBase, { recursive: true, force: true });
}
