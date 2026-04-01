/**
 * Shared daemon client utilities.
 *
 * Extracted from mcp-proxy.ts so that both the MCP proxy and other
 * consumers (e.g. plugin skills) can share daemon lifecycle helpers.
 */

import { readLockfile, isServerAlive } from '../monitor/lockfile.js';
import { spawn } from 'node:child_process';

export const DAEMON_START_TIMEOUT_MS = 15_000;
export const DAEMON_POLL_INTERVAL_MS = 500;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function ensureDaemon(cwd: string): Promise<number> {
  const existing = readLockfile(cwd);
  if (existing && (await isServerAlive(existing))) {
    return existing.port;
  }

  // Auto-start daemon
  const child = spawn('eforge', ['daemon', 'start'], {
    cwd,
    detached: true,
    stdio: 'ignore',
  });
  child.on('error', () => {
    // Swallow — poll loop will time out with descriptive error
  });
  child.unref();

  const deadline = Date.now() + DAEMON_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(DAEMON_POLL_INTERVAL_MS);
    const lock = readLockfile(cwd);
    if (lock && (await isServerAlive(lock))) {
      return lock.port;
    }
  }

  throw new Error(
    'Daemon failed to start within timeout. Run `eforge daemon start` manually to diagnose.',
  );
}

/**
 * Like daemonRequest but only talks to an already-running daemon.
 * Returns null if daemon is not running instead of trying to start it.
 */
export async function daemonRequestIfRunning(
  cwd: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ data: unknown; port: number } | null> {
  const lock = readLockfile(cwd);
  if (!lock || !(await isServerAlive(lock))) return null;
  return daemonRequestWithPort(lock.port, method, path, body);
}

async function daemonRequestWithPort(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ data: unknown; port: number }> {
  const url = `http://127.0.0.1:${port}${path}`;
  const options: RequestInit = {
    method,
    signal: AbortSignal.timeout(30_000),
  };
  if (body !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  const res = await fetch(url, options);
  const text = await res.text();
  if (!res.ok) {
    const truncated = text.length > 200 ? text.slice(0, 200) + '...' : text;
    throw new Error(`Daemon returned ${res.status}: ${truncated}`);
  }
  try {
    return { data: JSON.parse(text), port };
  } catch {
    return { data: text, port };
  }
}

export async function daemonRequest(
  cwd: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ data: unknown; port: number }> {
  const port = await ensureDaemon(cwd);
  return daemonRequestWithPort(port, method, path, body);
}
