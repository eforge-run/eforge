import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { useTempDir } from './test-tmpdir.js';
import { openDatabase } from '@eforge-build/monitor/db';

describe('file_diffs DB operations', () => {
  const makeTempDir = useTempDir();

  function createDb() {
    const dir = makeTempDir();
    const dbPath = resolve(dir, 'test.db');
    return openDatabase(dbPath);
  }

  function seedRun(db: ReturnType<typeof openDatabase>, runId: string, sessionId: string) {
    db.insertRun({
      id: runId,
      sessionId,
      planSet: 'test-set',
      command: 'build',
      status: 'running',
      startedAt: new Date().toISOString(),
      cwd: '/tmp/test',
    });
  }

  it('insertFileDiffs and getFileDiff round-trip', () => {
    const db = createDb();
    const runId = 'run-1';
    const sessionId = 'session-1';
    seedRun(db, runId, sessionId);

    const diffs = [
      { path: 'src/foo.ts', diff: 'diff --git a/src/foo.ts...' },
      { path: 'src/bar.ts', diff: 'diff --git a/src/bar.ts...' },
    ];
    const timestamp = new Date().toISOString();

    db.insertFileDiffs(runId, 'plan-01', diffs, timestamp);

    const record = db.getFileDiff(sessionId, 'plan-01', 'src/foo.ts');
    expect(record).toBeDefined();
    expect(record!.filePath).toBe('src/foo.ts');
    expect(record!.diffText).toBe('diff --git a/src/foo.ts...');
    expect(record!.planId).toBe('plan-01');

    const record2 = db.getFileDiff(sessionId, 'plan-01', 'src/bar.ts');
    expect(record2).toBeDefined();
    expect(record2!.filePath).toBe('src/bar.ts');

    db.close();
  });

  it('getFileDiff returns latest diff for duplicate file paths', () => {
    const db = createDb();
    const runId = 'run-1';
    const sessionId = 'session-1';
    seedRun(db, runId, sessionId);

    const ts1 = '2025-01-01T00:00:00.000Z';
    const ts2 = '2025-01-01T00:01:00.000Z';

    db.insertFileDiffs(runId, 'plan-01', [{ path: 'src/foo.ts', diff: 'old diff' }], ts1);
    db.insertFileDiffs(runId, 'plan-01', [{ path: 'src/foo.ts', diff: 'new diff' }], ts2);

    const record = db.getFileDiff(sessionId, 'plan-01', 'src/foo.ts');
    expect(record).toBeDefined();
    expect(record!.diffText).toBe('new diff');

    db.close();
  });

  it('getFileDiffs returns all files for a plan', () => {
    const db = createDb();
    const runId = 'run-1';
    const sessionId = 'session-1';
    seedRun(db, runId, sessionId);

    const timestamp = new Date().toISOString();
    db.insertFileDiffs(runId, 'plan-01', [
      { path: 'src/a.ts', diff: 'diff-a' },
      { path: 'src/b.ts', diff: 'diff-b' },
      { path: 'src/c.ts', diff: 'diff-c' },
    ], timestamp);

    const records = db.getFileDiffs(sessionId, 'plan-01');
    expect(records).toHaveLength(3);
    const paths = records.map((r) => r.filePath).sort();
    expect(paths).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);

    db.close();
  });

  it('getFileDiffs deduplicates to latest diff per file', () => {
    const db = createDb();
    const runId = 'run-1';
    const sessionId = 'session-1';
    seedRun(db, runId, sessionId);

    db.insertFileDiffs(runId, 'plan-01', [{ path: 'src/a.ts', diff: 'old' }], '2025-01-01T00:00:00Z');
    db.insertFileDiffs(runId, 'plan-01', [{ path: 'src/a.ts', diff: 'new' }], '2025-01-01T00:01:00Z');

    const records = db.getFileDiffs(sessionId, 'plan-01');
    expect(records).toHaveLength(1);
    expect(records[0].diffText).toBe('new');

    db.close();
  });

  it('getFileDiff returns undefined for non-existent file', () => {
    const db = createDb();
    const runId = 'run-1';
    const sessionId = 'session-1';
    seedRun(db, runId, sessionId);

    const record = db.getFileDiff(sessionId, 'plan-01', 'nonexistent.ts');
    expect(record).toBeUndefined();

    db.close();
  });

  it('cleanupOldSessions deletes sessions beyond keep count', () => {
    const db = createDb();

    // Create 5 sessions with staggered timestamps
    for (let i = 1; i <= 5; i++) {
      const sessionId = `session-${i}`;
      const runId = `run-${i}`;
      db.insertRun({
        id: runId,
        sessionId,
        planSet: 'test-set',
        command: 'build',
        status: 'completed',
        startedAt: `2025-01-0${i}T00:00:00Z`,
        cwd: '/tmp/test',
      });
      db.insertEvent({
        runId,
        type: 'plan:build:start',
        planId: `plan-${i}`,
        data: '{}',
        timestamp: `2025-01-0${i}T00:00:00Z`,
      });
      db.insertFileDiffs(runId, `plan-${i}`, [
        { path: `file-${i}.ts`, diff: `diff-${i}` },
      ], `2025-01-0${i}T00:00:00Z`);
    }

    // Keep only 2 most recent sessions
    db.cleanupOldSessions(2);

    // Sessions 4 and 5 should remain (most recent by started_at DESC)
    const runs = db.getRuns();
    expect(runs).toHaveLength(2);
    const sessionIds = runs.map((r) => r.sessionId).sort();
    expect(sessionIds).toEqual(['session-4', 'session-5']);

    // File diffs for old sessions should be gone
    const oldDiff = db.getFileDiff('session-1', 'plan-1', 'file-1.ts');
    expect(oldDiff).toBeUndefined();

    // File diffs for recent sessions should remain
    const recentDiff = db.getFileDiff('session-5', 'plan-5', 'file-5.ts');
    expect(recentDiff).toBeDefined();
    expect(recentDiff!.diffText).toBe('diff-5');

    db.close();
  });

  it('cleanupOldSessions is a no-op when session count is within keep limit', () => {
    const db = createDb();

    // Create 2 sessions
    for (let i = 1; i <= 2; i++) {
      const sessionId = `session-${i}`;
      const runId = `run-${i}`;
      db.insertRun({
        id: runId,
        sessionId,
        planSet: 'test-set',
        command: 'build',
        status: 'completed',
        startedAt: `2025-01-0${i}T00:00:00Z`,
        cwd: '/tmp/test',
      });
    }

    // Keep 5 — should not delete anything
    db.cleanupOldSessions(5);

    const runs = db.getRuns();
    expect(runs).toHaveLength(2);

    db.close();
  });
});
