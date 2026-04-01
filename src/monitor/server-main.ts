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
import { writeLockfile, removeLockfile, updateLockfile, isPidAlive, readLockfile, isServerAlive } from './lockfile.js';
import { registerPort, deregisterPort } from './registry.js';
import { loadConfig } from '../engine/config.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { openSync, closeSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

let respawnDelayMs = 5000;
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

function writeAutoBuildPausedEvent(db: MonitorDB, sessionId: string): void {
  try {
    db.insertEvent({
      runId: sessionId,
      type: 'daemon:auto-build:paused',
      data: JSON.stringify({ reason: 'Watcher exited with non-zero code', timestamp: new Date().toISOString() }),
      timestamp: new Date().toISOString(),
    });
  } catch {
    // DB may not accept the event if runId doesn't match — best effort
  }
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
      spawnWorker(command: string, args: string[]): { sessionId: string; pid: number } {
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
        });
        child.on('exit', () => {
          workerProcesses.delete(sessionId);
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
              data: JSON.stringify({ runId: run.id, result: { status: 'failed', summary: 'Cancelled' }, timestamp: now }),
              timestamp: now,
            });
          }
          db.insertEvent({
            runId: sessionId,
            type: 'session:end',
            data: JSON.stringify({ sessionId, result: { status: 'failed', summary: 'Cancelled' }, timestamp: now }),
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
              data: JSON.stringify({ runId: run.id, result: { status: 'failed', summary: 'Cancelled' }, timestamp: now }),
              timestamp: now,
            });
          }
          db.insertEvent({
            runId: sessionId,
            type: 'session:end',
            data: JSON.stringify({ sessionId, result: { status: 'failed', summary: 'Cancelled' }, timestamp: now }),
            timestamp: now,
          });
          return true;
        }

        return false;
      },
    };
  }

  const workerTracker = persistent ? createWorkerTracker() : undefined;

  // --- Watcher lifecycle for auto-build (persistent mode only) ---
  let watcherProcess: ChildProcess | null = null;
  let watcherKilledByUs = false;

  const daemonState: DaemonState | undefined = persistent ? {
    autoBuild: false, // will be set from config below
    watcher: {
      running: false,
      pid: null,
      sessionId: null,
    },
    onSpawnWatcher: () => spawnWatcher(),
    onKillWatcher: () => killWatcher(),
    onShutdown: undefined as (() => void) | undefined,
  } : undefined;

  function spawnWatcher(): void {
    if (!daemonState) return;
    if (watcherProcess) return; // already running

    watcherKilledByUs = false;
    const sessionId = `watcher-${Date.now()}-${randomBytes(6).toString('hex')}`;

    const child = spawn('eforge', ['run', '--queue', '--watch', '--auto', '--no-monitor'], {
      cwd,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    watcherProcess = child;

    daemonState.watcher = {
      running: true,
      pid: child.pid ?? null,
      sessionId,
    };

    // Track watcher PID in lockfile for external lifecycle management
    if (child.pid) {
      updateLockfile(cwd, { watcherPid: child.pid });
    }

    // Capture reference so exit/error handlers only act on THIS child,
    // not a replacement spawned after killWatcher() + spawnWatcher().
    const thisChild = child;

    child.on('error', () => {
      if (watcherProcess !== thisChild) return; // stale — a new watcher replaced us
      watcherProcess = null;
      daemonState.watcher = { running: false, pid: null, sessionId: null };
      // Remove watcher PID from lockfile on error
      updateLockfile(cwd, { watcherPid: undefined });
      // Spawn failure — pause auto-build (same as non-zero exit)
      daemonState.autoBuild = false;
      writeAutoBuildPausedEvent(db, sessionId);
    });

    child.on('exit', (code) => {
      if (watcherProcess !== thisChild) return; // stale — a new watcher replaced us
      watcherProcess = null;
      daemonState.watcher = { running: false, pid: null, sessionId: null };
      // Remove watcher PID from lockfile on exit (crash resilience)
      updateLockfile(cwd, { watcherPid: undefined });

      if (watcherKilledByUs) {
        // Intentional kill — do not respawn
        return;
      }

      if (code !== 0 && code !== null) {
        // Build failure — pause auto-build and write event to SQLite
        daemonState.autoBuild = false;
        writeAutoBuildPausedEvent(db, sessionId);
        return;
      }

      // Clean exit (code 0) — watcher is long-lived, no respawn needed.
      // The watcher stays alive via fs.watch; clean exit means intentional shutdown.
    });
  }

  function killWatcher(): void {
    if (!watcherProcess) return;
    watcherKilledByUs = true;
    try {
      if (watcherProcess.pid) {
        process.kill(watcherProcess.pid, 'SIGTERM');
      }
    } catch {
      // Process may have already exited
    }
    watcherProcess = null;
    if (daemonState) {
      daemonState.watcher = { running: false, pid: null, sessionId: null };
    }
    // Remove watcher PID from lockfile
    updateLockfile(cwd, { watcherPid: undefined });
  }

  // Load config before starting server so we can pass it for validation
  let config: Awaited<ReturnType<typeof loadConfig>> | undefined;
  if (persistent) {
    try {
      config = await loadConfig(cwd);
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

  // Declare state-machine variables before use (setupStateMachine assigns stateTimer)
  let stateTimer: ReturnType<typeof setInterval> | undefined;
  let isShuttingDown = false;

  // --- Start watcher if autoBuild enabled + idle shutdown (persistent mode) ---
  if (persistent && daemonState && config) {
    respawnDelayMs = config.prdQueue.watchPollIntervalMs;
    daemonState.autoBuild = config.prdQueue.autoBuild;
    if (daemonState.autoBuild) {
      spawnWatcher();
    }
    // Enable idle auto-shutdown for persistent mode when configured (0 = disabled)
    if (config.daemon.idleShutdownMs > 0) {
      setupStateMachine(config.daemon.idleShutdownMs);
    }
  }

  // Orphan detection loop (also checks watcher health in persistent mode)
  const orphanTimer = setInterval(() => {
    try {
      const runningRuns = db.getRunningRuns();
      for (const run of runningRuns) {
        if (run.pid && !isPidAlive(run.pid)) {
          db.updateRunStatus(run.id, 'killed');
        }
      }

      // Check watcher health in persistent mode
      if (persistent && daemonState?.watcher.running && watcherProcess?.pid) {
        if (!isPidAlive(watcherProcess.pid)) {
          // Watcher died without exit event — clean up
          watcherProcess = null;
          daemonState.watcher = { running: false, pid: null, sessionId: null };
          updateLockfile(cwd, { watcherPid: undefined });
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

    // Kill watcher before removing lockfile
    killWatcher();

    deregisterPort(cwd);
    removeLockfile(cwd);

    server.stop().then(() => {
      db.close();
      process.exit(0);
    }).catch(() => {
      db.close();
      process.exit(1);
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
