import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { validateRuntimeReadiness } from '../src/engine/plan.js';

const exec = promisify(execFile);

async function createTempGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'forge-test-'));
  await exec('git', ['init', dir]);
  await exec('git', ['-C', dir, 'config', 'user.email', 'test@test.com']);
  await exec('git', ['-C', dir, 'config', 'user.name', 'Test']);
  // Create an initial commit so the repo is valid
  await writeFile(join(dir, 'README.md'), '# Test');
  await exec('git', ['-C', dir, 'add', '.']);
  await exec('git', ['-C', dir, 'commit', '-m', 'init']);
  return dir;
}

const testPlans = [
  { id: 'plan-a', name: 'Plan A', dependsOn: [], branch: 'test/plan-a' },
  { id: 'plan-b', name: 'Plan B', dependsOn: ['plan-a'], branch: 'test/plan-b' },
];

describe('validateRuntimeReadiness', () => {
  it('clean repo passes with no warnings', async () => {
    const dir = await createTempGitRepo();
    try {
      const warnings = await validateRuntimeReadiness(dir, testPlans);
      expect(warnings).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('dirty repo warns about uncommitted changes', async () => {
    const dir = await createTempGitRepo();
    try {
      // Create an uncommitted file
      await writeFile(join(dir, 'dirty.txt'), 'uncommitted');
      const warnings = await validateRuntimeReadiness(dir, testPlans);
      expect(warnings).toContain('Git working directory has uncommitted changes');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('existing branches warn', async () => {
    const dir = await createTempGitRepo();
    try {
      // Create one of the plan branches
      await exec('git', ['-C', dir, 'branch', 'test/plan-a']);
      const warnings = await validateRuntimeReadiness(dir, testPlans);
      expect(warnings).toContainEqual(
        expect.stringContaining("Branch 'test/plan-a' already exists"),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('unwritable directory warns', async () => {
    const dir = await createTempGitRepo();
    // Create a subdirectory and make the parent unwritable
    const subDir = join(dir, 'locked', 'repo');
    await exec('mkdir', ['-p', subDir]);
    await exec('git', ['init', subDir]);
    await exec('git', ['-C', subDir, 'config', 'user.email', 'test@test.com']);
    await exec('git', ['-C', subDir, 'config', 'user.name', 'Test']);
    await writeFile(join(subDir, 'README.md'), '# Test');
    await exec('git', ['-C', subDir, 'add', '.']);
    await exec('git', ['-C', subDir, 'commit', '-m', 'init']);

    const lockedDir = join(dir, 'locked');
    try {
      await chmod(lockedDir, 0o555);
      const warnings = await validateRuntimeReadiness(subDir, testPlans);
      expect(warnings).toContainEqual(
        expect.stringContaining('Worktree parent directory is not writable'),
      );
    } finally {
      // Restore permissions before cleanup
      await chmod(lockedDir, 0o755);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
