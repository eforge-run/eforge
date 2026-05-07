/**
 * Tests that the run DB read path produces the canonical `RunInfo` wire shape.
 *
 * Covers:
 *  (a) A run with all `RunInfo` fields populated (including `pid`, `sessionId`,
 *      `completedAt`) round-trips through `GET /api/runs` as exact deep-equal JSON.
 *  (b) A run without optional fields (`pid`, `sessionId`, `completedAt`) produces
 *      a wire object that omits those keys (not serialized as `null`).
 *
 * Follows AGENTS.md conventions:
 * - No mocks. Real SQLite DB via openDatabase. Real HTTP via startServer.
 * - Constructs inputs inline.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db.js';
import { startServer } from '../server.js';
import type { MonitorServer } from '../server.js';
import type { RunInfo } from '@eforge-build/client';

function makeTmpCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), 'eforge-runs-roundtrip-'));
  mkdirSync(join(dir, '.eforge'), { recursive: true });
  return dir;
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

const servers: MonitorServer[] = [];

afterEach(async () => {
  for (const s of servers) {
    try {
      await s.stop();
    } catch {
      // best-effort
    }
  }
  servers.length = 0;
});

describe('GET /api/runs — canonical RunInfo round-trip', () => {
  it('returns a deep-equal canonical RunInfo for a run with all fields populated', async () => {
    const cwd = makeTmpCwd();
    const db = openDatabase(join(cwd, '.eforge', 'monitor.db'));

    const startedAt = '2024-01-01T00:00:00.000Z';
    const completedAt = '2024-01-01T01:00:00.000Z';
    const runId = `run-all-fields-${Date.now()}`;
    const sessionId = `sess-all-${Date.now()}`;

    db.insertRun({
      id: runId,
      sessionId,
      planSet: 'my-plan-set',
      command: 'compile',
      status: 'running',
      startedAt,
      cwd,
      pid: 12345,
    });
    db.updateRunStatus(runId, 'completed', completedAt);

    const server = await startServer(db, 0, { cwd });
    servers.push(server);

    const runs = await fetchJson(`http://127.0.0.1:${server.port}/api/runs`) as RunInfo[];
    const run = runs.find((r) => r.id === runId);

    expect(run).toBeDefined();

    const expected: RunInfo = {
      id: runId,
      sessionId,
      planSet: 'my-plan-set',
      command: 'compile',
      status: 'completed',
      startedAt,
      completedAt,
      cwd,
      pid: 12345,
    };

    expect(run).toEqual(expected);

    // Direct DB-level assertions: verify rowToRunInfo wiring for all read methods
    expect(db.getRun(runId)).toEqual(expected);
    // Run is completed, so getRunningRuns should not include it
    expect(db.getRunningRuns().find((r) => r.id === runId)).toBeUndefined();
    // getRunsBySession and getSessionRuns should both return the run
    expect(db.getRunsBySession(sessionId).find((r) => r.id === runId)).toEqual(expected);
    expect(db.getSessionRuns(sessionId).find((r) => r.id === runId)).toEqual(expected);

    await server.stop();
    db.close();
  });

  it('omits optional keys (not serialized as null) for a run without pid, sessionId, or completedAt', async () => {
    const cwd = makeTmpCwd();
    const db = openDatabase(join(cwd, '.eforge', 'monitor.db'));

    const startedAt = '2024-02-01T00:00:00.000Z';
    const runId = `run-minimal-${Date.now()}`;

    // Insert a run without optional fields — no sessionId, no pid
    db.insertRun({
      id: runId,
      planSet: 'bare-plan-set',
      command: 'build',
      status: 'running',
      startedAt,
      cwd,
    });
    // No updateRunStatus call — completedAt stays null

    const server = await startServer(db, 0, { cwd });
    servers.push(server);

    const runs = await fetchJson(`http://127.0.0.1:${server.port}/api/runs`) as RunInfo[];
    const run = runs.find((r) => r.id === runId);
    expect(run).toBeDefined();

    // Optional fields must be absent (undefined → omitted in JSON), not present as null
    const runJson = JSON.stringify(run);
    const parsed = JSON.parse(runJson) as Record<string, unknown>;
    expect('sessionId' in parsed).toBe(false);
    expect('completedAt' in parsed).toBe(false);
    expect('pid' in parsed).toBe(false);

    // Required fields must be present
    expect(parsed.id).toBe(runId);
    expect(parsed.planSet).toBe('bare-plan-set');
    expect(parsed.command).toBe('build');
    expect(parsed.status).toBe('running');
    expect(parsed.startedAt).toBe(startedAt);
    expect(parsed.cwd).toBe(cwd);

    // Direct DB-level assertions: verify rowToRunInfo wiring for all read methods
    const expectedMinimal: RunInfo = {
      id: runId,
      planSet: 'bare-plan-set',
      command: 'build',
      status: 'running',
      startedAt,
      cwd,
    };
    expect(db.getRun(runId)).toEqual(expectedMinimal);
    // Run is still running, so getRunningRuns should include it
    expect(db.getRunningRuns().find((r) => r.id === runId)).toEqual(expectedMinimal);

    await server.stop();
    db.close();
  });
});
