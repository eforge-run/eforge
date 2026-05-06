/**
 * Tests for the daemon SSE skip-history + resync-marker behavior.
 *
 * Covers:
 *  (a) getMaxDaemonEventId() returns 0 on empty DB and matches getDaemonEventsAfter filter.
 *  (b) serveDaemonEventsSSE initial connect (no Last-Event-ID) writes a single
 *      daemon:resync-marker with id: <maxDaemonId> and replays no historical events.
 *  (c) Last-Event-ID-present branch still replays events with id > the header value.
 *  (d) Marker is omitted when no daemon events exist (fresh DB).
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
  const dir = mkdtempSync(join(tmpdir(), 'eforge-sse-resync-'));
  mkdirSync(join(dir, '.eforge'), { recursive: true });
  return dir;
}

/**
 * Collect SSE blocks from an HTTP response body.
 * Resolves once `minBlocks` complete SSE blocks (separated by double-newline)
 * have been received, or after `timeoutMs` ms, whichever comes first.
 */
function fetchSseFirstChunk(url: string, headers: Record<string, string> = {}, minBlocks = 1, timeoutMs = 2000): Promise<string> {
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
    // Insert an event type that is NOT in the daemon allowlist
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
    // Insert a non-daemon event to confirm it doesn't pollute the max
    db.insertEvent({ runId: sessionId, type: 'agent:start', data: JSON.stringify({ type: 'agent:start', timestamp: now }), timestamp: now });

    // getDaemonEventsAfter(0) returns daemon events; last one has the max daemon id.
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

    // Insert several daemon events
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
// (b) serveDaemonEventsSSE — no Last-Event-ID → resync marker
// ---------------------------------------------------------------------------

describe('serveDaemonEventsSSE — initial connect (no Last-Event-ID)', () => {
  it('writes a single daemon:resync-marker block when daemon events exist', async () => {
    const cwd = makeTmpCwd();
    const db = openDatabase(join(cwd, '.eforge', 'monitor.db'));
    const now = new Date().toISOString();
    const sessionId = `daemon-sse-${Date.now()}`;

    db.insertEvent({ runId: sessionId, type: 'daemon:lifecycle:starting', data: JSON.stringify({ type: 'daemon:lifecycle:starting', timestamp: now }), timestamp: now });
    db.insertEvent({ runId: sessionId, type: 'daemon:lifecycle:ready', data: JSON.stringify({ type: 'daemon:lifecycle:ready', timestamp: now }), timestamp: now });

    const expectedMaxId = db.getMaxDaemonEventId();

    const server = await startServer(db, 0, { cwd });
    servers.push(server);

    const raw = await fetchSseFirstChunk(`http://127.0.0.1:${server.port}/api/daemon-events`);

    // Should contain exactly one SSE block: the resync-marker
    const blocks = raw.trim().split(/\r?\n\r?\n/).filter(Boolean);
    expect(blocks).toHaveLength(1);

    const block = blocks[0];
    expect(block).toContain(`id: ${expectedMaxId}`);
    expect(block).toContain('"type":"daemon:resync-marker"');
    // Must NOT contain any other event types (no historical replay)
    expect(block).not.toContain('daemon:lifecycle');

    await server.stop();
    db.close();
  });

  it('does not write any SSE blocks when no daemon events exist', async () => {
    const cwd = makeTmpCwd();
    const db = openDatabase(join(cwd, '.eforge', 'monitor.db'));
    // Empty DB — no daemon events

    const server = await startServer(db, 0, { cwd });
    servers.push(server);

    // Use fetchSseFirstChunk with a short timeout (400ms). Since no marker is
    // emitted on initial connect with an empty DB, we expect no complete SSE
    // blocks to arrive within that window.
    const raw = await fetchSseFirstChunk(
      `http://127.0.0.1:${server.port}/api/daemon-events`,
      {},
      1,
      400,
    );

    const blocks = raw.trim().split(/\r?\n\r?\n/).filter(Boolean);
    expect(blocks).toHaveLength(0);

    await server.stop();
    db.close();
  });
});

// ---------------------------------------------------------------------------
// (c) serveDaemonEventsSSE — Last-Event-ID present → replay deltas
// ---------------------------------------------------------------------------

describe('serveDaemonEventsSSE — Last-Event-ID present replays missed events', () => {
  it('replays events with id > Last-Event-ID', async () => {
    const cwd = makeTmpCwd();
    const db = openDatabase(join(cwd, '.eforge', 'monitor.db'));
    const now = new Date().toISOString();
    const sessionId = `daemon-replay-${Date.now()}`;

    db.insertEvent({ runId: sessionId, type: 'daemon:lifecycle:starting', data: JSON.stringify({ type: 'daemon:lifecycle:starting', timestamp: now }), timestamp: now });
    const idAfterFirst = db.getMaxDaemonEventId();
    db.insertEvent({ runId: sessionId, type: 'daemon:lifecycle:ready', data: JSON.stringify({ type: 'daemon:lifecycle:ready', timestamp: now }), timestamp: now });
    db.insertEvent({ runId: sessionId, type: 'daemon:recovery:complete', data: JSON.stringify({ type: 'daemon:recovery:complete', runsFailed: 0, locksRemoved: 0, durationMs: 1, timestamp: now }), timestamp: now });

    const server = await startServer(db, 0, { cwd });
    servers.push(server);

    // Wait for at least 2 SSE blocks (the two replay events after idAfterFirst)
    const raw = await fetchSseFirstChunk(
      `http://127.0.0.1:${server.port}/api/daemon-events`,
      { 'last-event-id': String(idAfterFirst) },
      2,
    );

    // Should contain the two events with id > idAfterFirst (no resync-marker)
    expect(raw).toContain('daemon:lifecycle:ready');
    expect(raw).toContain('daemon:recovery:complete');
    // Must NOT contain the first event (id <= idAfterFirst)
    expect(raw).not.toContain('daemon:lifecycle:starting');
    // Must NOT contain a resync-marker
    expect(raw).not.toContain('daemon:resync-marker');

    await server.stop();
    db.close();
  });
});

// ---------------------------------------------------------------------------
// (d) subscriber lastSeenId is set to maxId on initial connect
// ---------------------------------------------------------------------------

describe('serveDaemonEventsSSE — subscriber lastSeenId after initial connect', () => {
  it('does not re-deliver the marker event on the next poll cycle', async () => {
    const cwd = makeTmpCwd();
    const db = openDatabase(join(cwd, '.eforge', 'monitor.db'));
    const now = new Date().toISOString();
    const sessionId = `daemon-lastseen-${Date.now()}`;

    db.insertEvent({ runId: sessionId, type: 'session:start', data: JSON.stringify({ type: 'session:start', timestamp: now }), timestamp: now });

    const maxId = db.getMaxDaemonEventId();

    const server = await startServer(db, 0, { cwd });
    servers.push(server);

    // Connect and collect data for ~500ms to catch any duplicate delivery
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

    // Count occurrences of the resync-marker: should be exactly one
    const markerCount = (raw.match(/daemon:resync-marker/g) ?? []).length;
    expect(markerCount).toBe(1);

    // The id in the marker should match maxId
    expect(raw).toContain(`id: ${maxId}`);

    await server.stop();
    db.close();
  });
});
