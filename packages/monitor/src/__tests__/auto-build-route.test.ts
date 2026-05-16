/**
 * Tests for POST /api/auto-build daemon-mode mutations.
 *
 * Follows AGENTS.md conventions:
 * - Real SQLite DB via openDatabase. Real HTTP via startServer.
 * - Constructs inputs inline.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { API_ROUTES } from '@eforge-build/client';
import { openDatabase } from '../db.js';
import { startServer } from '../server.js';
import type { DaemonState, MonitorServer, WorkerTracker } from '../server.js';
import { AutoBuildSupervisor, type AutoBuildWatcherState } from '../auto-build-supervisor.js';

function makeTmpCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), 'eforge-auto-build-route-'));
  mkdirSync(join(dir, '.eforge'), { recursive: true });
  return dir;
}

function makeDaemonState(options: {
  desired?: 'enabled' | 'disabled';
  mode?: 'disabled' | 'starting' | 'running' | 'paused' | 'stopping' | 'restarting' | 'faulted';
  watcher?: AutoBuildWatcherState;
  schedulerAlive?: boolean;
} = {}): { daemonState: DaemonState; calls: string[] } {
  const calls: string[] = [];
  let watcher = options.watcher ?? { running: false, pid: null, sessionId: null };
  let schedulerAlive = options.schedulerAlive ?? watcher.running;

  const controller = new AutoBuildSupervisor({
    initialState: {
      desired: options.desired ?? 'disabled',
      mode: options.mode ?? 'disabled',
      watcher,
      scheduler: { alive: schedulerAlive, paused: false },
    },
    effects: {
      now: () => '2025-01-01T00:00:00.000Z',
      getWatcher: () => watcher,
      isSchedulerAlive: () => schedulerAlive,
      spawnWatcher: () => {
        calls.push('spawn-watcher');
        watcher = { running: true, pid: null, sessionId: 'watcher-spawned' };
        schedulerAlive = true;
      },
      stopWatcher: () => {
        calls.push('stop-watcher');
        watcher = { running: false, pid: null, sessionId: null };
        schedulerAlive = false;
      },
      restartWatcher: () => {
        calls.push('restart-watcher');
        watcher = { running: true, pid: null, sessionId: 'watcher-restarted' };
        schedulerAlive = true;
      },
      pauseScheduler: () => calls.push('pause-scheduler'),
      resumeScheduler: () => {
        calls.push('resume-scheduler');
        schedulerAlive = true;
      },
      emitSchedulerMutation: (reason) => calls.push(`mutation:${reason}`),
      emitEvent: (event) => calls.push(`event:${event.type}`),
    },
  });

  return { daemonState: { autoBuildController: controller }, calls };
}

const servers: MonitorServer[] = [];

afterEach(async () => {
  for (const server of servers) {
    try {
      await server.stop();
    } catch {
      // best-effort cleanup
    }
  }
  servers.length = 0;
  vi.restoreAllMocks();
});

describe('POST /api/auto-build', () => {
  it('manual disable delegates to the controller and returns AutoBuildState', async () => {
    const cwd = makeTmpCwd();
    const db = openDatabase(join(cwd, '.eforge', 'monitor.db'));
    const { daemonState, calls } = makeDaemonState({
      desired: 'enabled',
      mode: 'running',
      watcher: { running: true, pid: 1234, sessionId: 'watcher-session' },
      schedulerAlive: true,
    });

    const server = await startServer(db, 0, { cwd, daemonState });
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${server.port}${API_ROUTES.autoBuildSet}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      enabled: false,
      desired: 'disabled',
      mode: 'disabled',
      watcher: { running: false, pid: null, sessionId: null },
    });
    expect(calls).toEqual([
      'event:daemon:auto-build:transition',
      'pause-scheduler',
      'stop-watcher',
      'event:daemon:auto-build:transition',
      'event:daemon:auto-build:disabled',
    ]);

    db.close();
  });

  it('manual enable delegates to the controller and returns the controller snapshot', async () => {
    const cwd = makeTmpCwd();
    const db = openDatabase(join(cwd, '.eforge', 'monitor.db'));
    const { daemonState, calls } = makeDaemonState();

    const server = await startServer(db, 0, { cwd, daemonState });
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${server.port}${API_ROUTES.autoBuildSet}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      enabled: true,
      desired: 'enabled',
      mode: 'running',
      watcher: { running: true, pid: null, sessionId: 'watcher-spawned' },
    });
    expect(calls).toContain('spawn-watcher');
    expect(calls).toContain('event:daemon:auto-build:enabled');

    db.close();
  });

  it('rejects invalid bodies without calling the controller', async () => {
    const cwd = makeTmpCwd();
    const db = openDatabase(join(cwd, '.eforge', 'monitor.db'));
    const { daemonState, calls } = makeDaemonState();
    const server = await startServer(db, 0, { cwd, daemonState });
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${server.port}${API_ROUTES.autoBuildSet}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: 'yes' }),
    });

    expect(response.status).toBe(400);
    expect(calls).toEqual([]);

    db.close();
  });

  it('enabling an inert running watcher restarts the watcher generation', async () => {
    const cwd = makeTmpCwd();
    const db = openDatabase(join(cwd, '.eforge', 'monitor.db'));
    const { daemonState, calls } = makeDaemonState({
      desired: 'enabled',
      mode: 'running',
      watcher: { running: true, pid: null, sessionId: 'watcher-inert' },
      schedulerAlive: false,
    });
    const server = await startServer(db, 0, { cwd, daemonState });
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${server.port}${API_ROUTES.autoBuildSet}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { mode?: string; watcher?: { sessionId?: string | null } };
    expect(body.mode).toBe('running');
    expect(body.watcher?.sessionId).toBe('watcher-spawned');
    expect(calls).toContain('spawn-watcher');

    db.close();
  });
});

describe('POST /api/enqueue', () => {
  it('notifies the auto-build controller after the enqueue worker completes', async () => {
    const cwd = makeTmpCwd();
    const db = openDatabase(join(cwd, '.eforge', 'monitor.db'));
    const { daemonState, calls } = makeDaemonState({
      desired: 'enabled',
      mode: 'running',
      watcher: { running: true, pid: null, sessionId: 'watcher-live' },
      schedulerAlive: true,
    });
    const workerExitCallbacks: Array<() => void> = [];
    const workerTracker: WorkerTracker = {
      spawnWorker: (_command, _args, onExit) => {
        if (onExit) workerExitCallbacks.push(onExit);
        return { sessionId: 'enqueue-session', pid: 12345 };
      },
      cancelWorker: () => false,
    };
    const server = await startServer(db, 0, { cwd, daemonState, workerTracker });
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${server.port}${API_ROUTES.enqueue}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: '# Test PRD' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ sessionId: 'enqueue-session', autoBuild: true });
    expect(calls).not.toContain('mutation:enqueue');

    expect(workerExitCallbacks).toHaveLength(1);
    workerExitCallbacks[0]!();
    expect(calls).toContain('mutation:enqueue');

    db.close();
  });
});

describe('POST /api/scheduler/kick', () => {
  it('delegates queue mutation wakes to the auto-build controller', async () => {
    const cwd = makeTmpCwd();
    const db = openDatabase(join(cwd, '.eforge', 'monitor.db'));
    const { daemonState, calls } = makeDaemonState({
      desired: 'enabled',
      mode: 'running',
      watcher: { running: true, pid: null, sessionId: 'watcher-live' },
      schedulerAlive: true,
    });
    const server = await startServer(db, 0, { cwd, daemonState });
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${server.port}${API_ROUTES.schedulerKick}`, { method: 'POST' });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(calls).toContain('mutation:external');

    db.close();
  });
});
