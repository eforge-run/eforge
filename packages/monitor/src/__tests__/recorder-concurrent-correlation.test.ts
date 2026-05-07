/**
 * Concurrent correlation test for withRecording().
 *
 * Verifies that the generator-local `enqueueRunId` variable cannot leak
 * between two independent withRecording() invocations that share the same DB.
 *
 * Two sessions are interleaved:
 *   - Session A: enqueue-only (enqueue:start → enqueue:complete)
 *   - Session B: phase-driven build (phase:start → phase:end)
 *
 * Assertions:
 *   1. daemon:run:upsert payloads from session A all share the same run ID,
 *      which is distinct from session B's run ID.
 *   2. Each session's daemon:run:upsert payloads reference only that session's
 *      run — no cross-contamination of IDs.
 *   3. db.getRuns() contains exactly two runs, one per session.
 *
 * Follows AGENTS.md conventions:
 * - No mocks. Real SQLite DB via openDatabase.
 * - Constructs inputs inline (no fixtures).
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db.js';
import { withRecording } from '../recorder.js';
import type { EforgeEvent } from '@eforge-build/engine/events';

function makeTmpCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), 'eforge-recorder-concurrent-'));
  mkdirSync(join(dir, '.eforge'), { recursive: true });
  return dir;
}

async function* asGenerator(events: EforgeEvent[]): AsyncGenerator<EforgeEvent> {
  for (const event of events) yield event;
}

async function collectEvents(gen: AsyncGenerator<EforgeEvent>): Promise<EforgeEvent[]> {
  const result: EforgeEvent[] = [];
  for await (const event of gen) result.push(event);
  return result;
}

function upserts(
  events: EforgeEvent[],
): Extract<EforgeEvent, { type: 'daemon:run:upsert' }>[] {
  return events.filter(
    (e): e is Extract<EforgeEvent, { type: 'daemon:run:upsert' }> =>
      e.type === 'daemon:run:upsert',
  );
}

describe('withRecording() concurrent-session isolation', () => {
  it('two concurrent withRecording() instances do not share enqueueRunId', async () => {
    const cwd = makeTmpCwd();
    const db = openDatabase(join(cwd, '.eforge', 'monitor.db'));
    const ts = new Date().toISOString();

    // Session A: enqueue-only
    const sessionAId = `sess-a-${Date.now()}`;
    const sessionAEvents: EforgeEvent[] = [
      { type: 'session:start', sessionId: sessionAId, timestamp: ts },
      { type: 'enqueue:start', source: 'api', timestamp: ts },
      {
        type: 'enqueue:complete',
        id: 'prd-from-a',
        filePath: '/queue/prd-from-a.md',
        title: 'Feature A',
        planSet: 'feature-a',
        timestamp: ts,
      },
      { type: 'session:end', sessionId: sessionAId, result: { status: 'completed', summary: 'ok' }, timestamp: ts },
    ];

    // Session B: phase-driven build
    const sessionBId = `sess-b-${Date.now()}`;
    const runBId = `run-b-${Date.now()}`;
    const sessionBEvents: EforgeEvent[] = [
      { type: 'session:start', sessionId: sessionBId, timestamp: ts },
      { type: 'phase:start', runId: runBId, sessionId: sessionBId, planSet: 'feature-b', command: 'build', timestamp: ts },
      { type: 'phase:end', runId: runBId, result: { status: 'completed', summary: 'ok' }, timestamp: ts },
      { type: 'session:end', sessionId: sessionBId, result: { status: 'completed', summary: 'ok' }, timestamp: ts },
    ];

    // Run both sessions concurrently (interleaved via Promise.all)
    const [resultA, resultB] = await Promise.all([
      collectEvents(withRecording(asGenerator(sessionAEvents), db, cwd, 100)),
      collectEvents(withRecording(asGenerator(sessionBEvents), db, cwd, 200)),
    ]);

    // --- Isolate upserts per session ---
    const upsertsA = upserts(resultA);
    const upsertsB = upserts(resultB);

    expect(upsertsA.length).toBeGreaterThan(0);
    expect(upsertsB.length).toBeGreaterThan(0);

    // All upserts from session A must reference the same run ID
    const runIdA = upsertsA[0].run.id;
    for (const u of upsertsA) {
      expect(u.run.id).toBe(runIdA);
    }

    // All upserts from session B must reference the phase run ID
    for (const u of upsertsB) {
      expect(u.run.id).toBe(runBId);
    }

    // The two run IDs must be distinct (no cross-contamination)
    expect(runIdA).not.toBe(runBId);

    // Session A's run is an enqueue run; session B's is a build run
    const lastA = upsertsA[upsertsA.length - 1];
    const lastB = upsertsB[upsertsB.length - 1];
    expect(lastA.run.command).toBe('enqueue');
    expect(lastB.run.command).toBe('build');

    // Final status for both should be completed
    expect(lastA.run.status).toBe('completed');
    expect(lastB.run.status).toBe('completed');

    // DB should contain exactly 2 runs
    const allRuns = db.getRuns();
    const runIds = new Set(allRuns.map((r) => r.id));
    expect(runIds.has(runIdA)).toBe(true);
    expect(runIds.has(runBId)).toBe(true);

    db.close();
  });

  it('session A enqueueRunId does not appear in session B daemon:run:upsert payloads', async () => {
    const cwd = makeTmpCwd();
    const db = openDatabase(join(cwd, '.eforge', 'monitor.db'));
    const ts = new Date().toISOString();

    // Two enqueue-only sessions
    const sessionCId = `sess-c-${Date.now()}`;
    const sessionDId = `sess-d-${Date.now()}`;

    const sessionCEvents: EforgeEvent[] = [
      { type: 'session:start', sessionId: sessionCId, timestamp: ts },
      { type: 'enqueue:start', source: 'file-watch', timestamp: ts },
      {
        type: 'enqueue:complete',
        id: 'prd-c',
        filePath: '/queue/prd-c.md',
        title: 'Feature C',
        planSet: 'feature-c',
        timestamp: ts,
      },
      { type: 'session:end', sessionId: sessionCId, result: { status: 'completed', summary: 'ok' }, timestamp: ts },
    ];

    const sessionDEvents: EforgeEvent[] = [
      { type: 'session:start', sessionId: sessionDId, timestamp: ts },
      { type: 'enqueue:start', source: 'api', timestamp: ts },
      { type: 'enqueue:failed', error: 'validation error', timestamp: ts },
      { type: 'session:end', sessionId: sessionDId, result: { status: 'failed', summary: 'err' }, timestamp: ts },
    ];

    const [resultC, resultD] = await Promise.all([
      collectEvents(withRecording(asGenerator(sessionCEvents), db, cwd, 300)),
      collectEvents(withRecording(asGenerator(sessionDEvents), db, cwd, 400)),
    ]);

    const upsertsC = upserts(resultC);
    const upsertsD = upserts(resultD);

    const runIdC = upsertsC[0].run.id;
    const runIdD = upsertsD[0].run.id;

    // IDs must be distinct
    expect(runIdC).not.toBe(runIdD);

    // No upsert from session C references session D's run ID
    for (const u of upsertsC) {
      expect(u.run.id).not.toBe(runIdD);
    }

    // No upsert from session D references session C's run ID
    for (const u of upsertsD) {
      expect(u.run.id).not.toBe(runIdC);
    }

    // Session C ended successfully; session D ended failed
    expect(upsertsC[upsertsC.length - 1].run.status).toBe('completed');
    expect(upsertsD[upsertsD.length - 1].run.status).toBe('failed');

    db.close();
  });
});
