import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { forgeCommit, ATTRIBUTION } from '@eforge-build/engine/git';
import { useTempDir } from './test-tmpdir.js';

const exec = promisify(execFile);

/**
 * Initialize a git repo with an initial commit on `main`.
 * Returns the repo root path.
 */
async function initRepo(dir: string): Promise<string> {
  const repoRoot = join(dir, 'repo');
  await exec('git', ['init', repoRoot]);
  await exec('git', ['config', 'user.email', 'test@eforge.build'], { cwd: repoRoot });
  await exec('git', ['config', 'user.name', 'eforge-test'], { cwd: repoRoot });
  await writeFile(join(repoRoot, 'README.md'), '# init\n');
  await exec('git', ['add', '.'], { cwd: repoRoot });
  await exec('git', ['commit', '-m', 'initial commit'], { cwd: repoRoot });
  await exec('git', ['branch', '-M', 'main'], { cwd: repoRoot });
  return repoRoot;
}

/**
 * Get the full commit message of the most recent commit.
 */
async function lastCommitMessage(cwd: string): Promise<string> {
  const { stdout } = await exec('git', ['log', '-1', '--format=%B'], { cwd });
  return stdout.trim();
}

describe('forgeCommit', () => {
  const makeTempDir = useTempDir('eforge-forge-commit-');

  it('standard commit: appends attribution trailer to commit message', async () => {
    const baseDir = makeTempDir();
    const repoRoot = await initRepo(baseDir);

    await writeFile(join(repoRoot, 'feature.txt'), 'feature content\n');
    await exec('git', ['add', '.'], { cwd: repoRoot });

    await forgeCommit(repoRoot, 'feat: add feature');

    const msg = await lastCommitMessage(repoRoot);
    expect(msg).toContain('feat: add feature');
    expect(msg).toContain(ATTRIBUTION);
  });

  it('commit with paths option: stages specified paths and appends attribution', async () => {
    const baseDir = makeTempDir();
    const repoRoot = await initRepo(baseDir);

    // Write two files but only stage one via paths
    await writeFile(join(repoRoot, 'tracked.txt'), 'tracked\n');
    await writeFile(join(repoRoot, 'untracked.txt'), 'untracked\n');
    await exec('git', ['add', 'tracked.txt'], { cwd: repoRoot });

    await forgeCommit(repoRoot, 'chore: add tracked file', { paths: ['tracked.txt'] });

    const msg = await lastCommitMessage(repoRoot);
    expect(msg).toContain('chore: add tracked file');
    expect(msg).toContain(ATTRIBUTION);

    // The committed tree should contain tracked.txt
    const { stdout: files } = await exec('git', ['ls-files'], { cwd: repoRoot });
    expect(files).toContain('tracked.txt');
  });

  it('reuseMessage mode: rewrites MERGE_MSG with attribution and commits via --no-edit', async () => {
    const baseDir = makeTempDir();
    const repoRoot = await initRepo(baseDir);

    // Create a feature branch with a unique file
    await exec('git', ['checkout', '-b', 'feature'], { cwd: repoRoot });
    await writeFile(join(repoRoot, 'feature.txt'), 'feature work\n');
    await exec('git', ['add', '.'], { cwd: repoRoot });
    await exec('git', ['commit', '-m', 'feat: feature work'], { cwd: repoRoot });

    // Go back to main and also modify a different file so branches truly diverge
    await exec('git', ['checkout', 'main'], { cwd: repoRoot });
    await writeFile(join(repoRoot, 'main-change.txt'), 'main change\n');
    await exec('git', ['add', '.'], { cwd: repoRoot });
    await exec('git', ['commit', '-m', 'chore: main side change'], { cwd: repoRoot });

    // Start a --no-ff --no-commit merge to put the repo in "merge in progress" state.
    // This creates MERGE_MSG without auto-committing.
    await exec('git', ['merge', '--no-ff', '--no-commit', 'feature'], { cwd: repoRoot });

    // Call forgeCommit with reuseMessage: true
    await forgeCommit(repoRoot, undefined, { reuseMessage: true });

    const msg = await lastCommitMessage(repoRoot);
    // The message should include the original merge message text
    expect(msg).toContain("Merge branch 'feature'");
    // And it must have the attribution trailer
    expect(msg).toContain(ATTRIBUTION);

    // Both files should exist on main
    const { stdout: files } = await exec('git', ['ls-files'], { cwd: repoRoot });
    expect(files).toContain('feature.txt');
    expect(files).toContain('main-change.txt');
  });
});
