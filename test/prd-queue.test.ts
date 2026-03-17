import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validatePrdFrontmatter, resolveQueueOrder, updatePrdStatus, type QueuedPrd } from '../src/engine/prd-queue.js';

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
      status: 'pending',
      depends_on: ['setup-db'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.title).toBe('Add user auth');
      expect(result.data.priority).toBe(1);
      expect(result.data.status).toBe('pending');
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

  it('rejects frontmatter with invalid status', () => {
    const result = validatePrdFrontmatter({
      title: 'Bad status',
      status: 'in-progress',
    });
    expect(result.success).toBe(false);
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

  it('accepts all valid status values', () => {
    for (const status of ['pending', 'running', 'completed', 'failed', 'skipped']) {
      const result = validatePrdFrontmatter({ title: 'Test', status });
      expect(result.success).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Queue Ordering
// ---------------------------------------------------------------------------

describe('resolveQueueOrder', () => {
  it('sorts by priority ascending (lower = higher priority)', () => {
    const prds = [
      makeQueuedPrd({ id: 'low', frontmatter: { title: 'Low', priority: 3, status: 'pending' } }),
      makeQueuedPrd({ id: 'high', frontmatter: { title: 'High', priority: 1, status: 'pending' } }),
      makeQueuedPrd({ id: 'mid', frontmatter: { title: 'Mid', priority: 2, status: 'pending' } }),
    ];

    const ordered = resolveQueueOrder(prds);
    expect(ordered.map((p) => p.id)).toEqual(['high', 'mid', 'low']);
  });

  it('respects dependency waves - dependents come after dependencies', () => {
    const prds = [
      makeQueuedPrd({
        id: 'api',
        frontmatter: { title: 'API', status: 'pending', depends_on: ['db'] },
      }),
      makeQueuedPrd({
        id: 'db',
        frontmatter: { title: 'Database', status: 'pending' },
      }),
    ];

    const ordered = resolveQueueOrder(prds);
    expect(ordered.map((p) => p.id)).toEqual(['db', 'api']);
  });

  it('handles priority + deps combined - deps first, then priority within wave', () => {
    const prds = [
      makeQueuedPrd({
        id: 'feature-b',
        frontmatter: { title: 'Feature B', priority: 1, status: 'pending', depends_on: ['foundation'] },
      }),
      makeQueuedPrd({
        id: 'feature-a',
        frontmatter: { title: 'Feature A', priority: 2, status: 'pending', depends_on: ['foundation'] },
      }),
      makeQueuedPrd({
        id: 'foundation',
        frontmatter: { title: 'Foundation', priority: 3, status: 'pending' },
      }),
    ];

    const ordered = resolveQueueOrder(prds);
    // Foundation first (wave 0), then feature-b before feature-a (priority)
    expect(ordered.map((p) => p.id)).toEqual(['foundation', 'feature-b', 'feature-a']);
  });

  it('filters to only pending PRDs', () => {
    const prds = [
      makeQueuedPrd({ id: 'done', frontmatter: { title: 'Done', status: 'completed' } }),
      makeQueuedPrd({ id: 'todo', frontmatter: { title: 'Todo', status: 'pending' } }),
      makeQueuedPrd({ id: 'skip', frontmatter: { title: 'Skip', status: 'skipped' } }),
    ];

    const ordered = resolveQueueOrder(prds);
    expect(ordered).toHaveLength(1);
    expect(ordered[0].id).toBe('todo');
  });

  it('returns empty array when no pending PRDs', () => {
    const prds = [
      makeQueuedPrd({ id: 'done', frontmatter: { title: 'Done', status: 'completed' } }),
    ];
    expect(resolveQueueOrder(prds)).toEqual([]);
  });

  it('treats PRDs without status as pending', () => {
    const prds = [
      makeQueuedPrd({ id: 'no-status', frontmatter: { title: 'No Status' } }),
    ];

    const ordered = resolveQueueOrder(prds);
    expect(ordered).toHaveLength(1);
    expect(ordered[0].id).toBe('no-status');
  });

  it('filters out dependencies referencing non-pending PRDs', () => {
    const prds = [
      makeQueuedPrd({ id: 'completed-dep', frontmatter: { title: 'Completed', status: 'completed' } }),
      makeQueuedPrd({
        id: 'feature',
        frontmatter: { title: 'Feature', status: 'pending', depends_on: ['completed-dep'] },
      }),
    ];

    // completed-dep is not pending, so feature's dependency on it should be filtered out
    const ordered = resolveQueueOrder(prds);
    expect(ordered).toHaveLength(1);
    expect(ordered[0].id).toBe('feature');
  });
});

// ---------------------------------------------------------------------------
// updatePrdStatus
// ---------------------------------------------------------------------------

describe('updatePrdStatus', () => {
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'eforge-prd-status-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it('replaces existing status line', async () => {
    const dir = makeTempDir();
    const filePath = join(dir, 'test.md');
    writeFileSync(filePath, '---\ntitle: Test\nstatus: pending\n---\n\n# Test\n');

    await updatePrdStatus(filePath, 'completed');

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('status: completed');
    expect(content).not.toContain('status: pending');
  });

  it('inserts status when absent', async () => {
    const dir = makeTempDir();
    const filePath = join(dir, 'test.md');
    writeFileSync(filePath, '---\ntitle: Test\n---\n\n# Test\n');

    await updatePrdStatus(filePath, 'running');

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('status: running');
    // Should still have valid frontmatter structure
    expect(content).toMatch(/^---\n/);
    expect(content).toMatch(/\n---\n/);
  });
});
