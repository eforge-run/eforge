/**
 * Tests that GET /api/queue attaches recoveryVerdict for failed items with valid
 * recovery sidecars, and omits it for items with missing or malformed sidecars.
 *
 * Layout used across all tests:
 *   - eforge/queue/pending-prd.md        → pending item (no sidecar, irrelevant)
 *   - eforge/queue/failed/with-sidecar.md + .recovery.json  → verdict embedded
 *   - eforge/queue/failed/no-sidecar.md                     → verdict absent (missing JSON)
 *   - eforge/queue/failed/bad-sidecar.md + .recovery.json   → verdict absent (malformed JSON)
 *
 * Follows AGENTS.md conventions:
 * - No mocks. Real SQLite, real filesystem, real HTTP server.
 * - useTempDir for cleanup.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { useTempDir } from './test-tmpdir.js';
import { openDatabase } from '@eforge-build/monitor/db';
import { startServer, type MonitorServer } from '@eforge-build/monitor/server';
import { API_ROUTES } from '@eforge-build/client';
import type { QueueItem } from '@eforge-build/client';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const PENDING_PRD_ID = 'pending-prd';
const FAILED_WITH_SIDECAR_ID = 'with-sidecar';
const FAILED_NO_SIDECAR_ID = 'no-sidecar';
const FAILED_BAD_SIDECAR_ID = 'bad-sidecar';

async function seedQueueFixtures(dir: string): Promise<void> {
  const queueDir = join(dir, 'eforge', 'queue');
  const failedDir = join(queueDir, 'failed');
  await mkdir(queueDir, { recursive: true });
  await mkdir(failedDir, { recursive: true });

  // Pending PRD (no sidecar — unrelated)
  await writeFile(
    join(queueDir, `${PENDING_PRD_ID}.md`),
    `---\ntitle: Pending PRD\ncreated: 2024-01-01\n---\n\n# Pending\n`,
  );

  // Failed PRD with valid sidecar (retry verdict, high confidence)
  await writeFile(
    join(failedDir, `${FAILED_WITH_SIDECAR_ID}.md`),
    `---\ntitle: Failed With Sidecar\ncreated: 2024-01-01\n---\n\n# Failed\n`,
  );
  await writeFile(
    join(failedDir, `${FAILED_WITH_SIDECAR_ID}.recovery.json`),
    JSON.stringify({
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      summary: {
        prdId: FAILED_WITH_SIDECAR_ID,
        setName: 'test-set',
        featureBranch: 'eforge/test-set',
        baseBranch: 'main',
        plans: [],
        failingPlan: { planId: 'plan-01' },
        landedCommits: [],
        diffStat: '',
        modelsUsed: [],
        failedAt: new Date().toISOString(),
      },
      verdict: {
        verdict: 'retry',
        confidence: 'high',
        rationale: 'Transient build failure.',
        completedWork: [],
        remainingWork: [],
        risks: [],
      },
    }, null, 2),
  );

  // Failed PRD with no sidecar JSON
  await writeFile(
    join(failedDir, `${FAILED_NO_SIDECAR_ID}.md`),
    `---\ntitle: Failed No Sidecar\ncreated: 2024-01-01\n---\n\n# Failed\n`,
  );
  // (no .recovery.json written for FAILED_NO_SIDECAR_ID)

  // Failed PRD with malformed sidecar JSON
  await writeFile(
    join(failedDir, `${FAILED_BAD_SIDECAR_ID}.md`),
    `---\ntitle: Failed Bad Sidecar\ncreated: 2024-01-01\n---\n\n# Failed\n`,
  );
  await writeFile(
    join(failedDir, `${FAILED_BAD_SIDECAR_ID}.recovery.json`),
    'THIS IS NOT JSON {{{',
  );
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const makeTempDir = useTempDir('eforge-queue-verdict-test-');

let tmpDir: string;
let dbPath: string;
let server: MonitorServer;

beforeEach(async () => {
  tmpDir = makeTempDir();
  dbPath = resolve(tmpDir, 'monitor.db');
  await seedQueueFixtures(tmpDir);

  server = await startServer(
    openDatabase(dbPath),
    0,
    { strictPort: true, cwd: tmpDir },
  );
});

afterEach(async () => {
  await server?.stop();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/queue — recoveryVerdict embedding', () => {
  async function fetchQueue(): Promise<QueueItem[]> {
    const res = await fetch(`http://localhost:${server.port}${API_ROUTES.queue}`);
    expect(res.status).toBe(200);
    return res.json() as Promise<QueueItem[]>;
  }

  it('attaches recoveryVerdict for failed item with valid sidecar', async () => {
    const items = await fetchQueue();
    const item = items.find((i) => i.id === FAILED_WITH_SIDECAR_ID);
    expect(item).toBeDefined();
    expect(item!.status).toBe('failed');
    expect(item!.recoveryVerdict).toBeDefined();
    expect(item!.recoveryVerdict!.verdict).toBe('retry');
    expect(item!.recoveryVerdict!.confidence).toBe('high');
  });

  it('omits recoveryVerdict for failed item with missing sidecar JSON', async () => {
    const items = await fetchQueue();
    const item = items.find((i) => i.id === FAILED_NO_SIDECAR_ID);
    expect(item).toBeDefined();
    expect(item!.status).toBe('failed');
    expect(item!.recoveryVerdict).toBeUndefined();
  });

  it('omits recoveryVerdict for failed item with malformed sidecar JSON', async () => {
    const items = await fetchQueue();
    const item = items.find((i) => i.id === FAILED_BAD_SIDECAR_ID);
    expect(item).toBeDefined();
    expect(item!.status).toBe('failed');
    expect(item!.recoveryVerdict).toBeUndefined();
  });

  it('does not set recoveryVerdict on pending items', async () => {
    const items = await fetchQueue();
    const item = items.find((i) => i.id === PENDING_PRD_ID);
    expect(item).toBeDefined();
    expect(item!.status).toBe('pending');
    expect(item!.recoveryVerdict).toBeUndefined();
  });

  it('other items still load correctly when one sidecar is malformed', async () => {
    const items = await fetchQueue();
    // All four items should still appear
    const ids = items.map((i) => i.id);
    expect(ids).toContain(PENDING_PRD_ID);
    expect(ids).toContain(FAILED_WITH_SIDECAR_ID);
    expect(ids).toContain(FAILED_NO_SIDECAR_ID);
    expect(ids).toContain(FAILED_BAD_SIDECAR_ID);
  });
});
