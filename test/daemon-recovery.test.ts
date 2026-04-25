/**
 * Integration tests for the daemon recovery trigger and HTTP routes.
 *
 * Tests covered:
 * 1. Auto-trigger: when a plan:build:failed event is inserted after server start,
 *    the daemon spawns eforge recover with the correct setName and prdId.
 * 2. Idempotency: a second plan:build:failed event for the same prdId when a
 *    recovery sidecar already exists does NOT spawn a second recover process.
 * 3. No concurrent-build blocking: recovery spawn and a normal build spawn can
 *    both be called without either blocking the other.
 * 4. POST /api/recover: manual trigger route returns sessionId and pid.
 * 5. GET /api/recovery/sidecar: reads and returns sidecar files.
 * 6. DAEMON_API_VERSION is 7.
 * 7. API_ROUTES.recover and API_ROUTES.readRecoverySidecar are exported.
 *
 * Follows AGENTS.md conventions:
 * - No mocks. Real in-process HTTP server. Stub WorkerTracker (hand-crafted).
 * - useTempDir for filesystem cleanup.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { useTempDir } from './test-tmpdir.js';
import { openDatabase } from '@eforge-build/monitor/db';
import { startServer, type WorkerTracker, type MonitorServer } from '@eforge-build/monitor/server';
import {
  DAEMON_API_VERSION,
  API_ROUTES,
} from '@eforge-build/client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface SpawnCall {
  command: string;
  args: string[];
  sessionId: string;
  pid: number;
}

/** Stub WorkerTracker that records spawn calls without actually spawning. */
function makeStubTracker(): { tracker: WorkerTracker; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  let pidCounter = 10000;
  let sessionCounter = 0;

  const tracker: WorkerTracker = {
    spawnWorker(command: string, args: string[]): { sessionId: string; pid: number } {
      const sessionId = `stub-${++sessionCounter}`;
      const pid = ++pidCounter;
      calls.push({ command, args, sessionId, pid });
      return { sessionId, pid };
    },
    cancelWorker(_sessionId: string): boolean {
      return false;
    },
  };

  return { tracker, calls };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const makeTempDir = useTempDir();

let tmpDir: string;
let dbPath: string;
let server: MonitorServer;
let tracker: WorkerTracker;
let spawnCalls: SpawnCall[];

async function setupServer(failedPrdDir?: string): Promise<void> {
  const { tracker: t, calls } = makeStubTracker();
  tracker = t;
  spawnCalls = calls;

  server = await startServer(
    openDatabase(dbPath),
    0, // pick any free port
    {
      strictPort: true,
      cwd: tmpDir,
      failedPrdDir,
      workerTracker: tracker,
    },
  );
}

beforeEach(async () => {
  tmpDir = makeTempDir();
  dbPath = resolve(tmpDir, 'monitor.db');
});

afterEach(async () => {
  await server?.stop();
});

// ---------------------------------------------------------------------------
// 6. DAEMON_API_VERSION is 7
// ---------------------------------------------------------------------------

describe('DAEMON_API_VERSION', () => {
  it('is 7', () => {
    expect(DAEMON_API_VERSION).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// 7. API_ROUTES exports
// ---------------------------------------------------------------------------

describe('API_ROUTES', () => {
  it('exposes recover route', () => {
    expect(API_ROUTES.recover).toBe('/api/recover');
  });

  it('exposes readRecoverySidecar route', () => {
    expect(API_ROUTES.readRecoverySidecar).toBe('/api/recovery/sidecar');
  });
});

// ---------------------------------------------------------------------------
// 4. POST /api/recover — manual trigger
// ---------------------------------------------------------------------------

describe('POST /api/recover', () => {
  beforeEach(async () => {
    await setupServer(tmpDir);
  });

  it('spawns recover with setName and prdId and returns sessionId + pid', async () => {
    const res = await fetch(`http://localhost:${server.port}${API_ROUTES.recover}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setName: 'my-set', prdId: 'plan-01' }),
    });

    expect(res.status).toBe(200);
    const data = await res.json() as { sessionId: string; pid: number };
    expect(typeof data.sessionId).toBe('string');
    expect(typeof data.pid).toBe('number');

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe('recover');
    expect(spawnCalls[0].args).toEqual(['my-set', 'plan-01']);
  });

  it('returns 400 when setName is missing', async () => {
    const res = await fetch(`http://localhost:${server.port}${API_ROUTES.recover}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prdId: 'plan-01' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when prdId is missing', async () => {
    const res = await fetch(`http://localhost:${server.port}${API_ROUTES.recover}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setName: 'my-set' }),
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 5. GET /api/recovery/sidecar — read sidecar files
// ---------------------------------------------------------------------------

describe('GET /api/recovery/sidecar', () => {
  beforeEach(async () => {
    await setupServer(tmpDir);
  });

  it('returns markdown and json sidecar content', async () => {
    // Write fixture sidecar files directly in failedPrdDir (tmpDir), no setName subdir
    await writeFile(resolve(tmpDir, 'plan-01.recovery.md'), '# Recovery Summary\nAll good.');
    await writeFile(
      resolve(tmpDir, 'plan-01.recovery.json'),
      JSON.stringify({ verdict: 'retry', summary: 'retry is recommended', prdId: 'plan-01', setName: 'my-set', timestamp: '2024-01-01T00:00:00Z' }),
    );

    const url = `http://localhost:${server.port}${API_ROUTES.readRecoverySidecar}?setName=my-set&prdId=plan-01`;
    const res = await fetch(url);

    expect(res.status).toBe(200);
    const data = await res.json() as { markdown: string; json: { verdict: string } };
    expect(data.markdown).toContain('Recovery Summary');
    expect(data.json.verdict).toBe('retry');
  });

  it('returns 404 when sidecar files do not exist', async () => {
    const url = `http://localhost:${server.port}${API_ROUTES.readRecoverySidecar}?setName=nonexistent&prdId=plan-99`;
    const res = await fetch(url);
    expect(res.status).toBe(404);
  });

  it('returns 400 when query params are missing', async () => {
    const url = `http://localhost:${server.port}${API_ROUTES.readRecoverySidecar}?setName=my-set`;
    const res = await fetch(url);
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 1. Auto-trigger on plan:build:failed
// ---------------------------------------------------------------------------

describe('auto-trigger on plan:build:failed', () => {
  it('spawns recover when plan:build:failed event is inserted after server start', async () => {
    const planOutputDir = resolve(tmpDir, 'plan-output');
    await mkdir(planOutputDir, { recursive: true });
    await setupServer(planOutputDir);

    const db = openDatabase(dbPath);
    try {
      // Insert a run record (required for foreign key and getRun lookup)
      db.insertRun({
        id: 'run-auto-1',
        sessionId: 'session-auto-1',
        planSet: 'test-set',
        command: 'build',
        status: 'failed',
        startedAt: new Date().toISOString(),
        cwd: tmpDir,
        pid: 99999,
      });

      // Insert the plan:build:failed event
      db.insertEvent({
        runId: 'run-auto-1',
        type: 'plan:build:failed',
        planId: 'plan-01',
        data: JSON.stringify({ type: 'plan:build:failed', planId: 'plan-01', timestamp: new Date().toISOString() }),
        timestamp: new Date().toISOString(),
      });
    } finally {
      db.close();
    }

    // Wait for the poll loop to fire (200ms interval) — give it 3 cycles
    await sleep(800);

    expect(spawnCalls.some((c) => c.command === 'recover' && c.args[0] === 'test-set' && c.args[1] === 'plan-01')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Idempotency: existing sidecar prevents re-spawn
// ---------------------------------------------------------------------------

describe('idempotency: existing sidecar prevents re-spawn', () => {
  it('does not re-spawn recover when sidecar already exists', async () => {
    const planOutputDir = resolve(tmpDir, 'plan-output');
    await mkdir(planOutputDir, { recursive: true });

    // Write the sidecar before the server starts (simulating prior recovery run)
    // Files live directly in failedPrdDir — no setName subdir
    await writeFile(
      resolve(planOutputDir, 'plan-02.recovery.json'),
      JSON.stringify({ verdict: 'skip', summary: 'already recovered', prdId: 'plan-02', setName: 'test-set', timestamp: '2024-01-01T00:00:00Z' }),
    );

    await setupServer(planOutputDir);

    const db = openDatabase(dbPath);
    try {
      db.insertRun({
        id: 'run-idempotent-1',
        sessionId: 'session-idempotent-1',
        planSet: 'test-set',
        command: 'build',
        status: 'failed',
        startedAt: new Date().toISOString(),
        cwd: tmpDir,
        pid: 99999,
      });

      // First failed event
      db.insertEvent({
        runId: 'run-idempotent-1',
        type: 'plan:build:failed',
        planId: 'plan-02',
        data: JSON.stringify({ type: 'plan:build:failed', planId: 'plan-02', timestamp: new Date().toISOString() }),
        timestamp: new Date().toISOString(),
      });
    } finally {
      db.close();
    }

    // Wait for poll loop
    await sleep(800);

    // Sidecar already exists — recover should NOT have been spawned
    const recoverCalls = spawnCalls.filter((c) => c.command === 'recover' && c.args[1] === 'plan-02');
    expect(recoverCalls).toHaveLength(0);
  });

  it('does not re-spawn on second plan:build:failed event when sidecar was created between events', async () => {
    const planOutputDir = resolve(tmpDir, 'plan-output');
    await mkdir(planOutputDir, { recursive: true });
    await setupServer(planOutputDir);

    const db = openDatabase(dbPath);
    try {
      db.insertRun({
        id: 'run-idempotent-2',
        sessionId: 'session-idempotent-2',
        planSet: 'test-set',
        command: 'build',
        status: 'failed',
        startedAt: new Date().toISOString(),
        cwd: tmpDir,
        pid: 99999,
      });

      // First failed event — no sidecar yet, should spawn
      db.insertEvent({
        runId: 'run-idempotent-2',
        type: 'plan:build:failed',
        planId: 'plan-03',
        data: JSON.stringify({ type: 'plan:build:failed', planId: 'plan-03', timestamp: new Date().toISOString() }),
        timestamp: new Date().toISOString(),
      });
    } finally {
      db.close();
    }

    // Wait for first spawn
    await sleep(800);

    const firstSpawnCount = spawnCalls.filter((c) => c.command === 'recover' && c.args[1] === 'plan-03').length;
    expect(firstSpawnCount).toBe(1);

    // Now write the sidecar (simulating recovery agent completing)
    // Files live directly in failedPrdDir — no setName subdir
    await writeFile(
      resolve(planOutputDir, 'plan-03.recovery.json'),
      JSON.stringify({ verdict: 'fixed', summary: 'recovery done', prdId: 'plan-03', setName: 'test-set', timestamp: new Date().toISOString() }),
    );

    // Insert second failed event for the same prdId
    const db2 = openDatabase(dbPath);
    try {
      db2.insertEvent({
        runId: 'run-idempotent-2',
        type: 'plan:build:failed',
        planId: 'plan-03',
        data: JSON.stringify({ type: 'plan:build:failed', planId: 'plan-03', timestamp: new Date().toISOString() }),
        timestamp: new Date().toISOString(),
      });
    } finally {
      db2.close();
    }

    // Wait for second poll cycle
    await sleep(800);

    // Should still be exactly 1 (no second spawn)
    const secondSpawnCount = spawnCalls.filter((c) => c.command === 'recover' && c.args[1] === 'plan-03').length;
    expect(secondSpawnCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Recovery spawn does not block a concurrent build spawn
// ---------------------------------------------------------------------------

describe('recovery and build spawns do not block each other', () => {
  it('both recover and enqueue spawns complete independently', async () => {
    const planOutputDir = resolve(tmpDir, 'plan-output');
    await mkdir(planOutputDir, { recursive: true });
    await setupServer(planOutputDir);

    // Trigger a manual recover spawn
    const recoverRes = await fetch(`http://localhost:${server.port}${API_ROUTES.recover}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setName: 'set-a', prdId: 'plan-x' }),
    });
    expect(recoverRes.status).toBe(200);

    // Trigger a normal enqueue spawn via the API
    const enqueueRes = await fetch(`http://localhost:${server.port}${API_ROUTES.enqueue}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'my-prd.md' }),
    });
    expect(enqueueRes.status).toBe(200);

    // Both spawns should have been recorded
    const recoverCall = spawnCalls.find((c) => c.command === 'recover');
    const enqueueCall = spawnCalls.find((c) => c.command === 'enqueue');
    expect(recoverCall).toBeDefined();
    expect(enqueueCall).toBeDefined();
  });
});
