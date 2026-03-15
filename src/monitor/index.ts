import { resolve, dirname } from 'node:path';
import { accessSync } from 'node:fs';
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
  const getSpawnError = await spawnDetachedServer(dbPath, preferredPort, cwd);

  // Wait for the server to come up by polling lockfile + health
  const serverPort = await waitForServer(cwd, getSpawnError);

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
    execArgv: process.execArgv,
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
