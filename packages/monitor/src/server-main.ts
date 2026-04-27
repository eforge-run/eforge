/**
 * Detached monitor/daemon server entry point.
 *
 * Runs as a detached child process. Polls SQLite for new events,
 * serves SSE to subscribers, and detects orphaned runs.
 *
 * In ephemeral mode (default), auto-shuts down when idle using a
 * WATCHING → COUNTDOWN → SHUTDOWN state machine.
 *
 * In persistent mode (`--persistent` flag), stays alive until
 * explicitly stopped via SIGTERM/SIGINT. Used by `eforge daemon start`.
 *
 * Usage: node dist/server-main.js <dbPath> <port> <cwd> [--persistent]
 */

import { openDatabase, type MonitorDB } from './db.js';
import { startServer, type WorkerTracker, type DaemonState } from './server.js';
import { writeLockfile, removeLockfile, isPidAlive, readLockfile, isServerAlive } from '@eforge-build/client';
import { registerPort, deregisterPort } from './registry.js';
import { loadConfig, type HookConfig } from '@eforge-build/engine/config';
import { EforgeEngine } from '@eforge-build/engine/eforge';
import { withHooks } from '@eforge-build/engine/hooks';
import type { EforgeEvent } from '@eforge-build/engine/events';
import { withRecording } from './recorder.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { openSync, closeSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

const WATCHER_DRAIN_TIMEOUT_MS = 5000;
const ORPHAN_CHECK_INTERVAL_MS = 5000;
const STATE_CHECK_INTERVAL_MS = 2000;
const COUNTDOWN_WITH_SUBSCRIBERS_MS = 60_000;
const COUNTDOWN_WITHOUT_SUBSCRIBERS_MS = 10_000;
const IDLE_FALLBACK_MS = 10_000;
const MAX_WAIT_FOR_ACTIVITY_MS = 300_000;

export type ServerState = 'WATCHING' | 'COUNTDOWN' | 'SHUTDOWN';

export interface StateCheckContext {
  state: ServerState;
  lastActivityTimestamp: number;
  hasSeenActivity: boolean;
  serverStartedAt: number;
  idleFallbackMs: number;
  maxWaitForActivityMs: number;
  getRunningRuns: () => { id: string }[];
  getLatestEventTimestamp: () => string | undefined;
  transitionToCountdown: () => void;
  cancelCountdown: () => void;
}

/**
 * Core state-check logic extracted for testability.
 * Returns updated mutable fields (state, lastActivityTimestamp, hasSeenActivity).
 */
export function evaluateStateCheck(ctx: StateCheckContext): {
  state: ServerState;
  lastActivityTimestamp: number;
  hasSeenActivity: boolean;
} {
  const runningRuns = ctx.getRunningRuns();
  const hasRunning = runningRuns.length > 0;
  let { state, lastActivityTimestamp, hasSeenActivity } = ctx;

  if (hasRunning) {
    lastActivityTimestamp = Date.now();
    if (state === 'COUNTDOWN') {
      ctx.cancelCountdown();
      state = 'WATCHING';
    }
    return { state, lastActivityTimestamp, hasSeenActivity };
  }

  // No running runs
  if (state === 'WATCHING') {
    const latestTimestamp = ctx.getLatestEventTimestamp();
    if (latestTimestamp) {
      const eventTime = new Date(latestTimestamp).getTime();
      if (eventTime > lastActivityTimestamp) {
        lastActivityTimestamp = eventTime;
      }
      if (!hasSeenActivity && eventTime >= ctx.serverStartedAt) {
        hasSeenActivity = true;
      }
    }

    if (!hasSeenActivity) {
      if (ctx.maxWaitForActivityMs > 0 && Date.now() - ctx.serverStartedAt >= ctx.maxWaitForActivityMs) {
        ctx.transitionToCountdown();
        state = 'COUNTDOWN';
      }
      return { state, lastActivityTimestamp, hasSeenActivity };
    }

    const idleMs = Date.now() - lastActivityTimestamp;
    if (idleMs >= ctx.idleFallbackMs) {
      ctx.transitionToCountdown();
      state = 'COUNTDOWN';
    }
    return { state, lastActivityTimestamp, hasSeenActivity };
  }

  return { state, lastActivityTimestamp, hasSeenActivity };
}

/**
 * Reconcile orphaned queue state on daemon startup.
 *
 * Two classes of orphan:
 *  1. Runs in the SQLite DB with status='running' whose PID is no longer
 *     alive (crash, hard-kill). Marked as 'failed' with a reconcile reason.
 *  2. Lock files under `.eforge/queue-locks/*.lock` whose PID is no longer
 *     alive. Deleted so the PRD can be re-claimed.
 *
 * Ordering note: the PRD file itself is left wherever it was (usually in
 * `queue/` root) so the scheduler can pick it up again. We do NOT move it
 * to `queue/failed/` here, because that would be destructive on every
 * daemon restart — the user may want the next auto-build pass to retry.
 *
 * This runs exactly once at daemon startup. The periodic orphan-detection
 * loop still handles live-running daemons.
 */
export function reconcileOrphanedState(db: MonitorDB, cwd: string): void {
  // 1) Runs whose PID is dead
  try {
    const runningRuns = db.getRunningRuns();
    const now = new Date().toISOString();
    for (const run of runningRuns) {
      if (run.pid && !isPidAlive(run.pid)) {
        db.updateRunStatus(run.id, 'failed', now);
        try {
          db.insertEvent({
            runId: run.id,
            type: 'phase:end',
            data: JSON.stringify({
              type: 'phase:end',
              runId: run.id,
              result: { status: 'failed', summary: 'reconciled: process not alive at daemon startup' },
              timestamp: now,
            }),
            timestamp: now,
          });
        } catch {
          // insertEvent may fail if run row was removed between queries — best-effort
        }
      }
    }
  } catch {
    // DB may be in an inconsistent state on first-ever startup — best-effort
  }

  // 2) Lock files whose PID is dead
  const lockDir = resolve(cwd, '.eforge', 'queue-locks');
  let entries: string[];
  try {
    entries = readdirSync(lockDir);
  } catch {
    return; // Dir doesn't exist yet — nothing to reconcile
  }
  for (const file of entries) {
    if (!file.endsWith('.lock')) continue;
    const lockPath = resolve(lockDir, file);
    let pid: number;
    try {
      pid = parseInt(readFileSync(lockPath, 'utf-8').trim(), 10);
    } catch {
      continue;
    }
    if (!Number.isFinite(pid) || pid <= 0) {
      // Corrupt lock file — remove it
      try { unlinkSync(lockPath); } catch { /* ignore */ }
      continue;
    }
    if (!isPidAlive(pid)) {
      try { unlinkSync(lockPath); } catch { /* ignore */ }
    }
  }
}

function writeAutoBuildPausedEvent(db: MonitorDB, sessionId: string, reason: string): void {
  try {
    db.insertEvent({
      runId: sessionId,
      type: 'daemon:auto-build:paused',
      data: JSON.stringify({ type: 'daemon:auto-build:paused', reason, timestamp: new Date().toISOString() }),
      timestamp: new Date().toISOString(),
    });
  } catch {
    // DB may not accept the event if runId doesn't match — best effort
  }
}

/**
 * Compose the watcher event-stream middlewares for the daemon.
 * withRecording (inner) persists events to SQLite first; withHooks (outer)
 * fires user-configured hooks against the same stream.
 *
 * Exported so the wiring can be unit-tested without spawning a real daemon.
 */
export function wrapWatcherEvents(
  events: AsyncGenerator<EforgeEvent>,
  db: MonitorDB,
  cwd: string,
  pid: number,
  hooks: readonly HookConfig[],
): AsyncGenerator<EforgeEvent> {
  return withHooks(withRecording(events, db, cwd, pid), hooks, cwd);
}

async function main(): Promise<void> {
  process.title = 'eforge-monitor';
  const serverStartedAt = Date.now();
  const args = process.argv.slice(2);
  const persistent = args.includes('--persistent');
  const positionalArgs = args.filter((a) => a !== '--persistent');
  const [dbPath, portStr, cwd] = positionalArgs;
  if (!dbPath || !portStr || !cwd) {
    console.error('Usage: server-main <dbPath> <port> <cwd> [--persistent]');
    process.exit(1);
  }

  const preferredPort = parseInt(portStr, 10);
  const db = openDatabase(dbPath);

  // Pre-flight: refuse to start if a live daemon already owns this cwd
  const existingLock = readLockfile(cwd);
  if (existingLock && existingLock.pid !== process.pid) {
    const alive = await isServerAlive(existingLock);
    if (alive) {
      console.error(`eforge-monitor: existing daemon (pid=${existingLock.pid}, port=${existingLock.port}) is alive for this cwd, exiting`);
      db.close();
      process.exit(0);
    }
  }

  // --- Worker tracking for persistent (daemon) mode ---
  const workerProcesses = new Map<string, ChildProcess>();

  function createWorkerTracker(): WorkerTracker {
    return {
      spawnWorker(command: string, args: string[], onExit?: () => void): { sessionId: string; pid: number } {
        const sessionId = `daemon-${Date.now()}-${randomBytes(6).toString('hex')}`;
        const commandArgs = [command, ...args];
        // Only append --no-monitor for commands that support it (build/run, not enqueue)
        if (command !== 'enqueue') {
          commandArgs.push('--no-monitor');
        }
        // Ensure .eforge/ directory exists and open a per-session log file
        const eforgeDir = resolve(cwd, '.eforge');
        mkdirSync(eforgeDir, { recursive: true });
        const logFd = openSync(resolve(eforgeDir, `worker-${sessionId}.log`), 'w');
        let child: ReturnType<typeof spawn>;
        try {
          child = spawn('eforge', commandArgs, {
            cwd,
            detached: true,
            stdio: ['ignore', logFd, logFd],
          });
          child.unref();
        } finally {
          closeSync(logFd);
        }
        const pid = child.pid;
        if (pid === undefined) {
          throw new Error(`Failed to spawn worker for command: ${command}`);
        }
        workerProcesses.set(sessionId, child);

        child.on('error', () => {
          workerProcesses.delete(sessionId);
          onExit?.();
        });
        child.on('exit', () => {
          workerProcesses.delete(sessionId);
          onExit?.();
        });

        return { sessionId, pid };
      },

      cancelWorker(sessionId: string): boolean {
        // First check in-memory tracked workers
        const child = workerProcesses.get(sessionId);
        if (child && child.pid) {
          try {
            process.kill(child.pid, 'SIGTERM');
          } catch {
            // Process may have already exited
          }
          workerProcesses.delete(sessionId);

          // Mark running runs as killed in DB and write lifecycle events
          const runs = db.getRunningRuns().filter((r) => r.sessionId === sessionId);
          const now = new Date().toISOString();
          for (const run of runs) {
            db.updateRunStatus(run.id, 'killed', now);
            db.insertEvent({
              runId: run.id,
              type: 'phase:end',
              data: JSON.stringify({ type: 'phase:end', runId: run.id, result: { status: 'failed', summary: 'Cancelled' }, timestamp: now }),
              timestamp: now,
            });
          }
          db.insertEvent({
            runId: sessionId,
            type: 'session:end',
            data: JSON.stringify({ type: 'session:end', sessionId, result: { status: 'failed', summary: 'Cancelled' }, timestamp: now }),
            timestamp: now,
          });

          return true;
        }

        // Fall back to DB for workers spawned before daemon restart
        const runningRuns = db.getRunningRuns();
        const sessionRuns = runningRuns.filter((r) => r.sessionId === sessionId);
        if (sessionRuns.length > 0) {
          const now = new Date().toISOString();
          for (const run of sessionRuns) {
            if (run.pid) {
              try {
                process.kill(run.pid, 'SIGTERM');
              } catch {
                // Process not alive
              }
            }
            db.updateRunStatus(run.id, 'killed', now);
            db.insertEvent({
              runId: run.id,
              type: 'phase:end',
              data: JSON.stringify({ type: 'phase:end', runId: run.id, result: { status: 'failed', summary: 'Cancelled' }, timestamp: now }),
              timestamp: now,
            });
          }
          db.insertEvent({
            runId: sessionId,
            type: 'session:end',
            data: JSON.stringify({ type: 'session:end', sessionId, result: { status: 'failed', summary: 'Cancelled' }, timestamp: now }),
            timestamp: now,
          });
          return true;
        }

        return false;
      },
    };
  }

  const workerTracker = persistent ? createWorkerTracker() : undefined;

  // --- In-process watcher lifecycle for auto-build (persistent mode only) ---
  // The watcher runs engine.watchQueue() inside the daemon itself. Each start
  // owns an AbortController; stopping aborts it and waits for the generator to
  // drain. In-flight PRD build subprocesses are not killed by stopping the
  // watcher — they complete or are reconciled on next daemon startup.
  let watcherAbort: AbortController | null = null;
  let watcherDone: Promise<void> | null = null;

  const daemonState: DaemonState | undefined = persistent ? {
    autoBuild: false, // will be set from config below
    watcher: {
      running: false,
      pid: null,
      sessionId: null,
    },
    onSpawnWatcher: () => { void startWatcher(config?.hooks ?? []); },
    onKillWatcher: () => { void stopWatcher(); },
    onShutdown: undefined as (() => void) | undefined,
  } : undefined;

  async function startWatcher(hooks: readonly HookConfig[] = []): Promise<void> {
    if (!daemonState) return;
    if (watcherAbort) return; // already running

    const sessionId = `watcher-${Date.now()}-${randomBytes(6).toString('hex')}`;
    const controller = new AbortController();
    watcherAbort = controller;
    daemonState.watcher = {
      running: true,
      // Watcher runs in-process with the daemon; no distinct PID to report.
      pid: null,
      sessionId,
    };

    let engine: EforgeEngine;
    try {
      engine = await EforgeEngine.create({ cwd });
    } catch (err) {
      watcherAbort = null;
      daemonState.watcher = { running: false, pid: null, sessionId: null };
      daemonState.autoBuild = false;
      const reason = `Watcher failed to initialize: ${err instanceof Error ? err.message : String(err)}`;
      writeAutoBuildPausedEvent(db, sessionId, reason);
      return;
    }

    // If shutdown was requested during engine init, bail out now rather than
    // spinning up watchQueue just to tear it down immediately.
    if (controller.signal.aborted) {
      if (watcherAbort === controller) {
        watcherAbort = null;
        daemonState.watcher = { running: false, pid: null, sessionId: null };
      }
      return;
    }

    watcherDone = (async () => {
      try {
        const events = wrapWatcherEvents(
          engine.watchQueue({ auto: true, abortController: controller }),
          db,
          cwd,
          process.pid,
          hooks,
        );
        // Drain the event stream; withRecording persists each event to SQLite
        // and withHooks fires user-configured hooks non-blocking.
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _event of events) { /* persisted by withRecording, hooks fired by withHooks */ }
      } catch (err) {
        // Only pause if this controller is still the active one — otherwise
        // a newer startWatcher() has already taken over.
        if (watcherAbort === controller && daemonState) {
          daemonState.autoBuild = false;
          const reason = `Watcher crashed: ${err instanceof Error ? err.message : String(err)}`;
          writeAutoBuildPausedEvent(db, sessionId, reason);
        }
      } finally {
        if (watcherAbort === controller) {
          watcherAbort = null;
          watcherDone = null;
          if (daemonState) {
            daemonState.watcher = { running: false, pid: null, sessionId: null };
          }
        }
      }
    })();
  }

  async function stopWatcher(): Promise<void> {
    if (!watcherAbort) return;
    const done = watcherDone;
    watcherAbort.abort();
    if (!done) return;
    // Bounded wait so shutdown cannot hang on a stuck generator
    await Promise.race([
      done,
      new Promise<void>((resolveWait) => setTimeout(resolveWait, WATCHER_DRAIN_TIMEOUT_MS).unref()),
    ]);
  }

  // Load config before starting server so we can pass it for validation
  let config: Awaited<ReturnType<typeof loadConfig>>['config'] | undefined;
  if (persistent) {
    try {
      const { config: loadedConfig, warnings } = await loadConfig(cwd);
      for (const warning of warnings) {
        process.stderr.write(`[eforge] ${warning}\n`);
      }
      config = loadedConfig;
    } catch {
      // Config load failure — leave config undefined
    }
  }

  let server: Awaited<ReturnType<typeof startServer>>;
  try {
    server = await startServer(db, preferredPort, { cwd, workerTracker, daemonState, config });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      // Another server won the race — exit cleanly
      db.close();
      process.exit(0);
    }
    throw err;
  }

  // Write lockfile
  writeLockfile(cwd, {
    pid: process.pid,
    port: server.port,
    startedAt: new Date().toISOString(),
  });

  // Register in global port registry
  registerPort(cwd, server.port, process.pid);

  // One-shot reconciliation for state left behind by a previous crash or
  // hard-kill. Runs after we own the lockfile so no other daemon instance
  // can be touching the same files.
  reconcileOrphanedState(db, cwd);

  // Declare state-machine variables before use (setupStateMachine assigns stateTimer)
  let stateTimer: ReturnType<typeof setInterval> | undefined;
  let isShuttingDown = false;

  // --- Start watcher if autoBuild enabled + idle shutdown (persistent mode) ---
  if (persistent && daemonState && config) {
    daemonState.autoBuild = config.prdQueue.autoBuild;
    if (daemonState.autoBuild) {
      void startWatcher(config.hooks);
    }
    // Enable idle auto-shutdown for persistent mode when configured (0 = disabled)
    if (config.daemon.idleShutdownMs > 0) {
      setupStateMachine(config.daemon.idleShutdownMs);
    }
  }

  // Orphan detection loop: mark dead PRD build subprocesses as killed.
  // The in-process watcher doesn't need a health check — if it dies, the
  // daemon dies with it, and the next startup's reconciler cleans up.
  const orphanTimer = setInterval(() => {
    try {
      const runningRuns = db.getRunningRuns();
      for (const run of runningRuns) {
        if (run.pid && !isPidAlive(run.pid)) {
          db.updateRunStatus(run.id, 'killed');
        }
      }
    } catch {
      // DB might be closed during shutdown
    }
  }, ORPHAN_CHECK_INTERVAL_MS);
  orphanTimer.unref();

  function setupStateMachine(idleFallbackMs: number): void {
    let state: ServerState = 'WATCHING';
    let countdownStartedAt = 0;
    let lastActivityTimestamp = Date.now();
    let hasSeenActivity = false;

    function countdownDurationMs(): number {
      return server.subscriberCount > 0
        ? COUNTDOWN_WITH_SUBSCRIBERS_MS
        : COUNTDOWN_WITHOUT_SUBSCRIBERS_MS;
    }

    function transitionToCountdown(): void {
      if (state === 'COUNTDOWN') return;
      state = 'COUNTDOWN';
      countdownStartedAt = Date.now();
      const durationSec = Math.round(countdownDurationMs() / 1000);
      server.broadcast('monitor:shutdown-pending', JSON.stringify({ countdown: durationSec }));
    }

    function cancelCountdown(): void {
      if (state !== 'COUNTDOWN') return;
      state = 'WATCHING';
      countdownStartedAt = 0;
      lastActivityTimestamp = Date.now();
      server.broadcast('monitor:shutdown-cancelled', JSON.stringify({}));
    }

    // Wire keep-alive to reset countdown
    server.onKeepAlive = () => {
      lastActivityTimestamp = Date.now();
      if (state === 'COUNTDOWN') {
        // Reset countdown rather than transitioning back to WATCHING -
        // this avoids re-entering the watching state without an actual running run
        countdownStartedAt = Date.now();
        const durationSec = Math.round(countdownDurationMs() / 1000);
        server.broadcast('monitor:shutdown-cancelled', JSON.stringify({}));
        server.broadcast('monitor:shutdown-pending', JSON.stringify({ countdown: durationSec }));
      }
    };

    // State machine check loop
    stateTimer = setInterval(() => {
      try {
        const result = evaluateStateCheck({
          state,
          lastActivityTimestamp,
          hasSeenActivity,
          serverStartedAt,
          idleFallbackMs,
          maxWaitForActivityMs: MAX_WAIT_FOR_ACTIVITY_MS,
          getRunningRuns: () => db.getRunningRuns(),
          getLatestEventTimestamp: () => db.getLatestEventTimestamp(),
          transitionToCountdown,
          cancelCountdown,
        });
        state = result.state;
        lastActivityTimestamp = result.lastActivityTimestamp;
        hasSeenActivity = result.hasSeenActivity;

        if (state === 'COUNTDOWN') {
          const elapsed = Date.now() - countdownStartedAt;
          if (elapsed >= countdownDurationMs()) {
            state = 'SHUTDOWN';
            shutdown();
          }
        }
      } catch {
        // DB might be closed during shutdown
      }
    }, STATE_CHECK_INTERVAL_MS);
    stateTimer.unref();
  }

  if (!persistent) {
    // --- Ephemeral mode: State machine with default idle threshold ---
    setupStateMachine(IDLE_FALLBACK_MS);
  }

  function shutdown(): void {
    if (isShuttingDown) return;
    isShuttingDown = true;

    clearInterval(orphanTimer);
    if (stateTimer) clearInterval(stateTimer);

    // Abort the in-process watcher and wait (with timeout) for it to drain.
    // In-flight PRD build subprocesses are orphaned here; the next daemon
    // startup's reconciler cleans up their stale locks.
    void stopWatcher().finally(() => {
      deregisterPort(cwd);
      removeLockfile(cwd);

      server.stop().then(() => {
        db.close();
        process.exit(0);
      }).catch(() => {
        db.close();
        process.exit(1);
      });
    });
  }

  // Wire onShutdown callback so the HTTP endpoint can trigger graceful shutdown
  if (daemonState) {
    daemonState.onShutdown = shutdown;
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Disconnect stdio so the parent process can exit
  if (process.stdout.isTTY === false || process.send === undefined) {
    // We're a detached child — detach stdio
    process.stdin.destroy();
    process.stdout.destroy();
    process.stderr.destroy();
  }
}

// Only auto-execute when run as an entry point (not when imported for testing)
const isEntryPoint = process.argv[1] &&
  (process.argv[1].endsWith('server-main.js') || process.argv[1].endsWith('server-main.ts'));
if (isEntryPoint) {
  main().catch((err) => {
    console.error('Monitor server failed:', err);
    process.exit(1);
  });
}
