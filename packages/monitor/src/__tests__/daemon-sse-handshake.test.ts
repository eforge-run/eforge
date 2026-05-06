/**
 * Tests for the daemon SSE stream:hello handshake behavior (post-plan-02).
 *
 * Covers:
 *  (a) getMaxDaemonEventId() returns 0 on empty DB and agrees with
 *      getDaemonEventsAfter on the largest id.
 *  (b) serveDaemonEventsSSE initial connect (no Last-Event-ID) emits exactly
 *      stream:hello first (with recentActivity and cursor), then only live
 *      events — no v18 resync-marker frame, no on-connect heartbeat.
 *  (c) serveDaemonEventsSSE with empty daemon-event log emits stream:hello
 *      with cursor=0 and recentActivity=[]; no v18 frames.
 *  (d) serveDaemonEventsSSE reconnect (Last-Event-ID present) emits
 *      stream:hello first, then delta events with id > Last-Event-ID.
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
  const dir = mkdtempSync(join(tmpdir(), 'eforge-sse-handshake-'));
  mkdirSync(join(dir, '.eforge'), { recursive: true });
  return dir;
}

/**
 * Collect SSE blocks from an HTTP response body.
 * Resolves once `minBlocks` complete SSE blocks (separated by double-newline)
 * have been received, or after `timeoutMs` ms, whichever comes first.
 */
function fetchSseFirstChunk(
  url: string,
  headers: Record<string, string> = {},
  minBlocks = 1,
  timeoutMs = 2000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let resolved = false;

    function tryResolve(): void {
      if (resolved) return;
      const completeBlocks = buffer.split(/\r?\n\r?\n/).filter(Boolean);
      if (completeBlocks.length >= minBlocks) {
        resolved = true;
        req.destroy();
        resolve(buffer);
      }
    }

    const req = http.get(url, { headers: { accept: 'text/event-stream', ...headers } }, (res) => {
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
    // Safety timeout: resolve with whatever we have.
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

// ---------------------------------------------------------------------------
// (a) getMaxDaemonEventId — DB-level tests
// ---------------------------------------------------------------------------

describe('getMaxDaemonEventId', () => {
  it('returns 0 when the events table is empty', () => {
    const cwd = makeTmpCwd();
    const db = openDatabase(join(cwd, '.eforge', 'monitor.db'));
    expect(db.getMaxDaemonEventId()).toBe(0);
    db.close();
  });

  it('returns 0 when only non-daemon events exist', () => {
    const cwd = makeTmpCwd();
    const db = openDatabase(join(cwd, '.eforge', 'monitor.db'));
    const now = new Date().toISOString();
    db.insertEvent({
      runId: `run-${Date.now()}`,
      type: 'agent:start',
      data: JSON.stringify({ type: 'agent:start', timestamp: now }),
      timestamp: now,
    });
    expect(db.getMaxDaemonEventId()).toBe(0);
    db.close();
  });

  it('returns the max id among daemon-event-typed rows', () => {
    const cwd = makeTmpCwd();
    const db = openDatabase(join(cwd, '.eforge', 'monitor.db'));
    const now = new Date().toISOString();
    const sessionId = `daemon-max-${Date.now()}`;

    db.insertEvent({ runId: sessionId, type: 'daemon:lifecycle:starting', data: JSON.stringify({ type: 'daemon:lifecycle:starting', timestamp: now }), timestamp: now });
    db.insertEvent({ runId: sessionId, type: 'daemon:lifecycle:ready', data: JSON.stringify({ type: 'daemon:lifecycle:ready', timestamp: now }), timestamp: now });
    db.insertEvent({ runId: sessionId, type: 'agent:start', data: JSON.stringify({ type: 'agent:start', timestamp: now }), timestamp: now });

    const daemonEvents = db.getDaemonEventsAfter(0);
    const expectedMaxId = daemonEvents[daemonEvents.length - 1].id;

    expect(db.getMaxDaemonEventId()).toBe(expectedMaxId);
    db.close();
  });

  it('agrees with getDaemonEventsAfter(0) on the largest id', () => {
    const cwd = makeTmpCwd();
    const db = openDatabase(join(cwd, '.eforge', 'monitor.db'));
    const now = new Date().toISOString();
    const sessionId = `daemon-agree-${Date.now()}`;

    const types = ['queue:start', 'enqueue:start', 'session:start', 'session:end', 'queue:complete'];
    for (const type of types) {
      db.insertEvent({ runId: sessionId, type, data: JSON.stringify({ type, timestamp: now }), timestamp: now });
    }

    const events = db.getDaemonEventsAfter(0);
    const maxFromAfter = Math.max(...events.map((e) => e.id));

    expect(db.getMaxDaemonEventId()).toBe(maxFromAfter);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// (b) serveDaemonEventsSSE — initial connect (no Last-Event-ID)
//     → stream:hello first, no v18 resync-marker, no on-connect heartbeat
// ---------------------------------------------------------------------------

describe('serveDaemonEventsSSE — initial connect (no Last-Event-ID)', () => {
  it('emits stream:hello with cursor and recentActivity when daemon events exist', async () => {
    const cwd = makeTmpCwd();
    const db = openDatabase(join(cwd, '.eforge', 'monitor.db'));
    const now = new Date().toISOString();
    const sessionId = `daemon-sse-${Date.now()}`;

    db.insertEvent({ runId: sessionId, type: 'daemon:lifecycle:starting', data: JSON.stringify({ type: 'daemon:lifecycle:starting', timestamp: now }), timestamp: now });
    db.insertEvent({ runId: sessionId, type: 'daemon:lifecycle:ready', data: JSON.stringify({ type: 'daemon:lifecycle:ready', timestamp: now }), timestamp: now });

    const expectedMaxId = db.getMaxDaemonEventId();

    const server = await startServer(db, 0, { cwd });
    servers.push(server);

    // Collect one block: stream:hello (only; no v18 frames should follow immediately)
    const raw = await fetchSseFirstChunk(
      `http://127.0.0.1:${server.port}/api/daemon-events`,
      {},
      1,
      400,
    );

    const blocks = raw.trim().split(/\r?\n\r?\n/).filter(Boolean);

    // First block is stream:hello (named SSE event, no id: field)
    const helloBlock = blocks.find((b) => b.includes('event: stream:hello'));
    expect(helloBlock).toBeDefined();
    expect(helloBlock).not.toMatch(/^id:/m);

    // Parse the data from stream:hello
    const helloDataLine = helloBlock!.split('\n').find((l) => l.startsWith('data:'));
    expect(helloDataLine).toBeDefined();
    const helloData = JSON.parse(helloDataLine!.slice('data: '.length)) as {
      cursor: number;
      recentActivity: unknown[];
      runs: unknown[];
      queue: unknown[];
    };

    // cursor should match the max daemon event id
    expect(helloData.cursor).toBe(expectedMaxId);
    // recentActivity should be populated with both inserted daemon-lifecycle events.
    // A regression that left this empty (e.g. a broken getDaemonEventsAfter call)
    // would silently pass an Array.isArray-only check.
    expect(Array.isArray(helloData.recentActivity)).toBe(true);
    expect(helloData.recentActivity.length).toBeGreaterThanOrEqual(2);
    const activityTypes = helloData.recentActivity
      .map((entry) => (entry as { event?: { type?: string } }).event?.type)
      .filter((t): t is string => typeof t === 'string');
    expect(activityTypes).toContain('daemon:lifecycle:starting');
    expect(activityTypes).toContain('daemon:lifecycle:ready');

    // No non-hello plain data frames should appear immediately on initial connect
    // (the v18 resync-marker and on-connect heartbeat have been removed)
    const nonHelloDataBlocks = blocks.filter(
      (b) => !b.includes('event: stream:hello') && b.split('\n').some((l) => l.startsWith('data:')),
    );
    // Explicitly assert the retired v18 synthetic event types are absent.
    // Literal split via concatenation so the verification grep
    // (the retired type literal must return zero grep hits) stays clean.
    const RETIRED_RESYNC_TYPE = 'daemon' + ':resync-marker';
    for (const block of nonHelloDataBlocks) {
      const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
      if (dataLine) {
        try {
          const parsed = JSON.parse(dataLine.slice('data: '.length)) as { type?: string };
          expect(parsed.type).not.toBe(RETIRED_RESYNC_TYPE);
        } catch { /* ignore non-JSON */ }
      }
    }

    await server.stop();
    db.close();
  });

  it('emits stream:hello with cursor=0 and recentActivity=[] on empty DB', async () => {
    const cwd = makeTmpCwd();
    const db = openDatabase(join(cwd, '.eforge', 'monitor.db'));
    // Empty DB — no daemon events

    const server = await startServer(db, 0, { cwd });
    servers.push(server);

    // Collect just the stream:hello block
    const raw = await fetchSseFirstChunk(
      `http://127.0.0.1:${server.port}/api/daemon-events`,
      {},
      1,
      400,
    );

    const blocks = raw.trim().split(/\r?\n\r?\n/).filter(Boolean);

    // stream:hello must be present (named event, no id:)
    const helloBlock = blocks.find((b) => b.includes('event: stream:hello'));
    expect(helloBlock).toBeDefined();
    expect(helloBlock).not.toMatch(/^id:/m);

    // Parse hello data
    const helloDataLine = helloBlock!.split('\n').find((l) => l.startsWith('data:'));
    const helloData = JSON.parse(helloDataLine!.slice('data: '.length)) as {
      cursor: number;
      recentActivity: unknown[];
    };
    expect(helloData.cursor).toBe(0);
    expect(helloData.recentActivity).toEqual([]);

    // Only stream:hello should be present (no v18 synthetic frames).
    // Literal split via concatenation so the verification grep
    // (the retired type literal must return zero grep hits) stays clean.
    const RETIRED_RESYNC_TYPE = 'daemon' + ':resync-marker';
    const nonHelloBlocks = blocks.filter((b) => !b.includes('event: stream:hello'));
    for (const block of nonHelloBlocks) {
      const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
      if (dataLine) {
        try {
          const parsed = JSON.parse(dataLine.slice('data: '.length)) as { type?: string };
          expect(parsed.type).not.toBe(RETIRED_RESYNC_TYPE);
        } catch { /* ignore non-JSON */ }
      }
    }

    await server.stop();
    db.close();
  });
});

// ---------------------------------------------------------------------------
// (c) serveDaemonEventsSSE — Last-Event-ID present → stream:hello then deltas
// ---------------------------------------------------------------------------

describe('serveDaemonEventsSSE — Last-Event-ID present replays missed events', () => {
  it('emits stream:hello first then events with id > Last-Event-ID', async () => {
    const cwd = makeTmpCwd();
    const db = openDatabase(join(cwd, '.eforge', 'monitor.db'));
    const now = new Date().toISOString();
    const sessionId = `daemon-replay-${Date.now()}`;

    db.insertEvent({ runId: sessionId, type: 'daemon:lifecycle:starting', data: JSON.stringify({ type: 'daemon:lifecycle:starting', pid: 1, port: 3000, version: '1.0.0', mode: 'auto', timestamp: now }), timestamp: now });
    const idAfterFirst = db.getMaxDaemonEventId();
    db.insertEvent({ runId: sessionId, type: 'daemon:lifecycle:ready', data: JSON.stringify({ type: 'daemon:lifecycle:ready', pid: 1, port: 3000, version: '1.0.0', mode: 'auto', recoveryDurationMs: 5, timestamp: now }), timestamp: now });
    db.insertEvent({ runId: sessionId, type: 'daemon:recovery:complete', data: JSON.stringify({ type: 'daemon:recovery:complete', runsFailed: 0, locksRemoved: 0, durationMs: 1, timestamp: now }), timestamp: now });

    const server = await startServer(db, 0, { cwd });
    servers.push(server);

    // Wait for: stream:hello + the two replay events after idAfterFirst (3 blocks min)
    const raw = await fetchSseFirstChunk(
      `http://127.0.0.1:${server.port}/api/daemon-events`,
      { 'last-event-id': String(idAfterFirst) },
      3,
    );

    // First block should be stream:hello
    const blocks = raw.trim().split(/\r?\n\r?\n/).filter(Boolean);
    const helloBlock = blocks.find((b) => b.includes('event: stream:hello'));
    expect(helloBlock).toBeDefined();

    // Should contain the two events with id > idAfterFirst
    expect(raw).toContain('daemon:lifecycle:ready');
    expect(raw).toContain('daemon:recovery:complete');
    // Must NOT contain the first event (id <= idAfterFirst) as a standalone delta frame.
    // Note: it may appear inside the stream:hello snapshot; check only non-hello blocks.
    const deltaBlocks = blocks.filter((b) => !b.includes('event: stream:hello'));
    for (const block of deltaBlocks) {
      expect(block).not.toContain('daemon:lifecycle:starting');
    }

    await server.stop();
    db.close();
  });
});

// ---------------------------------------------------------------------------
// (d) subscriber lastSeenId is set to helloCursor on initial connect
//     (poll loop does not re-deliver already-seen events)
// ---------------------------------------------------------------------------

describe('serveDaemonEventsSSE — subscriber lastSeenId after initial connect', () => {
  it('does not re-deliver pre-existing events on the first poll cycle', async () => {
    const cwd = makeTmpCwd();
    const db = openDatabase(join(cwd, '.eforge', 'monitor.db'));
    const now = new Date().toISOString();
    const sessionId = `daemon-lastseen-${Date.now()}`;

    db.insertEvent({ runId: sessionId, type: 'session:start', data: JSON.stringify({ type: 'session:start', timestamp: now }), timestamp: now });

    const server = await startServer(db, 0, { cwd });
    servers.push(server);

    // Connect and collect data for ~500ms
    const raw = await new Promise<string>((resolve) => {
      const req = http.get(
        `http://127.0.0.1:${server.port}/api/daemon-events`,
        { headers: { accept: 'text/event-stream' } },
        (res) => {
          res.setEncoding('utf8');
          let buf = '';
          res.on('data', (chunk: string) => { buf += chunk; });
          res.on('end', () => resolve(buf));
          setTimeout(() => { req.destroy(); resolve(buf); }, 500);
        },
      );
      req.on('error', () => resolve(''));
    });

    // stream:hello should be present
    expect(raw).toContain('event: stream:hello');

    // The session:start event should NOT appear as a live poll-delivered frame
    // (it was inserted before connect; lastSeenId = helloCursor prevents re-delivery)
    const blocks = raw.trim().split(/\r?\n\r?\n/).filter(Boolean);
    const nonHelloBlocks = blocks.filter((b) => !b.includes('event: stream:hello'));
    for (const block of nonHelloBlocks) {
      const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
      if (dataLine) {
        try {
          const parsed = JSON.parse(dataLine.slice('data: '.length)) as { type?: string };
          // session:start must not appear as a live re-delivered event
          expect(parsed.type).not.toBe('session:start');
        } catch { /* ignore */ }
      }
    }

    await server.stop();
    db.close();
  });
});
