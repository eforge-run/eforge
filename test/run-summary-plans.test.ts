/**
 * Unit tests for buildRunSummary plan derivation.
 *
 * Tests:
 * 1. Seeds pending plans from planning:complete event.
 * 2. Overlays running status on top of pending while siblings stay pending.
 * 3. Overlays completed and failed with no plans dropped.
 * 4. Falls back to build events when planning:complete is absent (backward compat).
 * 5. Prefers latest planning:complete on re-plan.
 *
 * Follows AGENTS.md conventions: no mocks, real SQLite, inline data construction.
 */

import { describe, it, expect } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { useTempDir } from './test-tmpdir.js';
import { openDatabase } from '@eforge-build/monitor/db';
import { buildRunSummary } from '@eforge-build/monitor/server';

const makeTempDir = useTempDir('eforge-run-summary-');

async function openTestDb(tmpDir: string) {
  const eforgeDir = join(tmpDir, '.eforge');
  await mkdir(eforgeDir, { recursive: true });
  return openDatabase(join(eforgeDir, 'monitor.db'));
}

const NOW = new Date().toISOString();

function insertRun(db: ReturnType<typeof openDatabase>, sessionId: string, runId: string) {
  db.insertRun({
    id: runId,
    sessionId,
    planSet: 'test-plan-set',
    command: 'eforge build',
    status: 'running',
    startedAt: NOW,
    cwd: '/tmp/test',
  });
}

function insertEvent(
  db: ReturnType<typeof openDatabase>,
  runId: string,
  type: string,
  data: unknown,
  planId?: string,
) {
  db.insertEvent({
    runId,
    type,
    planId,
    data: JSON.stringify(data),
    timestamp: NOW,
  });
}

// ---------------------------------------------------------------------------
// Case 1: Seeds pending plans from planning:complete
// ---------------------------------------------------------------------------

describe('buildRunSummary plan seeding', () => {
  it('seeds pending plans from planning:complete event', async () => {
    const tmp = makeTempDir();
    const db = await openTestDb(tmp);
    const sessionId = 'session-seed-pending';
    const runId = 'run-seed-pending';

    insertRun(db, sessionId, runId);
    insertEvent(db, runId, 'planning:complete', {
      plans: [
        { id: 'plan-alpha', branch: 'feat/alpha', dependsOn: [] },
        { id: 'plan-beta', branch: 'feat/beta', dependsOn: ['plan-alpha'] },
      ],
    });

    const summary = buildRunSummary(db, sessionId);

    expect(summary.plans).toHaveLength(2);

    const alpha = summary.plans.find((p) => p.id === 'plan-alpha');
    expect(alpha).toBeDefined();
    expect(alpha!.status).toBe('pending');
    expect(alpha!.branch).toBe('feat/alpha');
    expect(alpha!.dependsOn).toEqual([]);

    const beta = summary.plans.find((p) => p.id === 'plan-beta');
    expect(beta).toBeDefined();
    expect(beta!.status).toBe('pending');
    expect(beta!.branch).toBe('feat/beta');
    expect(beta!.dependsOn).toEqual(['plan-alpha']);

    db.close();
  });

  // -------------------------------------------------------------------------
  // Case 2: Overlay running on top of pending while sibling stays pending
  // -------------------------------------------------------------------------

  it('overlays running status while sibling stays pending', async () => {
    const tmp = makeTempDir();
    const db = await openTestDb(tmp);
    const sessionId = 'session-overlay-running';
    const runId = 'run-overlay-running';

    insertRun(db, sessionId, runId);
    insertEvent(db, runId, 'planning:complete', {
      plans: [
        { id: 'plan-alpha', branch: 'feat/alpha', dependsOn: [] },
        { id: 'plan-beta', branch: 'feat/beta', dependsOn: ['plan-alpha'] },
      ],
    });
    insertEvent(db, runId, 'plan:build:start', { planId: 'plan-alpha', branch: 'feat/alpha', dependsOn: [] }, 'plan-alpha');

    const summary = buildRunSummary(db, sessionId);

    expect(summary.plans).toHaveLength(2);

    const alpha = summary.plans.find((p) => p.id === 'plan-alpha');
    expect(alpha!.status).toBe('running');

    const beta = summary.plans.find((p) => p.id === 'plan-beta');
    expect(beta!.status).toBe('pending');

    db.close();
  });

  // -------------------------------------------------------------------------
  // Case 3: Overlay completed and failed with no plans dropped
  // -------------------------------------------------------------------------

  it('overlays completed and failed with no plans dropped', async () => {
    const tmp = makeTempDir();
    const db = await openTestDb(tmp);
    const sessionId = 'session-overlay-complete-fail';
    const runId = 'run-overlay-complete-fail';

    insertRun(db, sessionId, runId);
    insertEvent(db, runId, 'planning:complete', {
      plans: [
        { id: 'plan-alpha', branch: 'feat/alpha', dependsOn: [] },
        { id: 'plan-beta', branch: 'feat/beta', dependsOn: ['plan-alpha'] },
      ],
    });
    insertEvent(db, runId, 'plan:build:start', { planId: 'plan-alpha' }, 'plan-alpha');
    insertEvent(db, runId, 'plan:build:start', { planId: 'plan-beta' }, 'plan-beta');
    insertEvent(db, runId, 'plan:build:complete', { planId: 'plan-alpha' }, 'plan-alpha');
    insertEvent(db, runId, 'plan:build:failed', { planId: 'plan-beta' }, 'plan-beta');

    const summary = buildRunSummary(db, sessionId);

    expect(summary.plans).toHaveLength(2);

    const alpha = summary.plans.find((p) => p.id === 'plan-alpha');
    expect(alpha!.status).toBe('completed');

    const beta = summary.plans.find((p) => p.id === 'plan-beta');
    expect(beta!.status).toBe('failed');

    db.close();
  });

  // -------------------------------------------------------------------------
  // Case 4: Falls back to build events when planning:complete is absent
  // -------------------------------------------------------------------------

  it('falls back to build events when planning:complete is absent', async () => {
    const tmp = makeTempDir();
    const db = await openTestDb(tmp);
    const sessionId = 'session-fallback';
    const runId = 'run-fallback';

    insertRun(db, sessionId, runId);
    // Real plan:build:start events only carry { planId } — branch/dependsOn
    // are not part of the schema and are never populated by the engine.
    // When planning:complete is absent, these fields fall back to null/[].
    insertEvent(
      db,
      runId,
      'plan:build:start',
      { planId: 'plan-legacy' },
      'plan-legacy',
    );

    const summary = buildRunSummary(db, sessionId);

    expect(summary.plans).toHaveLength(1);
    const plan = summary.plans[0];
    expect(plan.id).toBe('plan-legacy');
    expect(plan.status).toBe('running');
    expect(plan.branch).toBeNull();
    expect(plan.dependsOn).toEqual([]);

    db.close();
  });

  // -------------------------------------------------------------------------
  // Case 5: Prefers latest planning:complete on re-plan
  // -------------------------------------------------------------------------

  it('prefers latest planning:complete on re-plan', async () => {
    const tmp = makeTempDir();
    const db = await openTestDb(tmp);
    const sessionId = 'session-replan';
    const runId = 'run-replan';

    insertRun(db, sessionId, runId);

    // First planning:complete — stale plan ids
    insertEvent(db, runId, 'planning:complete', {
      plans: [
        { id: 'plan-stale-1', branch: 'feat/stale-1', dependsOn: [] },
        { id: 'plan-stale-2', branch: 'feat/stale-2', dependsOn: ['plan-stale-1'] },
      ],
    });

    // Second planning:complete — new plan ids after re-plan
    insertEvent(db, runId, 'planning:complete', {
      plans: [
        { id: 'plan-new-1', branch: 'feat/new-1', dependsOn: [] },
        { id: 'plan-new-2', branch: 'feat/new-2', dependsOn: ['plan-new-1'] },
        { id: 'plan-new-3', branch: 'feat/new-3', dependsOn: ['plan-new-1'] },
      ],
    });

    const summary = buildRunSummary(db, sessionId);

    // Only the latest planning:complete's ids should appear
    expect(summary.plans).toHaveLength(3);
    const ids = summary.plans.map((p) => p.id);
    expect(ids).toContain('plan-new-1');
    expect(ids).toContain('plan-new-2');
    expect(ids).toContain('plan-new-3');
    expect(ids).not.toContain('plan-stale-1');
    expect(ids).not.toContain('plan-stale-2');

    for (const plan of summary.plans) {
      expect(plan.status).toBe('pending');
    }

    db.close();
  });
});
