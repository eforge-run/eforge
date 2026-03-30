import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { useTempDir } from './test-tmpdir.js';
import { WorktreeManager } from '../src/engine/worktree-manager.js';
import { createMergeWorktree } from '../src/engine/worktree-ops.js';
import type { EforgeState } from '../src/engine/events.js';

const exec = promisify(execFile);

/**
 * Initialize a git repo with an initial commit on `main`,
 * create a merge worktree on a feature branch, and return
 * everything needed to construct a WorktreeManager.
 */
async function setupRepoWithMergeWorktree(
  baseDir: string,
  setName: string = 'test-set',
): Promise<{
  repoRoot: string;
  baseBranch: string;
  featureBranch: string;
  worktreeBase: string;
  mergeWorktreePath: string;
}> {
  const repoRoot = join(baseDir, 'repo');
  const baseBranch = 'main';
  const featureBranch = `eforge/${setName}`;
  const worktreeBase = join(baseDir, 'worktrees');

  await exec('git', ['init', repoRoot]);
  await exec('git', ['config', 'user.email', 'test@test.com'], { cwd: repoRoot });
  await exec('git', ['config', 'user.name', 'Test'], { cwd: repoRoot });
  writeFileSync(join(repoRoot, 'README.md'), '# init\n');
  await exec('git', ['add', '.'], { cwd: repoRoot });
  await exec('git', ['commit', '-m', 'initial commit'], { cwd: repoRoot });
  await exec('git', ['branch', '-M', 'main'], { cwd: repoRoot });

  const mergeWorktreePath = await createMergeWorktree(
    repoRoot,
    worktreeBase,
    featureBranch,
    baseBranch,
  );

  return { repoRoot, baseBranch, featureBranch, worktreeBase, mergeWorktreePath };
}

function makeState(
  overrides: Partial<EforgeState> & { plans: EforgeState['plans'] },
): EforgeState {
  return {
    setName: 'test-set',
    status: 'running',
    startedAt: '2026-01-01T00:00:00Z',
    baseBranch: 'main',
    worktreeBase: '/tmp/worktrees',
    plans: overrides.plans,
    completedPlans: [],
    ...overrides,
  };
}

describe('WorktreeManager.reconcile', () => {
  const makeTempDir = useTempDir('eforge-reconcile-');

  it('reports all valid when worktrees exist and are on correct branches', async () => {
    const baseDir = makeTempDir();
    const { repoRoot, featureBranch, worktreeBase, mergeWorktreePath } =
      await setupRepoWithMergeWorktree(baseDir);

    const wm = new WorktreeManager({ repoRoot, worktreeBase, featureBranch, mergeWorktreePath });

    // Create a plan worktree
    const planBranch = 'eforge/plan-01';
    const planWorktreePath = await wm.acquireForPlan('plan-01', planBranch, true);

    const state = makeState({
      mergeWorktreePath,
      worktreeBase,
      featureBranch,
      plans: {
        'plan-01': {
          status: 'running',
          branch: planBranch,
          dependsOn: [],
          merged: false,
          worktreePath: planWorktreePath,
        },
      },
    });

    const report = await wm.reconcile(state);

    expect(report.valid).toContain('__merge__');
    expect(report.valid).toContain('plan-01');
    expect(report.missing).toEqual([]);
    expect(report.corrupt).toEqual([]);
    expect(report.cleared).toEqual([]);
    // State should be unchanged
    expect(state.mergeWorktreePath).toBe(mergeWorktreePath);
    expect(state.plans['plan-01'].worktreePath).toBe(planWorktreePath);
  });

  it('detects missing worktree and clears worktreePath in state', async () => {
    const baseDir = makeTempDir();
    const { repoRoot, featureBranch, worktreeBase, mergeWorktreePath } =
      await setupRepoWithMergeWorktree(baseDir);

    const wm = new WorktreeManager({ repoRoot, worktreeBase, featureBranch, mergeWorktreePath });

    // Create a plan worktree, then delete its directory
    const planBranch = 'eforge/plan-01';
    const planWorktreePath = await wm.acquireForPlan('plan-01', planBranch, true);
    rmSync(planWorktreePath, { recursive: true, force: true });

    const state = makeState({
      mergeWorktreePath,
      worktreeBase,
      featureBranch,
      plans: {
        'plan-01': {
          status: 'running',
          branch: planBranch,
          dependsOn: [],
          merged: false,
          worktreePath: planWorktreePath,
        },
      },
    });

    const report = await wm.reconcile(state);

    expect(report.missing).toContain('plan-01');
    expect(report.cleared).toContain('plan-01');
    expect(report.valid).not.toContain('plan-01');
    // State should have worktreePath cleared and status reset to pending
    expect(state.plans['plan-01'].worktreePath).toBeUndefined();
    expect(state.plans['plan-01'].status).toBe('pending');
  });

  it('detects corrupt worktree (wrong branch) and clears worktreePath', async () => {
    const baseDir = makeTempDir();
    const { repoRoot, featureBranch, worktreeBase, mergeWorktreePath } =
      await setupRepoWithMergeWorktree(baseDir);

    const wm = new WorktreeManager({ repoRoot, worktreeBase, featureBranch, mergeWorktreePath });

    // Create a plan worktree
    const planBranch = 'eforge/plan-01';
    const planWorktreePath = await wm.acquireForPlan('plan-01', planBranch, true);

    // Corrupt the worktree by checking out a different branch
    await exec('git', ['checkout', '-b', 'wrong-branch'], { cwd: planWorktreePath });

    const state = makeState({
      mergeWorktreePath,
      worktreeBase,
      featureBranch,
      plans: {
        'plan-01': {
          status: 'running',
          branch: planBranch,
          dependsOn: [],
          merged: false,
          worktreePath: planWorktreePath,
        },
      },
    });

    const report = await wm.reconcile(state);

    expect(report.corrupt).toContain('plan-01');
    expect(report.cleared).toContain('plan-01');
    expect(report.valid).not.toContain('plan-01');
    // State should have worktreePath cleared and status reset to pending
    expect(state.plans['plan-01'].worktreePath).toBeUndefined();
    expect(state.plans['plan-01'].status).toBe('pending');
  });

  it('skips plans without worktreePath set', async () => {
    const baseDir = makeTempDir();
    const { repoRoot, featureBranch, worktreeBase, mergeWorktreePath } =
      await setupRepoWithMergeWorktree(baseDir);

    const wm = new WorktreeManager({ repoRoot, worktreeBase, featureBranch, mergeWorktreePath });

    const state = makeState({
      mergeWorktreePath,
      worktreeBase,
      featureBranch,
      plans: {
        'plan-01': {
          status: 'pending',
          branch: 'eforge/plan-01',
          dependsOn: [],
          merged: false,
          // No worktreePath set
        },
      },
    });

    const report = await wm.reconcile(state);

    expect(report.valid).toContain('__merge__');
    expect(report.missing).toEqual([]);
    expect(report.corrupt).toEqual([]);
    expect(report.cleared).toEqual([]);
  });

  it('detects missing merge worktree and clears mergeWorktreePath', async () => {
    const baseDir = makeTempDir();
    const { repoRoot, featureBranch, worktreeBase, mergeWorktreePath } =
      await setupRepoWithMergeWorktree(baseDir);

    const wm = new WorktreeManager({ repoRoot, worktreeBase, featureBranch, mergeWorktreePath });

    // Delete the merge worktree directory
    rmSync(mergeWorktreePath, { recursive: true, force: true });

    const state = makeState({
      mergeWorktreePath,
      worktreeBase,
      featureBranch,
      plans: {},
    });

    const report = await wm.reconcile(state);

    expect(report.missing).toContain('__merge__');
    expect(report.cleared).toContain('__merge__');
    expect(state.mergeWorktreePath).toBeUndefined();
  });
});
