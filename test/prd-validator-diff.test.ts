import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { buildPrdValidatorDiff } from '@eforge-build/engine/prd-validator-diff';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

describe('buildPrdValidatorDiff', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), 'eforge-prd-diff-test-'));
    git(repoDir, 'init', '-b', 'main');
    git(repoDir, 'config', 'user.email', 'test@test.com');
    git(repoDir, 'config', 'user.name', 'Test');
    git(repoDir, 'config', 'commit.gpgsign', 'false');

    await writeFile(join(repoDir, 'README.md'), '# base\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'initial');

    git(repoDir, 'checkout', '-b', 'feature');
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it('returns empty result when base and head are identical', async () => {
    const result = await buildPrdValidatorDiff({ cwd: repoDir, baseRef: 'main' });
    expect(result.files.length).toBe(0);
    expect(result.renderedText.trim()).toBe('');
    expect(result.totalBytes).toBe(0);
    expect(result.summarizedCount).toBe(0);
  });

  it('renders small changesets verbatim', async () => {
    await writeFile(join(repoDir, 'foo.ts'), 'export const foo = 1;\n');
    await writeFile(join(repoDir, 'bar.ts'), 'export const bar = 2;\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'small');

    const result = await buildPrdValidatorDiff({ cwd: repoDir, baseRef: 'main' });

    expect(result.files.length).toBe(2);
    expect(result.summarizedCount).toBe(0);
    for (const f of result.files) {
      expect(f.summarized).toBe(false);
      expect(f.body).toContain('diff --git');
      expect(f.body).toContain('+export const');
    }
    expect(result.renderedText).toContain('export const foo');
    expect(result.renderedText).toContain('export const bar');
  });

  it('summarizes a file whose per-file diff exceeds the byte budget', async () => {
    const big = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n') + '\n';
    await writeFile(join(repoDir, 'big.ts'), big);
    await writeFile(join(repoDir, 'small.ts'), 'export const x = 1;\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'big + small');

    const result = await buildPrdValidatorDiff({
      cwd: repoDir,
      baseRef: 'main',
      perFileBudgetBytes: 500,
      maxChangedLinesBeforeSummary: 10_000,
    });

    const bigFile = result.files.find((f) => f.path === 'big.ts');
    const smallFile = result.files.find((f) => f.path === 'small.ts');
    expect(bigFile).toBeDefined();
    expect(bigFile!.summarized).toBe(true);
    expect(bigFile!.body).toContain('[summarized:');
    expect(smallFile).toBeDefined();
    expect(smallFile!.summarized).toBe(false);
    expect(result.summarizedCount).toBe(1);
  });

  it('summarizes a file whose changed-line count exceeds threshold', async () => {
    const many = Array.from({ length: 50 }, (_, i) => `entry ${i}`).join('\n') + '\n';
    await writeFile(join(repoDir, 'many.ts'), many);
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'many lines');

    const result = await buildPrdValidatorDiff({
      cwd: repoDir,
      baseRef: 'main',
      maxChangedLinesBeforeSummary: 10,
    });

    const manyFile = result.files.find((f) => f.path === 'many.ts');
    expect(manyFile).toBeDefined();
    expect(manyFile!.summarized).toBe(true);
    expect(manyFile!.body).toContain('[summarized:');
  });

  it('marks binary files name-only with no hunk content', async () => {
    // Write a file containing a null byte so git treats it as binary
    const bytes = Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0x10, 0x20]);
    writeFileSync(join(repoDir, 'blob.bin'), bytes);
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'binary');

    const result = await buildPrdValidatorDiff({ cwd: repoDir, baseRef: 'main' });

    const binFile = result.files.find((f) => f.path === 'blob.bin');
    expect(binFile).toBeDefined();
    expect(binFile!.binary).toBe(true);
    expect(binFile!.added).toBe(-1);
    expect(binFile!.deleted).toBe(-1);
    // No hunk content (no `@@` markers, no `+`/`-` diff lines)
    expect(binFile!.body).not.toContain('@@');
    expect(binFile!.body).toContain('[summarized:');
  });

  it('does not hide alphabetically-later source changes behind a large early file', async () => {
    // `aaa-huge.json` sorts before `zzz-real.ts`. In the legacy 80K-slice code
    // the real source file could be truncated away. With the per-file budget
    // it must still appear verbatim in renderedText.
    const huge = JSON.stringify(
      { data: Array.from({ length: 5000 }, (_, i) => ({ i, v: `padding-${i}` })) },
      null,
      2,
    );
    await writeFile(join(repoDir, 'aaa-huge.json'), huge);
    expect(huge.length).toBeGreaterThan(80_000);

    const realSource = [
      'export function importantFeature(input: string): string {',
      '  // Critical implementation the PRD validator must see.',
      '  return `processed: ${input}`;',
      '}',
      '',
    ].join('\n');
    await writeFile(join(repoDir, 'zzz-real.ts'), realSource);
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'huge + real');

    const result = await buildPrdValidatorDiff({ cwd: repoDir, baseRef: 'main' });

    const real = result.files.find((f) => f.path === 'zzz-real.ts');
    expect(real).toBeDefined();
    expect(real!.summarized).toBe(false);
    expect(real!.body).toContain('importantFeature');
    // And it shows up in the final rendered text
    expect(result.renderedText).toContain('importantFeature');
    // The huge file must be summarized (exceeds default per-file budget of 20K)
    const huge_ = result.files.find((f) => f.path === 'aaa-huge.json');
    expect(huge_).toBeDefined();
    expect(huge_!.summarized).toBe(true);
  });

  it('handles files in subdirectories', async () => {
    await mkdir(join(repoDir, 'src', 'engine'), { recursive: true });
    await writeFile(join(repoDir, 'src', 'engine', 'foo.ts'), 'export const foo = 1;\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'nested');

    const result = await buildPrdValidatorDiff({ cwd: repoDir, baseRef: 'main' });

    expect(result.files.length).toBe(1);
    expect(result.files[0].path).toBe('src/engine/foo.ts');
  });
});
