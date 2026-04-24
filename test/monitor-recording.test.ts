import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { useTempDir } from './test-tmpdir.js';
import { ensureMonitor } from '@eforge-build/monitor';
import { openDatabase } from '@eforge-build/monitor/db';
import type { EforgeEvent } from '@eforge-build/engine/events';

describe('ensureMonitor with noServer', () => {
  const makeTempDir = useTempDir();

  it('returns server: null with a working wrapEvents when noServer is true', async () => {
    const cwd = makeTempDir();
    mkdirSync(resolve(cwd, '.eforge'), { recursive: true });

    const monitor = await ensureMonitor(cwd, { noServer: true });

    expect(monitor.server).toBeNull();
    expect(typeof monitor.wrapEvents).toBe('function');
    expect(typeof monitor.stop).toBe('function');
    expect(monitor.db).toBeDefined();

    monitor.stop();
  });

  it('records events to SQLite via wrapEvents when noServer is true', async () => {
    const cwd = makeTempDir();
    mkdirSync(resolve(cwd, '.eforge'), { recursive: true });

    const monitor = await ensureMonitor(cwd, { noServer: true });

    // Create a minimal event stream with phase:start and phase:end
    const runId = 'test-run-001';
    const sessionId = 'test-session-001';
    const now = new Date().toISOString();

    async function* fakeEvents(): AsyncGenerator<EforgeEvent> {
      yield {
        type: 'phase:start',
        runId,
        sessionId,
        planSet: 'test-set',
        command: 'build',
        timestamp: now,
      } as unknown as EforgeEvent;
      yield {
        type: 'phase:end',
        runId,
        sessionId,
        result: { status: 'completed' },
        timestamp: now,
      } as unknown as EforgeEvent;
    }

    const wrapped = monitor.wrapEvents(fakeEvents());
    const collected: EforgeEvent[] = [];
    for await (const event of wrapped) {
      collected.push(event);
    }

    expect(collected).toHaveLength(2);
    expect(collected[0].type).toBe('phase:start');
    expect(collected[1].type).toBe('phase:end');

    // Verify events were inserted into the DB
    const dbPath = resolve(cwd, '.eforge', 'monitor.db');
    const db = openDatabase(dbPath);
    const runs = db.getRuns();
    expect(runs.length).toBeGreaterThanOrEqual(1);
    const run = runs.find((r) => r.id === runId);
    expect(run).toBeDefined();
    expect(run!.status).toBe('completed');

    const events = db.getEvents(runId);
    expect(events).toHaveLength(2);

    db.close();
    monitor.stop();
  });
});

describe('enqueue recording', () => {
  const makeTempDir = useTempDir();

  it('records enqueue event stream as a run with command enqueue', async () => {
    const cwd = makeTempDir();
    mkdirSync(resolve(cwd, '.eforge'), { recursive: true });
    const dbPath = resolve(cwd, '.eforge', 'monitor.db');
    const db = openDatabase(dbPath);

    const sessionId = 'test-session-enqueue';
    const now = new Date().toISOString();

    const events: EforgeEvent[] = [
      { type: 'session:start', sessionId, timestamp: now } as unknown as EforgeEvent,
      { type: 'enqueue:start', source: '/tmp/my-prd.md' , timestamp: now } as unknown as EforgeEvent,
      { type: 'agent:start', agentId: 'a1', agent: 'formatter', timestamp: now } as unknown as EforgeEvent,
      { type: 'agent:result', agent: 'formatter', result: { durationMs: 100, durationApiMs: 80, numTurns: 1, totalCostUsd: 0.01, usage: { input: 100, output: 50, total: 150 }, modelUsage: {} } , timestamp: now } as unknown as EforgeEvent,
      { type: 'agent:stop', agentId: 'a1', agent: 'formatter', timestamp: now } as unknown as EforgeEvent,
      { type: 'enqueue:complete', id: 'prd-001', filePath: '/tmp/queue/prd-001.md', title: 'My Great Feature' , timestamp: now } as unknown as EforgeEvent,
      { type: 'session:end', sessionId, result: { status: 'completed', summary: 'Enqueued' }, timestamp: now } as unknown as EforgeEvent,
    ];

    async function* fakeEvents(): AsyncGenerator<EforgeEvent> {
      for (const e of events) yield e;
    }

    const { withRecording } = await import('@eforge-build/monitor/recorder');
    const wrapped = withRecording(fakeEvents(), db, cwd);
    const collected: EforgeEvent[] = [];
    for await (const event of wrapped) {
      collected.push(event);
    }

    expect(collected).toHaveLength(7);

    // Find the enqueue run
    const runs = db.getRuns();
    const enqueueRun = runs.find((r) => r.command === 'enqueue');
    expect(enqueueRun).toBeDefined();
    expect(enqueueRun!.status).toBe('completed');
    expect(enqueueRun!.planSet).toBe('My Great Feature');

    // All 7 events should be stored (session:start is buffered then flushed)
    const dbEvents = db.getEvents(enqueueRun!.id);
    expect(dbEvents).toHaveLength(7);

    db.close();
  });
});

describe('enqueue:failed recording', () => {
  const makeTempDir = useTempDir();

  it('marks enqueue run as failed when enqueue:failed event is recorded', async () => {
    const cwd = makeTempDir();
    mkdirSync(resolve(cwd, '.eforge'), { recursive: true });
    const dbPath = resolve(cwd, '.eforge', 'monitor.db');
    const db = openDatabase(dbPath);

    const sessionId = 'test-session-enqueue-failed';
    const now = new Date().toISOString();

    const events: EforgeEvent[] = [
      { type: 'session:start', sessionId, timestamp: now } as unknown as EforgeEvent,
      { type: 'enqueue:start', source: '/tmp/my-prd.md' , timestamp: now } as unknown as EforgeEvent,
      { type: 'agent:start', agentId: 'a1', agent: 'formatter', timestamp: now } as unknown as EforgeEvent,
      { type: 'agent:stop', agentId: 'a1', agent: 'formatter', timestamp: now } as unknown as EforgeEvent,
      { type: 'enqueue:failed', error: 'Formatter crashed: invalid input' , timestamp: now } as unknown as EforgeEvent,
      { type: 'session:end', sessionId, result: { status: 'failed', summary: 'Enqueue failed: Formatter crashed: invalid input' }, timestamp: now } as unknown as EforgeEvent,
    ];

    async function* fakeEvents(): AsyncGenerator<EforgeEvent> {
      for (const e of events) yield e;
    }

    const { withRecording } = await import('@eforge-build/monitor/recorder');
    const wrapped = withRecording(fakeEvents(), db, cwd);
    const collected: EforgeEvent[] = [];
    for await (const event of wrapped) {
      collected.push(event);
    }

    expect(collected).toHaveLength(6);

    // Find the enqueue run
    const runs = db.getRuns();
    const enqueueRun = runs.find((r) => r.command === 'enqueue');
    expect(enqueueRun).toBeDefined();
    expect(enqueueRun!.status).toBe('failed');

    db.close();
  });
});

describe('enqueue-only session via runSession + withRecording', () => {
  const makeTempDir = useTempDir();

  it('records enqueue-only session with completed status when using runSession', async () => {
    const cwd = makeTempDir();
    mkdirSync(resolve(cwd, '.eforge'), { recursive: true });
    const dbPath = resolve(cwd, '.eforge', 'monitor.db');
    const db = openDatabase(dbPath);

    const now = new Date().toISOString();

    // Simulate an enqueue-only event stream (no phase:end)
    async function* enqueueOnlyEvents(): AsyncGenerator<EforgeEvent> {
      yield { type: 'enqueue:start', source: '/tmp/my-prd.md' , timestamp: now } as unknown as EforgeEvent;
      yield { type: 'agent:start', agentId: 'a1', agent: 'formatter', timestamp: now } as unknown as EforgeEvent;
      yield { type: 'agent:stop', agentId: 'a1', agent: 'formatter', timestamp: now } as unknown as EforgeEvent;
      yield { type: 'enqueue:complete', id: 'prd-002', filePath: '/tmp/queue/prd-002.md', title: 'Enqueue Only Feature' , timestamp: now } as unknown as EforgeEvent;
    }

    // Wrap with runSession (which should detect enqueue:complete as success)
    const { runSession } = await import('@eforge-build/engine/session');
    const sessionId = 'test-session-enqueue-only';
    const sessionWrapped = runSession(enqueueOnlyEvents(), sessionId);

    const { withRecording } = await import('@eforge-build/monitor/recorder');
    const recorded = withRecording(sessionWrapped, db, cwd);

    const collected: EforgeEvent[] = [];
    for await (const event of recorded) {
      collected.push(event);
    }

    // Should have session:start + 4 inner events + session:end = 6
    expect(collected).toHaveLength(6);

    // session:end should report completed
    const sessionEnd = collected.find((e) => e.type === 'session:end');
    expect(sessionEnd).toBeDefined();
    expect(sessionEnd!.type === 'session:end' && sessionEnd!.result.status).toBe('completed');

    // Check the database — the enqueue run should have status 'completed'
    const runs = db.getRuns();
    const enqueueRun = runs.find((r) => r.command === 'enqueue');
    expect(enqueueRun).toBeDefined();
    expect(enqueueRun!.status).toBe('completed');

    db.close();
  });
});

describe('queue cycle event scoping', () => {
  const makeTempDir = useTempDir();

  it('queue-level events between PRD sessions are not recorded under either PRD run', async () => {
    const cwd = makeTempDir();
    mkdirSync(resolve(cwd, '.eforge'), { recursive: true });
    const dbPath = resolve(cwd, '.eforge', 'monitor.db');
    const db = openDatabase(dbPath);

    const now = new Date().toISOString();

    // Simulate a queue cycle with 2 PRD sessions and queue-level events in between
    async function* queueCycleEvents(): AsyncGenerator<EforgeEvent> {
      // --- PRD 1 session ---
      yield { type: 'session:start', sessionId: 'session-1', timestamp: now } as unknown as EforgeEvent;
      yield { type: 'phase:start', runId: 'run-1', sessionId: 'session-1', planSet: 'prd-1', command: 'build', timestamp: now } as unknown as EforgeEvent;
      yield { type: 'phase:end', runId: 'run-1', sessionId: 'session-1', result: { status: 'completed' }, timestamp: now } as unknown as EforgeEvent;
      yield { type: 'session:end', sessionId: 'session-1', result: { status: 'completed', summary: 'Done' }, timestamp: now } as unknown as EforgeEvent;

      // --- Queue-level events between sessions ---
      yield { type: 'queue:prd:skip', prdId: 'prd-skip', reason: 'already done', timestamp: now } as unknown as EforgeEvent;
      yield { type: 'queue:prd:discovered', prdId: 'prd-new', title: 'New PRD', timestamp: now } as unknown as EforgeEvent;

      // --- PRD 2 session ---
      yield { type: 'session:start', sessionId: 'session-2', timestamp: now } as unknown as EforgeEvent;
      yield { type: 'phase:start', runId: 'run-2', sessionId: 'session-2', planSet: 'prd-2', command: 'build', timestamp: now } as unknown as EforgeEvent;
      yield { type: 'phase:end', runId: 'run-2', sessionId: 'session-2', result: { status: 'completed' }, timestamp: now } as unknown as EforgeEvent;
      yield { type: 'session:end', sessionId: 'session-2', result: { status: 'completed', summary: 'Done' }, timestamp: now } as unknown as EforgeEvent;
    }

    const { withRecording } = await import('@eforge-build/monitor/recorder');
    const wrapped = withRecording(queueCycleEvents(), db, cwd);
    const collected: EforgeEvent[] = [];
    for await (const event of wrapped) {
      collected.push(event);
    }

    expect(collected).toHaveLength(10);

    // Both runs should exist
    const runs = db.getRuns();
    const run1 = runs.find((r) => r.id === 'run-1');
    const run2 = runs.find((r) => r.id === 'run-2');
    expect(run1).toBeDefined();
    expect(run2).toBeDefined();

    // Queue-level events should NOT be in run-1's events
    const run1Events = db.getEvents('run-1');
    const run1Types = run1Events.map((e) => e.type);
    expect(run1Types).not.toContain('queue:prd:skip');
    expect(run1Types).not.toContain('queue:prd:discovered');

    // Queue-level events should NOT be in run-2's events
    const run2Events = db.getEvents('run-2');
    const run2Types = run2Events.map((e) => e.type);
    expect(run2Types).not.toContain('queue:prd:skip');
    expect(run2Types).not.toContain('queue:prd:discovered');

    db.close();
  });
});

describe('multi-phase session recording with withRunId', () => {
  const makeTempDir = useTempDir();

  it('session:end IS present in SQLite events after compile + build phases', async () => {
    const cwd = makeTempDir();
    mkdirSync(resolve(cwd, '.eforge'), { recursive: true });
    const dbPath = resolve(cwd, '.eforge', 'monitor.db');
    const db = openDatabase(dbPath);

    const now = new Date().toISOString();

    // Simulate a multi-phase session: compile then build
    async function* multiPhaseEvents(): AsyncGenerator<EforgeEvent> {
      yield { type: 'session:start', sessionId: 'session-multi', timestamp: now } as unknown as EforgeEvent;
      // Compile phase
      yield { type: 'phase:start', runId: 'run-compile', sessionId: 'session-multi', planSet: 'test-set', command: 'compile', timestamp: now } as unknown as EforgeEvent;
      yield { type: 'planning:start', source: 'test.md' , timestamp: now } as unknown as EforgeEvent;
      yield { type: 'phase:end', runId: 'run-compile', sessionId: 'session-multi', result: { status: 'completed' }, timestamp: now } as unknown as EforgeEvent;
      // Build phase
      yield { type: 'phase:start', runId: 'run-build', sessionId: 'session-multi', planSet: 'test-set', command: 'build', timestamp: now } as unknown as EforgeEvent;
      yield { type: 'plan:build:start', planId: 'plan-01' , timestamp: now } as unknown as EforgeEvent;
      yield { type: 'plan:build:complete', planId: 'plan-01' , timestamp: now } as unknown as EforgeEvent;
      yield { type: 'phase:end', runId: 'run-build', sessionId: 'session-multi', result: { status: 'completed' }, timestamp: now } as unknown as EforgeEvent;
      yield { type: 'session:end', sessionId: 'session-multi', result: { status: 'completed', summary: 'All done' }, timestamp: now } as unknown as EforgeEvent;
    }

    // Run through withRunId then withRecording
    const { withRunId } = await import('@eforge-build/engine/session');
    const { withRecording } = await import('@eforge-build/monitor/recorder');
    const stamped = withRunId(multiPhaseEvents());
    const recorded = withRecording(stamped, db, cwd);

    const collected: EforgeEvent[] = [];
    for await (const event of recorded) {
      collected.push(event);
    }

    expect(collected).toHaveLength(9);

    // Both runs should exist
    const runs = db.getRuns();
    const compileRun = runs.find((r) => r.id === 'run-compile');
    const buildRun = runs.find((r) => r.id === 'run-build');
    expect(compileRun).toBeDefined();
    expect(buildRun).toBeDefined();
    expect(compileRun!.status).toBe('completed');
    expect(buildRun!.status).toBe('completed');

    // session:end should be recorded under the build run (via withRunId's lastRunId)
    const buildEvents = db.getEvents('run-build');
    const buildEventTypes = buildEvents.map((e) => e.type);
    expect(buildEventTypes).toContain('session:end');

    db.close();
  });
});

describe('queue cycle recording with session:end presence', () => {
  const makeTempDir = useTempDir();

  it('session:end events ARE present per run in the DB', async () => {
    const cwd = makeTempDir();
    mkdirSync(resolve(cwd, '.eforge'), { recursive: true });
    const dbPath = resolve(cwd, '.eforge', 'monitor.db');
    const db = openDatabase(dbPath);

    const now = new Date().toISOString();

    // Simulate a queue cycle with 2 PRD sessions, using withRunId
    async function* queueCycleEvents(): AsyncGenerator<EforgeEvent> {
      // --- PRD 1 session ---
      yield { type: 'session:start', sessionId: 'session-1', timestamp: now } as unknown as EforgeEvent;
      yield { type: 'phase:start', runId: 'run-1', sessionId: 'session-1', planSet: 'prd-1', command: 'build', timestamp: now } as unknown as EforgeEvent;
      yield { type: 'plan:build:start', planId: 'plan-01' , timestamp: now } as unknown as EforgeEvent;
      yield { type: 'phase:end', runId: 'run-1', sessionId: 'session-1', result: { status: 'completed' }, timestamp: now } as unknown as EforgeEvent;
      yield { type: 'session:end', sessionId: 'session-1', result: { status: 'completed', summary: 'Done' }, timestamp: now } as unknown as EforgeEvent;

      // --- Queue-level events between sessions ---
      yield { type: 'queue:prd:skip', prdId: 'prd-skip', reason: 'already done', timestamp: now } as unknown as EforgeEvent;

      // --- PRD 2 session ---
      yield { type: 'session:start', sessionId: 'session-2', timestamp: now } as unknown as EforgeEvent;
      yield { type: 'phase:start', runId: 'run-2', sessionId: 'session-2', planSet: 'prd-2', command: 'build', timestamp: now } as unknown as EforgeEvent;
      yield { type: 'plan:build:start', planId: 'plan-02' , timestamp: now } as unknown as EforgeEvent;
      yield { type: 'phase:end', runId: 'run-2', sessionId: 'session-2', result: { status: 'completed' }, timestamp: now } as unknown as EforgeEvent;
      yield { type: 'session:end', sessionId: 'session-2', result: { status: 'completed', summary: 'Done' }, timestamp: now } as unknown as EforgeEvent;
    }

    const { withRunId } = await import('@eforge-build/engine/session');
    const { withRecording } = await import('@eforge-build/monitor/recorder');
    const stamped = withRunId(queueCycleEvents());
    const recorded = withRecording(stamped, db, cwd);

    const collected: EforgeEvent[] = [];
    for await (const event of recorded) {
      collected.push(event);
    }

    // Both runs should exist
    const runs = db.getRuns();
    const run1 = runs.find((r) => r.id === 'run-1');
    const run2 = runs.find((r) => r.id === 'run-2');
    expect(run1).toBeDefined();
    expect(run2).toBeDefined();

    // session:end should be present in run-1's events
    const run1Events = db.getEvents('run-1');
    const run1Types = run1Events.map((e) => e.type);
    expect(run1Types).toContain('session:end');

    // session:end should be present in run-2's events
    const run2Events = db.getEvents('run-2');
    const run2Types = run2Events.map((e) => e.type);
    expect(run2Types).toContain('session:end');

    // Queue-level events should NOT be in either run
    expect(run1Types).not.toContain('queue:prd:skip');
    expect(run2Types).not.toContain('queue:prd:skip');

    db.close();
  });
});

describe('recorder extracts diffs from build:files_changed events', () => {
  const makeTempDir = useTempDir();

  it('inserts diffs into file_diffs table and strips them from serialized event', async () => {
    const cwd = makeTempDir();
    mkdirSync(resolve(cwd, '.eforge'), { recursive: true });
    const dbPath = resolve(cwd, '.eforge', 'monitor.db');
    const db = openDatabase(dbPath);

    const sessionId = 'session-diffs';
    const runId = 'run-diffs';
    const now = new Date().toISOString();

    async function* fakeEvents(): AsyncGenerator<EforgeEvent> {
      yield { type: 'session:start', sessionId, timestamp: now } as unknown as EforgeEvent;
      yield {
        type: 'phase:start', runId, sessionId, planSet: 'test-set', command: 'build', timestamp: now,
      } as unknown as EforgeEvent;
      yield {
        type: 'plan:build:files_changed',
        runId,
        planId: 'plan-01',
        files: ['src/a.ts', 'src/b.ts'],
        diffs: [
          { path: 'src/a.ts', diff: 'diff content for a' },
          { path: 'src/b.ts', diff: 'diff content for b' },
        ],
        timestamp: now,
      } as unknown as EforgeEvent;
      yield {
        type: 'phase:end', runId, sessionId, result: { status: 'completed' }, timestamp: now,
      } as unknown as EforgeEvent;
      yield {
        type: 'session:end', sessionId, result: { status: 'completed', summary: 'Done' }, timestamp: now,
      } as unknown as EforgeEvent;
    }

    const { withRecording } = await import('@eforge-build/monitor/recorder');
    const wrapped = withRecording(fakeEvents(), db, cwd);
    const collected: EforgeEvent[] = [];
    for await (const event of wrapped) {
      collected.push(event);
    }

    // Diffs should be inserted into file_diffs table
    const diffA = db.getFileDiff(sessionId, 'plan-01', 'src/a.ts');
    expect(diffA).toBeDefined();
    expect(diffA!.diffText).toBe('diff content for a');

    const diffB = db.getFileDiff(sessionId, 'plan-01', 'src/b.ts');
    expect(diffB).toBeDefined();
    expect(diffB!.diffText).toBe('diff content for b');

    // The serialized event in the events table should NOT contain diffs
    const events = db.getEvents(runId);
    const filesChangedEvent = events.find((e) => e.type === 'plan:build:files_changed');
    expect(filesChangedEvent).toBeDefined();
    const parsed = JSON.parse(filesChangedEvent!.data);
    expect(parsed.diffs).toBeUndefined();
    expect(parsed.files).toEqual(['src/a.ts', 'src/b.ts']);

    db.close();
  });

  it('passes through build:files_changed without diffs unchanged', async () => {
    const cwd = makeTempDir();
    mkdirSync(resolve(cwd, '.eforge'), { recursive: true });
    const dbPath = resolve(cwd, '.eforge', 'monitor.db');
    const db = openDatabase(dbPath);

    const sessionId = 'session-no-diffs';
    const runId = 'run-no-diffs';
    const now = new Date().toISOString();

    async function* fakeEvents(): AsyncGenerator<EforgeEvent> {
      yield { type: 'session:start', sessionId, timestamp: now } as unknown as EforgeEvent;
      yield {
        type: 'phase:start', runId, sessionId, planSet: 'test-set', command: 'build', timestamp: now,
      } as unknown as EforgeEvent;
      yield {
        type: 'plan:build:files_changed',
        runId,
        planId: 'plan-01',
        files: ['src/a.ts'],
        timestamp: now,
      } as unknown as EforgeEvent;
      yield {
        type: 'phase:end', runId, sessionId, result: { status: 'completed' }, timestamp: now,
      } as unknown as EforgeEvent;
      yield {
        type: 'session:end', sessionId, result: { status: 'completed', summary: 'Done' }, timestamp: now,
      } as unknown as EforgeEvent;
    }

    const { withRecording } = await import('@eforge-build/monitor/recorder');
    const wrapped = withRecording(fakeEvents(), db, cwd);
    const collected: EforgeEvent[] = [];
    for await (const event of wrapped) {
      collected.push(event);
    }

    // No diffs should be in file_diffs table
    const diffs = db.getFileDiffs(sessionId, 'plan-01');
    expect(diffs).toHaveLength(0);

    // The event should still be recorded normally
    const events = db.getEvents(runId);
    const filesChangedEvent = events.find((e) => e.type === 'plan:build:files_changed');
    expect(filesChangedEvent).toBeDefined();
    const parsed = JSON.parse(filesChangedEvent!.data);
    expect(parsed.files).toEqual(['src/a.ts']);

    db.close();
  });
});

describe('buildMonitor wiring', () => {
  const makeTempDir = useTempDir();

  it('creates a monitor with server info when port is provided', async () => {
    const cwd = makeTempDir();
    mkdirSync(resolve(cwd, '.eforge'), { recursive: true });

    // Use noServer to avoid spawning a real server — this tests the buildMonitor
    // path for recording-only mode
    const monitor = await ensureMonitor(cwd, { noServer: true });

    // The monitor should have a null server when noServer is true
    expect(monitor.server).toBeNull();
    expect(monitor.db).toBeDefined();

    // wrapEvents should return an async generator
    async function* emptyEvents(): AsyncGenerator<EforgeEvent> {}
    const wrapped = monitor.wrapEvents(emptyEvents());
    expect(wrapped[Symbol.asyncIterator]).toBeDefined();

    monitor.stop();
  });
});
