import { describe, it, expect } from 'vitest';
import { isAgentWorktreeCwd, ensureDaemon, DaemonInWorktreeError } from '@eforge-build/client';

describe('isAgentWorktreeCwd', () => {
  it('flags the merge worktree', () => {
    expect(isAgentWorktreeCwd('/tmp/eforge-eval-foo-add-prd-worktrees/__merge__')).toBe(true);
  });

  it('flags a per-module worktree', () => {
    expect(isAgentWorktreeCwd('/tmp/proj-set-worktrees/module-01')).toBe(true);
  });

  it('does not flag a normal project root', () => {
    expect(isAgentWorktreeCwd('/Users/me/projects/myapp')).toBe(false);
  });

  it('does not flag a directory whose ancestor merely contains "worktrees" in its name', () => {
    expect(isAgentWorktreeCwd('/Users/me/worktrees-research/notes')).toBe(false);
  });
});

describe('ensureDaemon worktree guard', () => {
  it('refuses to spawn a daemon from a __merge__ cwd', async () => {
    await expect(
      ensureDaemon('/tmp/no-such-eforge-eval-XYZ-worktrees/__merge__'),
    ).rejects.toBeInstanceOf(DaemonInWorktreeError);
  });

  it('refuses to spawn a daemon from a per-module worktree', async () => {
    await expect(
      ensureDaemon('/tmp/no-such-eforge-eval-XYZ-worktrees/module-02'),
    ).rejects.toBeInstanceOf(DaemonInWorktreeError);
  });
});
