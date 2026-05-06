/**
 * Tests for the daemon-events SSE endpoint and DB query.
 *
 * Covers:
 * (a) getDaemonEventsAfter returns events of the configured types in id order
 * (b) Historical replay on initial connect respects last-event-id
 * (c) Poll loop pushes new daemon-wide events to every subscriber
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDatabase } from '@eforge-build/monitor/db';
import { startServer } from '@eforge-build/monitor/server';
import type { MonitorDB } from '@eforge-build/monitor/db';
import type { MonitorServer } from '@eforge-build/monitor/server';
import { API_ROUTES } from '@eforge-build/client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function insertEvent(
  db: MonitorDB,
  runId: string,
  type: string,
  data: Record<string, unknown> = {},
): number {
  return db.insertEvent({
    runId,
    type,
    planId: undefined,
    agent: undefined,
    data: JSON.stringify({ type, ...data }),
    timestamp: new Date().toISOString(),
  });
}

function ensureRun(db: MonitorDB, runId: string): void {
  try {
    db.insertRun({
      id: runId,
      sessionId: runId,
      planSet: 'test-set',
      command: 'build',
      status: 'running',
      startedAt: new Date().toISOString(),
      cwd: '/tmp',
    });
  } catch {
    // Run may already exist
  }
}

async function collectSseEvents(
  url: string,
  expectedCount: number,
  lastEventId?: number,
  timeoutMs = 2000,
): Promise<{ id: string; data: string }[]> {
  const headers: Record<string, string> = { accept: 'text/event-stream' };
  if (lastEventId !== undefined) {
    headers['last-event-id'] = String(lastEventId);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const collected: { id: string; data: string }[] = [];
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok || !res.body) throw new Error(`Non-2xx response: ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (collected.length < expectedCount) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';
      for (const block of blocks) {
        if (!block.trim()) continue;
        let id = '';
        let data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('id:')) id = line.slice(3).trim();
          if (line.startsWith('data:')) data = line.slice(5).trim();
        }
        if (data) collected.push({ id, data });
      }
    }

    reader.cancel().catch(() => {});
  } catch (err) {
    if ((err as Error).name !== 'AbortError') throw err;
  } finally {
    clearTimeout(timer);
  }

  return collected;
}

// ---------------------------------------------------------------------------
// (a) getDaemonEventsAfter DB query
// ---------------------------------------------------------------------------

describe('getDaemonEventsAfter', () => {
  it('returns only events whose type is in the daemon-wide allowlist, in id order', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'eforge-daemon-db-'));
    const eforgeDir = resolve(tmpDir, '.eforge');
    mkdirSync(eforgeDir, { recursive: true });
    const db = openDatabase(resolve(eforgeDir, 'monitor.db'));

    const runId = 'daemon-db-test-001';
    ensureRun(db, runId);

    try {
      // Insert a mix of daemon-wide and per-session events
      insertEvent(db, runId, 'session:start', { sessionId: runId });
      insertEvent(db, runId, 'agent:start', { agentId: 'a1' }); // NOT daemon-wide
      insertEvent(db, runId, 'queue:prd:start', { prdId: 'my-prd' });
      insertEvent(db, runId, 'enqueue:complete', { id: 'prd-001' });
      insertEvent(db, runId, 'phase:start', { phase: 'planning' }); // NOT daemon-wide
      insertEvent(db, runId, 'session:end', { status: 'completed' });

      const daemonEvents = db.getDaemonEventsAfter(0);

      // Only daemon-wide types should be returned
      const types = daemonEvents.map((e) => e.type);
      expect(types).toContain('session:start');
      expect(types).toContain('queue:prd:start');
      expect(types).toContain('enqueue:complete');
      expect(types).toContain('session:end');

      // Non-daemon-wide types must not appear
      expect(types).not.toContain('agent:start');
      expect(types).not.toContain('phase:start');

      // Must be in ascending id order
      const ids = daemonEvents.map((e) => e.id);
      for (let i = 1; i < ids.length; i++) {
        expect(ids[i]).toBeGreaterThan(ids[i - 1]);
      }
    } finally {
      db.close();
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns only events with id > afterId', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'eforge-daemon-after-'));
    const eforgeDir = resolve(tmpDir, '.eforge');
    mkdirSync(eforgeDir, { recursive: true });
    const db = openDatabase(resolve(eforgeDir, 'monitor.db'));

    const runId = 'daemon-after-test-001';
    ensureRun(db, runId);

    try {
      const id1 = insertEvent(db, runId, 'session:start');
      const _id2 = insertEvent(db, runId, 'queue:prd:start', { prdId: 'x' });
      const id3 = insertEvent(db, runId, 'enqueue:complete', { id: 'y' });

      // Ask for events after id1 only
      const afterFirst = db.getDaemonEventsAfter(id1);
      expect(afterFirst.length).toBe(2);
      expect(afterFirst.every((e) => e.id > id1)).toBe(true);

      // Ask for events after id3 — none
      const afterLast = db.getDaemonEventsAfter(id3);
      expect(afterLast.length).toBe(0);
    } finally {
      db.close();
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// (b) Historical replay respects Last-Event-ID
// (c) Poll loop pushes new events to subscribers
// ---------------------------------------------------------------------------

describe('GET /api/daemon-events SSE endpoint', () => {
  let server: MonitorServer | null = null;
  let db: MonitorDB | null = null;
  let tmpDir: string | null = null;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = null;
    }
    if (db) {
      db.close();
      db = null;
    }
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('(b) initial connect emits resync-marker; Last-Event-ID triggers delta replay', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'eforge-daemon-sse-replay-'));
    const eforgeDir = resolve(tmpDir, '.eforge');
    mkdirSync(eforgeDir, { recursive: true });
    db = openDatabase(resolve(eforgeDir, 'monitor.db'));

    const runId = 'daemon-sse-replay-001';
    ensureRun(db, runId);

    // Insert 3 daemon-wide events before the server starts
    const id1 = insertEvent(db, runId, 'session:start');
    const id2 = insertEvent(db, runId, 'queue:prd:start', { prdId: 'prd-1' });
    const id3 = insertEvent(db, runId, 'enqueue:complete', { id: 'prd-2' });

    server = await startServer(db, 0);
    const daemonEventsUrl = `http://127.0.0.1:${server.port}${API_ROUTES.daemonEvents}`;

    // Without Last-Event-ID: new behavior — emits a daemon:resync-marker (with id:)
    // followed by an immediate on-connect daemon:heartbeat (no id:). Filter out
    // heartbeats to isolate the resync-marker assertion.
    const allInitialEvents = await collectSseEvents(daemonEventsUrl, 2, undefined, 500);
    const initialEvents = allInitialEvents.filter(
      (e) => JSON.parse(e.data).type !== 'daemon:heartbeat',
    );
    expect(initialEvents.length).toBe(1);
    expect(JSON.parse(initialEvents[0].data).type).toBe('daemon:resync-marker');
    expect(Number(initialEvents[0].id)).toBe(id3);

    // With Last-Event-ID = id1: should replay only events after id1 (id2, id3).
    // The on-connect heartbeat (no id:) is also emitted; filter it out.
    const allAfterFirst = await collectSseEvents(daemonEventsUrl, 3, id1);
    const afterFirst = allAfterFirst.filter(
      (e) => JSON.parse(e.data).type !== 'daemon:heartbeat',
    );
    expect(afterFirst.length).toBe(2);
    const afterFirstIds = afterFirst.map((e) => e.id);
    expect(afterFirstIds).not.toContain(String(id1));
    expect(afterFirstIds).toContain(String(id2));
    expect(afterFirstIds).toContain(String(id3));

    // With Last-Event-ID = id3: should replay no historical events.
    // The on-connect heartbeat (no id:) is still emitted; filter it out.
    const allAfterLast = await collectSseEvents(daemonEventsUrl, 1, id3, 300);
    const afterLast = allAfterLast.filter(
      (e) => JSON.parse(e.data).type !== 'daemon:heartbeat',
    );
    expect(afterLast.length).toBe(0);
  });

  it('(c) poll loop pushes newly inserted daemon-wide events to subscribers', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'eforge-daemon-sse-poll-'));
    const eforgeDir = resolve(tmpDir, '.eforge');
    mkdirSync(eforgeDir, { recursive: true });
    db = openDatabase(resolve(eforgeDir, 'monitor.db'));

    const runId = 'daemon-sse-poll-001';
    ensureRun(db, runId);

    server = await startServer(db, 0);
    const daemonEventsUrl = `http://127.0.0.1:${server.port}${API_ROUTES.daemonEvents}`;

    // Start collecting — will wait up to 2s for 3 events (on-connect heartbeat + 2 real events)
    const collectPromise = collectSseEvents(daemonEventsUrl, 3, undefined, 2000);

    // Give the SSE connection a moment to establish, then insert events
    await new Promise((r) => setTimeout(r, 150));
    insertEvent(db, runId, 'queue:start', { queueDir: '/tmp/queue' });
    await new Promise((r) => setTimeout(r, 150));
    insertEvent(db, runId, 'enqueue:complete', { id: 'new-prd' });

    const events = await collectPromise;
    expect(events.length).toBeGreaterThanOrEqual(2);

    const types = events.map((e) => JSON.parse(e.data).type);
    expect(types).toContain('queue:start');
    expect(types).toContain('enqueue:complete');
  });

  it('does not deliver per-session events (agent:start, phase:start) over daemon-events stream', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'eforge-daemon-sse-filter-'));
    const eforgeDir = resolve(tmpDir, '.eforge');
    mkdirSync(eforgeDir, { recursive: true });
    db = openDatabase(resolve(eforgeDir, 'monitor.db'));

    const runId = 'daemon-sse-filter-001';
    ensureRun(db, runId);

    // Insert a mix: one daemon-wide, two non-daemon-wide
    insertEvent(db, runId, 'agent:start', { agentId: 'a1' });
    const sessionStartId = insertEvent(db, runId, 'session:start');
    insertEvent(db, runId, 'phase:start', { phase: 'planning' });

    server = await startServer(db, 0);
    const daemonEventsUrl = `http://127.0.0.1:${server.port}${API_ROUTES.daemonEvents}`;

    // Initial connect (no Last-Event-ID): emits resync-marker (with id:) and an
    // immediate on-connect daemon:heartbeat (no id:). Filter heartbeats to isolate
    // the resync-marker assertion. No per-session events included.
    const allInitialEvents = await collectSseEvents(daemonEventsUrl, 2, undefined, 500);
    const initialEvents = allInitialEvents.filter(
      (e) => JSON.parse(e.data).type !== 'daemon:heartbeat',
    );
    expect(initialEvents.length).toBe(1);
    expect(JSON.parse(initialEvents[0].data).type).toBe('daemon:resync-marker');
    // The marker id equals the max daemon-wide event id (session:start)
    expect(Number(initialEvents[0].id)).toBe(sessionStartId);

    // With Last-Event-ID = 0: replay from beginning — only daemon-wide events
    // (session:start); agent:start and phase:start must not appear.
    // Filter out the on-connect heartbeat frame (emitted after subscriber registration).
    const allDeltaEvents = await collectSseEvents(daemonEventsUrl, 2, 0, 500);
    const deltaEvents = allDeltaEvents.filter(
      (e) => JSON.parse(e.data).type !== 'daemon:heartbeat',
    );
    expect(deltaEvents.length).toBe(1);
    expect(JSON.parse(deltaEvents[0].data).type).toBe('session:start');
    // Confirm non-daemon-wide types were filtered
    const deltaTypes = deltaEvents.map((e) => JSON.parse(e.data).type);
    expect(deltaTypes).not.toContain('agent:start');
    expect(deltaTypes).not.toContain('phase:start');
  });
});
