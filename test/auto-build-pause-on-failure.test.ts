import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { maybePauseOnFailure, type PauseOnFailureCtx } from '@eforge-build/monitor/server-main';
import { openDatabase } from '@eforge-build/monitor/db';
import type { EforgeEvent } from '@eforge-build/engine/events';
import type { DaemonState } from '@eforge-build/monitor/server';

function makeDaemonState(killWatcher: () => void): DaemonState {
  return {
    autoBuild: true,
    watcher: { running: true, pid: null, sessionId: null },
    onSpawnWatcher: () => {},
    onKillWatcher: killWatcher,
    onShutdown: undefined,
  };
}

function makeFailedEvent(prdId: string): EforgeEvent {
  return {
    type: 'queue:prd:complete',
    prdId,
    status: 'failed',
    timestamp: new Date().toISOString(),
  } as unknown as EforgeEvent;
}

describe('maybePauseOnFailure', () => {
  it('pauses auto-build on the first failed queue:prd:complete', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'eforge-auto-build-pause-'));
    const eforgeDir = resolve(tmpDir, '.eforge');
    mkdirSync(eforgeDir, { recursive: true });
    const db = openDatabase(resolve(eforgeDir, 'monitor.db'));

    try {
      const sessionId = 'watcher-session-pause-test-001';
      const prdId = 'sample-prd';
      const killWatcher = vi.fn();
      const daemonState = makeDaemonState(killWatcher);

      const ctx: PauseOnFailureCtx = {
        isActiveController: () => true,
        daemonState,
        db,
        sessionId,
      };

      maybePauseOnFailure(makeFailedEvent(prdId), ctx);

      // (a) autoBuild should be false
      expect(daemonState.autoBuild).toBe(false);

      // (b) daemon:auto-build:paused event written to DB with correct reason
      const pausedEvents = db.getEventsByType(sessionId, 'daemon:auto-build:paused');
      expect(pausedEvents.length).toBeGreaterThan(0);
      const parsed = JSON.parse(pausedEvents[0].data) as { reason: string };
      expect(parsed.reason).toBe(`Build failed: ${prdId}`);

      // (c) onKillWatcher called exactly once
      expect(killWatcher).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not re-pause when autoBuild is already false (idempotency guard)', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'eforge-auto-build-idempotent-'));
    const eforgeDir = resolve(tmpDir, '.eforge');
    mkdirSync(eforgeDir, { recursive: true });
    const db = openDatabase(resolve(eforgeDir, 'monitor.db'));

    try {
      const sessionId = 'watcher-session-idempotent-001';
      const killWatcher = vi.fn();
      const daemonState = makeDaemonState(killWatcher);

      const ctx: PauseOnFailureCtx = {
        isActiveController: () => true,
        daemonState,
        db,
        sessionId,
      };

      const failedEvent = makeFailedEvent('sample-prd');

      // First call pauses
      maybePauseOnFailure(failedEvent, ctx);
      expect(daemonState.autoBuild).toBe(false);
      expect(killWatcher).toHaveBeenCalledTimes(1);

      // Second call is a no-op: autoBuild is already false
      maybePauseOnFailure(failedEvent, ctx);
      expect(killWatcher).toHaveBeenCalledTimes(1); // still 1

      const pausedEvents = db.getEventsByType(sessionId, 'daemon:auto-build:paused');
      expect(pausedEvents).toHaveLength(1); // only one event written
    } finally {
      db.close();
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not pause when controller is not the active one', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'eforge-auto-build-controller-'));
    const eforgeDir = resolve(tmpDir, '.eforge');
    mkdirSync(eforgeDir, { recursive: true });
    const db = openDatabase(resolve(eforgeDir, 'monitor.db'));

    try {
      const sessionId = 'watcher-session-controller-guard-001';
      const killWatcher = vi.fn();
      const daemonState = makeDaemonState(killWatcher);

      const ctx: PauseOnFailureCtx = {
        isActiveController: () => false, // superseded controller
        daemonState,
        db,
        sessionId,
      };

      maybePauseOnFailure(makeFailedEvent('sample-prd'), ctx);

      expect(daemonState.autoBuild).toBe(true); // unchanged
      expect(killWatcher).not.toHaveBeenCalled();
      expect(db.getEventsByType(sessionId, 'daemon:auto-build:paused')).toHaveLength(0);
    } finally {
      db.close();
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not pause on queue:prd:complete with status completed', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'eforge-auto-build-completed-'));
    const eforgeDir = resolve(tmpDir, '.eforge');
    mkdirSync(eforgeDir, { recursive: true });
    const db = openDatabase(resolve(eforgeDir, 'monitor.db'));

    try {
      const sessionId = 'watcher-session-completed-test-001';
      const killWatcher = vi.fn();
      const daemonState = makeDaemonState(killWatcher);

      const ctx: PauseOnFailureCtx = {
        isActiveController: () => true,
        daemonState,
        db,
        sessionId,
      };

      const completedEvent = {
        type: 'queue:prd:complete',
        prdId: 'sample-prd',
        status: 'completed',
        timestamp: new Date().toISOString(),
      } as unknown as EforgeEvent;

      maybePauseOnFailure(completedEvent, ctx);

      expect(daemonState.autoBuild).toBe(true); // unchanged
      expect(killWatcher).not.toHaveBeenCalled();
    } finally {
      db.close();
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
