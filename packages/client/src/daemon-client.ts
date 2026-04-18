/**
 * Shared daemon client utilities.
 *
 * Extracted from mcp-proxy.ts so that both the MCP proxy and other
 * consumers (e.g. plugin skills) can share daemon lifecycle helpers.
 */

import { readLockfile, isServerAlive } from './lockfile.js';
import { spawn } from 'node:child_process';
import { basename, resolve } from 'node:path';

export const DAEMON_START_TIMEOUT_MS = 15_000;
export const DAEMON_POLL_INTERVAL_MS = 500;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * True when `cwd` looks like an eforge agent worktree: the merge worktree
 * (`.../<project>-<setName>-worktrees/__merge__`) or a per-module worktree
 * (`.../<project>-<setName>-worktrees/<moduleId>`). Spawning a daemon there
 * causes a recursive auto-build of the still-committed PRD in
 * `eforge/queue/`. See the bug report in `eforge/queue/`.
 */
export function isAgentWorktreeCwd(cwd: string): boolean {
  if (basename(cwd) === '__merge__') return true;
  return /-worktrees$/.test(basename(resolve(cwd, '..')));
}

export class DaemonInWorktreeError extends Error {
  readonly cwd: string;
  constructor(cwd: string) {
    super(
      `Refusing to spawn eforge daemon from agent worktree: ${cwd}. ` +
      `An auto-discovered eforge plugin or extension reached an agent subprocess. ` +
      `Run eforge from the project root, not from inside a worktree.`,
    );
    this.name = 'DaemonInWorktreeError';
    this.cwd = cwd;
  }
}

export async function ensureDaemon(cwd: string): Promise<number> {
  const existing = readLockfile(cwd);
  if (existing && (await isServerAlive(existing))) {
    return existing.port;
  }

  if (isAgentWorktreeCwd(cwd)) {
    throw new DaemonInWorktreeError(cwd);
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
export async function daemonRequestIfRunning<T = unknown>(
  cwd: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ data: T; port: number } | null> {
  const lock = readLockfile(cwd);
  if (!lock || !(await isServerAlive(lock))) return null;
  return daemonRequestWithPort<T>(lock.port, method, path, body);
}

async function daemonRequestWithPort<T = unknown>(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ data: T; port: number }> {
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
    return { data: JSON.parse(text) as T, port };
  } catch {
    return { data: text as T, port };
  }
}

export async function daemonRequest<T = unknown>(
  cwd: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ data: T; port: number }> {
  const port = await ensureDaemon(cwd);
  return daemonRequestWithPort<T>(port, method, path, body);
}
