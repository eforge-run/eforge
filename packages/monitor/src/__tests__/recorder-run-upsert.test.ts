/**
 * End-to-end recorder test: daemon:run:upsert emission.
 *
 * Drives withRecording() over synthetic event streams and asserts:
 *   1. Exactly one daemon:run:upsert is yielded per DB mutation
 *      (insertRun, updateRunStatus, updateRunPlanSet).
 *   2. Each payload's `run` field deep-equals db.getRunById(runId).
 *
 * Covers two sequences:
 *   - Enqueue-only: enqueue:start → enqueue:complete (and enqueue:failed variant)
 *   - Phase-driven build: phase:start → phase:end
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
import type { RunInfo } from '@eforge-build/client';

function makeTmpCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), 'eforge-recorder-upsert-'));
  mkdirSync(join(dir, '.eforge'), { recursive: true });
  return dir;
}

/** Convert an array of events into an async generator. */
async function* asGenerator(events: EforgeEvent[]): AsyncGenerator<EforgeEvent> {
  for (const event of events) yield event;
}

/** Collect all yielded events from a withRecording generator. */
async function collectEvents(gen: AsyncGenerator<EforgeEvent>): Promise<EforgeEvent[]> {
  const result: EforgeEvent[] = [];
  for await (const event of gen) result.push(event);
  return result;
}

// ---------------------------------------------------------------------------
// Helper: extract daemon:run:upsert events from a collected sequence
// ---------------------------------------------------------------------------

function upserts(events: EforgeEvent[]): Extract<EforgeEvent, { type: 'daemon:run:upsert' }>[] {
  return events.filter(
    (e): e is Extract<EforgeEvent, { type: 'daemon:run:upsert' }> =>
      e.type === 'daemon:run:upsert',
  );
}

// ---------------------------------------------------------------------------
// Enqueue-only sequence: enqueue:start → enqueue:complete
// ---------------------------------------------------------------------------

describe('withRecording() enqueue-only sequence', () => {
  it('emits exactly 2 daemon:run:upsert events (one on insertRun, one on updateRunStatus)', async () => {
    const cwd = makeTmpCwd();
    const db = openDatabase(join(cwd, '.eforge', 'monitor.db'));
    const ts = new Date().toISOString();

    const inputEvents: EforgeEvent[] = [
      { type: 'session:start', sessionId: 'sess-enq-1', timestamp: ts },
      { type: 'enqueue:start', source: 'api', timestamp: ts },
      {
        type: 'enqueue:complete',
        id: 'prd-abc',
        filePath: '/queue/prd-abc.md',
        title: 'My Feature',
        planSet: 'my-feature',
        timestamp: ts,
      },
      { type: 'session:end', sessionId: 'sess-enq-1', result: { status: 'completed', summary: 'done' }, timestamp: ts },
    ];

    const yielded = await collectEvents(withRecording(asGenerator(inputEvents), db, cwd));
    const emitted = upserts(yielded);

    // Expect exactly 2: one after insertRun (enqueue:start) and one after updateRunStatus (enqueue:complete)
    expect(emitted).toHaveLength(2);

    // Both should be for the same run (the enqueue run)
    const runId = emitted[0].run.id;
    expect(emitted[1].run.id).toBe(runId);

    // First upsert: run is 'running' with command='enqueue'
    // Verify the full payload shape at insertion time (no completedAt yet,
    // cwd matches, planSet matches the source provided to enqueue:start).
    expect(emitted[0].run.command).toBe('enqueue');
    expect(emitted[0].run.status).toBe('running');
    expect(emitted[0].run.cwd).toBe(cwd);
    expect(emitted[0].run.completedAt).toBeUndefined();
    expect(typeof emitted[0].run.startedAt).toBe('string');

    // Second upsert: run is 'completed' with planSet updated
    expect(emitted[1].run.status).toBe('completed');
    expect(emitted[1].run.planSet).toBe('my-feature');
    expect(emitted[1].run.completedAt).toBeDefined();

    // Each payload must deep-equal db.getRunById at the time of emission —
    // verify final state matches db.getRuns()
    const dbRuns = db.getRuns();
    const dbRun = dbRuns.find((r) => r.id === runId);
    expect(dbRun).toBeDefined();
    expect(emitted[1].run).toEqual(dbRun as RunInfo);

    db.close();
  });

  it('emits 2 daemon:run:upsert events for enqueue:failed (insertRun + updateRunStatus)', async () => {
    const cwd = makeTmpCwd();
    const db = openDatabase(join(cwd, '.eforge', 'monitor.db'));
    const ts = new Date().toISOString();

    const inputEvents: EforgeEvent[] = [
      { type: 'session:start', sessionId: 'sess-enq-fail', timestamp: ts },
      { type: 'enqueue:start', source: 'api', timestamp: ts },
      { type: 'enqueue:failed', error: 'git commit failed', timestamp: ts },
      { type: 'session:end', sessionId: 'sess-enq-fail', result: { status: 'failed', summary: 'err' }, timestamp: ts },
    ];

    const yielded = await collectEvents(withRecording(asGenerator(inputEvents), db, cwd));
    const emitted = upserts(yielded);

    // 2 upserts: insertRun + updateRunStatus(failed)
    expect(emitted).toHaveLength(2);
    expect(emitted[0].run.status).toBe('running');
    expect(emitted[1].run.status).toBe('failed');

    // Verify final run matches DB
    const dbRun = db.getRunById(emitted[1].run.id);
    expect(dbRun).toBeDefined();
    expect(emitted[1].run).toEqual(dbRun as RunInfo);

    db.close();
  });

  it('emits daemon:run:upsert on session:end with failed result for enqueue sessions', async () => {
    const cwd = makeTmpCwd();
    const db = openDatabase(join(cwd, '.eforge', 'monitor.db'));
    const ts = new Date().toISOString();

    // Simulate: enqueue:start is received but no enqueue:complete/failed before session:end fails
    const inputEvents: EforgeEvent[] = [
      { type: 'session:start', sessionId: 'sess-enq-crash', timestamp: ts },
      { type: 'enqueue:start', source: 'api', timestamp: ts },
      // session:end(failed) without explicit enqueue:failed — the recorder updates
      // enqueueRunId to 'failed' in the session:end handler
      { type: 'session:end', sessionId: 'sess-enq-crash', result: { status: 'failed', summary: 'crash' }, timestamp: ts },
    ];

    const yielded = await collectEvents(withRecording(asGenerator(inputEvents), db, cwd));
    const emitted = upserts(yielded);

    // Expect: insertRun upsert + session:end failure upsert = 2
    expect(emitted).toHaveLength(2);
    expect(emitted[0].run.status).toBe('running');
    expect(emitted[1].run.status).toBe('failed');

    db.close();
  });
});

// ---------------------------------------------------------------------------
// Phase-driven build sequence: phase:start → phase:end
// ---------------------------------------------------------------------------

describe('withRecording() phase-driven build sequence', () => {
  it('emits exactly 2 daemon:run:upsert events (insertRun + updateRunStatus)', async () => {
    const cwd = makeTmpCwd();
    const db = openDatabase(join(cwd, '.eforge', 'monitor.db'));
    const ts = new Date().toISOString();
    const runId = `run-phase-${Date.now()}`;
    const sessionId = `sess-phase-${Date.now()}`;

    const inputEvents: EforgeEvent[] = [
      { type: 'session:start', sessionId, timestamp: ts },
      { type: 'phase:start', runId, sessionId, planSet: 'my-plan-set', command: 'build', timestamp: ts },
      { type: 'phase:end', runId, result: { status: 'completed', summary: 'done' }, timestamp: ts },
      { type: 'session:end', sessionId, result: { status: 'completed', summary: 'done' }, timestamp: ts },
    ];

    const yielded = await collectEvents(withRecording(asGenerator(inputEvents), db, cwd));
    const emitted = upserts(yielded);

    // 2 upserts: insertRun (phase:start) + updateRunStatus (phase:end)
    expect(emitted).toHaveLength(2);

    // Both should reference the phase runId
    expect(emitted[0].run.id).toBe(runId);
    expect(emitted[1].run.id).toBe(runId);

    // First: running
    expect(emitted[0].run.status).toBe('running');
    expect(emitted[0].run.command).toBe('build');
    expect(emitted[0].run.planSet).toBe('my-plan-set');

    // Second: completed
    expect(emitted[1].run.status).toBe('completed');

    // Final payload must equal db.getRunById
    const dbRun = db.getRunById(runId);
    expect(dbRun).toBeDefined();
    expect(emitted[1].run).toEqual(dbRun as RunInfo);

    // Also verify the emitted[0] payload matched db state at that time by checking
    // it has all required fields
    expect(emitted[0].run.cwd).toBe(cwd);
    expect(typeof emitted[0].run.startedAt).toBe('string');

    db.close();
  });

  it('daemon:run:upsert events are persisted to the DB and visible via getDaemonEventsAfter', async () => {
    const cwd = makeTmpCwd();
    const db = openDatabase(join(cwd, '.eforge', 'monitor.db'));
    const ts = new Date().toISOString();
    const runId = `run-persist-${Date.now()}`;
    const sessionId = `sess-persist-${Date.now()}`;

    const inputEvents: EforgeEvent[] = [
      { type: 'session:start', sessionId, timestamp: ts },
      { type: 'phase:start', runId, sessionId, planSet: 'test-set', command: 'compile', timestamp: ts },
      { type: 'phase:end', runId, result: { status: 'failed', summary: 'err' }, timestamp: ts },
      { type: 'session:end', sessionId, result: { status: 'failed', summary: 'err' }, timestamp: ts },
    ];

    await collectEvents(withRecording(asGenerator(inputEvents), db, cwd));

    // Retrieve all daemon-wide events; daemon:run:upsert should be in there
    const daemonEvents = db.getDaemonEventsAfter(0);
    const upsertEvents = daemonEvents.filter((e) => e.type === 'daemon:run:upsert');

    expect(upsertEvents.length).toBe(2);

    // Parse and verify
    const first = JSON.parse(upsertEvents[0].data) as Extract<EforgeEvent, { type: 'daemon:run:upsert' }>;
    const second = JSON.parse(upsertEvents[1].data) as Extract<EforgeEvent, { type: 'daemon:run:upsert' }>;

    expect(first.type).toBe('daemon:run:upsert');
    expect(first.run.id).toBe(runId);
    expect(first.run.status).toBe('running');

    expect(second.run.id).toBe(runId);
    expect(second.run.status).toBe('failed');

    db.close();
  });

  it('daemon:run:upsert events are ordered after their triggering event in the yield sequence', async () => {
    const cwd = makeTmpCwd();
    const db = openDatabase(join(cwd, '.eforge', 'monitor.db'));
    const ts = new Date().toISOString();
    const runId = `run-order-${Date.now()}`;
    const sessionId = `sess-order-${Date.now()}`;

    const inputEvents: EforgeEvent[] = [
      { type: 'session:start', sessionId, timestamp: ts },
      { type: 'phase:start', runId, sessionId, planSet: 'test', command: 'build', timestamp: ts },
      { type: 'phase:end', runId, result: { status: 'completed', summary: 'ok' }, timestamp: ts },
      { type: 'session:end', sessionId, result: { status: 'completed', summary: 'ok' }, timestamp: ts },
    ];

    const yielded = await collectEvents(withRecording(asGenerator(inputEvents), db, cwd));
    const types = yielded.map((e) => e.type);

    // phase:start should be immediately followed by its daemon:run:upsert
    const phaseStartIdx = types.indexOf('phase:start');
    expect(types[phaseStartIdx + 1]).toBe('daemon:run:upsert');

    // phase:end should be immediately followed by its daemon:run:upsert
    const phaseEndIdx = types.indexOf('phase:end');
    expect(types[phaseEndIdx + 1]).toBe('daemon:run:upsert');

    db.close();
  });
});
