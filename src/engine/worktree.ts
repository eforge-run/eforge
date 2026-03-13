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
 * Merge a branch into the base branch using --no-ff.
 * Caller must handle merge conflicts (thrown as errors).
 */
export async function mergeWorktree(
  repoRoot: string,
  branch: string,
  baseBranch: string,
): Promise<void> {
  await exec('git', ['checkout', baseBranch], { cwd: repoRoot });
  await exec(
    'git',
    ['merge', '--no-ff', branch, '-m', `Merge ${branch} into ${baseBranch}`],
    { cwd: repoRoot },
  );
}

/**
 * Cleanup all worktrees: prune git metadata and remove the base directory.
 */
export async function cleanupWorktrees(repoRoot: string, worktreeBase: string): Promise<void> {
  await exec('git', ['worktree', 'prune'], { cwd: repoRoot });
  await rm(worktreeBase, { recursive: true, force: true });
}
