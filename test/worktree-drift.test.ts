import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { useTempDir } from './test-tmpdir.js';
import { recoverDriftedWorktree } from '../src/engine/worktree.js';

const exec = promisify(execFile);

/**
 * Initialize a bare git repo + working clone with an initial commit,
 * then create and checkout a feature branch.
 * Returns the working clone path (already on `featureBranch`).
 */
async function setupRepo(baseDir: string, featureBranch: string): Promise<string> {
  const repoPath = join(baseDir, 'repo');

  // Init repo with an initial commit
  await exec('git', ['init', repoPath]);
  await exec('git', ['config', 'user.email', 'test@test.com'], { cwd: repoPath });
  await exec('git', ['config', 'user.name', 'Test'], { cwd: repoPath });
  writeFileSync(join(repoPath, 'README.md'), '# init\n');
  await exec('git', ['add', '.'], { cwd: repoPath });
  await exec('git', ['commit', '-m', 'initial commit'], { cwd: repoPath });

  // Create and checkout the feature branch
  await exec('git', ['checkout', '-b', featureBranch], { cwd: repoPath });

  return repoPath;
}

describe('recoverDriftedWorktree', () => {
  const makeTempDir = useTempDir('eforge-drift-');

  it('is a no-op when already on the expected branch', async () => {
    const baseDir = makeTempDir();
    const featureBranch = 'eforge/my-feature';
    const repoPath = await setupRepo(baseDir, featureBranch);

    // Add a commit on the feature branch
    writeFileSync(join(repoPath, 'feature.txt'), 'feature work\n');
    await exec('git', ['add', '.'], { cwd: repoPath });
    await exec('git', ['commit', '-m', 'feature work'], { cwd: repoPath });

    const { stdout: shaBefore } = await exec('git', ['rev-parse', 'HEAD'], { cwd: repoPath });

    // Should be a no-op
    await recoverDriftedWorktree(repoPath, featureBranch, 'recover drift');

    // Verify still on the same branch and same commit
    const { stdout: branchAfter } = await exec('git', ['branch', '--show-current'], { cwd: repoPath });
    expect(branchAfter.trim()).toBe(featureBranch);

    const { stdout: shaAfter } = await exec('git', ['rev-parse', 'HEAD'], { cwd: repoPath });
    expect(shaAfter.trim()).toBe(shaBefore.trim());
  });

  it('recovers when builder drifted to a different named branch', async () => {
    const baseDir = makeTempDir();
    const featureBranch = 'eforge/my-feature';
    const repoPath = await setupRepo(baseDir, featureBranch);

    // Simulate builder drifting to a different branch
    const driftBranch = 'plan-01/implementation';
    await exec('git', ['checkout', '-b', driftBranch], { cwd: repoPath });

    // Add a commit on the drifted branch
    writeFileSync(join(repoPath, 'impl.txt'), 'implementation work\n');
    await exec('git', ['add', '.'], { cwd: repoPath });
    await exec('git', ['commit', '-m', 'impl work on wrong branch'], { cwd: repoPath });

    // Recover
    await recoverDriftedWorktree(repoPath, featureBranch, 'recover: squash drift');

    // Verify we're back on the feature branch
    const { stdout: branchAfter } = await exec('git', ['branch', '--show-current'], { cwd: repoPath });
    expect(branchAfter.trim()).toBe(featureBranch);

    // Verify the drifted file is present on the feature branch
    const { stdout: files } = await exec('git', ['ls-files'], { cwd: repoPath });
    expect(files).toContain('impl.txt');
  });

  it('recovers when builder is in detached HEAD state', async () => {
    const baseDir = makeTempDir();
    const featureBranch = 'eforge/my-feature';
    const repoPath = await setupRepo(baseDir, featureBranch);

    // Add a commit, then detach HEAD
    writeFileSync(join(repoPath, 'detached.txt'), 'detached work\n');
    await exec('git', ['add', '.'], { cwd: repoPath });
    await exec('git', ['commit', '-m', 'detached commit'], { cwd: repoPath });
    const { stdout: detachedSha } = await exec('git', ['rev-parse', 'HEAD'], { cwd: repoPath });
    await exec('git', ['checkout', '--detach'], { cwd: repoPath });

    // Verify we're actually detached
    const { stdout: branchBefore } = await exec('git', ['branch', '--show-current'], { cwd: repoPath });
    expect(branchBefore.trim()).toBe('');

    // Recover
    await recoverDriftedWorktree(repoPath, featureBranch, 'recover: detached HEAD');

    // Verify we're back on the feature branch
    const { stdout: branchAfter } = await exec('git', ['branch', '--show-current'], { cwd: repoPath });
    expect(branchAfter.trim()).toBe(featureBranch);

    // Verify the detached file is present on the feature branch
    const { stdout: files } = await exec('git', ['ls-files'], { cwd: repoPath });
    expect(files).toContain('detached.txt');
  });
});
