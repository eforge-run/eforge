/**
 * Best-effort opener for session plan Markdown files.
 *
 * Spawns the platform's default application for the given path in a detached
 * child process. Never throws — all outcomes are encoded in the returned
 * OpenStatus so callers can surface them without failing the parent operation.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { resolve as resolvePath, sep as pathSep } from 'node:path';

export interface OpenStatus {
  attempted: boolean;
  ok: boolean;
  command?: string;
  error?: string;
}

export interface OpenSessionPlanOptions {
  /** Absolute path to the .eforge/session-plans/{session}.md file. */
  path: string;
  /** Project working directory; used to enforce path containment. */
  cwd: string;
  /** For testing: override platform detection. */
  platform?: NodeJS.Platform;
  /** For testing: inject a spawn function. */
  spawn?: (command: string, args: string[], options: object) => { unref?: () => void };
}

export function openSessionPlanFile(opts: OpenSessionPlanOptions): OpenStatus {
  const { path, cwd } = opts;
  const platform = opts.platform ?? process.platform;
  const spawnFn = opts.spawn ?? nodeSpawn;

  // Path containment check — defense in depth even though daemon already constrains it.
  // Use the OS-native separator so the prefix matches `path.resolve()` output on Windows (\) and POSIX (/).
  const prefix = resolvePath(cwd, '.eforge', 'session-plans') + pathSep;
  const resolved = resolvePath(path);
  if (!resolved.startsWith(prefix)) {
    return { attempted: false, ok: false, error: 'path-out-of-scope' };
  }

  let command: string;
  let args: string[];

  switch (platform) {
    case 'darwin':
      command = 'open';
      args = [path];
      break;
    case 'linux':
      command = 'xdg-open';
      args = [path];
      break;
    case 'win32':
      command = 'cmd';
      args = ['/c', 'start', '""', path];
      break;
    default:
      return { attempted: false, ok: false, error: 'unsupported-platform' };
  }

  try {
    const child = spawnFn(command, args, {
      detached: true,
      stdio: 'ignore',
    });
    child.unref?.();
    return { attempted: true, ok: true, command };
  } catch (err) {
    return { attempted: true, ok: false, command, error: String(err) };
  }
}
