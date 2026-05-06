/**
 * Tests for the refactored reconcileOrphanedState (structured-report contract)
 * and the caller's daemon:recovery:* emission sequence.
 *
 * Follows AGENTS.md conventions:
 * - No mocks. Real SQLite DB via openDatabase. Real filesystem for lock dirs.
 * - Constructs synthetic input rows inline (no fixtures).
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db.js';
import { reconcileOrphanedState, writeDaemonEvent, type ReconciliationReport } from '../server-main.js';

// A PID that is guaranteed to be dead (no process ever runs with this id in tests).
const DEAD_PID = 999999;

function makeTmpCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), 'eforge-recovery-emit-'));
  mkdirSync(join(dir, '.eforge'), { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// 1. Structured-report shape
// ---------------------------------------------------------------------------

describe('reconcileOrphanedState returns structured report', () => {
  it('returns the correct shape with runsFailed, locksRemoved, durationMs', () => {
    const cwd = makeTmpCwd();
    const db = openDatabase(join(cwd, '.eforge', 'monitor.db'));

    // Insert a run whose PID is dead
    db.insertRun({
      id: 'run-dead',
      sessionId: 'sess-dead',
      planSet: 'test-set',
      command: 'build',
      status: 'running',
      startedAt: new Date().toISOString(),
      cwd,
      pid: DEAD_PID,
    });

    // Create a stale lock file
    const lockDir = join(cwd, '.eforge', 'queue-locks');
    mkdirSync(lockDir, { recursive: true });
    const lockPath = join(lockDir, 'prd-stale.lock');
    writeFileSync(lockPath, String(DEAD_PID));

    const report = reconcileOrphanedState(db, cwd);

    // runsFailed shape
    expect(Array.isArray(report.runsFailed)).toBe(true);
    expect(report.runsFailed).toHaveLength(1);
    expect(report.runsFailed[0]).toMatchObject({
      runId: 'run-dead',
      sessionId: 'sess-dead',
      planSet: 'test-set',
      reason: expect.stringContaining('reconciled'),
    });

    // locksRemoved shape
    expect(Array.isArray(report.locksRemoved)).toBe(true);
    expect(report.locksRemoved).toHaveLength(1);
    expect(report.locksRemoved[0]).toMatchObject({
      path: lockPath,
      pid: DEAD_PID,
    });

    // durationMs is a non-negative number
    expect(typeof report.durationMs).toBe('number');
    expect(report.durationMs).toBeGreaterThanOrEqual(0);

    db.close();
  });

  it('returns empty arrays when nothing needs reconciling', () => {
    const cwd = makeTmpCwd();
    const db = openDatabase(join(cwd, '.eforge', 'monitor.db'));

    // Insert a run whose PID is the current process (alive)
    db.insertRun({
      id: 'run-alive',
      planSet: 'test-set',
      command: 'build',
      status: 'running',
      startedAt: new Date().toISOString(),
      cwd,
      pid: process.pid,
    });

    const report = reconcileOrphanedState(db, cwd);

    expect(report.runsFailed).toHaveLength(0);
    expect(report.locksRemoved).toHaveLength(0);
    expect(typeof report.durationMs).toBe('number');

    db.close();
  });

  it('emits no daemon:recovery:* events itself (emission is the caller\'s responsibility)', () => {
    const cwd = makeTmpCwd();
    const db = openDatabase(join(cwd, '.eforge', 'monitor.db'));

    // Insert a dead run to ensure reconciliation actually does something
    db.insertRun({
      id: 'run-dead-2',
      planSet: 'test-set',
      command: 'build',
      status: 'running',
      startedAt: new Date().toISOString(),
      cwd,
      pid: DEAD_PID,
    });

    reconcileOrphanedState(db, cwd);

    // No daemon:recovery:* events should exist in DB (only phase:end inserted by reconciler)
    const allEvents = db.getDaemonEventsAfter(0);
    const recoveryEvents = allEvents.filter((e) =>
      e.type.startsWith('daemon:recovery:'),
    );
    expect(recoveryEvents).toHaveLength(0);

    db.close();
  });

  it('tolerates missing queue-locks directory and returns empty locksRemoved', () => {
    const cwd = makeTmpCwd();
    const db = openDatabase(join(cwd, '.eforge', 'monitor.db'));

    // No lock dir created
    const report = reconcileOrphanedState(db, cwd);

    expect(report.locksRemoved).toHaveLength(0);
    expect(typeof report.durationMs).toBe('number');

    db.close();
  });
});

// ---------------------------------------------------------------------------
// 2. Caller emission sequence and counts
// ---------------------------------------------------------------------------

describe('caller emission sequence', () => {
  it('emits daemon:recovery:start, per-item events, daemon:recovery:complete in correct sequence', () => {
    const cwd = makeTmpCwd();
    const db = openDatabase(join(cwd, '.eforge', 'monitor.db'));

    // Insert two dead runs
    db.insertRun({
      id: 'run-dead-a',
      sessionId: 'sess-a',
      planSet: 'set-a',
      command: 'build',
      status: 'running',
      startedAt: new Date().toISOString(),
      cwd,
      pid: DEAD_PID,
    });
    db.insertRun({
      id: 'run-dead-b',
      sessionId: 'sess-b',
      planSet: 'set-b',
      command: 'build',
      status: 'running',
      startedAt: new Date().toISOString(),
      cwd,
      pid: DEAD_PID,
    });

    // Create two stale lock files
    const lockDir = join(cwd, '.eforge', 'queue-locks');
    mkdirSync(lockDir, { recursive: true });
    const lockPath1 = join(lockDir, 'prd-a.lock');
    const lockPath2 = join(lockDir, 'prd-b.lock');
    writeFileSync(lockPath1, String(DEAD_PID));
    writeFileSync(lockPath2, String(DEAD_PID));

    const daemonSessionId = `daemon-test-${Date.now()}`;

    // Simulate what main() does: reconcile, then emit the sequence
    const report: ReconciliationReport = reconcileOrphanedState(db, cwd);

    writeDaemonEvent(db, { type: 'daemon:recovery:start' }, daemonSessionId);
    for (const run of report.runsFailed) {
      writeDaemonEvent(db, {
        type: 'daemon:recovery:run-marked-failed',
        runId: run.runId,
        planSet: run.planSet,
        reason: run.reason,
      }, daemonSessionId);
    }
    for (const lock of report.locksRemoved) {
      writeDaemonEvent(db, {
        type: 'daemon:recovery:lock-removed',
        path: lock.path,
        pid: lock.pid,
      }, daemonSessionId);
    }
    writeDaemonEvent(db, {
      type: 'daemon:recovery:complete',
      runsFailed: report.runsFailed.length,
      locksRemoved: report.locksRemoved.length,
      durationMs: report.durationMs,
    }, daemonSessionId);

    // Assert the DB contains the correct daemon:recovery:* events
    const daemonEvents = db.getDaemonEventsAfter(0).filter((e) =>
      e.type.startsWith('daemon:recovery:'),
    );

    // Should have: 1 start + 2 run-marked-failed + 2 lock-removed + 1 complete = 6
    expect(daemonEvents).toHaveLength(6);
    expect(daemonEvents[0].type).toBe('daemon:recovery:start');
    expect(daemonEvents[daemonEvents.length - 1].type).toBe('daemon:recovery:complete');

    // Middle events are run-marked-failed and lock-removed (order follows insertion order)
    const markedFailed = daemonEvents.filter((e) => e.type === 'daemon:recovery:run-marked-failed');
    const locksRemoved = daemonEvents.filter((e) => e.type === 'daemon:recovery:lock-removed');
    expect(markedFailed).toHaveLength(2);
    expect(locksRemoved).toHaveLength(2);

    // Validate complete event payload
    const completeEvent = daemonEvents[daemonEvents.length - 1];
    const completePayload = JSON.parse(completeEvent.data) as { runsFailed: number; locksRemoved: number; durationMs: number };
    expect(completePayload.runsFailed).toBe(2);
    expect(completePayload.locksRemoved).toBe(2);
    expect(typeof completePayload.durationMs).toBe('number');

    // All events carry the daemonSessionId
    for (const event of daemonEvents) {
      expect(event.runId).toBe(daemonSessionId);
    }

    db.close();
  });

  it('writeDaemonEvent inserts events with correct type, runId, and JSON data', () => {
    const cwd = makeTmpCwd();
    const db = openDatabase(join(cwd, '.eforge', 'monitor.db'));

    const daemonSessionId = `daemon-test-write-${Date.now()}`;

    writeDaemonEvent(db, {
      type: 'daemon:lifecycle:starting',
      pid: 12345,
      port: 4567,
      version: '1.0.0',
      mode: 'persistent',
    }, daemonSessionId);

    const events = db.getDaemonEventsAfter(0);
    const lifecycleEvent = events.find((e) => e.type === 'daemon:lifecycle:starting');
    expect(lifecycleEvent).toBeDefined();
    expect(lifecycleEvent!.runId).toBe(daemonSessionId);

    const payload = JSON.parse(lifecycleEvent!.data) as {
      type: string;
      pid: number;
      port: number;
      version: string;
      mode: string;
      sessionId: string;
    };
    expect(payload.type).toBe('daemon:lifecycle:starting');
    expect(payload.pid).toBe(12345);
    expect(payload.port).toBe(4567);
    expect(payload.sessionId).toBe(daemonSessionId);

    db.close();
  });
});
