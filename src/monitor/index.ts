import { resolve, dirname } from 'node:path';
import { accessSync } from 'node:fs';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { EforgeEvent } from '../engine/events.js';
import { openDatabase, type MonitorDB } from './db.js';
import { withRecording } from './recorder.js';
import { readLockfile, isServerAlive, killPidIfAlive, removeLockfile } from './lockfile.js';
import { allocatePort } from './registry.js';

export type { MonitorDB } from './db.js';
export type { MonitorServer } from './server.js';
export { withRecording } from './recorder.js';
export { allocatePort } from './registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface Monitor {
  db: MonitorDB;
  server: { port: number; url: string } | null;
  wrapEvents(events: AsyncGenerator<EforgeEvent>): AsyncGenerator<EforgeEvent>;
  stop(): void;
}

export interface EnsureMonitorOptions {
  port?: number;
  noServer?: boolean;
}

const DEFAULT_PORT = 4567;
const HEALTH_CHECK_RETRIES = 20;
const HEALTH_CHECK_INTERVAL_MS = 250;

/**
 * Ensure a detached monitor server is running. If one is already alive
 * (checked via lockfile + health endpoint), reuse it. Otherwise, spawn
 * a new detached child process.
 *
 * When `noServer` is true, opens the DB and returns a Monitor with
 * `server: null` but a fully functional `wrapEvents`. No lockfile or
 * server process is touched.
 *
 * Returns a Monitor whose `wrapEvents` only writes to SQLite (the detached
 * server polls the DB for SSE delivery). `stop()` closes the DB connection
 * but does NOT kill the server.
 */
export async function ensureMonitor(cwd: string, options?: EnsureMonitorOptions): Promise<Monitor> {
  const dbPath = process.env.EFORGE_MONITOR_DB || resolve(cwd, '.eforge', 'monitor.db');
  const db = openDatabase(dbPath);

  if (options?.noServer) {
    return buildMonitor(db, null, cwd);
  }

  const envPort = process.env.EFORGE_MONITOR_PORT ? parseInt(process.env.EFORGE_MONITOR_PORT, 10) : undefined;
  if (envPort !== undefined && (Number.isNaN(envPort) || envPort < 1024 || envPort > 65535)) {
    throw new Error(`Invalid EFORGE_MONITOR_PORT: "${process.env.EFORGE_MONITOR_PORT}" (must be 1024-65535)`);
  }
  const preferredPort = allocatePort(cwd, options?.port ?? envPort);

  // Check if a server is already alive
  const existingLock = readLockfile(cwd);
  if (existingLock) {
    const alive = await isServerAlive(existingLock);
    if (alive) {
      return buildMonitor(db, existingLock.port, cwd);
    }
    // Stale lockfile — kill stale PIDs before spawning new server
    killPidIfAlive(existingLock.pid);
    if (existingLock.watcherPid) {
      killPidIfAlive(existingLock.watcherPid);
    }
    removeLockfile(cwd);
  }

  // Spawn detached child process
  const getSpawnError = await spawnDetachedServer(dbPath, preferredPort, cwd);

  // Wait for the server to come up by polling lockfile + health
  const serverPort = await waitForServer(cwd, getSpawnError);

  return buildMonitor(db, serverPort, cwd);
}

/**
 * Signal the detached monitor server to shut down, if no active runs remain.
 * Reads the lockfile, checks server health, queries the DB for running runs,
 * and sends SIGTERM if idle.
 */
export async function signalMonitorShutdown(cwd: string): Promise<void> {
  const lock = readLockfile(cwd);
  if (!lock) return;

  const alive = await isServerAlive(lock);
  if (!alive) return;

  // Check if there are running runs by opening DB briefly
  const dbPath = process.env.EFORGE_MONITOR_DB || resolve(cwd, '.eforge', 'monitor.db');
  let hasRunning = false;
  try {
    const checkDb = openDatabase(dbPath);
    hasRunning = checkDb.getRunningRuns().length > 0;
    checkDb.close();
  } catch {}

  if (hasRunning) return;

  // Send SIGTERM to the detached server
  try {
    process.kill(lock.pid, 'SIGTERM');
  } catch {}
}

function buildMonitor(db: MonitorDB, port: number | null, cwd: string): Monitor {
  return {
    db,
    server: port !== null ? { port, url: `http://localhost:${port}` } : null,
    wrapEvents(events: AsyncGenerator<EforgeEvent>): AsyncGenerator<EforgeEvent> {
      return withRecording(events, db, cwd, process.pid);
    },
    stop(): void {
      db.close();
    },
  };
}

function resolveServerMain(): string {
  // In prod (bundled): __dirname = dist/, server-main.js sits alongside cli.js
  // In dev (tsx): __dirname = src/monitor/, server-main.ts is in the same directory
  const jsPath = resolve(__dirname, 'server-main.js');
  try {
    accessSync(jsPath);
    return jsPath;
  } catch {}
  const tsPath = resolve(__dirname, 'server-main.ts');
  try {
    accessSync(tsPath);
    return tsPath;
  } catch {}
  throw new Error(`Monitor server entry point not found at ${jsPath} or ${tsPath}`);
}

async function spawnDetachedServer(
  dbPath: string,
  port: number,
  cwd: string,
): Promise<() => Error | undefined> {
  const serverMainPath = resolveServerMain();

  let spawnError: Error | undefined;

  const child = fork(serverMainPath, [dbPath, String(port), cwd], {
    detached: true,
    stdio: 'ignore',
    // Propagate execArgv so tsx loaders work in dev mode
    execArgv: [...process.execArgv, '--disable-warning=ExperimentalWarning'],
  });

  child.on('error', (err) => {
    spawnError = err;
  });

  // Detach the child so the parent can exit independently
  child.unref();
  child.disconnect?.();

  return () => spawnError;
}

async function waitForServer(
  cwd: string,
  getSpawnError?: () => Error | undefined,
): Promise<number> {
  for (let i = 0; i < HEALTH_CHECK_RETRIES; i++) {
    const err = getSpawnError?.();
    if (err) {
      throw new Error(`Monitor server failed to spawn: ${err.message}`);
    }

    await sleep(HEALTH_CHECK_INTERVAL_MS);

    const lock = readLockfile(cwd);
    if (lock) {
      const alive = await isServerAlive(lock);
      if (alive) {
        return lock.port;
      }
    }
  }

  const err = getSpawnError?.();
  const detail = err ? `: ${err.message}` : '';
  throw new Error(`Monitor server failed to start within timeout${detail}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
