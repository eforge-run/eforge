import { readFileSync, writeFileSync, unlinkSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface LockfileData {
  pid: number;
  port: number;
  startedAt: string;
}

const LOCKFILE_NAME = 'monitor.lock';

export function lockfilePath(cwd: string): string {
  return resolve(cwd, '.eforge', LOCKFILE_NAME);
}

export function readLockfile(cwd: string): LockfileData | null {
  try {
    const raw = readFileSync(lockfilePath(cwd), 'utf-8');
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

export function writeLockfile(cwd: string, data: LockfileData): void {
  const target = lockfilePath(cwd);
  mkdirSync(dirname(target), { recursive: true });

  // Atomic write: write to temp file then rename
  const tmpFile = resolve(dirname(target), `.monitor.lock.${randomBytes(4).toString('hex')}.tmp`);
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
