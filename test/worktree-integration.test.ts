import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { useTempDir } from './test-tmpdir.js';
import {
  computeWorktreeBase,
  createWorktree,
  removeWorktree,
  mergeWorktree,
  createMergeWorktree,
  mergeFeatureBranchToBase,
  cleanupWorktrees,
} from '../src/engine/worktree.js';

const exec = promisify(execFile);

/**
 * Initialize a git repo with an initial commit on `main`,
 * then optionally create a feature branch from main.
 * Returns `{ repoRoot, baseBranch }` with cwd on baseBranch.
 */
async function setupRepo(
  baseDir: string,
  opts: { featureBranch?: string } = {},
): Promise<{ repoRoot: string; baseBranch: string }> {
  const repoRoot = join(baseDir, 'repo');

  await exec('git', ['init', repoRoot]);
  await exec('git', ['config', 'user.email', 'test@test.com'], { cwd: repoRoot });
  await exec('git', ['config', 'user.name', 'Test'], { cwd: repoRoot });
  writeFileSync(join(repoRoot, 'README.md'), '# init\n');
  await exec('git', ['add', '.'], { cwd: repoRoot });
  await exec('git', ['commit', '-m', 'initial commit'], { cwd: repoRoot });

  // Rename default branch to 'main' for consistency
  await exec('git', ['branch', '-M', 'main'], { cwd: repoRoot });

  if (opts.featureBranch) {
    await exec('git', ['checkout', '-b', opts.featureBranch], { cwd: repoRoot });
    // Go back to main so the repo root stays on baseBranch
    await exec('git', ['checkout', 'main'], { cwd: repoRoot });
  }

  return { repoRoot, baseBranch: 'main' };
}

describe('worktree integration', () => {
  const makeTempDir = useTempDir('eforge-worktree-int-');

  it('computeWorktreeBase returns sibling directory with project name and set name', () => {
    const base = computeWorktreeBase('/home/user/projects/my-app', 'plan-set-1');
    expect(base).toBe('/home/user/projects/my-app-plan-set-1-worktrees');
  });

  it('createWorktree creates a new worktree and returns its path', async () => {
    const baseDir = makeTempDir();
    const { repoRoot, baseBranch } = await setupRepo(baseDir);
    const worktreeBase = join(baseDir, 'worktrees');
    const branch = 'eforge/plan-01';

    const worktreePath = await createWorktree(repoRoot, worktreeBase, branch, baseBranch);

    // Verify worktree path exists
    expect(existsSync(worktreePath)).toBe(true);

    // Verify the worktree is on the correct branch
    const { stdout: currentBranch } = await exec('git', ['branch', '--show-current'], {
      cwd: worktreePath,
    });
    expect(currentBranch.trim()).toBe(branch);

    // Verify git worktree list shows it
    const { stdout: worktreeList } = await exec('git', ['worktree', 'list'], { cwd: repoRoot });
    expect(worktreeList).toContain(branch);
  });

  it('createWorktree resumes when branch already exists', async () => {
    const baseDir = makeTempDir();
    const { repoRoot, baseBranch } = await setupRepo(baseDir);
    const worktreeBase = join(baseDir, 'worktrees');
    const branch = 'eforge/plan-01';

    // First call creates the worktree
    const path1 = await createWorktree(repoRoot, worktreeBase, branch, baseBranch);

    // Commit something so the branch has unique content
    writeFileSync(join(path1, 'file.txt'), 'work in progress\n');
    await exec('git', ['add', '.'], { cwd: path1 });
    await exec('git', ['commit', '-m', 'wip'], { cwd: path1 });

    // Remove the worktree but keep the branch
    await removeWorktree(repoRoot, path1);

    // Second call should resume with the existing branch (no error)
    const path2 = await createWorktree(repoRoot, worktreeBase, branch, baseBranch);

    expect(existsSync(path2)).toBe(true);

    // Verify the previously committed file is present (branch was reused)
    const { stdout: files } = await exec('git', ['ls-files'], { cwd: path2 });
    expect(files).toContain('file.txt');
  });

  it('removeWorktree removes the worktree and cleans up', async () => {
    const baseDir = makeTempDir();
    const { repoRoot, baseBranch } = await setupRepo(baseDir);
    const worktreeBase = join(baseDir, 'worktrees');
    const branch = 'eforge/plan-rm';

    const worktreePath = await createWorktree(repoRoot, worktreeBase, branch, baseBranch);
    expect(existsSync(worktreePath)).toBe(true);

    await removeWorktree(repoRoot, worktreePath);

    // Worktree directory should be gone
    expect(existsSync(worktreePath)).toBe(false);

    // git worktree list should not contain the branch
    const { stdout: worktreeList } = await exec('git', ['worktree', 'list'], { cwd: repoRoot });
    expect(worktreeList).not.toContain(branch);
  });

  it('multi-plan: two plan worktrees merge into a feature branch', async () => {
    const baseDir = makeTempDir();
    const featureBranch = 'eforge/feature';
    const { repoRoot, baseBranch } = await setupRepo(baseDir, { featureBranch });
    const worktreeBase = join(baseDir, 'worktrees');

    // Create a merge worktree on the feature branch
    const mergeWorktreePath = await createMergeWorktree(
      repoRoot,
      worktreeBase,
      featureBranch,
      baseBranch,
    );
    expect(existsSync(mergeWorktreePath)).toBe(true);

    // Create two plan worktrees branching from the feature branch
    const plan1Branch = 'eforge/plan-01';
    const plan2Branch = 'eforge/plan-02';
    const plan1Path = await createWorktree(repoRoot, worktreeBase, plan1Branch, featureBranch);
    const plan2Path = await createWorktree(repoRoot, worktreeBase, plan2Branch, featureBranch);

    // Commit on plan-01
    writeFileSync(join(plan1Path, 'plan1.txt'), 'plan 1 changes\n');
    await exec('git', ['add', '.'], { cwd: plan1Path });
    await exec('git', ['commit', '-m', 'plan 1 implementation'], { cwd: plan1Path });

    // Commit on plan-02
    writeFileSync(join(plan2Path, 'plan2.txt'), 'plan 2 changes\n');
    await exec('git', ['add', '.'], { cwd: plan2Path });
    await exec('git', ['commit', '-m', 'plan 2 implementation'], { cwd: plan2Path });

    // Squash-merge both plans into the feature branch via the merge worktree
    await mergeWorktree(mergeWorktreePath, plan1Branch, featureBranch, 'merge plan-01');
    await mergeWorktree(mergeWorktreePath, plan2Branch, featureBranch, 'merge plan-02');

    // Verify both files exist on the feature branch
    const { stdout: files } = await exec('git', ['ls-files'], { cwd: mergeWorktreePath });
    expect(files).toContain('plan1.txt');
    expect(files).toContain('plan2.txt');

    // Verify commit history on feature branch has both merge commits
    const { stdout: log } = await exec('git', ['log', '--oneline'], { cwd: mergeWorktreePath });
    expect(log).toContain('merge plan-01');
    expect(log).toContain('merge plan-02');
  });

  it('mergeFeatureBranchToBase fast-forwards base branch', async () => {
    const baseDir = makeTempDir();
    const featureBranch = 'eforge/feature';
    const { repoRoot, baseBranch } = await setupRepo(baseDir, { featureBranch });
    const worktreeBase = join(baseDir, 'worktrees');

    // Create a merge worktree and commit on the feature branch
    const mergeWorktreePath = await createMergeWorktree(
      repoRoot,
      worktreeBase,
      featureBranch,
      baseBranch,
    );

    writeFileSync(join(mergeWorktreePath, 'feature.txt'), 'feature work\n');
    await exec('git', ['add', '.'], { cwd: mergeWorktreePath });
    await exec('git', ['commit', '-m', 'feature commit'], { cwd: mergeWorktreePath });

    const { stdout: featureSha } = await exec('git', ['rev-parse', 'HEAD'], {
      cwd: mergeWorktreePath,
    });

    // Remove merge worktree before merging to base (avoids branch conflicts)
    await removeWorktree(repoRoot, mergeWorktreePath);

    // Merge feature branch back to base
    const sha = await mergeFeatureBranchToBase(
      repoRoot,
      featureBranch,
      baseBranch,
      worktreeBase,
    );

    // Fast-forward: SHA should match the feature branch HEAD
    expect(sha).toBe(featureSha.trim());

    // Verify file exists on base branch
    const { stdout: files } = await exec('git', ['ls-files'], { cwd: repoRoot });
    expect(files).toContain('feature.txt');
  });

  it('cleanupWorktrees removes all worktrees and the base directory', async () => {
    const baseDir = makeTempDir();
    const { repoRoot, baseBranch } = await setupRepo(baseDir);
    const worktreeBase = join(baseDir, 'worktrees');
    const plan1Branch = 'eforge/plan-cleanup-1';
    const plan2Branch = 'eforge/plan-cleanup-2';

    // Create two worktrees
    const path1 = await createWorktree(repoRoot, worktreeBase, plan1Branch, baseBranch);
    const path2 = await createWorktree(repoRoot, worktreeBase, plan2Branch, baseBranch);
    expect(existsSync(path1)).toBe(true);
    expect(existsSync(path2)).toBe(true);

    // Remove worktrees from git first (cleanupWorktrees only prunes + removes dir)
    await removeWorktree(repoRoot, path1);
    await removeWorktree(repoRoot, path2);

    // Delete plan branches
    await exec('git', ['branch', '-D', plan1Branch], { cwd: repoRoot });
    await exec('git', ['branch', '-D', plan2Branch], { cwd: repoRoot });

    // Now clean up
    await cleanupWorktrees(repoRoot, worktreeBase);

    // Verify worktree base directory is gone
    expect(existsSync(worktreeBase)).toBe(false);

    // Verify git worktree list shows only the main worktree
    const { stdout: worktreeList } = await exec('git', ['worktree', 'list'], { cwd: repoRoot });
    const lines = worktreeList.trim().split('\n');
    expect(lines).toHaveLength(1);

    // Verify plan branches are deleted
    const { stdout: branches } = await exec('git', ['branch', '--list'], { cwd: repoRoot });
    expect(branches).not.toContain(plan1Branch);
    expect(branches).not.toContain(plan2Branch);
  });

  it('mergeWorktree with conflict invokes MergeResolver', async () => {
    const baseDir = makeTempDir();
    const { repoRoot, baseBranch } = await setupRepo(baseDir);
    const worktreeBase = join(baseDir, 'worktrees');
    const featureBranch = 'eforge/feature-conflict';
    const planBranch = 'eforge/plan-conflict';

    // Create feature branch worktree and add a file
    const featurePath = await createWorktree(repoRoot, worktreeBase, featureBranch, baseBranch);
    writeFileSync(join(featurePath, 'shared.txt'), 'line from feature\n');
    await exec('git', ['add', '.'], { cwd: featurePath });
    await exec('git', ['commit', '-m', 'feature edits shared.txt'], { cwd: featurePath });

    // Create plan branch from base (not feature), so it doesn't have feature's changes
    const planPath = await createWorktree(repoRoot, worktreeBase, planBranch, baseBranch);
    writeFileSync(join(planPath, 'shared.txt'), 'line from plan\n');
    await exec('git', ['add', '.'], { cwd: planPath });
    await exec('git', ['commit', '-m', 'plan edits shared.txt'], { cwd: planPath });

    // Now merge feature branch into base so that `shared.txt` exists on feature branch
    // We'll use the feature worktree as the merge target
    // First, merge feature into base so base has the file
    await removeWorktree(repoRoot, featurePath);
    await exec('git', ['merge', '--ff-only', featureBranch], { cwd: repoRoot });

    // Remove plan worktree so we can work with branches directly
    await removeWorktree(repoRoot, planPath);

    // Create a merge worktree on featureBranch for the squash merge
    const mergeWorktreePath = await createMergeWorktree(
      repoRoot,
      worktreeBase,
      'eforge/merge-target',
      baseBranch,
    );

    // Now squash-merge planBranch into merge-target - this will conflict on shared.txt
    let resolverCalled = false;
    const resolver = async (cwd: string, conflict: { conflictedFiles: string[] }) => {
      resolverCalled = true;
      expect(conflict.conflictedFiles).toContain('shared.txt');

      // Resolve by picking plan's version
      writeFileSync(join(cwd, 'shared.txt'), 'resolved content\n');
      await exec('git', ['add', 'shared.txt'], { cwd });
      return true;
    };

    await mergeWorktree(
      mergeWorktreePath,
      planBranch,
      'eforge/merge-target',
      'merge plan with conflict resolution',
      resolver,
    );

    expect(resolverCalled).toBe(true);

    // Verify the merge commit exists
    const { stdout: log } = await exec('git', ['log', '--oneline'], { cwd: mergeWorktreePath });
    expect(log).toContain('merge plan with conflict resolution');

    // Verify resolved content
    const { stdout: content } = await exec('git', ['show', 'HEAD:shared.txt'], {
      cwd: mergeWorktreePath,
    });
    expect(content).toBe('resolved content\n');
  });

  it('createMergeWorktree resumes when feature branch already exists', async () => {
    const baseDir = makeTempDir();
    const featureBranch = 'eforge/feature-resume';
    const { repoRoot, baseBranch } = await setupRepo(baseDir, { featureBranch });
    const worktreeBase = join(baseDir, 'worktrees');

    // First call creates the merge worktree
    const path1 = await createMergeWorktree(repoRoot, worktreeBase, featureBranch, baseBranch);
    expect(existsSync(path1)).toBe(true);

    // Commit something on the feature branch
    writeFileSync(join(path1, 'progress.txt'), 'some progress\n');
    await exec('git', ['add', '.'], { cwd: path1 });
    await exec('git', ['commit', '-m', 'progress'], { cwd: path1 });

    // Remove the worktree but keep the branch
    await removeWorktree(repoRoot, path1);

    // Second call should resume with the existing branch
    const path2 = await createMergeWorktree(repoRoot, worktreeBase, featureBranch, baseBranch);
    expect(existsSync(path2)).toBe(true);

    // Verify previously committed file is present
    const { stdout: files } = await exec('git', ['ls-files'], { cwd: path2 });
    expect(files).toContain('progress.txt');
  });
});
