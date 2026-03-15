/**
 * Detached monitor server entry point.
 *
 * Runs as a detached child process. Polls SQLite for new events,
 * serves SSE to subscribers, detects orphaned runs, and auto-shuts
 * down when idle.
 *
 * Usage: node dist/server-main.js <dbPath> <port> <cwd>
 */

import { openDatabase } from './db.js';
import { startServer } from './server.js';
import { writeLockfile, removeLockfile, isPidAlive } from './lockfile.js';

const ORPHAN_CHECK_INTERVAL_MS = 5000;
const AUTO_SHUTDOWN_CHECK_INTERVAL_MS = 5000;
const IDLE_TIMEOUT_MS = 30_000;

async function main(): Promise<void> {
  const [dbPath, portStr, cwd] = process.argv.slice(2);
  if (!dbPath || !portStr || !cwd) {
    console.error('Usage: server-main <dbPath> <port> <cwd>');
    process.exit(1);
  }

  const preferredPort = parseInt(portStr, 10);
  const db = openDatabase(dbPath);

  let server: Awaited<ReturnType<typeof startServer>>;
  try {
    server = await startServer(db, preferredPort, { strictPort: true });
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

  let lastEventTimestamp = Date.now();

  // Track last seen event ID per run for poll-based SSE (unused in this process,
  // the server itself handles polling now via its internal poll loop)

  // Orphan detection loop
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

  // Auto-shutdown check loop
  const shutdownTimer = setInterval(() => {
    try {
      const runningRuns = db.getRunningRuns();
      if (runningRuns.length > 0) {
        lastEventTimestamp = Date.now();
        return;
      }

      // Check if there have been recent events
      const latestTimestamp = db.getLatestEventTimestamp();
      if (latestTimestamp) {
        const eventTime = new Date(latestTimestamp).getTime();
        if (eventTime > lastEventTimestamp) {
          lastEventTimestamp = eventTime;
        }
      }

      const idleMs = Date.now() - lastEventTimestamp;
      if (idleMs >= IDLE_TIMEOUT_MS) {
        shutdown();
      }
    } catch {
      // DB might be closed during shutdown
    }
  }, AUTO_SHUTDOWN_CHECK_INTERVAL_MS);
  shutdownTimer.unref();

  let isShuttingDown = false;

  function shutdown(): void {
    if (isShuttingDown) return;
    isShuttingDown = true;

    clearInterval(orphanTimer);
    clearInterval(shutdownTimer);

    removeLockfile(cwd);

    server.stop().then(() => {
      db.close();
      process.exit(0);
    }).catch(() => {
      db.close();
      process.exit(1);
    });
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

main().catch((err) => {
  console.error('Monitor server failed:', err);
  process.exit(1);
});
