import { resolve, dirname } from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { EforgeEvent } from '../engine/events.js';
import { openDatabase, type MonitorDB } from './db.js';
import { withRecording } from './recorder.js';
import { readLockfile, isServerAlive } from './lockfile.js';

export type { MonitorDB } from './db.js';
export type { MonitorServer } from './server.js';
export { withRecording } from './recorder.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface Monitor {
  db: MonitorDB;
  server: { port: number; url: string };
  wrapEvents(events: AsyncGenerator<EforgeEvent>): AsyncGenerator<EforgeEvent>;
  stop(): void;
}

const DEFAULT_PORT = 4567;
const HEALTH_CHECK_RETRIES = 20;
const HEALTH_CHECK_INTERVAL_MS = 250;

/**
 * Ensure a detached monitor server is running. If one is already alive
 * (checked via lockfile + health endpoint), reuse it. Otherwise, spawn
 * a new detached child process.
 *
 * Returns a Monitor whose `wrapEvents` only writes to SQLite (the detached
 * server polls the DB for SSE delivery). `stop()` closes the DB connection
 * but does NOT kill the server.
 */
export async function ensureMonitor(cwd: string, port?: number): Promise<Monitor> {
  const dbPath = resolve(cwd, '.eforge', 'monitor.db');
  const db = openDatabase(dbPath);
  const preferredPort = port ?? DEFAULT_PORT;

  // Check if a server is already alive
  const existingLock = readLockfile(cwd);
  if (existingLock) {
    const alive = await isServerAlive(existingLock);
    if (alive) {
      return buildMonitor(db, existingLock.port, cwd);
    }
    // Stale lockfile — will be replaced by the new server
  }

  // Spawn detached child process
  await spawnDetachedServer(dbPath, preferredPort, cwd);

  // Wait for the server to come up by polling lockfile + health
  const serverPort = await waitForServer(cwd);

  return buildMonitor(db, serverPort, cwd);
}

function buildMonitor(db: MonitorDB, port: number, cwd: string): Monitor {
  return {
    db,
    server: { port, url: `http://localhost:${port}` },
    wrapEvents(events: AsyncGenerator<EforgeEvent>): AsyncGenerator<EforgeEvent> {
      return withRecording(events, db, cwd, process.pid);
    },
    stop(): void {
      db.close();
    },
  };
}

async function spawnDetachedServer(dbPath: string, port: number, cwd: string): Promise<void> {
  // Determine the server-main entry point
  // In dev (tsx), use the source file; in production, use the built file
  let serverMainPath: string;
  const builtPath = resolve(__dirname, '..', 'server-main.js');
  const sourcePath = resolve(__dirname, 'server-main.ts');

  // Check if we're running from dist/ (built) or src/ (dev)
  if (__dirname.includes('/dist/')) {
    serverMainPath = builtPath;
  } else {
    serverMainPath = sourcePath;
  }

  const child = fork(serverMainPath, [dbPath, String(port), cwd], {
    detached: true,
    stdio: 'ignore',
    // Propagate execArgv so tsx loaders work in dev mode
    execArgv: process.execArgv,
  });

  // Detach the child so the parent can exit independently
  child.unref();
  child.disconnect?.();
}

async function waitForServer(cwd: string): Promise<number> {
  for (let i = 0; i < HEALTH_CHECK_RETRIES; i++) {
    await sleep(HEALTH_CHECK_INTERVAL_MS);

    const lock = readLockfile(cwd);
    if (lock) {
      const alive = await isServerAlive(lock);
      if (alive) {
        return lock.port;
      }
    }
  }

  throw new Error('Monitor server failed to start within timeout');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
