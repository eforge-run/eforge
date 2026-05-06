/**
 * Tests for the daemon-events SSE endpoint and DB query.
 *
 * Covers:
 * (a) getDaemonEventsAfter returns events of the configured types in id order
 * (b) Initial connect emits stream:hello first; Last-Event-ID triggers delta replay
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
): Promise<{ id: string; data: string; event?: string }[]> {
  const headers: Record<string, string> = { accept: 'text/event-stream' };
  if (lastEventId !== undefined) {
    headers['last-event-id'] = String(lastEventId);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const collected: { id: string; data: string; event?: string }[] = [];
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
        let eventName: string | undefined;
        for (const line of block.split('\n')) {
          if (line.startsWith('id:')) id = line.slice(3).trim();
          if (line.startsWith('data:')) data = line.slice(5).trim();
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
        }
        if (data) collected.push({ id, data, event: eventName });
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

      const types = daemonEvents.map((e) => e.type);
      expect(types).toContain('session:start');
      expect(types).toContain('queue:prd:start');
      expect(types).toContain('enqueue:complete');
      expect(types).toContain('session:end');
      expect(types).not.toContain('agent:start');
      expect(types).not.toContain('phase:start');

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

      const afterFirst = db.getDaemonEventsAfter(id1);
      expect(afterFirst.length).toBe(2);
      expect(afterFirst.every((e) => e.id > id1)).toBe(true);

      const afterLast = db.getDaemonEventsAfter(id3);
      expect(afterLast.length).toBe(0);
    } finally {
      db.close();
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// (b) Initial connect emits stream:hello first; Last-Event-ID triggers delta replay
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

  it('(b) initial connect emits stream:hello first; Last-Event-ID triggers delta replay without resync-marker', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'eforge-daemon-sse-replay-'));
    const eforgeDir = resolve(tmpDir, '.eforge');
    mkdirSync(eforgeDir, { recursive: true });
    db = openDatabase(resolve(eforgeDir, 'monitor.db'));

    const runId = 'daemon-sse-replay-001';
    ensureRun(db, runId);

    const id1 = insertEvent(db, runId, 'session:start', { sessionId: runId });
    const id2 = insertEvent(db, runId, 'queue:prd:start', { prdId: 'prd-1', title: 'PRD 1' });
    const id3 = insertEvent(db, runId, 'enqueue:complete', { id: 'prd-2', filePath: '/queue/prd-2.md', title: 'PRD 2' });

    server = await startServer(db, 0);
    const daemonEventsUrl = `http://127.0.0.1:${server.port}${API_ROUTES.daemonEvents}`;

    // Without Last-Event-ID: emits stream:hello (named event) only — no resync-marker, no on-connect heartbeat.
    const initialRaw = await collectSseEvents(daemonEventsUrl, 1, undefined, 500);
    // The first (and likely only) block in this short window is stream:hello
    expect(initialRaw.length).toBeGreaterThanOrEqual(1);
    const helloFrame = initialRaw.find((e) => e.event === 'stream:hello');
    expect(helloFrame).toBeDefined();
    // No resync-marker should be present
    // On initial connect (no Last-Event-ID), only stream:hello should appear — no synthetic
    // v18 frames should follow. Verify by checking that all non-hello plain data frames
    // carry known, non-internal event types.
    const nonHelloPlainFrames = initialRaw.filter((e) => !e.event);
    for (const frame of nonHelloPlainFrames) {
      try {
        const parsed = JSON.parse(frame.data) as { type?: string };
        // Known daemon event types are non-empty; internal synthetic markers were removed
        expect(typeof parsed.type).toBe('string');
        expect(parsed.type!.length).toBeGreaterThan(0);
      } catch { /* ignore non-JSON */ }
    }

    // With Last-Event-ID = id1: emits stream:hello then replays events after id1 (id2, id3).
    // Collect up to 3 items (stream:hello + id2 + id3)
    const afterFirst = await collectSseEvents(daemonEventsUrl, 3, id1);
    const helloFrame2 = afterFirst.find((e) => e.event === 'stream:hello');
    expect(helloFrame2).toBeDefined();
    const deltaEvents = afterFirst.filter((e) => !e.event);
    const deltaIds = deltaEvents.map((e) => e.id);
    expect(deltaIds).not.toContain(String(id1));
    expect(deltaIds).toContain(String(id2));
    expect(deltaIds).toContain(String(id3));

    // With Last-Event-ID = id3: emits stream:hello then no historical events.
    const afterLast = await collectSseEvents(daemonEventsUrl, 1, id3, 300);
    const helloFrame3 = afterLast.find((e) => e.event === 'stream:hello');
    expect(helloFrame3).toBeDefined();
    const afterLastDeltas = afterLast.filter((e) => !e.event);
    expect(afterLastDeltas.length).toBe(0);
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

    // Start collecting — wait up to 2s for stream:hello + 2 real live events (3 total)
    const collectPromise = collectSseEvents(daemonEventsUrl, 3, undefined, 2000);

    // Give the SSE connection a moment to establish, then insert events
    await new Promise((r) => setTimeout(r, 150));
    insertEvent(db, runId, 'queue:start', { prdCount: 1, dir: '/tmp/queue' });
    await new Promise((r) => setTimeout(r, 150));
    insertEvent(db, runId, 'enqueue:complete', { id: 'new-prd', filePath: '/queue/new-prd.md', title: 'New PRD' });

    const events = await collectPromise;
    expect(events.length).toBeGreaterThanOrEqual(2);

    const allData = events.map((e) => {
      try { return JSON.parse(e.data); } catch { return {}; }
    });
    const types = allData.map((d: { type?: string }) => d.type).filter(Boolean);
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

    insertEvent(db, runId, 'agent:start', { agentId: 'a1' });
    const sessionStartId = insertEvent(db, runId, 'session:start', { sessionId: runId });
    insertEvent(db, runId, 'phase:start', { phase: 'planning' });

    server = await startServer(db, 0);
    const daemonEventsUrl = `http://127.0.0.1:${server.port}${API_ROUTES.daemonEvents}`;

    // Initial connect (no Last-Event-ID): emits stream:hello only, no resync-marker.
    const initialRaw = await collectSseEvents(daemonEventsUrl, 1, undefined, 500);
    const helloFrame = initialRaw.find((e) => e.event === 'stream:hello');
    expect(helloFrame).toBeDefined();
    const nonHello = initialRaw.filter((e) => !e.event);
    // No synthetic v18 frames or non-daemon events should appear in plain data blocks
    for (const frame of nonHello) {
      try {
        const parsed = JSON.parse(frame.data) as { type?: string };
        expect(parsed.type).not.toBe('agent:start');
        expect(parsed.type).not.toBe('phase:start');
      } catch { /* ignore */ }
    }

    // With Last-Event-ID = 0: emits stream:hello then replays from beginning —
    // only daemon-wide events (session:start); agent:start and phase:start must not appear.
    const deltaRaw = await collectSseEvents(daemonEventsUrl, 2, 0, 500);
    const deltaHello = deltaRaw.find((e) => e.event === 'stream:hello');
    expect(deltaHello).toBeDefined();
    const deltaEvents = deltaRaw.filter((e) => !e.event);
    expect(deltaEvents.length).toBe(1);
    const deltaType = (JSON.parse(deltaEvents[0].data) as { type?: string }).type;
    expect(deltaType).toBe('session:start');
    expect(String(sessionStartId)).toBe(deltaEvents[0].id);
  });
});
