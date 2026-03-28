import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { mkdir, writeFile, utimes, stat, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isLockError, removeStaleIndexLock, retryOnLock } from '../src/engine/git.js';
import { useTempDir } from './test-tmpdir.js';

const execAsync = promisify(execFile);

describe('isLockError', () => {
  it('returns true for error messages containing index.lock', () => {
    const err = new Error(
      "fatal: Unable to create '/repo/.git/index.lock': File exists.",
    );
    expect(isLockError(err)).toBe(true);
  });

  it('returns true for error messages with Unable to create and .lock', () => {
    const err = new Error(
      "error: Unable to create '/repo/.git/refs/heads/main.lock': File exists.",
    );
    expect(isLockError(err)).toBe(true);
  });

  it('returns false for unrelated error messages', () => {
    const err = new Error(
      'CONFLICT (content): Merge conflict in src/foo.ts',
    );
    expect(isLockError(err)).toBe(false);
  });

  it('returns false for non-Error values', () => {
    expect(isLockError('some string')).toBe(false);
  });

  it('handles string values containing index.lock', () => {
    expect(isLockError('index.lock already exists')).toBe(true);
  });
});

describe('removeStaleIndexLock', () => {
  const makeTmpDir = useTempDir();

  async function initRepo(dir: string): Promise<string> {
    await execAsync('git', ['init', dir]);
    return join(dir, '.git');
  }

  it('removes a lock file older than 5 seconds and returns true', async () => {
    const repoRoot = makeTmpDir();
    const gitDir = await initRepo(repoRoot);
    const lockPath = join(gitDir, 'index.lock');
    await writeFile(lockPath, '');

    // Set mtime to 10 seconds ago
    const past = new Date(Date.now() - 10_000);
    await utimes(lockPath, past, past);

    const result = await removeStaleIndexLock(repoRoot);
    expect(result).toBe(true);

    // Verify file was deleted
    await expect(access(lockPath)).rejects.toThrow();
  });

  it('does not remove a lock file younger than 5 seconds and returns false', async () => {
    const repoRoot = makeTmpDir();
    const gitDir = await initRepo(repoRoot);
    const lockPath = join(gitDir, 'index.lock');
    await writeFile(lockPath, '');

    const result = await removeStaleIndexLock(repoRoot);
    expect(result).toBe(false);

    // Verify file still exists
    const st = await stat(lockPath);
    expect(st.isFile()).toBe(true);
  });

  it('returns false when no lock file exists', async () => {
    const repoRoot = makeTmpDir();
    await initRepo(repoRoot);

    const result = await removeStaleIndexLock(repoRoot);
    expect(result).toBe(false);
  });
});

describe('retryOnLock', () => {
  const makeTmpDir = useTempDir();

  it('succeeds on first attempt when no error occurs', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await retryOnLock(fn, '/tmp');
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws immediately on non-lock errors without retrying', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('merge conflict'));
    await expect(retryOnLock(fn, '/tmp')).rejects.toThrow('merge conflict');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries up to maxRetries times on lock errors', async () => {
    const lockErr = new Error("Unable to create '/repo/.git/index.lock': File exists.");
    const fn = vi.fn().mockRejectedValue(lockErr);

    await expect(retryOnLock(fn, '/tmp', 3, 10)).rejects.toThrow(lockErr.message);
    // 1 initial attempt + 3 retries = 4 calls
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('succeeds after transient lock errors resolve', async () => {
    const lockErr = new Error("fatal: Unable to create '/repo/.git/index.lock': File exists.");
    const fn = vi
      .fn()
      .mockRejectedValueOnce(lockErr)
      .mockRejectedValueOnce(lockErr)
      .mockResolvedValue('recovered');

    const result = await retryOnLock(fn, '/tmp', 5, 10);
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('calls removeStaleIndexLock between retry attempts', async () => {
    const repoRoot = makeTmpDir();
    const lockErr = new Error('index.lock exists');
    const fn = vi
      .fn()
      .mockRejectedValueOnce(lockErr)
      .mockResolvedValue('ok');

    // Create a real git repo and a stale lock file to verify it gets cleaned up
    await execAsync('git', ['init', repoRoot]);
    const gitDir = join(repoRoot, '.git');
    const lockPath = join(gitDir, 'index.lock');
    await writeFile(lockPath, '');
    const past = new Date(Date.now() - 10_000);
    await utimes(lockPath, past, past);

    const result = await retryOnLock(fn, repoRoot, 5, 10);
    expect(result).toBe('ok');

    // The stale lock should have been removed
    await expect(access(lockPath)).rejects.toThrow();
  });
});
