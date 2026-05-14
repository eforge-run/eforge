import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { collectDiffStats } from '@eforge-build/engine/git-diff-stats';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

describe('collectDiffStats', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), 'eforge-diffstats-test-'));
    git(repoDir, 'init', '-b', 'main');
    git(repoDir, 'config', 'user.email', 'test@test.com');
    git(repoDir, 'config', 'user.name', 'Test');
    git(repoDir, 'config', 'commit.gpgsign', 'false');

    // Initial commit establishing the base
    await writeFile(join(repoDir, 'README.md'), '# base\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'initial');
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it('returns empty totals when base and HEAD are identical (no changes)', async () => {
    const result = await collectDiffStats({ cwd: repoDir, fromRef: 'HEAD' });
    expect(result.files).toHaveLength(0);
    expect(result.totals.filesChanged).toBe(0);
    expect(result.totals.additions).toBe(0);
    expect(result.totals.deletions).toBe(0);
  });

  it('returns empty totals on git failure (invalid ref)', async () => {
    const result = await collectDiffStats({ cwd: repoDir, fromRef: 'nonexistent-ref' });
    expect(result.files).toHaveLength(0);
    expect(result.totals.filesChanged).toBe(0);
  });

  it('detects added and modified files', async () => {
    // Modify README.md and add a new file
    await writeFile(join(repoDir, 'README.md'), '# base\n\nmodified line\n');
    await writeFile(join(repoDir, 'src.ts'), 'export const x = 1;\nexport const y = 2;\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'feat: add and modify');

    const result = await collectDiffStats({ cwd: repoDir, fromRef: 'HEAD~1' });
    expect(result.totals.filesChanged).toBe(2);
    expect(result.totals.additions).toBeGreaterThan(0);

    const paths = result.files.map((f) => f.path).sort();
    expect(paths).toContain('README.md');
    expect(paths).toContain('src.ts');

    const readmeFile = result.files.find((f) => f.path === 'README.md');
    expect(readmeFile?.status).toBe('M');
    expect(readmeFile?.binary).toBe(false);

    const srcFile = result.files.find((f) => f.path === 'src.ts');
    expect(srcFile?.status).toBe('A');
    expect(srcFile?.additions).toBe(2);
    expect(srcFile?.deletions).toBe(0);
  });

  it('detects deleted files', async () => {
    git(repoDir, 'rm', 'README.md');
    git(repoDir, 'commit', '-m', 'chore: remove readme');

    const result = await collectDiffStats({ cwd: repoDir, fromRef: 'HEAD~1' });
    expect(result.totals.filesChanged).toBe(1);

    const deleted = result.files.find((f) => f.path === 'README.md');
    expect(deleted?.status).toBe('D');
    expect(deleted?.additions).toBe(0);
    expect(deleted?.deletions).toBeGreaterThan(0);
  });

  it('detects renamed files', async () => {
    git(repoDir, 'mv', 'README.md', 'RENAMED.md');
    git(repoDir, 'commit', '-m', 'chore: rename');

    const result = await collectDiffStats({ cwd: repoDir, fromRef: 'HEAD~1' });
    expect(result.totals.filesChanged).toBe(1);

    // Rename shows up under the new path
    const renamed = result.files.find((f) => f.path === 'RENAMED.md');
    expect(renamed).toBeDefined();
    expect(renamed?.status).toMatch(/^R/);
  });

  it('handles binary files with zero additions/deletions and binary flag', async () => {
    // Write a minimal PNG header (binary content) using Buffer
    const binaryContent = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk length + type
    ]);
    const { writeFile: writeFileFn } = await import('node:fs/promises');
    await writeFileFn(join(repoDir, 'image.png'), binaryContent);
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'chore: add binary');

    const result = await collectDiffStats({ cwd: repoDir, fromRef: 'HEAD~1' });
    const binaryFile = result.files.find((f) => f.path === 'image.png');
    expect(binaryFile).toBeDefined();
    expect(binaryFile?.binary).toBe(true);
    // Binary files report 0 for additions/deletions (not -1) in our normalized output
    expect(binaryFile?.additions).toBe(0);
    expect(binaryFile?.deletions).toBe(0);
  });

  it('handles file paths with embedded spaces', async () => {
    await writeFile(join(repoDir, 'file with spaces.ts'), 'export {};\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'feat: file with spaces');

    const result = await collectDiffStats({ cwd: repoDir, fromRef: 'HEAD~1' });
    const spacedFile = result.files.find((f) => f.path === 'file with spaces.ts');
    expect(spacedFile).toBeDefined();
    expect(spacedFile?.additions).toBe(1);
  });

  it('sums totals correctly across multiple files', async () => {
    await writeFile(join(repoDir, 'a.ts'), 'line1\nline2\nline3\n');
    await writeFile(join(repoDir, 'b.ts'), 'x\ny\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'feat: multiple files');

    const result = await collectDiffStats({ cwd: repoDir, fromRef: 'HEAD~1' });
    expect(result.totals.filesChanged).toBe(2);
    expect(result.totals.additions).toBe(5); // 3 + 2
    expect(result.totals.deletions).toBe(0);
  });
});
