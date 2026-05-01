import { readLockfile, isServerAlive } from './lockfile.js';
import { API_ROUTES } from './routes.js';
import type { VersionResponse } from './routes.js';

/**
 * Bump `DAEMON_API_VERSION` when making a **breaking** change to the daemon
 * HTTP API surface:
 *
 *   - Renaming a route path
 *   - Removing a required request or response field
 *   - Changing the type of an existing request or response field
 *
 * Adding a new **optional** response field is NOT breaking and must NOT bump
 * the version. Removing a field, renaming a route, or changing a response's
 * required fields IS breaking and must bump the version.
 */
export const DAEMON_API_VERSION = 14; // v14: removed `setName` request param from `GET /api/recovery/sidecar` and `POST /api/recover/apply` (dead-weight parameter — paths are computed from `prdId` alone).

/** Per-process cache: maps `${port}:${pid}` to the verified daemon version. */
const verifiedDaemons = new Map<string, number>();

/**
 * Reset the per-process version cache. For test use only.
 */
export function clearApiVersionCache(): void {
  verifiedDaemons.clear();
}

/**
 * Verify that the running daemon's API version matches `DAEMON_API_VERSION`.
 *
 * - If no lockfile exists, silently returns (the daemon is down; the caller
 *   will surface a clearer `daemon-down` error shortly via `ensureDaemon`).
 * - If the daemon reports a different version, throws an `Error` whose message
 *   contains `version mismatch` so `classifyDaemonError` routes it to
 *   `kind: 'version-mismatch'`.
 * - Results are cached per `${port}:${pid}` key for the lifetime of this
 *   process, so the check is only ever issued once per daemon instance.
 */
export async function verifyApiVersion(cwd: string): Promise<void> {
  const lock = readLockfile(cwd);
  if (!lock) return;

  // Stale lockfile: daemon process exited or port was reused. Bail out silently
  // so `ensureDaemon` downstream can detect the dead lockfile and auto-start a
  // fresh daemon instead of surfacing a misleading `daemon-down` error here.
  if (!(await isServerAlive(lock))) return;

  const cacheKey = `${lock.port}:${lock.pid}`;
  if (verifiedDaemons.has(cacheKey)) return;

  const url = `http://127.0.0.1:${lock.port}${API_ROUTES.version}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Failed to fetch daemon version: ${res.status} ${text}`);
  }

  const data = JSON.parse(text) as VersionResponse;
  if (data.version !== DAEMON_API_VERSION) {
    throw new Error(
      `eforge daemon API version-mismatch: client expects v${DAEMON_API_VERSION}, daemon reports v${data.version}. Restart the daemon with the matching version.`,
    );
  }

  verifiedDaemons.set(cacheKey, data.version);
}
