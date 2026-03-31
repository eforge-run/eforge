import { describe, it, expect } from 'vitest';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { validatePrdFrontmatter, resolveQueueOrder, claimPrd, releasePrd, movePrdToSubdir, isPrdRunning, type QueuedPrd } from '../src/engine/prd-queue.js';
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

// ---------------------------------------------------------------------------
// Frontmatter Validation
// ---------------------------------------------------------------------------

describe('validatePrdFrontmatter', () => {
  it('accepts valid frontmatter with all fields', () => {
    const result = validatePrdFrontmatter({
      title: 'Add user auth',
      created: '2026-01-15',
      priority: 1,
      depends_on: ['setup-db'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.title).toBe('Add user auth');
      expect(result.data.priority).toBe(1);
      expect(result.data.depends_on).toEqual(['setup-db']);
    }
  });

  it('rejects frontmatter missing title', () => {
    const result = validatePrdFrontmatter({
      created: '2026-01-15',
      priority: 1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects frontmatter with missing created (optional - should pass)', () => {
    // created is optional per schema
    const result = validatePrdFrontmatter({
      title: 'No date',
    });
    expect(result.success).toBe(true);
  });

  it('ignores extra fields gracefully', () => {
    const result = validatePrdFrontmatter({
      title: 'Extra fields',
      created: '2026-01-15',
      customField: 'should be ignored',
      anotherOne: 42,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.title).toBe('Extra fields');
    }
  });
});

// ---------------------------------------------------------------------------
// Queue Ordering
// ---------------------------------------------------------------------------

describe('resolveQueueOrder', () => {
  it('sorts by priority ascending (lower = higher priority)', () => {
    const prds = [
      makeQueuedPrd({ id: 'low', frontmatter: { title: 'Low', priority: 3 } }),
      makeQueuedPrd({ id: 'high', frontmatter: { title: 'High', priority: 1 } }),
      makeQueuedPrd({ id: 'mid', frontmatter: { title: 'Mid', priority: 2 } }),
    ];

    const ordered = resolveQueueOrder(prds);
    expect(ordered.map((p) => p.id)).toEqual(['high', 'mid', 'low']);
  });

  it('respects dependency waves - dependents come after dependencies', () => {
    const prds = [
      makeQueuedPrd({
        id: 'api',
        frontmatter: { title: 'API', depends_on: ['db'] },
      }),
      makeQueuedPrd({
        id: 'db',
        frontmatter: { title: 'Database' },
      }),
    ];

    const ordered = resolveQueueOrder(prds);
    expect(ordered.map((p) => p.id)).toEqual(['db', 'api']);
  });

  it('handles priority + deps combined - deps first, then priority within wave', () => {
    const prds = [
      makeQueuedPrd({
        id: 'feature-b',
        frontmatter: { title: 'Feature B', priority: 1, depends_on: ['foundation'] },
      }),
      makeQueuedPrd({
        id: 'feature-a',
        frontmatter: { title: 'Feature A', priority: 2, depends_on: ['foundation'] },
      }),
      makeQueuedPrd({
        id: 'foundation',
        frontmatter: { title: 'Foundation', priority: 3 },
      }),
    ];

    const ordered = resolveQueueOrder(prds);
    // Foundation first (wave 0), then feature-b before feature-a (priority)
    expect(ordered.map((p) => p.id)).toEqual(['foundation', 'feature-b', 'feature-a']);
  });

  it('returns all PRDs in queue (all are pending by definition)', () => {
    const prds = [
      makeQueuedPrd({ id: 'a', frontmatter: { title: 'A' } }),
      makeQueuedPrd({ id: 'b', frontmatter: { title: 'B' } }),
    ];

    const ordered = resolveQueueOrder(prds);
    expect(ordered).toHaveLength(2);
  });

  it('returns empty array for empty input', () => {
    expect(resolveQueueOrder([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// movePrdToSubdir
// ---------------------------------------------------------------------------

describe('movePrdToSubdir', () => {
  const makeTempDir = useTempDir('eforge-prd-move-');

  it('moves a PRD file to a subdirectory via git mv', async () => {
    const dir = makeTempDir();
    // Initialize git repo
    execFileSync('git', ['init'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });

    const queueDir = join(dir, 'eforge', 'queue');
    mkdirSync(queueDir, { recursive: true });

    const filePath = join(queueDir, 'test-prd.md');
    writeFileSync(filePath, '---\ntitle: Test\n---\n\n# Test\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });

    await movePrdToSubdir(filePath, 'failed', dir);

    expect(existsSync(join(queueDir, 'failed', 'test-prd.md'))).toBe(true);
    expect(existsSync(filePath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isPrdRunning
// ---------------------------------------------------------------------------

describe('isPrdRunning', () => {
  const makeTempDir = useTempDir('eforge-prd-running-');

  it('returns false when no lock file exists', async () => {
    const dir = makeTempDir();
    expect(await isPrdRunning('test', dir)).toBe(false);
  });

  it('returns true when lock file exists', async () => {
    const dir = makeTempDir();
    const lockDir = join(dir, '.eforge', 'queue-locks');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'test.lock'), String(process.pid));

    expect(await isPrdRunning('test', dir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// claimPrd / releasePrd
// ---------------------------------------------------------------------------

describe('claimPrd', () => {
  const makeTempDir = useTempDir('eforge-prd-claim-');

  it('returns true on first call and creates .lock file', async () => {
    const dir = makeTempDir();
    const prdId = 'test';

    const result = await claimPrd(prdId, dir);
    expect(result).toBe(true);
    expect(existsSync(join(dir, '.eforge', 'queue-locks', `${prdId}.lock`))).toBe(true);
  });

  it('returns false on second call for the same prdId', async () => {
    const dir = makeTempDir();
    const prdId = 'test';

    const first = await claimPrd(prdId, dir);
    expect(first).toBe(true);

    const second = await claimPrd(prdId, dir);
    expect(second).toBe(false);
  });

  it('returns true and re-acquires when lock file contains a dead PID', async () => {
    const dir = makeTempDir();
    const prdId = 'test';
    const lockPath = join(dir, '.eforge', 'queue-locks', `${prdId}.lock`);

    // Write a lock file with a PID that does not exist
    mkdirSync(join(dir, '.eforge', 'queue-locks'), { recursive: true });
    writeFileSync(lockPath, '999999');

    const result = await claimPrd(prdId, dir);
    expect(result).toBe(true);

    // Lock file should now contain our PID
    const lockContent = readFileSync(lockPath, 'utf-8');
    expect(lockContent).toBe(String(process.pid));
  });

  it('returns false when lock file contains a live PID', async () => {
    const dir = makeTempDir();
    const prdId = 'test';
    const lockPath = join(dir, '.eforge', 'queue-locks', `${prdId}.lock`);

    // Write a lock file with the current (alive) process PID
    mkdirSync(join(dir, '.eforge', 'queue-locks'), { recursive: true });
    writeFileSync(lockPath, String(process.pid));

    const result = await claimPrd(prdId, dir);
    expect(result).toBe(false);
  });

  it('returns false when lock file contains invalid content', async () => {
    const dir = makeTempDir();
    const prdId = 'test';
    const lockPath = join(dir, '.eforge', 'queue-locks', `${prdId}.lock`);

    // Write a lock file with non-numeric content
    mkdirSync(join(dir, '.eforge', 'queue-locks'), { recursive: true });
    writeFileSync(lockPath, 'not-a-pid');

    const result = await claimPrd(prdId, dir);
    expect(result).toBe(false);
  });

  it('returns false when lock file is empty', async () => {
    const dir = makeTempDir();
    const prdId = 'test';
    const lockPath = join(dir, '.eforge', 'queue-locks', `${prdId}.lock`);

    // Write an empty lock file
    mkdirSync(join(dir, '.eforge', 'queue-locks'), { recursive: true });
    writeFileSync(lockPath, '');

    const result = await claimPrd(prdId, dir);
    expect(result).toBe(false);
  });

  it('succeeds again after releasePrd', async () => {
    const dir = makeTempDir();
    const prdId = 'test';

    await claimPrd(prdId, dir);
    await releasePrd(prdId, dir);

    const result = await claimPrd(prdId, dir);
    expect(result).toBe(true);
  });
});

describe('releasePrd', () => {
  const makeTempDir = useTempDir('eforge-prd-release-');

  it('removes the .lock file', async () => {
    const dir = makeTempDir();
    const prdId = 'test';
    const lockPath = join(dir, '.eforge', 'queue-locks', `${prdId}.lock`);

    await claimPrd(prdId, dir);
    expect(existsSync(lockPath)).toBe(true);

    await releasePrd(prdId, dir);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('does not throw when lock file is already gone', async () => {
    const dir = makeTempDir();
    const prdId = 'nonexistent';

    // Should not throw even though there's no lock file
    await expect(releasePrd(prdId, dir)).resolves.toBeUndefined();
  });
});
