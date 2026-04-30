/**
 * Tests for piggyback scheduling: waiting/skipped state transitions, recursive
 * skip propagation, multi-dependent fan-out, persistence across restart, and
 * enqueue-time validation.
 *
 * All helpers use real filesystem operations but do not require a full daemon.
 */

import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import {
  findDependents,
  propagateSkip,
  unblockWaiting,
  validateDependsOnExists,
  enqueuePrd,
  loadQueue,
  type QueuedPrd,
} from '@eforge-build/engine/prd-queue';
import { useTempDir } from './test-tmpdir.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeQueuedPrd(overrides: Partial<QueuedPrd> & { id: string }): QueuedPrd {
  return {
    filePath: `/tmp/${overrides.id}.md`,
    frontmatter: { title: overrides.id },
    content: `---\ntitle: ${overrides.id}\n---\n\n# ${overrides.id}`,
    lastCommitHash: '',
    lastCommitDate: '',
    ...overrides,
  };
}

/**
 * Set up a minimal git repo with a queue directory structure.
 * Returns the cwd and queueDir string.
 */
function setupGitQueue(dir: string): { cwd: string; queueDir: string } {
  const queueDir = 'eforge/queue';
  mkdirSync(join(dir, queueDir, 'waiting'), { recursive: true });
  mkdirSync(join(dir, queueDir, 'failed'), { recursive: true });
  mkdirSync(join(dir, queueDir, 'skipped'), { recursive: true });

  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });

  return { cwd: dir, queueDir };
}

/**
 * Write a PRD file to the waiting/ subdirectory and stage+commit it.
 */
function writePrdToWaiting(
  cwd: string,
  queueDir: string,
  id: string,
  depends_on: string[],
): string {
  const waitingDir = join(cwd, queueDir, 'waiting');
  const filePath = join(waitingDir, `${id}.md`);
  const depsLine = `depends_on: [${depends_on.map((d) => `"${d}"`).join(', ')}]`;
  writeFileSync(
    filePath,
    `---\ntitle: ${id}\ncreated: 2026-04-30\n${depsLine}\n---\n\n# ${id}\n`,
  );
  execFileSync('git', ['add', filePath], { cwd });
  execFileSync('git', ['commit', '-m', `add waiting PRD ${id}`, '--allow-empty-message'], { cwd });
  return filePath;
}

/**
 * Write a PRD file to the queue root and stage+commit it.
 */
function writePrdToQueue(cwd: string, queueDir: string, id: string): string {
  const filePath = join(cwd, queueDir, `${id}.md`);
  writeFileSync(
    filePath,
    `---\ntitle: ${id}\ncreated: 2026-04-30\n---\n\n# ${id}\n`,
  );
  execFileSync('git', ['add', filePath], { cwd });
  execFileSync('git', ['commit', '-m', `add queue PRD ${id}`, '--allow-empty-message'], { cwd });
  return filePath;
}

// ---------------------------------------------------------------------------
// findDependents (pure, no filesystem)
// ---------------------------------------------------------------------------

describe('findDependents', () => {
  it('returns PRDs whose depends_on includes the upstream id', () => {
    const prds = [
      makeQueuedPrd({ id: 'a', frontmatter: { title: 'A' } }),
      makeQueuedPrd({ id: 'b', frontmatter: { title: 'B', depends_on: ['a'] } }),
      makeQueuedPrd({ id: 'c', frontmatter: { title: 'C', depends_on: ['a', 'd'] } }),
      makeQueuedPrd({ id: 'd', frontmatter: { title: 'D' } }),
    ];

    const dependents = findDependents(prds, 'a');
    expect(dependents.map((p) => p.id)).toEqual(['b', 'c']);
  });

  it('returns empty array when no PRDs depend on the upstream', () => {
    const prds = [
      makeQueuedPrd({ id: 'a', frontmatter: { title: 'A' } }),
      makeQueuedPrd({ id: 'b', frontmatter: { title: 'B' } }),
    ];

    expect(findDependents(prds, 'a')).toHaveLength(0);
  });

  it('returns empty array for empty input', () => {
    expect(findDependents([], 'any')).toHaveLength(0);
  });

  it('handles PRDs with no depends_on field', () => {
    const prds = [
      makeQueuedPrd({ id: 'x', frontmatter: { title: 'X' } }), // no depends_on
    ];
    expect(findDependents(prds, 'x')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// propagateSkip — upstream failed → dependents move to skipped/
// ---------------------------------------------------------------------------

describe('propagateSkip', () => {
  const makeTempDir = useTempDir('eforge-piggyback-skip-');

  it('moves waiting dependents to skipped/ when upstream failed', async () => {
    const dir = makeTempDir();
    const { cwd, queueDir } = setupGitQueue(dir);

    writePrdToWaiting(cwd, queueDir, 'feature', ['upstream']);

    await propagateSkip(queueDir, cwd, 'upstream', 'failed');

    const skippedDir = join(cwd, queueDir, 'skipped');
    expect(existsSync(join(skippedDir, 'feature.md'))).toBe(true);
    // Original waiting file must be gone
    expect(existsSync(join(cwd, queueDir, 'waiting', 'feature.md'))).toBe(false);
  });

  it('moves waiting dependents to skipped/ when upstream cancelled', async () => {
    const dir = makeTempDir();
    const { cwd, queueDir } = setupGitQueue(dir);

    writePrdToWaiting(cwd, queueDir, 'docs-update', ['build-x']);

    await propagateSkip(queueDir, cwd, 'build-x', 'cancelled');

    expect(existsSync(join(cwd, queueDir, 'skipped', 'docs-update.md'))).toBe(true);
    expect(existsSync(join(cwd, queueDir, 'waiting', 'docs-update.md'))).toBe(false);
  });

  it('recursively skips dependents of skipped PRDs', async () => {
    const dir = makeTempDir();
    const { cwd, queueDir } = setupGitQueue(dir);

    // Chain: upstream → level1 → level2
    writePrdToWaiting(cwd, queueDir, 'level1', ['upstream']);
    writePrdToWaiting(cwd, queueDir, 'level2', ['level1']);

    await propagateSkip(queueDir, cwd, 'upstream', 'failed');

    const skippedDir = join(cwd, queueDir, 'skipped');
    expect(existsSync(join(skippedDir, 'level1.md'))).toBe(true);
    expect(existsSync(join(skippedDir, 'level2.md'))).toBe(true);
  });

  it('multi-dependent fan-out: one upstream, three dependents all skipped', async () => {
    const dir = makeTempDir();
    const { cwd, queueDir } = setupGitQueue(dir);

    writePrdToWaiting(cwd, queueDir, 'dep-a', ['root']);
    writePrdToWaiting(cwd, queueDir, 'dep-b', ['root']);
    writePrdToWaiting(cwd, queueDir, 'dep-c', ['root']);

    await propagateSkip(queueDir, cwd, 'root', 'failed');

    const skippedDir = join(cwd, queueDir, 'skipped');
    expect(existsSync(join(skippedDir, 'dep-a.md'))).toBe(true);
    expect(existsSync(join(skippedDir, 'dep-b.md'))).toBe(true);
    expect(existsSync(join(skippedDir, 'dep-c.md'))).toBe(true);
  });

  it('is a no-op when waiting/ directory does not exist', async () => {
    const dir = makeTempDir();
    // No git init, no waiting directory
    const queueDir = 'eforge/queue';
    // Should not throw
    await expect(propagateSkip(queueDir, dir, 'nonexistent', 'failed')).resolves.toBeUndefined();
  });

  it('is a no-op when no PRD depends on the upstream', async () => {
    const dir = makeTempDir();
    const { cwd, queueDir } = setupGitQueue(dir);
    writePrdToWaiting(cwd, queueDir, 'unrelated', ['other-upstream']);

    await propagateSkip(queueDir, cwd, 'nonexistent', 'failed');

    // unrelated should still be in waiting/
    expect(existsSync(join(cwd, queueDir, 'waiting', 'unrelated.md'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// unblockWaiting — upstream completed → dependents move to queue/
// ---------------------------------------------------------------------------

describe('unblockWaiting', () => {
  const makeTempDir = useTempDir('eforge-piggyback-unblock-');

  it('moves waiting dependents to queue/ when upstream completed', async () => {
    const dir = makeTempDir();
    const { cwd, queueDir } = setupGitQueue(dir);

    writePrdToWaiting(cwd, queueDir, 'feature', ['upstream']);

    const unblocked = await unblockWaiting(queueDir, cwd, 'upstream');

    expect(unblocked).toContain('feature');
    expect(existsSync(join(cwd, queueDir, 'feature.md'))).toBe(true);
    expect(existsSync(join(cwd, queueDir, 'waiting', 'feature.md'))).toBe(false);
  });

  it('does not unblock a PRD that still has unsatisfied deps', async () => {
    const dir = makeTempDir();
    const { cwd, queueDir } = setupGitQueue(dir);

    // feature depends on both 'upstream' and 'other'
    writePrdToWaiting(cwd, queueDir, 'feature', ['upstream', 'other']);
    // 'other' is still pending in queue/
    writePrdToQueue(cwd, queueDir, 'other');

    const unblocked = await unblockWaiting(queueDir, cwd, 'upstream');

    // feature has 'other' still active, so not unblocked
    expect(unblocked).not.toContain('feature');
    expect(existsSync(join(cwd, queueDir, 'waiting', 'feature.md'))).toBe(true);
  });

  it('unblocks when all deps are completed (multi-dep)', async () => {
    const dir = makeTempDir();
    const { cwd, queueDir } = setupGitQueue(dir);

    // feature depends on upstream-a and upstream-b; upstream-b already gone (completed)
    writePrdToWaiting(cwd, queueDir, 'feature', ['upstream-a', 'upstream-b']);
    // upstream-b is NOT in queue or waiting → treated as completed

    const unblocked = await unblockWaiting(queueDir, cwd, 'upstream-a');

    expect(unblocked).toContain('feature');
    expect(existsSync(join(cwd, queueDir, 'feature.md'))).toBe(true);
  });

  it('returns empty array when waiting/ is empty', async () => {
    const dir = makeTempDir();
    const { cwd, queueDir } = setupGitQueue(dir);
    // waiting/ exists but is empty

    const unblocked = await unblockWaiting(queueDir, cwd, 'any');
    expect(unblocked).toHaveLength(0);
  });

  it('returns empty array when waiting/ does not exist', async () => {
    const dir = makeTempDir();
    const queueDir = 'eforge/queue';
    mkdirSync(join(dir, queueDir), { recursive: true });
    // No waiting/ directory

    const unblocked = await unblockWaiting(queueDir, dir, 'any');
    expect(unblocked).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Persistence across restart: waiting and skipped state survives on disk
// ---------------------------------------------------------------------------

describe('piggyback state persistence across restart', () => {
  const makeTempDir = useTempDir('eforge-piggyback-persist-');

  it('waiting state survives daemon restart (files on disk)', async () => {
    const dir = makeTempDir();
    const { cwd, queueDir } = setupGitQueue(dir);

    // Simulate: piggybacked PRD written to waiting/
    writePrdToWaiting(cwd, queueDir, 'piggybacked', ['running-upstream']);

    // Simulate daemon restart: load waiting queue fresh
    const waitingPrds = await loadQueue(`${queueDir}/waiting`, cwd);
    expect(waitingPrds).toHaveLength(1);
    expect(waitingPrds[0].id).toBe('piggybacked');
    expect(waitingPrds[0].frontmatter.depends_on).toEqual(['running-upstream']);
  });

  it('skipped state survives daemon restart (files on disk)', async () => {
    const dir = makeTempDir();
    const { cwd, queueDir } = setupGitQueue(dir);

    writePrdToWaiting(cwd, queueDir, 'to-be-skipped', ['failed-upstream']);
    await propagateSkip(queueDir, cwd, 'failed-upstream', 'failed');

    // Simulate daemon restart: load skipped queue
    const skippedPrds = await loadQueue(`${queueDir}/skipped`, cwd);
    expect(skippedPrds.some((p) => p.id === 'to-be-skipped')).toBe(true);

    // And the waiting/ directory should now be empty
    const waitingPrds = await loadQueue(`${queueDir}/waiting`, cwd);
    expect(waitingPrds.some((p) => p.id === 'to-be-skipped')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateDependsOnExists — reject enqueue when upstream not in queue
// ---------------------------------------------------------------------------

describe('validateDependsOnExists', () => {
  const makeTempDir = useTempDir('eforge-piggyback-validate-');

  it('resolves when upstream exists in queue/', async () => {
    const dir = makeTempDir();
    const queueDir = 'eforge/queue';
    mkdirSync(join(dir, queueDir), { recursive: true });
    writeFileSync(
      join(dir, queueDir, 'upstream.md'),
      '---\ntitle: Upstream\n---\n\n# Upstream\n',
    );

    await expect(validateDependsOnExists(['upstream'], queueDir, dir)).resolves.toBeUndefined();
  });

  it('resolves when upstream exists in waiting/', async () => {
    const dir = makeTempDir();
    const queueDir = 'eforge/queue';
    mkdirSync(join(dir, queueDir, 'waiting'), { recursive: true });
    writeFileSync(
      join(dir, queueDir, 'waiting', 'in-waiting.md'),
      '---\ntitle: In Waiting\ndepends_on: ["other"]\n---\n\n# In Waiting\n',
    );

    await expect(validateDependsOnExists(['in-waiting'], queueDir, dir)).resolves.toBeUndefined();
  });

  it('throws when upstream does not exist anywhere in the queue', async () => {
    const dir = makeTempDir();
    const queueDir = 'eforge/queue';
    mkdirSync(join(dir, queueDir), { recursive: true });

    await expect(
      validateDependsOnExists(['ghost-id'], queueDir, dir),
    ).rejects.toThrow(/ghost-id/);
  });

  it('resolves for empty depends_on array without checking filesystem', async () => {
    const dir = makeTempDir();
    // No queue directory at all — should not throw for empty array
    await expect(validateDependsOnExists([], 'does-not-exist', dir)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// enqueuePrd with intoWaiting flag
// ---------------------------------------------------------------------------

describe('enqueuePrd with intoWaiting', () => {
  const makeTempDir = useTempDir('eforge-piggyback-enqueue-');

  it('writes PRD to waiting/ when intoWaiting is true', async () => {
    const dir = makeTempDir();
    const queueDir = 'eforge/queue';
    mkdirSync(join(dir, queueDir), { recursive: true });

    const result = await enqueuePrd({
      body: '# Feature\n\nDo something.',
      title: 'My Feature',
      queueDir,
      cwd: dir,
      depends_on: ['some-upstream'],
      intoWaiting: true,
    });

    const expectedPath = join(dir, queueDir, 'waiting', `${result.id}.md`);
    expect(existsSync(expectedPath)).toBe(true);
    // Should NOT be in queue root
    expect(existsSync(join(dir, queueDir, `${result.id}.md`))).toBe(false);
  });

  it('writes PRD to queue/ root when intoWaiting is false', async () => {
    const dir = makeTempDir();
    const queueDir = 'eforge/queue';
    mkdirSync(join(dir, queueDir), { recursive: true });

    const result = await enqueuePrd({
      body: '# Feature\n\nDo something.',
      title: 'My Feature',
      queueDir,
      cwd: dir,
      intoWaiting: false,
    });

    const expectedPath = join(dir, queueDir, `${result.id}.md`);
    expect(existsSync(expectedPath)).toBe(true);
    expect(existsSync(join(dir, queueDir, 'waiting', `${result.id}.md`))).toBe(false);
  });

  it('preserves depends_on in frontmatter when writing to waiting/', async () => {
    const dir = makeTempDir();
    const queueDir = 'eforge/queue';
    mkdirSync(join(dir, queueDir), { recursive: true });

    const result = await enqueuePrd({
      body: '# Feature',
      title: 'Piggybacked',
      queueDir,
      cwd: dir,
      depends_on: ['upstream-build'],
      intoWaiting: true,
    });

    const prds = await loadQueue(`${queueDir}/waiting`, dir);
    const prd = prds.find((p) => p.id === result.id);
    expect(prd).toBeDefined();
    expect(prd!.frontmatter.depends_on).toEqual(['upstream-build']);
  });
});
