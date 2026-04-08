import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import type { EforgeEvent } from './events.js';
import type { HookConfig } from './config.js';

const execAsync = promisify(execFile);

/**
 * Resolve the git origin remote URL for the given directory.
 * Returns empty string if not a git repo or no origin configured.
 */
async function resolveGitRemote(cwd: string): Promise<string> {
  try {
    const { stdout } = await execAsync('git', ['remote', 'get-url', 'origin'], { cwd });
    return stdout.trim();
  } catch {
    return '';
  }
}

/**
 * Convert a glob pattern to a RegExp.
 * `*` matches any characters including `:`, anchored with `^...$`.
 * Regex-special characters in non-`*` segments are escaped.
 */
export function compilePattern(pattern: string): RegExp {
  const escaped = pattern
    .split('*')
    .map((segment) => segment.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`);
}

/**
 * Check if a glob pattern matches an event type string.
 */
export function matchesPattern(pattern: string, eventType: string): boolean {
  return compilePattern(pattern).test(eventType);
}

/**
 * Execute a single hook for an event. Fire-and-forget — never rejects.
 * Tracks its promise in `inflight` and removes on settle.
 */
function executeHook(
  hook: HookConfig,
  event: EforgeEvent,
  baseEnv: Record<string, string | undefined>,
  cwd: string,
  inflight: Set<Promise<void>>,
): void {
  const promise = new Promise<void>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(hook.command, [], {
        cwd,
        stdio: ['pipe', 'ignore', 'pipe'],
        shell: true,
        env: { ...baseEnv, EFORGE_EVENT_TYPE: event.type },
      });
    } catch {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, hook.timeout);
    timer.unref();

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', () => {
      clearTimeout(timer);
      resolve();
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && code !== null) {
        process.stderr.write(
          `Warning: hook "${hook.command}" exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}\n`,
        );
      }
      resolve();
    });

    // Suppress EPIPE errors on stdin (process may exit before we finish writing)
    child.stdin?.on('error', () => {});
    try {
      child.stdin?.write(JSON.stringify(event));
      child.stdin?.end();
    } catch {
      // stdin may already be closed
    }
  });

  inflight.add(promise);
  promise.finally(() => {
    inflight.delete(promise);
  });
}

/**
 * Async generator middleware that fires hooks for matching events.
 * Events are yielded unchanged — hooks run non-blocking in the background.
 * On teardown, in-flight hooks are drained with a timeout derived from the
 * maximum configured hook timeout plus a 1-second grace period.
 */
export async function* withHooks(
  events: AsyncGenerator<EforgeEvent>,
  hooks: readonly HookConfig[],
  cwd: string,
): AsyncGenerator<EforgeEvent> {
  // Zero-overhead: no hooks means passthrough
  if (hooks.length === 0) {
    yield* events;
    return;
  }

  // Pre-compile all patterns
  const compiled = hooks.map((hook) => ({
    regex: compilePattern(hook.event),
    hook,
  }));

  // Resolve session-level env vars once
  const gitRemote = await resolveGitRemote(cwd);
  const hookEnv: Record<string, string | undefined> = {
    ...process.env,
    EFORGE_CWD: cwd,
    EFORGE_GIT_REMOTE: gitRemote,
  };

  const inflight = new Set<Promise<void>>();

  try {
    for await (const event of events) {
      // Capture session and run IDs from lifecycle events
      if (event.sessionId) {
        hookEnv.EFORGE_SESSION_ID = event.sessionId;
      }
      if (event.type === 'phase:start' || event.type === 'phase:end') {
        hookEnv.EFORGE_RUN_ID = event.runId;
      }

      // Fire matching hooks (non-blocking)
      for (const { regex, hook } of compiled) {
        if (regex.test(event.type)) {
          executeHook(hook, event, hookEnv, cwd, inflight);
        }
      }

      yield event;
    }
  } finally {
    // Drain in-flight hooks with a timeout derived from the max hook timeout + 1s grace
    if (inflight.size > 0) {
      const drainTimeout = Math.max(...hooks.map((h) => h.timeout), 0) + 1000;
      await Promise.race([
        Promise.allSettled([...inflight]),
        new Promise<void>((r) => {
          const t = setTimeout(r, drainTimeout);
          t.unref();
        }),
      ]);
    }
  }
}
