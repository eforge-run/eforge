import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { captureFileDiffs } from '../src/engine/pipeline.js';

/** Run a git command synchronously in the given cwd. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

describe('captureFileDiffs', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), 'eforge-diff-test-'));
    git(repoDir, 'init', '-b', 'main');
    git(repoDir, 'config', 'user.email', 'test@test.com');
    git(repoDir, 'config', 'user.name', 'Test');

    // Create initial commit on main
    await writeFile(join(repoDir, 'existing.ts'), 'const x = 1;\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'initial');
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true });
  });

  it('returns empty array when there are no diffs', async () => {
    const result = await captureFileDiffs(repoDir, 'main');
    expect(result).toEqual([]);
  });

  it('splits git diff output into per-file {path, diff} pairs', async () => {
    // Create a feature branch with changes to two files
    git(repoDir, 'checkout', '-b', 'feature');
    await writeFile(join(repoDir, 'existing.ts'), 'const x = 2;\n');
    await writeFile(join(repoDir, 'new-file.ts'), 'export const y = 42;\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'feature changes');

    const result = await captureFileDiffs(repoDir, 'main');

    expect(result.length).toBe(2);

    const paths = result.map((d) => d.path).sort();
    expect(paths).toEqual(['existing.ts', 'new-file.ts']);

    // Each diff entry should contain the diff --git header
    for (const entry of result) {
      expect(entry.diff).toContain('diff --git');
      expect(entry.diff).toContain(entry.path);
    }
  });

  it('handles single file diff', async () => {
    git(repoDir, 'checkout', '-b', 'feature');
    await writeFile(join(repoDir, 'existing.ts'), 'const x = 999;\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'single change');

    const result = await captureFileDiffs(repoDir, 'main');

    expect(result.length).toBe(1);
    expect(result[0].path).toBe('existing.ts');
    expect(result[0].diff).toContain('diff --git');
  });

  it('handles files in subdirectories', async () => {
    git(repoDir, 'checkout', '-b', 'feature');
    await mkdir(join(repoDir, 'src', 'engine'), { recursive: true });
    await writeFile(join(repoDir, 'src', 'engine', 'foo.ts'), 'export const foo = 1;\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'nested file');

    const result = await captureFileDiffs(repoDir, 'main');

    expect(result.length).toBe(1);
    expect(result[0].path).toBe('src/engine/foo.ts');
  });

  it('returns empty array when git command fails (invalid cwd)', async () => {
    const result = await captureFileDiffs('/nonexistent/path', 'main');
    expect(result).toEqual([]);
  });

  it('returns empty array when base branch does not exist', async () => {
    const result = await captureFileDiffs(repoDir, 'nonexistent-branch');
    expect(result).toEqual([]);
  });
});
