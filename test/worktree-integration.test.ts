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
  // --- eforge:region plan-02-policy-gate-engine-integration ---
  getNameStatusDiff,
  // --- eforge:endregion plan-02-policy-gate-engine-integration ---
} from '@eforge-build/engine/worktree-ops';

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

  // --- eforge:region plan-02-policy-gate-engine-integration ---
  it('computes git name-status diff summaries for added, modified, deleted, and renamed files', async () => {
    const baseDir = makeTempDir();
    const { repoRoot } = await setupRepo(baseDir);

    writeFileSync(join(repoRoot, 'modified.txt'), 'before\n');
    writeFileSync(join(repoRoot, 'deleted.txt'), 'delete me\n');
    writeFileSync(join(repoRoot, 'old-name.txt'), 'rename me\n');
    await exec('git', ['add', '.'], { cwd: repoRoot });
    await exec('git', ['commit', '-m', 'base files'], { cwd: repoRoot });

    await exec('git', ['checkout', '-b', 'eforge/diff-summary'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'added.txt'), 'added\n');
    writeFileSync(join(repoRoot, 'modified.txt'), 'after\n');
    await exec('git', ['rm', 'deleted.txt'], { cwd: repoRoot });
    await exec('git', ['mv', 'old-name.txt', 'new-name.txt'], { cwd: repoRoot });
    await exec('git', ['add', '.'], { cwd: repoRoot });
    await exec('git', ['commit', '-m', 'feature changes'], { cwd: repoRoot });
    await exec('git', ['checkout', 'main'], { cwd: repoRoot });

    const diff = await getNameStatusDiff(repoRoot, 'main', 'eforge/diff-summary');
    expect([...diff.files].sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'added.txt', status: 'added' },
      { path: 'deleted.txt', status: 'deleted' },
      { path: 'modified.txt', status: 'modified' },
      { path: 'new-name.txt', status: 'renamed' },
    ]);
  });
  // --- eforge:endregion plan-02-policy-gate-engine-integration ---

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

  it('mergeFeatureBranchToBase creates a --no-ff merge commit', async () => {
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

    // Merge feature branch back to base with --no-ff
    const commitMessage = 'feat(plan-01): feature merge';
    const sha = await mergeFeatureBranchToBase(
      repoRoot,
      featureBranch,
      baseBranch,
      commitMessage,
    );

    // --no-ff: SHA should differ from feature branch HEAD (it's a merge commit)
    expect(sha).not.toBe(featureSha.trim());

    // Verify merge commit has 2 parents
    const { stdout: commitInfo } = await exec('git', ['cat-file', '-p', 'HEAD'], { cwd: repoRoot });
    const parentLines = commitInfo.split('\n').filter((l: string) => l.startsWith('parent '));
    expect(parentLines).toHaveLength(2);

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

  it('mergeFeatureBranchToBase --no-ff preserves branch history with merge commit', async () => {
    const baseDir = makeTempDir();
    const featureBranch = 'eforge/feature-noff';
    const { repoRoot, baseBranch } = await setupRepo(baseDir, { featureBranch });
    const worktreeBase = join(baseDir, 'worktrees');

    // Create a merge worktree and make multiple commits on the feature branch
    const mergeWorktreePath = await createMergeWorktree(
      repoRoot,
      worktreeBase,
      featureBranch,
      baseBranch,
    );

    // Commit 1
    writeFileSync(join(mergeWorktreePath, 'file1.txt'), 'first file\n');
    await exec('git', ['add', '.'], { cwd: mergeWorktreePath });
    await exec('git', ['commit', '-m', 'builder: implement feature'], { cwd: mergeWorktreePath });

    // Commit 2
    writeFileSync(join(mergeWorktreePath, 'file2.txt'), 'second file\n');
    await exec('git', ['add', '.'], { cwd: mergeWorktreePath });
    await exec('git', ['commit', '-m', 'reviewer: apply fixes'], { cwd: mergeWorktreePath });

    // Commit 3
    writeFileSync(join(mergeWorktreePath, 'file3.txt'), 'third file\n');
    await exec('git', ['add', '.'], { cwd: mergeWorktreePath });
    await exec('git', ['commit', '-m', 'validation-fixer: fix validation'], { cwd: mergeWorktreePath });

    // Remove merge worktree before merging to base
    await removeWorktree(repoRoot, mergeWorktreePath);

    // --no-ff merge with a commit message
    const commitMessage = 'feat(plan-01): My feature\n\nCo-Authored-By: forged-by-eforge <noreply@eforge.build>';
    const sha = await mergeFeatureBranchToBase(
      repoRoot,
      featureBranch,
      baseBranch,
      commitMessage,
    );

    expect(sha).toBeTruthy();

    // Verify all files exist on base branch
    const { stdout: files } = await exec('git', ['ls-files'], { cwd: repoRoot });
    expect(files).toContain('file1.txt');
    expect(files).toContain('file2.txt');
    expect(files).toContain('file3.txt');

    // Verify merge commit at HEAD with 2 parents
    const { stdout: commitInfo } = await exec('git', ['cat-file', '-p', 'HEAD'], { cwd: repoRoot });
    const parentLines = commitInfo.split('\n').filter((l: string) => l.startsWith('parent '));
    expect(parentLines).toHaveLength(2);

    // First-parent history should show 2 commits (initial + merge)
    const { stdout: firstParentLog } = await exec('git', ['log', '--first-parent', '--oneline'], { cwd: repoRoot });
    const firstParentCommits = firstParentLog.trim().split('\n');
    expect(firstParentCommits).toHaveLength(2);

    // Full log should show all individual commits
    const { stdout: fullLog } = await exec('git', ['log', '--oneline'], { cwd: repoRoot });
    expect(fullLog).toContain('builder: implement feature');
    expect(fullLog).toContain('reviewer: apply fixes');
    expect(fullLog).toContain('validation-fixer: fix validation');

    // Verify commit message
    const { stdout: lastMsg } = await exec('git', ['log', '-1', '--format=%B'], { cwd: repoRoot });
    expect(lastMsg.trim()).toContain('feat(plan-01): My feature');
    expect(lastMsg.trim()).toContain('Co-Authored-By: forged-by-eforge');
  });

  it('mergeFeatureBranchToBase --no-ff preserves individual commits in full log', async () => {
    const baseDir = makeTempDir();
    const featureBranch = 'eforge/feature-no-squash';
    const { repoRoot, baseBranch } = await setupRepo(baseDir, { featureBranch });
    const worktreeBase = join(baseDir, 'worktrees');

    // Create a merge worktree and make multiple commits
    const mergeWorktreePath = await createMergeWorktree(
      repoRoot,
      worktreeBase,
      featureBranch,
      baseBranch,
    );

    writeFileSync(join(mergeWorktreePath, 'a.txt'), 'a\n');
    await exec('git', ['add', '.'], { cwd: mergeWorktreePath });
    await exec('git', ['commit', '-m', 'commit A'], { cwd: mergeWorktreePath });

    writeFileSync(join(mergeWorktreePath, 'b.txt'), 'b\n');
    await exec('git', ['add', '.'], { cwd: mergeWorktreePath });
    await exec('git', ['commit', '-m', 'commit B'], { cwd: mergeWorktreePath });

    await removeWorktree(repoRoot, mergeWorktreePath);

    // --no-ff merge creates a merge commit
    const commitMessage = 'feat(plan-01): merge feature';
    const sha = await mergeFeatureBranchToBase(
      repoRoot,
      featureBranch,
      baseBranch,
      commitMessage,
    );

    expect(sha).toBeTruthy();

    // Verify merge commit at HEAD with 2 parents
    const { stdout: commitInfo } = await exec('git', ['cat-file', '-p', 'HEAD'], { cwd: repoRoot });
    const parentLines = commitInfo.split('\n').filter((l: string) => l.startsWith('parent '));
    expect(parentLines).toHaveLength(2);

    // Individual commits are preserved in full log
    const { stdout: log } = await exec('git', ['log', '--oneline'], { cwd: repoRoot });
    expect(log).toContain('commit A');
    expect(log).toContain('commit B');
  });

  it('mergeFeatureBranchToBase --no-ff with conflict invokes resolver', async () => {
    const baseDir = makeTempDir();
    const featureBranch = 'eforge/feature-noff-conflict';
    const { repoRoot, baseBranch } = await setupRepo(baseDir);

    // Make a commit on main that will conflict
    writeFileSync(join(repoRoot, 'shared.txt'), 'main content\n');
    await exec('git', ['add', '.'], { cwd: repoRoot });
    await exec('git', ['commit', '-m', 'add shared.txt on main'], { cwd: repoRoot });

    // Create feature branch from main, then diverge
    await exec('git', ['checkout', '-b', featureBranch], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'shared.txt'), 'feature content\n');
    writeFileSync(join(repoRoot, 'feature-only.txt'), 'only in feature\n');
    await exec('git', ['add', '.'], { cwd: repoRoot });
    await exec('git', ['commit', '-m', 'feature changes'], { cwd: repoRoot });

    // Go back to main and make a conflicting change
    await exec('git', ['checkout', baseBranch], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'shared.txt'), 'main diverged content\n');
    await exec('git', ['add', '.'], { cwd: repoRoot });
    await exec('git', ['commit', '-m', 'main diverged'], { cwd: repoRoot });

    // Now --no-ff merge should conflict
    let resolverCalled = false;
    const resolver = async (cwd: string, conflict: { conflictedFiles: string[] }) => {
      resolverCalled = true;
      expect(conflict.conflictedFiles).toContain('shared.txt');

      // Resolve by writing merged content
      writeFileSync(join(cwd, 'shared.txt'), 'resolved content\n');
      await exec('git', ['add', 'shared.txt'], { cwd });
      return true;
    };

    const commitMessage = 'feat(plan-01): merged with resolution';
    const sha = await mergeFeatureBranchToBase(
      repoRoot,
      featureBranch,
      baseBranch,
      commitMessage,
      resolver,
    );

    expect(resolverCalled).toBe(true);
    expect(sha).toBeTruthy();

    // Verify merge commit has 2 parents
    const { stdout: commitInfo } = await exec('git', ['cat-file', '-p', 'HEAD'], { cwd: repoRoot });
    const parentLines = commitInfo.split('\n').filter((l: string) => l.startsWith('parent '));
    expect(parentLines).toHaveLength(2);

    // Verify resolved content
    const { stdout: content } = await exec('git', ['show', 'HEAD:shared.txt'], { cwd: repoRoot });
    expect(content).toBe('resolved content\n');

    // Verify feature-only file is present
    const { stdout: files } = await exec('git', ['ls-files'], { cwd: repoRoot });
    expect(files).toContain('feature-only.txt');
  });

  it('mergeFeatureBranchToBase --no-ff resets on failure without resolver', async () => {
    const baseDir = makeTempDir();
    const featureBranch = 'eforge/feature-noff-fail';
    const { repoRoot, baseBranch } = await setupRepo(baseDir);

    // Make a commit on main
    writeFileSync(join(repoRoot, 'shared.txt'), 'main content\n');
    await exec('git', ['add', '.'], { cwd: repoRoot });
    await exec('git', ['commit', '-m', 'add shared on main'], { cwd: repoRoot });

    // Create feature branch and diverge
    await exec('git', ['checkout', '-b', featureBranch], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'shared.txt'), 'feature content\n');
    await exec('git', ['add', '.'], { cwd: repoRoot });
    await exec('git', ['commit', '-m', 'feature changes'], { cwd: repoRoot });

    await exec('git', ['checkout', baseBranch], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'shared.txt'), 'main diverged\n');
    await exec('git', ['add', '.'], { cwd: repoRoot });
    await exec('git', ['commit', '-m', 'main diverged'], { cwd: repoRoot });

    // --no-ff merge without resolver - should fail and reset
    const commitMessage = 'feat(plan-01): should fail';
    await expect(
      mergeFeatureBranchToBase(
        repoRoot,
        featureBranch,
        baseBranch,
        commitMessage,
        undefined,
      ),
    ).rejects.toThrow();

    // Verify the merge state was reset (no conflict markers left)
    const { stdout: status } = await exec('git', ['status', '--porcelain'], { cwd: repoRoot });
    expect(status.trim()).toBe('');
  });
});
