/**
 * Tests for getDaemonEventsAfter with the new daemon event type allowlist.
 *
 * Verifies that:
 *  - All new persisted daemon event types are included in the allowlist query.
 *  - daemon:heartbeat is explicitly excluded (LIVE-ONLY, never persisted).
 *
 * Follows AGENTS.md conventions:
 * - No mocks. Real SQLite DB via openDatabase.
 * - Constructs input rows inline.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db.js';

function makeTmpCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), 'eforge-db-events-'));
  mkdirSync(join(dir, '.eforge'), { recursive: true });
  return dir;
}

// All new persisted daemon event types from plan-01 (heartbeat intentionally absent)
const NEW_PERSISTED_TYPES = [
  'daemon:lifecycle:starting',
  'daemon:lifecycle:ready',
  'daemon:lifecycle:shutdown:start',
  'daemon:lifecycle:shutdown:complete',
  'daemon:scheduler:dequeued',
  'daemon:scheduler:capacity-blocked',
  'daemon:scheduler:dependency-blocked',
  'daemon:auto-build:enabled',
  'daemon:auto-build:resumed',
  'daemon:auto-build:triggered',
  'daemon:recovery:start',
  'daemon:recovery:run-marked-failed',
  'daemon:recovery:lock-removed',
  'daemon:recovery:complete',
  'daemon:orphan:reaped',
  'daemon:warning',
  'daemon:error',
] as const;

describe('getDaemonEventsAfter — new persisted event types', () => {
  it('returns events for all new persisted daemon event types', () => {
    const cwd = makeTmpCwd();
    const db = openDatabase(join(cwd, '.eforge', 'monitor.db'));

    const daemonSessionId = `daemon-test-${Date.now()}`;
    const now = new Date().toISOString();

    // Insert one event of each new persisted type (FK is OFF — no matching run row needed)
    for (const eventType of NEW_PERSISTED_TYPES) {
      db.insertEvent({
        runId: daemonSessionId,
        type: eventType,
        data: JSON.stringify({ type: eventType, sessionId: daemonSessionId, timestamp: now }),
        timestamp: now,
      });
    }

    const events = db.getDaemonEventsAfter(0);
    const returnedTypes = new Set(events.map((e) => e.type));

    for (const eventType of NEW_PERSISTED_TYPES) {
      expect(returnedTypes.has(eventType), `Expected ${eventType} to be returned by getDaemonEventsAfter`).toBe(true);
    }

    db.close();
  });

  it('excludes daemon:heartbeat — it is LIVE-ONLY and must not be replayed', () => {
    const cwd = makeTmpCwd();
    const db = openDatabase(join(cwd, '.eforge', 'monitor.db'));

    const daemonSessionId = `daemon-test-hb-${Date.now()}`;
    const now = new Date().toISOString();

    // Insert a heartbeat event directly into the events table
    // (bypassing the allowlist that prevents it from ever being stored in practice)
    db.insertEvent({
      runId: daemonSessionId,
      type: 'daemon:heartbeat',
      data: JSON.stringify({
        type: 'daemon:heartbeat',
        uptime: 1000,
        queueDepth: 0,
        runningBuilds: 0,
        autoBuild: { enabled: true, paused: false },
        subscribers: 1,
        timestamp: now,
      }),
      timestamp: now,
    });

    // Also insert a persisted type so we can confirm the query does return results
    db.insertEvent({
      runId: daemonSessionId,
      type: 'daemon:lifecycle:starting',
      data: JSON.stringify({ type: 'daemon:lifecycle:starting', pid: 1, port: 4567, version: '1.0', mode: 'persistent', timestamp: now }),
      timestamp: now,
    });

    const events = db.getDaemonEventsAfter(0);
    const returnedTypes = events.map((e) => e.type);

    // daemon:heartbeat must NOT appear
    expect(returnedTypes).not.toContain('daemon:heartbeat');
    // daemon:lifecycle:starting MUST appear
    expect(returnedTypes).toContain('daemon:lifecycle:starting');

    db.close();
  });

  it('getDaemonEventsAfter(id) only returns events with id > afterId', () => {
    const cwd = makeTmpCwd();
    const db = openDatabase(join(cwd, '.eforge', 'monitor.db'));

    const daemonSessionId = `daemon-test-after-${Date.now()}`;
    const now = new Date().toISOString();

    // Insert two events
    db.insertEvent({
      runId: daemonSessionId,
      type: 'daemon:recovery:start',
      data: JSON.stringify({ type: 'daemon:recovery:start', timestamp: now }),
      timestamp: now,
    });
    const maxIdAfterFirst = db.getMaxEventId();

    db.insertEvent({
      runId: daemonSessionId,
      type: 'daemon:recovery:complete',
      data: JSON.stringify({ type: 'daemon:recovery:complete', runsFailed: 0, locksRemoved: 0, durationMs: 5, timestamp: now }),
      timestamp: now,
    });

    // getDaemonEventsAfter(maxIdAfterFirst) should only return the second event
    const events = db.getDaemonEventsAfter(maxIdAfterFirst);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('daemon:recovery:complete');

    db.close();
  });
});
