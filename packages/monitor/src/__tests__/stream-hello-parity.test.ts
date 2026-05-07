/**
 * Parity test: `stream:hello` snapshot fields must deep-equal the corresponding
 * REST endpoint payloads when both observe the same daemon state.
 *
 * Covers:
 *  - snapshot.runs      === GET /api/runs
 *  - snapshot.queue     === GET /api/queue
 *  - snapshot.sessionMetadata === GET /api/session-metadata
 *  - snapshot.autoBuild === GET /api/auto-build
 *
 * Follows AGENTS.md conventions:
 * - No mocks. Real SQLite DB via openDatabase. Real HTTP via startServer.
 * - Constructs inputs inline.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { openDatabase } from '../db.js';
import { startServer } from '../server.js';
import { withRecording } from '../recorder.js';
import type { MonitorServer, DaemonState } from '../server.js';
import type { EforgeEvent } from '@eforge-build/engine/events';

function makeTmpCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), 'eforge-hello-parity-'));
  mkdirSync(join(dir, '.eforge'), { recursive: true });
  mkdirSync(join(dir, '.eforge', 'queue-locks'), { recursive: true });
  return dir;
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

/**
 * Collect SSE blocks from an HTTP response body.
 * Resolves once `minBlocks` complete SSE blocks (separated by double-newline)
 * have been received, or after `timeoutMs` ms.
 */
function fetchSseFirstChunk(
  url: string,
  minBlocks = 1,
  timeoutMs = 2000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let resolved = false;

    function tryResolve(): void {
      if (resolved) return;
      // Count blocks terminated by `\n\n` (or `\r\n\r\n`). `split` returns
      // `parts.length - 1` separator occurrences; a buffer like `"partial"`
      // with no terminator yields `parts.length - 1 === 0`, so we don't
      // mistakenly resolve on a partial first chunk.
      const parts = buffer.split(/\r?\n\r?\n/);
      const completeBlocks = parts.length - 1;
      if (completeBlocks >= minBlocks) {
        resolved = true;
        req.destroy();
        resolve(buffer);
      }
    }

    const req = http.get(url, { headers: { accept: 'text/event-stream' } }, (res) => {
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`Non-2xx status: ${res.statusCode}`));
        return;
      }
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        tryResolve();
      });
      res.on('end', () => {
        if (!resolved) { resolved = true; resolve(buffer); }
      });
      res.on('error', (err) => {
        if (!resolved) { resolved = true; reject(err); }
      });
    });
    req.on('error', () => {
      if (!resolved) { resolved = true; resolve(buffer); }
    });
    setTimeout(() => {
      if (!resolved) { resolved = true; req.destroy(); resolve(buffer); }
    }, timeoutMs);
  });
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

async function* asGenerator(events: EforgeEvent[]): AsyncGenerator<EforgeEvent> {
  for (const event of events) yield event;
}

async function drainRecording(gen: AsyncGenerator<EforgeEvent>): Promise<void> {
  for await (const _e of gen) { /* drain */ }
}

describe('stream:hello snapshot parity with REST endpoints', () => {
  it('stream:hello runs/queue/sessionMetadata/autoBuild equal the corresponding REST payloads', async () => {
    const cwd = makeTmpCwd();
    const db = openDatabase(join(cwd, '.eforge', 'monitor.db'));

    const now = new Date().toISOString();

    // --- Seed runs: one running, one completed with all fields ---
    const runId1 = `run-running-${Date.now()}`;
    const sessionId1 = `sess-running-${Date.now()}`;
    db.insertRun({
      id: runId1,
      sessionId: sessionId1,
      planSet: 'my-expedition',
      command: 'compile',
      status: 'running',
      startedAt: now,
      cwd,
      pid: 42,
    });

    const runId2 = `run-done-${Date.now()}`;
    const sessionId2 = `sess-done-${Date.now()}`;
    db.insertRun({
      id: runId2,
      sessionId: sessionId2,
      planSet: 'my-expedition',
      command: 'build',
      status: 'running',
      startedAt: now,
      cwd,
      pid: 43,
    });
    db.updateRunStatus(runId2, 'completed', now);

    // --- Seed session metadata events ---
    // session:profile event for session1
    db.insertEvent({
      runId: runId1,
      type: 'session:profile',
      data: JSON.stringify({ type: 'session:profile', timestamp: now, profileName: 'test-profile', source: 'project', scope: 'project', config: null }),
      timestamp: now,
    });
    // planning:complete event for session1
    db.insertEvent({
      runId: runId1,
      type: 'planning:complete',
      data: JSON.stringify({ type: 'planning:complete', timestamp: now, plans: [{ id: 'plan-a' }, { id: 'plan-b' }] }),
      timestamp: now,
    });

    // --- Seed queue: pending PRD, pending PRD with depends_on, and failed PRD with recovery sidecar ---
    const queueDir = join(cwd, 'eforge', 'queue');
    mkdirSync(queueDir, { recursive: true });
    const prdContent = '---\ntitle: Test PRD for parity\npriority: 5\n---\n\n# My PRD\n';
    writeFileSync(join(queueDir, 'test-prd.md'), prdContent, 'utf-8');

    // A pending PRD with depends_on: one live dep (test-prd) and one missing dep
    const prdWithDepsContent = '---\ntitle: PRD with deps\npriority: 3\ndepends_on: [test-prd, nonexistent-dep]\n---\n\n# PRD with deps\n';
    writeFileSync(join(queueDir, 'test-prd-with-deps.md'), prdWithDepsContent, 'utf-8');

    // A failed PRD with a recovery.json sidecar — exercises the recoveryVerdict branch
    const failedDir = join(queueDir, 'failed');
    mkdirSync(failedDir, { recursive: true });
    const failedPrdContent = '---\ntitle: Failed PRD\npriority: 1\n---\n\n# Failed PRD\n';
    writeFileSync(join(failedDir, 'failed-prd.md'), failedPrdContent, 'utf-8');
    const recoverySidecar = JSON.stringify({
      verdict: { verdict: 'retry', confidence: 'high' },
    });
    writeFileSync(join(failedDir, 'failed-prd.recovery.json'), recoverySidecar, 'utf-8');

    // --- Configure daemonState ---
    const daemonState: DaemonState = {
      autoBuild: true,
      autoBuildPaused: false,
      watcher: {
        running: true,
        pid: 99,
        sessionId: 'sess-99',
      },
    };

    // --- Start server ---
    const server = await startServer(db, 0, { cwd, daemonState });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;

    // --- Capture stream:hello from /api/daemon-events ---
    const raw = await fetchSseFirstChunk(`${base}/api/daemon-events`, 1, 2000);
    const blocks = raw.trim().split(/\r?\n\r?\n/).filter(Boolean);
    const helloBlock = blocks.find((b) => b.includes('event: stream:hello'));
    expect(helloBlock).toBeDefined();

    const helloDataLine = helloBlock!.split('\n').find((l) => l.startsWith('data:'));
    expect(helloDataLine).toBeDefined();
    const helloData = JSON.parse(helloDataLine!.slice('data: '.length)) as {
      cursor: number;
      runs: unknown;
      queue: unknown;
      sessionMetadata: unknown;
      autoBuild: unknown;
    };

    // --- Fetch REST endpoints ---
    const [restRuns, restQueue, restSessionMetadata, restAutoBuild] = await Promise.all([
      fetchJson(`${base}/api/runs`),
      fetchJson(`${base}/api/queue`),
      fetchJson(`${base}/api/session-metadata`),
      fetchJson(`${base}/api/auto-build`),
    ]);

    // --- Defensive non-empty/value assertions ---
    // Without these, the parity test would still pass if both sides returned
    // empty/default data due to a shared regression. Assert the seeded state
    // actually surfaces in the REST payloads before comparing parity.
    expect(Array.isArray(restRuns)).toBe(true);
    expect((restRuns as unknown[]).length).toBe(2);
    expect(Array.isArray(restQueue)).toBe(true);
    expect((restQueue as unknown[]).length).toBe(3);
    expect(restSessionMetadata).toEqual({
      [sessionId1]: { planCount: 2, baseProfile: 'test-profile' },
    });
    expect(restAutoBuild).toEqual({
      enabled: true,
      watcher: { running: true, pid: 99, sessionId: 'sess-99' },
    });

    // --- Assert parity ---
    expect(helloData.runs).toEqual(restRuns);
    expect(helloData.queue).toEqual(restQueue);
    expect(helloData.sessionMetadata).toEqual(restSessionMetadata);
    expect(helloData.autoBuild).toEqual(restAutoBuild);

    await server.stop();
    db.close();
  });

  it('live daemon:run:upsert projection equals stream:hello snapshot runs after reconnect', async () => {
    const cwd = makeTmpCwd();
    const db = openDatabase(join(cwd, '.eforge', 'monitor.db'));
    const ts = new Date().toISOString();

    // Drive withRecording with a synthetic enqueue sequence.
    // This causes the recorder to insert runs and daemon:run:upsert events.
    const enqueueEvents: EforgeEvent[] = [
      { type: 'session:start', sessionId: 'sess-live-enq', timestamp: ts },
      { type: 'enqueue:start', source: 'api', timestamp: ts },
      {
        type: 'enqueue:complete',
        id: 'prd-live',
        filePath: '/queue/prd-live.md',
        title: 'Live Feature',
        planSet: 'live-feature',
        timestamp: ts,
      },
      { type: 'session:end', sessionId: 'sess-live-enq', result: { status: 'completed', summary: 'done' }, timestamp: ts },
    ];
    await drainRecording(withRecording(asGenerator(enqueueEvents), db, cwd));

    // Also add a phase-driven compile run
    const compileTs = new Date().toISOString();
    const compileRunId = `run-compile-${Date.now()}`;
    const compileSessionId = `sess-compile-${Date.now()}`;
    const phaseEvents: EforgeEvent[] = [
      { type: 'session:start', sessionId: compileSessionId, timestamp: compileTs },
      { type: 'phase:start', runId: compileRunId, sessionId: compileSessionId, planSet: 'live-feature', command: 'compile', timestamp: compileTs },
      { type: 'phase:end', runId: compileRunId, result: { status: 'completed', summary: 'done' }, timestamp: compileTs },
      { type: 'session:end', sessionId: compileSessionId, result: { status: 'completed', summary: 'done' }, timestamp: compileTs },
    ];
    await drainRecording(withRecording(asGenerator(phaseEvents), db, cwd));

    // Start server
    const server = await startServer(db, 0, { cwd });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;

    // --- Fetch stream:hello snapshot ---
    const raw = await fetchSseFirstChunk(`${base}/api/daemon-events`, 1, 2000);
    const blocks = raw.trim().split(/\r?\n\r?\n/).filter(Boolean);
    const helloBlock = blocks.find((b) => b.includes('event: stream:hello'));
    expect(helloBlock).toBeDefined();
    const helloDataLine = helloBlock!.split('\n').find((l) => l.startsWith('data:'));
    expect(helloDataLine).toBeDefined();
    const helloData = JSON.parse(helloDataLine!.slice('data: '.length)) as {
      runs: unknown[];
    };

    // --- Fetch REST /api/runs for ground truth ---
    const restRuns = await fetchJson(`${base}/api/runs`) as unknown[];

    expect(restRuns.length).toBeGreaterThanOrEqual(2);

    // Parity: stream:hello runs === REST /api/runs
    expect(helloData.runs).toEqual(restRuns);

    // --- Apply daemon:run:upsert events from DB to verify live projection parity ---
    // Collect all daemon:run:upsert events persisted by withRecording and build
    // a live runs array by applying each upsert in order. This simulates what
    // the daemonReducer does when receiving daemon:run:upsert via SSE.
    const daemonEvents = db.getDaemonEventsAfter(0);
    const liveRuns = new Map<string, Record<string, unknown>>();
    for (const dbEvent of daemonEvents) {
      if (dbEvent.type !== 'daemon:run:upsert') continue;
      let parsed: { run: Record<string, unknown> };
      try {
        parsed = JSON.parse(dbEvent.data) as { run: Record<string, unknown> };
      } catch {
        continue;
      }
      if (parsed.run?.id && typeof parsed.run.id === 'string') {
        liveRuns.set(parsed.run.id as string, parsed.run);
      }
    }

    // The live-applied run IDs must match the REST /api/runs IDs
    const liveRunIds = new Set(liveRuns.keys());
    const restRunIds = new Set((restRuns as { id: string }[]).map((r) => r.id));
    expect(liveRunIds).toEqual(restRunIds);

    // Stronger parity: the live-projected RunInfo for each id must deep-equal
    // the REST /api/runs row. ID-set parity alone would still pass if statuses
    // or other fields drifted between live deltas and the snapshot.
    for (const restRun of restRuns as Record<string, unknown>[]) {
      const id = restRun.id as string;
      const liveRun = liveRuns.get(id);
      expect(liveRun, `live run for id=${id}`).toBeDefined();
      expect(liveRun).toEqual(restRun);
    }

    await server.stop();
    db.close();
  });
});
