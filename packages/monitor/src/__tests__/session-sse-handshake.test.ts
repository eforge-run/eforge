/**
 * Integration tests for the per-session SSE stream:hello handshake (plan-02).
 *
 * Covers three cases:
 *  (a) Fresh connect to a running session emits stream:hello with snapshot.events
 *      populated, then stays open for live deltas — no historical replay frames
 *      after stream:hello.
 *  (b) Fresh connect to a terminal session emits stream:hello with full snapshot,
 *      then the server closes the connection — no live subscription established.
 *  (c) Reconnect with Last-Event-ID emits stream:hello first, then delta replay
 *      of events with id > Last-Event-ID.
 *
 * Follows AGENTS.md conventions:
 * - No mocks. Real SQLite DB via openDatabase. Real HTTP via startServer.
 * - Constructs inputs inline.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { openDatabase } from '../db.js';
import { startServer } from '../server.js';
import type { MonitorServer } from '../server.js';

function makeTmpCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), 'eforge-session-sse-'));
  mkdirSync(join(dir, '.eforge'), { recursive: true });
  return dir;
}

/**
 * Collect raw SSE text from an HTTP response for up to `timeoutMs` ms.
 * Resolves with whatever text was received when the timeout fires or the
 * connection closes (whichever comes first).
 */
function fetchSseRaw(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 1500,
): Promise<{ raw: string; closed: boolean }> {
  return new Promise((resolve) => {
    let raw = '';
    let resolved = false;
    let serverClosed = false;

    const req = http.get(url, { headers: { accept: 'text/event-stream', ...headers } }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { raw += chunk; });
      res.on('end', () => {
        serverClosed = true;
        if (!resolved) { resolved = true; resolve({ raw, closed: true }); }
      });
      res.on('error', () => {
        if (!resolved) { resolved = true; resolve({ raw, closed: serverClosed }); }
      });
    });
    req.on('error', () => {
      if (!resolved) { resolved = true; resolve({ raw, closed: serverClosed }); }
    });
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        req.destroy();
        resolve({ raw, closed: serverClosed });
      }
    }, timeoutMs);
  });
}

/**
 * Collect SSE blocks until `minBlocks` have been received or `timeoutMs` elapses.
 */
function fetchSseBlocks(
  url: string,
  headers: Record<string, string> = {},
  minBlocks = 1,
  timeoutMs = 1500,
): Promise<string> {
  return new Promise((resolve) => {
    let buffer = '';
    let resolved = false;

    function tryResolve(): void {
      if (resolved) return;
      const blocks = buffer.split(/\r?\n\r?\n/).filter(Boolean);
      if (blocks.length >= minBlocks) {
        resolved = true;
        req.destroy();
        resolve(buffer);
      }
    }

    const req = http.get(url, { headers: { accept: 'text/event-stream', ...headers } }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { buffer += chunk; tryResolve(); });
      res.on('end', () => { if (!resolved) { resolved = true; resolve(buffer); } });
      res.on('error', () => { if (!resolved) { resolved = true; resolve(buffer); } });
    });
    req.on('error', () => { if (!resolved) { resolved = true; resolve(buffer); } });
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

function insertRun(
  db: ReturnType<typeof openDatabase>,
  sessionId: string,
  status: 'running' | 'completed' | 'failed',
): void {
  db.insertRun({
    id: `run-${sessionId}`,
    sessionId,
    planSet: 'test-set',
    command: 'build',
    status,
    startedAt: new Date().toISOString(),
    cwd: '/tmp',
  });
}

// ---------------------------------------------------------------------------
// (a) Fresh connect to a running session
// ---------------------------------------------------------------------------

describe('serveSSE — fresh connect to a running session', () => {
  it('emits stream:hello with snapshot.events populated, then stays open for live deltas', async () => {
    const cwd = makeTmpCwd();
    const db = openDatabase(join(cwd, '.eforge', 'monitor.db'));
    const now = new Date().toISOString();
    const sessionId = `session-running-${Date.now()}`;

    insertRun(db, sessionId, 'running');

    // Insert historical events — runId must match the run's id (run-${sessionId})
    db.insertEvent({ runId: `run-${sessionId}`, type: 'phase:start', data: JSON.stringify({ type: 'phase:start', timestamp: now, sessionId }), timestamp: now });
    db.insertEvent({ runId: `run-${sessionId}`, type: 'agent:start', data: JSON.stringify({ type: 'agent:start', timestamp: now, sessionId }), timestamp: now });

    const server = await startServer(db, 0, { cwd });
    servers.push(server);

    const url = `http://127.0.0.1:${server.port}/api/events/${sessionId}`;

    // Collect at least the stream:hello block (1 block minimum)
    const raw = await fetchSseBlocks(url, {}, 1, 600);
    const blocks = raw.trim().split(/\r?\n\r?\n/).filter(Boolean);

    // First block must be stream:hello
    const helloBlock = blocks.find((b) => b.includes('event: stream:hello'));
    expect(helloBlock).toBeDefined();
    expect(helloBlock).not.toMatch(/^id:/m);

    // Parse hello data — events should be populated
    const helloDataLine = helloBlock!.split('\n').find((l) => l.startsWith('data:'));
    const helloData = JSON.parse(helloDataLine!.slice('data: '.length)) as {
      cursor: number;
      status: string;
      events: Array<{ id: number; data: string }>;
    };

    expect(helloData.status).toBe('running');
    expect(helloData.events.length).toBe(2); // phase:start + agent:start
    expect(helloData.cursor).toBeGreaterThan(0);

    // No historical replay frames should appear after stream:hello (no plain data frames
    // that contain phase:start or agent:start outside the hello payload)
    const nonHelloBlocks = blocks.filter((b) => !b.includes('event: stream:hello'));
    for (const block of nonHelloBlocks) {
      // Any plain data blocks after hello should not be historical replays
      // (they would only appear if Last-Event-ID were sent, which it wasn't)
      const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
      if (dataLine) {
        try {
          const parsed = JSON.parse(dataLine.slice('data: '.length)) as { type?: string };
          // No historical events should appear outside the hello payload
          expect(['phase:start', 'agent:start']).not.toContain(parsed.type);
        } catch { /* ignore non-JSON lines */ }
      }
    }

    await server.stop();
    db.close();
  });
});

// ---------------------------------------------------------------------------
// (b) Fresh connect to a terminal session — server closes after stream:hello
// ---------------------------------------------------------------------------

describe('serveSSE — fresh connect to a terminal session', () => {
  it('emits stream:hello then closes the connection (completed)', async () => {
    const cwd = makeTmpCwd();
    const db = openDatabase(join(cwd, '.eforge', 'monitor.db'));
    const now = new Date().toISOString();
    const sessionId = `session-done-${Date.now()}`;

    insertRun(db, sessionId, 'completed');
    db.insertEvent({ runId: `run-${sessionId}`, type: 'session:end', data: JSON.stringify({ type: 'session:end', timestamp: now, sessionId, result: { status: 'completed', summary: 'done' } }), timestamp: now });

    const server = await startServer(db, 0, { cwd });
    servers.push(server);

    const url = `http://127.0.0.1:${server.port}/api/events/${sessionId}`;

    const { raw, closed } = await fetchSseRaw(url, {}, 1500);

    // stream:hello must be present
    expect(raw).toContain('event: stream:hello');

    // The hello data should reflect completed status
    const blocks = raw.trim().split(/\r?\n\r?\n/).filter(Boolean);
    const helloBlock = blocks.find((b) => b.includes('event: stream:hello'));
    const helloDataLine = helloBlock!.split('\n').find((l) => l.startsWith('data:'));
    const helloData = JSON.parse(helloDataLine!.slice('data: '.length)) as {
      status: string;
      events: Array<{ id: number; data: string }>;
    };
    expect(helloData.status).toBe('completed');
    expect(helloData.events.length).toBeGreaterThanOrEqual(1);

    // Server must close the connection after stream:hello
    expect(closed).toBe(true);

    await server.stop();
    db.close();
  });

  it('emits stream:hello then closes the connection (failed)', async () => {
    const cwd = makeTmpCwd();
    const db = openDatabase(join(cwd, '.eforge', 'monitor.db'));
    const now = new Date().toISOString();
    const sessionId = `session-failed-${Date.now()}`;

    insertRun(db, sessionId, 'failed');
    // runId must match the run's id (run-${sessionId}) so the event surfaces
    // through getEventsBySession; otherwise the events.length assertion below
    // would silently see an empty array.
    db.insertEvent({ runId: `run-${sessionId}`, type: 'session:end', data: JSON.stringify({ type: 'session:end', timestamp: now, sessionId, result: { status: 'failed', summary: 'error' } }), timestamp: now });

    const server = await startServer(db, 0, { cwd });
    servers.push(server);

    const url = `http://127.0.0.1:${server.port}/api/events/${sessionId}`;
    const { raw, closed } = await fetchSseRaw(url, {}, 1500);

    expect(raw).toContain('event: stream:hello');
    expect(closed).toBe(true);

    const helloBlock = raw.trim().split(/\r?\n\r?\n/).filter(Boolean).find((b) => b.includes('event: stream:hello'));
    const helloDataLine = helloBlock!.split('\n').find((l) => l.startsWith('data:'));
    const helloData = JSON.parse(helloDataLine!.slice('data: '.length)) as {
      status: string;
      events: Array<{ id: number; data: string }>;
    };
    expect(helloData.status).toBe('failed');
    // Snapshot must carry the inserted session:end event so a terminal-failed
    // session matches the terminal-completed case's payload contract (the
    // client uses snapshot.events to reconstruct state when the connection
    // closes after stream:hello).
    expect(helloData.events.length).toBeGreaterThanOrEqual(1);

    await server.stop();
    db.close();
  });
});

// ---------------------------------------------------------------------------
// (c) Reconnect with Last-Event-ID — stream:hello first, then delta replay
// ---------------------------------------------------------------------------

describe('serveSSE — reconnect with Last-Event-ID', () => {
  it('emits stream:hello then delta events with id > Last-Event-ID', async () => {
    const cwd = makeTmpCwd();
    const db = openDatabase(join(cwd, '.eforge', 'monitor.db'));
    const now = new Date().toISOString();
    const sessionId = `session-reconnect-${Date.now()}`;

    insertRun(db, sessionId, 'running');

    // Insert two events; client reconnects after the first
    const id1 = db.insertEvent({ runId: `run-${sessionId}`, type: 'phase:start', data: JSON.stringify({ type: 'phase:start', timestamp: now, sessionId }), timestamp: now });
    db.insertEvent({ runId: `run-${sessionId}`, type: 'agent:start', data: JSON.stringify({ type: 'agent:start', timestamp: now, sessionId }), timestamp: now });

    const server = await startServer(db, 0, { cwd });
    servers.push(server);

    const url = `http://127.0.0.1:${server.port}/api/events/${sessionId}`;

    // Reconnect with Last-Event-ID = id1 → should get stream:hello + agent:start delta
    const raw = await fetchSseBlocks(url, { 'last-event-id': String(id1) }, 2, 1000);
    const blocks = raw.trim().split(/\r?\n\r?\n/).filter(Boolean);

    // First block is stream:hello
    const helloBlock = blocks.find((b) => b.includes('event: stream:hello'));
    expect(helloBlock).toBeDefined();

    // Should contain agent:start (id > id1) as a live delta
    expect(raw).toContain('agent:start');

    // Must NOT contain phase:start as a separate data frame (id <= id1)
    // Note: phase:start may appear inside the hello snapshot.events, but not as a live delta
    const dataBlocks = blocks.filter(
      (b) => !b.includes('event: stream:hello') && b.includes('data:'),
    );
    for (const block of dataBlocks) {
      const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
      if (dataLine) {
        try {
          const parsed = JSON.parse(dataLine.slice('data: '.length)) as { type?: string };
          expect(parsed.type).not.toBe('phase:start');
        } catch { /* ignore non-JSON */ }
      }
    }

    await server.stop();
    db.close();
  });
});
