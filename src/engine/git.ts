/**
 * Git helpers — shared commit logic with eforge attribution.
 * All engine-level commits go through forgeCommit() to ensure
 * the Co-Authored-By trailer is always appended.
 */

import { execFile } from 'node:child_process';
import { stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile);

export const ATTRIBUTION = 'Co-Authored-By: forged-by-eforge <noreply@eforge.build>';

/** Stale lock threshold in milliseconds (5 seconds). */
const STALE_LOCK_THRESHOLD_MS = 5_000;

/**
 * Detect whether an error is a git index lock error.
 * Git emits messages containing `index.lock` or `Unable to create` + `.lock`
 * when it cannot acquire the index lock.
 */
export function isLockError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('index.lock')) return true;
  if (message.includes('Unable to create') && message.includes('.lock')) return true;
  return false;
}

/**
 * Remove `index.lock` if it exists and is older than the stale threshold.
 * Resolves the git directory dynamically via `git rev-parse --git-dir` to
 * support both regular repos and worktrees (where `.git` is a file, not a directory).
 * Returns true if a stale lock was removed, false otherwise.
 */
export async function removeStaleIndexLock(cwd: string): Promise<boolean> {
  try {
    const { stdout: gitDir } = await exec('git', ['rev-parse', '--git-dir'], { cwd });
    const resolvedGitDir = gitDir.trim();
    // git rev-parse --git-dir may return a relative path; resolve against cwd
    const absoluteGitDir = resolvedGitDir.startsWith('/')
      ? resolvedGitDir
      : join(cwd, resolvedGitDir);
    const lockPath = join(absoluteGitDir, 'index.lock');
    const st = await stat(lockPath);
    const ageMs = Date.now() - st.mtimeMs;
    if (ageMs > STALE_LOCK_THRESHOLD_MS) {
      await unlink(lockPath);
      return true;
    }
    return false;
  } catch {
    // Lock file doesn't exist, can't be accessed, or not a git repo
    return false;
  }
}

/**
 * Retry a function on git index lock errors.
 * Between retries, attempts to remove stale index lock files.
 * Non-lock errors are thrown immediately without retry.
 */
export async function retryOnLock<T>(
  fn: () => Promise<T>,
  repoRoot: string,
  maxRetries = 5,
  delayMs = 500,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isLockError(err)) throw err;
      lastError = err;
      if (attempt < maxRetries) {
        await removeStaleIndexLock(repoRoot);
        await delay(delayMs);
      }
    }
  }
  throw lastError;
}

/**
 * Create a git commit with the eforge attribution appended.
 *
 * @param cwd - Working directory for the git command
 * @param message - Commit message (attribution is appended automatically)
 * @param paths - Optional paths to pass after `--` (for `git commit -m <msg> -- <paths>`)
 */
export async function forgeCommit(cwd: string, message: string, paths?: string[]): Promise<void> {
  const fullMessage = `${message}\n\n${ATTRIBUTION}`;
  const args = ['commit', '-m', fullMessage];
  if (paths && paths.length > 0) {
    args.push('--', ...paths);
  }
  await retryOnLock(() => exec('git', args, { cwd }), cwd);
}
