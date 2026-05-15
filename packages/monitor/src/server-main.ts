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
import { writeLockfile, removeLockfile, isPidAlive, readLockfile, isServerAlive, type ExtensionReloadWatcherMetadata } from '@eforge-build/client';
import { registerPort, deregisterPort } from './registry.js';
import { loadConfig, type HookConfig } from '@eforge-build/engine/config';
import { EforgeEngine, type SchedulerControl, type ProfileUsageProvider } from '@eforge-build/engine/eforge';
import { withHooks } from '@eforge-build/engine/hooks';
import type { EforgeEvent } from '@eforge-build/engine/events';
import { withNativeEventHooks, type NativeExtensionRegistry } from '@eforge-build/engine/extensions/index';
import { withRecording } from './recorder.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { openSync, closeSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

/** Replaced at build time by tsup `define` with the daemon bundle's package version. */
declare const EFORGE_VERSION: string;

// --- eforge:region plan-02-runtime-and-integration ---
/** Cooldown window applied after a quota error is detected (10 minutes). */
export const COOLDOWN_WINDOW_MS = 10 * 60 * 1000;
/** Default rolling window for usage queries when callers don't specify one (24 hours). */
export const DEFAULT_USAGE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Token input threshold after which `nearLimit` is set (1M input tokens). */
export const NEAR_LIMIT_TOKEN_THRESHOLD = 1_000_000;

/**
 * Create a ProfileUsageProvider backed by a MonitorDB instance.
 *
 * The provider queries `session:profile`, `agent:usage`, `agent:result`, and
 * `agent:stop` events to build best-effort usage statistics for each profile.
 * Cooldown and nearLimit derivation happen here so routers always see a
 * consistent `ProfileUsageSummary` regardless of which DB method is used.
 */
function createProfileUsageProvider(db: MonitorDB): ProfileUsageProvider {
  return {
    getUsageSummary(profileName: string, options?: { windowMs?: number }) {
      const windowMs = options?.windowMs ?? DEFAULT_USAGE_WINDOW_MS;
      let raw: ReturnType<MonitorDB['getProfileUsageSummary']>;
      try {
        raw = db.getProfileUsageSummary(profileName, windowMs);
      } catch {
        return null;
      }
      if (raw === null) return null;

      const hasQuotaErrors = raw.recentQuotaErrors > 0;
      const now = Date.now();
      const cooldownUntil = hasQuotaErrors
        ? new Date(now + COOLDOWN_WINDOW_MS).toISOString()
        : undefined;

      const inputTokens = raw.recentTokens?.input ?? 0;
      const nearLimit = inputTokens >= NEAR_LIMIT_TOKEN_THRESHOLD;

      return {
        lastUsedAt: raw.lastUsedAt,
        recentRunCount: raw.recentRunCount,
        recentTokens: raw.recentTokens,
        recentCostUsd: raw.recentCostUsd,
        recentQuotaErrors: raw.recentQuotaErrors,
        cooldownActive: hasQuotaErrors,
        ...(cooldownUntil !== undefined ? { cooldownUntil } : {}),
        nearLimit,
        dataSource: 'event-history' as const,
      };
    },
  };
}
// --- eforge:endregion plan-02-runtime-and-integration ---

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

// --- eforge:region plan-01-types-and-daemon-emission ---

/**
 * Structured report returned by `reconcileOrphanedState`.
 * The caller in `main()` uses this to emit the daemon:recovery:* event sequence.
 * `reconcileOrphanedState` itself emits no events — all event emission lives in the caller.
 */
export interface ReconciliationReport {
  /** Runs that were marked failed because their PID was no longer alive. */
  runsFailed: Array<{ runId: string; sessionId: string; planSet: string; reason: string }>;
  /** Lock files that were removed because their PID was no longer alive. */
  locksRemoved: Array<{ path: string; pid: number }>;
  /** Wall-clock duration of the reconciliation in milliseconds. */
  durationMs: number;
}

/**
 * Write a daemon-scoped event to the SQLite event log.
 * Uses `daemonSessionId` as the runId so all daemon events aggregate cleanly
 * under a single synthetic session. Foreign keys are OFF in the DB so an
 * unmatched run_id is safe (see PRAGMA foreign_keys = OFF in db.ts).
 *
 * Best-effort: any DB error is silently swallowed to avoid crashing the daemon
 * on a non-critical event write failure.
 */
export function writeDaemonEvent(
  db: MonitorDB,
  event: { type: string } & Record<string, unknown>,
  daemonSessionId: string,
): void {
  try {
    const now = new Date().toISOString();
    // Default sessionId to daemonSessionId, but preserve any explicit sessionId
    // on the event (e.g. `daemon:orphan:reaped` carries the orphan run's
    // sessionId so consumers can correlate back to the original run).
    db.insertEvent({
      runId: daemonSessionId,
      type: event.type,
      data: JSON.stringify({ sessionId: daemonSessionId, ...event, timestamp: now }),
      timestamp: now,
    });
  } catch {
    // Best-effort: DB may be closed or temporarily unavailable during shutdown
  }
}

// --- eforge:endregion plan-01-types-and-daemon-emission ---

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
 *
 * Returns a structured report of what was cleaned up. Emits no events itself —
 * all daemon:recovery:* event emission is the caller's responsibility.
 * The existing synthetic `phase:end` event per failed run is preserved here
 * for backward compatibility with session-scoped event streams.
 */
export function reconcileOrphanedState(db: MonitorDB, cwd: string): ReconciliationReport {
  const startedAt = Date.now();
  const runsFailed: Array<{ runId: string; sessionId: string; planSet: string; reason: string }> = [];
  const locksRemoved: Array<{ path: string; pid: number }> = [];

  // 1) Runs whose PID is dead
  try {
    const runningRuns = db.getRunningRuns();
    const now = new Date().toISOString();
    for (const run of runningRuns) {
      if (run.pid && !isPidAlive(run.pid)) {
        const reason = 'reconciled: process not alive at daemon startup';
        db.updateRunStatus(run.id, 'failed', now);
        // Preserve backward-compatible synthetic phase:end event for session-scoped streams.
        try {
          db.insertEvent({
            runId: run.id,
            type: 'phase:end',
            data: JSON.stringify({
              type: 'phase:end',
              runId: run.id,
              result: { status: 'failed', summary: reason },
              timestamp: now,
            }),
            timestamp: now,
          });
        } catch {
          // insertEvent may fail if run row was removed between queries — best-effort
        }
        runsFailed.push({
          runId: run.id,
          sessionId: run.sessionId ?? run.id,
          planSet: run.planSet,
          reason,
        });
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
    return { runsFailed, locksRemoved, durationMs: Date.now() - startedAt }; // Dir doesn't exist yet — nothing to reconcile
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
      // Corrupt lock file — remove it (not tracked in locksRemoved since no valid pid)
      try { unlinkSync(lockPath); } catch { /* ignore */ }
      continue;
    }
    if (!isPidAlive(pid)) {
      try {
        unlinkSync(lockPath);
        locksRemoved.push({ path: lockPath, pid });
      } catch { /* ignore */ }
    }
  }

  return { runsFailed, locksRemoved, durationMs: Date.now() - startedAt };
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
 * Context passed to maybePauseOnFailure for each event in the drain loop.
 * Exported for unit-testing without spinning up a real watcher.
 */
export interface PauseOnFailureCtx {
  /** Returns true when the drain loop's controller is still the active one. */
  isActiveController: () => boolean;
  daemonState: DaemonState;
  db: MonitorDB;
  sessionId: string;
}

/**
 * Inspect a single watcher event and pause auto-build if it is the first
 * failed queue:prd:complete for the active watcher session.
 *
 * Guards (must both hold before pausing):
 *  - isActiveController() — a superseded watcher must not pause a fresh one.
 *  - daemonState.autoBuild — avoids double-pause and redundant events.
 *
 * On pause, suspends new PRD launches via `onPauseScheduler` (does NOT abort
 * the watcher). This lets the failed `queue:prd:complete` complete its bus
 * round-trip through `QueueScheduler.onComplete()` so in-memory state is
 * finalized correctly before any re-enable attempt.
 *
 * Exported for unit-testing.
 */
export function maybePauseOnFailure(event: EforgeEvent, ctx: PauseOnFailureCtx): void {
  if (
    event.type === 'queue:prd:complete' &&
    event.status === 'failed' &&
    ctx.isActiveController() &&
    ctx.daemonState.autoBuild
  ) {
    ctx.daemonState.autoBuild = false;
    // --- eforge:region plan-01-types-and-daemon-emission ---
    ctx.daemonState.autoBuildPaused = true;
    // --- eforge:endregion plan-01-types-and-daemon-emission ---
    writeAutoBuildPausedEvent(ctx.db, ctx.sessionId, `Build failed: ${event.prdId}`);
    // --- eforge:region plan-01-scheduler-pause-resume-lifecycle ---
    // Suspend new PRD launches without aborting the watcher, so the failed
    // completion event still flows through QueueScheduler.onComplete() and
    // finalizes in-memory state. Manual disable (POST /api/auto-build enabled:false)
    // continues to call onKillWatcher for a full abort.
    ctx.daemonState.onPauseScheduler?.();
    // --- eforge:endregion plan-01-scheduler-pause-resume-lifecycle ---
  }
}

/**
 * Compose the watcher event-stream middlewares for the daemon.
 * Native event hooks run before recording so generated diagnostics are persisted;
 * withHooks (outer) fires user-configured shell hooks after recording.
 *
 * Exported so the wiring can be unit-tested without spawning a real daemon.
 */
export function wrapWatcherEvents(
  events: AsyncGenerator<EforgeEvent>,
  db: MonitorDB,
  cwd: string,
  pid: number,
  hooks: readonly HookConfig[],
  native?: {
    registry: Pick<NativeExtensionRegistry, 'eventHooks'>;
    timeoutMs: number;
  },
): AsyncGenerator<EforgeEvent> {
  const nativeEvents = withNativeEventHooks(events, native?.registry, { cwd, timeoutMs: native?.timeoutMs });
  const recordedEvents = withRecording(nativeEvents, db, cwd, pid);
  return withHooks(recordedEvents, hooks, cwd);
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

  // --- eforge:region plan-01-types-and-daemon-emission ---
  // Stable session id for all daemon-scoped events in this process lifetime.
  // FK is OFF in the DB so an unmatched run_id is safe (see PRAGMA in db.ts).
  const daemonSessionId = `daemon-${process.pid}-${Date.now()}`;
  // --- eforge:endregion plan-01-types-and-daemon-emission ---

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
    autoBuildPaused: false,
    watcher: {
      running: false,
      pid: null,
      sessionId: null,
    },
    onSpawnWatcher: () => { void startWatcher(config?.hooks ?? []); },
    onKillWatcher: () => { void stopWatcher(); },
    // --- eforge:region plan-01-extension-management-api ---
    onReloadExtensions: () => reloadExtensionsWatcher(),
    // --- eforge:endregion plan-01-extension-management-api ---
    onShutdown: undefined as (() => void) | undefined,
    // --- eforge:region plan-01-types-and-daemon-emission ---
    onDaemonEvent: (event) => writeDaemonEvent(db, event as { type: string } & Record<string, unknown>, daemonSessionId),
    // --- eforge:endregion plan-01-types-and-daemon-emission ---
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
      // --- eforge:region plan-02-runtime-and-integration ---
      const profileUsageProvider = createProfileUsageProvider(db);
      // --- eforge:endregion plan-02-runtime-and-integration ---
      engine = await EforgeEngine.create({ cwd, profileUsageProvider });
    } catch (err) {
      watcherAbort = null;
      daemonState.watcher = { running: false, pid: null, sessionId: null };
      daemonState.autoBuild = false;
      daemonState.injectSchedulerEvent = undefined;
      // --- eforge:region plan-01-scheduler-pause-resume-lifecycle ---
      daemonState.onPauseScheduler = undefined;
      daemonState.onResumeScheduler = undefined;
      daemonState.isSchedulerAlive = undefined;
      // --- eforge:endregion plan-01-scheduler-pause-resume-lifecycle ---
      const errMsg = err instanceof Error ? err.message : String(err);
      const reason = `Watcher failed to initialize: ${errMsg}`;
      // --- eforge:region plan-01-types-and-daemon-emission ---
      writeDaemonEvent(db, {
        type: 'daemon:error',
        source: 'watcher:init',
        message: reason,
        ...(err instanceof Error && err.stack ? { stack: err.stack } : {}),
      }, daemonSessionId);
      daemonState.autoBuildPaused = true;
      // --- eforge:endregion plan-01-types-and-daemon-emission ---
      writeAutoBuildPausedEvent(db, sessionId, reason);
      return;
    }

    // If shutdown was requested during engine init, bail out now rather than
    // spinning up watchQueue just to tear it down immediately.
    if (controller.signal.aborted) {
      if (watcherAbort === controller) {
        watcherAbort = null;
        daemonState.watcher = { running: false, pid: null, sessionId: null };
        daemonState.injectSchedulerEvent = undefined;
        // --- eforge:region plan-01-scheduler-pause-resume-lifecycle ---
        daemonState.onPauseScheduler = undefined;
        daemonState.onResumeScheduler = undefined;
        daemonState.isSchedulerAlive = undefined;
        // --- eforge:endregion plan-01-scheduler-pause-resume-lifecycle ---
      }
      return;
    }

    watcherDone = (async () => {
      try {
        const events = wrapWatcherEvents(
          engine.watchQueue({
            auto: true,
            abortController: controller,
            onInjectEventRegister: (inject) => {
              if (daemonState && watcherAbort === controller) {
                daemonState.injectSchedulerEvent = inject;
              }
            },
            // --- eforge:region plan-01-scheduler-pause-resume-lifecycle ---
            onSchedulerControlRegister: (control: SchedulerControl) => {
              if (daemonState && watcherAbort === controller) {
                daemonState.onPauseScheduler = () => control.pause();
                daemonState.onResumeScheduler = () => control.resume();
                daemonState.isSchedulerAlive = () => control.isAlive();
              }
            },
            // --- eforge:endregion plan-01-scheduler-pause-resume-lifecycle ---
          }),
          db,
          cwd,
          process.pid,
          hooks,
          {
            registry: engine.nativeExtensionRegistry,
            timeoutMs: engine.resolvedConfig.extensions.eventHookTimeoutMs,
          },
        );
        // Drain the event stream; native event hooks run first, withRecording
        // persists each event to SQLite, and withHooks fires user-configured hooks non-blocking.
        // Inspect each event to pause auto-build on the first failed PRD.
        const pauseCtx: PauseOnFailureCtx = {
          isActiveController: () => watcherAbort === controller,
          daemonState,
          db,
          sessionId,
        };
        for await (const event of events) {
          maybePauseOnFailure(event, pauseCtx);
          // --- eforge:region plan-01-types-and-daemon-emission ---
          // Emit daemon:auto-build:triggered when a queue scan cycle produces builds.
          if (event.type === 'queue:complete' && event.processed > 0) {
            writeDaemonEvent(db, {
              type: 'daemon:auto-build:triggered',
              trigger: 'auto',
              prdsEnqueued: event.processed,
            }, daemonSessionId);
          }
          // --- eforge:endregion plan-01-types-and-daemon-emission ---
        }
      } catch (err) {
        // Only pause if this controller is still the active one — otherwise
        // a newer startWatcher() has already taken over.
        if (watcherAbort === controller && daemonState) {
          daemonState.autoBuild = false;
          const errMsg = err instanceof Error ? err.message : String(err);
          const reason = `Watcher crashed: ${errMsg}`;
          // --- eforge:region plan-01-types-and-daemon-emission ---
          writeDaemonEvent(db, {
            type: 'daemon:error',
            source: 'watcher',
            message: errMsg,
            ...(err instanceof Error && err.stack ? { stack: err.stack } : {}),
          }, daemonSessionId);
          daemonState.autoBuildPaused = true;
          // --- eforge:endregion plan-01-types-and-daemon-emission ---
          writeAutoBuildPausedEvent(db, sessionId, reason);
        }
      } finally {
        if (watcherAbort === controller) {
          watcherAbort = null;
          watcherDone = null;
          if (daemonState) {
            daemonState.watcher = { running: false, pid: null, sessionId: null };
            daemonState.injectSchedulerEvent = undefined;
            // --- eforge:region plan-01-scheduler-pause-resume-lifecycle ---
            daemonState.onPauseScheduler = undefined;
            daemonState.onResumeScheduler = undefined;
            daemonState.isSchedulerAlive = undefined;
            // --- eforge:endregion plan-01-scheduler-pause-resume-lifecycle ---
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

  // --- eforge:region plan-01-extension-management-api ---
  async function reloadExtensionsWatcher(): Promise<ExtensionReloadWatcherMetadata> {
    if (!daemonState) {
      return {
        wasRunning: false,
        restarted: false,
        running: false,
        previousSessionId: null,
        sessionId: null,
        message: 'Extension discovery refreshed; no runtime watcher was restarted.',
      };
    }

    const wasRunning = watcherAbort !== null && daemonState.watcher.running;
    const previousSessionId = daemonState.watcher.sessionId;
    if (!wasRunning) {
      return {
        wasRunning: false,
        restarted: false,
        running: daemonState.watcher.running,
        previousSessionId,
        sessionId: daemonState.watcher.sessionId,
        message: 'Extension discovery refreshed; no runtime watcher was restarted.',
      };
    }

    await stopWatcher();
    try {
      const { config: reloadedConfig, warnings } = await loadConfig(cwd);
      for (const warning of warnings) {
        process.stderr.write(`[eforge] ${warning}\n`);
      }
      config = reloadedConfig;
    } catch {
      // Keep the previous config if reload-time config parsing fails; startWatcher
      // will perform its own engine initialization and report any failure.
    }
    await startWatcher(config?.hooks ?? []);

    const restarted = daemonState.watcher.running && daemonState.watcher.sessionId !== previousSessionId;
    return {
      wasRunning: true,
      restarted,
      running: daemonState.watcher.running,
      previousSessionId,
      sessionId: daemonState.watcher.sessionId,
      message: restarted
        ? 'Extension discovery refreshed and runtime watcher restarted.'
        : 'Extension discovery refreshed, but the runtime watcher did not restart.',
    };
  }
  // --- eforge:endregion plan-01-extension-management-api ---

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

  // --- eforge:region plan-01-types-and-daemon-emission ---
  // Emit lifecycle:starting now that port is known (server was just started above).
  writeDaemonEvent(db, {
    type: 'daemon:lifecycle:starting',
    pid: process.pid,
    port: server.port,
    version: typeof EFORGE_VERSION !== 'undefined' ? EFORGE_VERSION : 'unknown',
    mode: persistent ? 'persistent' : 'ephemeral',
  }, daemonSessionId);
  // --- eforge:endregion plan-01-types-and-daemon-emission ---

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
  // --- eforge:region plan-01-types-and-daemon-emission ---
  writeDaemonEvent(db, { type: 'daemon:recovery:start' }, daemonSessionId);
  const reconcileReport = reconcileOrphanedState(db, cwd);
  for (const run of reconcileReport.runsFailed) {
    // Emit the daemon-scoped failure event alongside the backward-compatible
    // phase:end that reconcileOrphanedState already inserted per run.
    writeDaemonEvent(db, {
      type: 'daemon:recovery:run-marked-failed',
      runId: run.runId,
      planSet: run.planSet,
      reason: run.reason,
    }, daemonSessionId);
  }
  for (const lock of reconcileReport.locksRemoved) {
    writeDaemonEvent(db, {
      type: 'daemon:recovery:lock-removed',
      path: lock.path,
      pid: lock.pid,
    }, daemonSessionId);
  }
  writeDaemonEvent(db, {
    type: 'daemon:recovery:complete',
    runsFailed: reconcileReport.runsFailed.length,
    locksRemoved: reconcileReport.locksRemoved.length,
    durationMs: reconcileReport.durationMs,
  }, daemonSessionId);
  writeDaemonEvent(db, {
    type: 'daemon:lifecycle:ready',
    pid: process.pid,
    port: server.port,
    version: typeof EFORGE_VERSION !== 'undefined' ? EFORGE_VERSION : 'unknown',
    mode: persistent ? 'persistent' : 'ephemeral',
    recoveryDurationMs: reconcileReport.durationMs,
  }, daemonSessionId);
  // --- eforge:endregion plan-01-types-and-daemon-emission ---

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
          // --- eforge:region plan-01-types-and-daemon-emission ---
          // Only emit orphan:reaped when a run is actually marked killed (not on every tick).
          writeDaemonEvent(db, {
            type: 'daemon:orphan:reaped',
            runId: run.id,
            sessionId: run.sessionId ?? run.id,
            planSet: run.planSet,
            pid: run.pid,
          }, daemonSessionId);
          // --- eforge:endregion plan-01-types-and-daemon-emission ---
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
            // --- eforge:region plan-01-types-and-daemon-emission ---
            shutdown('none', 'idle timeout');
            // --- eforge:endregion plan-01-types-and-daemon-emission ---
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

  // --- eforge:region plan-01-types-and-daemon-emission ---
  function shutdown(signal = 'none', reason = 'process signal'): void {
  // --- eforge:endregion plan-01-types-and-daemon-emission ---
    if (isShuttingDown) return;
    isShuttingDown = true;

    // --- eforge:region plan-01-types-and-daemon-emission ---
    writeDaemonEvent(db, {
      type: 'daemon:lifecycle:shutdown:start',
      signal,
      reason,
    }, daemonSessionId);
    const shutdownStartedAt = Date.now();
    // --- eforge:endregion plan-01-types-and-daemon-emission ---

    clearInterval(orphanTimer);
    if (stateTimer) clearInterval(stateTimer);

    // Abort the in-process watcher and wait (with timeout) for it to drain.
    // In-flight PRD build subprocesses are orphaned here; the next daemon
    // startup's reconciler cleans up their stale locks.
    void stopWatcher().finally(() => {
      deregisterPort(cwd);
      removeLockfile(cwd);

      server.stop().then(() => {
        // --- eforge:region plan-01-types-and-daemon-emission ---
        // Write shutdown:complete before closing the DB so the event is persisted.
        writeDaemonEvent(db, {
          type: 'daemon:lifecycle:shutdown:complete',
          durationMs: Date.now() - shutdownStartedAt,
        }, daemonSessionId);
        // --- eforge:endregion plan-01-types-and-daemon-emission ---
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
    // --- eforge:region plan-01-types-and-daemon-emission ---
    daemonState.onShutdown = () => shutdown('none', 'HTTP request');
    // --- eforge:endregion plan-01-types-and-daemon-emission ---
  }

  // --- eforge:region plan-01-types-and-daemon-emission ---
  process.on('SIGTERM', () => shutdown('SIGTERM', 'process signal'));
  process.on('SIGINT', () => shutdown('SIGINT', 'process signal'));
  // --- eforge:endregion plan-01-types-and-daemon-emission ---

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
