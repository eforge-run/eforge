import { readFileSync, writeFileSync, unlinkSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface LockfileData {
  pid: number;
  port: number;
  startedAt: string;
}

export const LOCKFILE_NAME = 'daemon.lock';

/** Polling interval (ms) used when waiting for the daemon lockfile to appear. */
export const LOCKFILE_POLL_INTERVAL_MS = 250;
/** Overall timeout (ms) for daemon lockfile polling. */
export const LOCKFILE_POLL_TIMEOUT_MS = 5000;

export function lockfilePath(cwd: string): string {
  return resolve(cwd, '.eforge', LOCKFILE_NAME);
}

function tryReadLockfileAt(path: string): LockfileData | null {
  try {
    const raw = readFileSync(path, 'utf-8');
    const data = JSON.parse(raw);
    if (
      typeof data.pid === 'number' &&
      typeof data.port === 'number' &&
      typeof data.startedAt === 'string'
    ) {
      return data as LockfileData;
    }
    return null;
  } catch {
    return null;
  }
}

export function readLockfile(cwd: string): LockfileData | null {
  return tryReadLockfileAt(lockfilePath(cwd));
}

export function writeLockfile(cwd: string, data: LockfileData): void {
  const target = lockfilePath(cwd);
  mkdirSync(dirname(target), { recursive: true });

  // Atomic write: write to temp file then rename
  const tmpFile = resolve(dirname(target), `.daemon.lock.${randomBytes(4).toString('hex')}.tmp`);
  writeFileSync(tmpFile, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  renameSync(tmpFile, target);
}

export function removeLockfile(cwd: string): void {
  try {
    unlinkSync(lockfilePath(cwd));
  } catch {
    // Already removed or never existed
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Update an existing lockfile (read-modify-write).
 * Accepts either a partial object to shallow-merge, or an updater function for full control.
 * If no lockfile exists, this is a no-op.
 */
export function updateLockfile(cwd: string, partialOrUpdater: Partial<LockfileData> | ((data: LockfileData) => LockfileData)): void {
  const existing = readLockfile(cwd);
  if (!existing) return;
  const updated = typeof partialOrUpdater === 'function'
    ? partialOrUpdater(existing)
    : (() => {
        const merged = { ...existing, ...partialOrUpdater };
        // Shallow merges may pass `undefined` to clear an optional field
        // (e.g. `{ somePartialField: undefined }` removes it from the stored
        // lockfile rather than writing `"somePartialField": undefined`).
        // `LockfileData` has no optional fields today, but keep the cleanup so
        // future optional additions behave the same way.
        for (const key of Object.keys(merged) as (keyof LockfileData)[]) {
          if (merged[key] === undefined) {
            delete merged[key];
          }
        }
        return merged as LockfileData;
      })();
  writeLockfile(cwd, updated);
}

/**
 * Send a signal to a PID if it's alive. Returns true if the signal was sent.
 */
export function killPidIfAlive(pid: number, signal: NodeJS.Signals = 'SIGTERM'): boolean {
  if (!isPidAlive(pid)) return false;
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

export async function isServerAlive(lock: LockfileData): Promise<boolean> {
  // First check if the PID is alive
  if (!isPidAlive(lock.pid)) {
    return false;
  }

  // Then check if the HTTP server responds
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`http://127.0.0.1:${lock.port}/api/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (res.ok) {
      const body = (await res.json()) as { status: string };
      return body.status === 'ok';
    }
    return false;
  } catch {
    return false;
  }
}
