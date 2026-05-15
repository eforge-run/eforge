import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DAEMON_EVENT_TYPES } from '@eforge-build/client';
import type { RunInfo, SessionMetadata } from '@eforge-build/client';

/** Raw DB row shape for the `runs` table — snake_case columns as returned by SQLite. */
interface RunRow {
  id: string;
  session_id: string | null;
  plan_set: string;
  command: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  cwd: string;
  pid: number | null;
}

/**
 * Map a raw `runs` DB row to the canonical `RunInfo` wire shape.
 * Explicit field mapping ensures a new required `RunInfo` field causes a
 * `pnpm type-check` failure here rather than silently producing bad JSON.
 */
function rowToRunInfo(row: RunRow): RunInfo {
  return {
    id: row.id,
    sessionId: row.session_id ?? undefined,
    planSet: row.plan_set,
    command: row.command,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at ?? undefined,
    cwd: row.cwd,
    pid: row.pid ?? undefined,
  };
}

export interface EventRecord {
  id: number;
  runId: string;
  type: string;
  planId?: string;
  agent?: string;
  data: string;
  timestamp: string;
}

export interface MonitorDB {
  insertRun(run: {
    id: string;
    sessionId?: string;
    planSet: string;
    command: string;
    status: string;
    startedAt: string;
    cwd: string;
    pid?: number;
  }): void;
  insertEvent(event: {
    runId: string;
    type: string;
    planId?: string;
    agent?: string;
    data: string;
    timestamp: string;
  }): number;
  updateRunStatus(runId: string, status: string, completedAt?: string): void;
  updateRunPlanSet(runId: string, planSet: string): void;
  getRuns(): RunInfo[];
  getRunningRuns(): RunInfo[];
  getRun(runId: string): RunInfo | undefined;
  /** Returns the run with the given id, or undefined if not found. Alias for getRun. */
  getRunById(runId: string): RunInfo | undefined;
  getEvents(runId: string, afterId?: number): EventRecord[];
  getEventsByType(runId: string, type: string): EventRecord[];
  getLatestRunId(): string | undefined;
  getRunsBySession(sessionId: string): RunInfo[];
  getEventsBySession(sessionId: string, afterId?: number): EventRecord[];
  getEventsByTypeForSession(sessionId: string, type: string): EventRecord[];
  getLatestSessionId(): string | undefined;
  getSessionRuns(sessionId: string): RunInfo[];
  getSessionMetadataBatch(): Record<string, SessionMetadata>;
  insertFileDiffs(runId: string, planId: string, diffs: Array<{ path: string; diff: string }>, timestamp: string): void;
  getFileDiff(sessionId: string, planId: string, filePath: string): FileDiffRecord | undefined;
  getFileDiffs(sessionId: string, planId: string): FileDiffRecord[];
  cleanupOldSessions(keepCount: number): void;
  getLatestEventTimestamp(): string | undefined;
  /** Returns the highest event row id in the events table, or 0 if empty. */
  getMaxEventId(): number;
  /**
   * Returns events from the hardcoded daemon-wide allowlist with `id > afterId`,
   * ordered by id ascending.
   *
   * The allowlist is the source of truth for which event types are "daemon-wide"
   * (not per-session). Adding a new daemon-wide type requires updating `db.ts`.
   */
  getDaemonEventsAfter(afterId: number): EventRecord[];
  /**
   * Returns the highest event row id among daemon-wide events (those whose type
   * appears in the `DAEMON_EVENT_TYPES` allowlist), or 0 when no such events exist.
   *
   * Filter parity: uses the same `DAEMON_EVENT_TYPES` allowlist as
   * `getDaemonEventsAfter`, so `getMaxDaemonEventId()` always equals the largest
   * `id` that `getDaemonEventsAfter(0)` would surface.
   */
  getMaxDaemonEventId(): number;
  /**
   * Aggregate profile usage statistics for runs using `profileName` within
   * the last `windowMs` milliseconds.
   *
   * Returns `null` when no `session:profile` events matching the profile name
   * exist within the window (caller maps to `{ dataSource: 'none' }`).
   *
   * `recentQuotaErrors` counts `agent:stop` events whose error field contains
   * rate-limit/quota indicators (429, rate_limit, quota, rate limit).
   */
  getProfileUsageSummary(profileName: string, windowMs: number): {
    lastUsedAt?: string;
    recentRunCount: number;
    recentTokens?: { input?: number; output?: number; total?: number };
    recentCostUsd?: number;
    recentQuotaErrors: number;
  } | null;
  close(): void;
}

export interface FileDiffRecord {
  id: number;
  runId: string;
  planId: string;
  filePath: string;
  diffText: string;
  timestamp: string;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    plan_set TEXT NOT NULL,
    command TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    started_at TEXT NOT NULL,
    completed_at TEXT,
    cwd TEXT NOT NULL,
    pid INTEGER
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(id),
    type TEXT NOT NULL,
    plan_id TEXT,
    agent TEXT,
    data TEXT NOT NULL,
    timestamp TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_events_run_id ON events(run_id);
  CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
  CREATE INDEX IF NOT EXISTS idx_runs_session_id ON runs(session_id);

  CREATE TABLE IF NOT EXISTS file_diffs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(id),
    plan_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    diff_text TEXT NOT NULL,
    timestamp TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_file_diffs_plan_file ON file_diffs(plan_id, file_path);
  CREATE INDEX IF NOT EXISTS idx_file_diffs_run_id ON file_diffs(run_id);
`;

/**
 * Allowlist of daemon-wide event types surfaced via GET /api/daemon-events.
 * Derived from the event registry in @eforge-build/client: entries with
 * persist:true are included; daemon:heartbeat (persist:false, LIVE-ONLY) is
 * intentionally absent so it is never replayed from storage.
 *
 * Source of truth: packages/client/src/event-registry.ts
 */
// DAEMON_EVENT_TYPES is imported from @eforge-build/client above.

export function openDatabase(dbPath: string): MonitorDB {
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  // Concurrent build subprocesses share this DB file; busy_timeout lets
  // SQLite's native busy handler wait for the write lock instead of
  // failing immediately with SQLITE_BUSY.
  db.exec('PRAGMA busy_timeout = 5000');
  // NORMAL is safe with WAL: durable across app crashes, only risks losing
  // the last committed transaction on OS/power failure. Trades that for
  // fewer fsyncs and much higher write throughput under concurrency.
  db.exec('PRAGMA synchronous = NORMAL');
  // Node.js DatabaseSync enforces FK constraints by default. Daemon-level
  // events (e.g. daemon:auto-build:paused) use the watcher sessionId as
  // run_id without a matching runs row, so FK enforcement must stay off.
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(SCHEMA);

  // Migrations for existing DBs
  const columns = db.prepare('PRAGMA table_info(runs)').all() as unknown as { name: string }[];
  if (!columns.some((c) => c.name === 'pid')) {
    db.exec('ALTER TABLE runs ADD COLUMN pid INTEGER');
  }
  if (!columns.some((c) => c.name === 'session_id')) {
    db.exec('ALTER TABLE runs ADD COLUMN session_id TEXT');
  }
  // Backfill session_id for pre-existing runs so session-scoped queries work
  db.exec('UPDATE runs SET session_id = id WHERE session_id IS NULL');
  // Rename 'plan' command to 'compile' for existing records
  db.exec("UPDATE runs SET command = 'compile' WHERE command = 'plan'");

  const stmts = {
    insertRun: db.prepare(
      `INSERT INTO runs (id, session_id, plan_set, command, status, started_at, cwd, pid) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    insertEvent: db.prepare(
      `INSERT INTO events (run_id, type, plan_id, agent, data, timestamp) VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    updateRunStatus: db.prepare(
      `UPDATE runs SET status = ?, completed_at = ? WHERE id = ?`,
    ),
    updateRunStatusNoCa: db.prepare(
      `UPDATE runs SET status = ? WHERE id = ?`,
    ),
    updateRunPlanSet: db.prepare(
      `UPDATE runs SET plan_set = ? WHERE id = ?`,
    ),
    getRuns: db.prepare(
      `SELECT id, session_id, plan_set, command, status, started_at, completed_at, cwd, pid FROM runs ORDER BY started_at DESC`,
    ),
    getRunningRuns: db.prepare(
      `SELECT id, session_id, plan_set, command, status, started_at, completed_at, cwd, pid FROM runs WHERE status = 'running' ORDER BY started_at DESC`,
    ),
    getEventsAll: db.prepare(
      `SELECT id, run_id as runId, type, plan_id as planId, agent, data, timestamp FROM events WHERE run_id = ? ORDER BY id`,
    ),
    getEventsAfter: db.prepare(
      `SELECT id, run_id as runId, type, plan_id as planId, agent, data, timestamp FROM events WHERE run_id = ? AND id > ? ORDER BY id`,
    ),
    getEventsByType: db.prepare(
      `SELECT id, run_id as runId, type, plan_id as planId, agent, data, timestamp FROM events WHERE run_id = ? AND type = ? ORDER BY id`,
    ),
    getRun: db.prepare(
      `SELECT id, session_id, plan_set, command, status, started_at, completed_at, cwd, pid FROM runs WHERE id = ?`,
    ),
    getLatestRunId: db.prepare(
      `SELECT id FROM runs ORDER BY started_at DESC LIMIT 1`,
    ),
    getLatestEventTimestamp: db.prepare(
      `SELECT timestamp FROM events ORDER BY id DESC LIMIT 1`,
    ),
    getMaxEventId: db.prepare(
      `SELECT COALESCE(MAX(id), 0) as maxId FROM events`,
    ),
    getDaemonEventsAfter: db.prepare(
      `SELECT id, run_id as runId, type, plan_id as planId, agent, data, timestamp FROM events WHERE type IN (${DAEMON_EVENT_TYPES.map(() => '?').join(', ')}) AND id > ? ORDER BY id`,
    ),
    getMaxDaemonEventId: db.prepare(
      `SELECT COALESCE(MAX(id), 0) as maxId FROM events WHERE type IN (${DAEMON_EVENT_TYPES.map(() => '?').join(', ')})`,
    ),
    getRunsBySession: db.prepare(
      `SELECT id, session_id, plan_set, command, status, started_at, completed_at, cwd, pid FROM runs WHERE session_id = ? ORDER BY started_at`,
    ),
    getEventsBySessionAll: db.prepare(
      `SELECT e.id, e.run_id as runId, e.type, e.plan_id as planId, e.agent, e.data, e.timestamp FROM events e JOIN runs r ON e.run_id = r.id WHERE r.session_id = ? ORDER BY e.id`,
    ),
    getEventsBySessionAfter: db.prepare(
      `SELECT e.id, e.run_id as runId, e.type, e.plan_id as planId, e.agent, e.data, e.timestamp FROM events e JOIN runs r ON e.run_id = r.id WHERE r.session_id = ? AND e.id > ? ORDER BY e.id`,
    ),
    getEventsByTypeForSession: db.prepare(
      `SELECT e.id, e.run_id as runId, e.type, e.plan_id as planId, e.agent, e.data, e.timestamp FROM events e JOIN runs r ON e.run_id = r.id WHERE r.session_id = ? AND e.type = ? ORDER BY e.id`,
    ),
    getLatestSessionId: db.prepare(
      `SELECT session_id as sessionId FROM runs ORDER BY started_at DESC LIMIT 1`,
    ),
    getSessionMetadataEvents: db.prepare(
      `SELECT e.type, e.data, r.session_id as sessionId FROM events e JOIN runs r ON e.run_id = r.id WHERE e.type IN ('session:profile', 'planning:complete', 'agent:start') ORDER BY e.id`,
    ),
    insertFileDiff: db.prepare(
      `INSERT INTO file_diffs (run_id, plan_id, file_path, diff_text, timestamp) VALUES (?, ?, ?, ?, ?)`,
    ),
    getFileDiff: db.prepare(
      `SELECT fd.id, fd.run_id as runId, fd.plan_id as planId, fd.file_path as filePath, fd.diff_text as diffText, fd.timestamp FROM file_diffs fd JOIN runs r ON fd.run_id = r.id WHERE r.session_id = ? AND fd.plan_id = ? AND fd.file_path = ? ORDER BY fd.timestamp DESC LIMIT 1`,
    ),
    getFileDiffs: db.prepare(
      `SELECT fd.id, fd.run_id as runId, fd.plan_id as planId, fd.file_path as filePath, fd.diff_text as diffText, fd.timestamp FROM file_diffs fd JOIN runs r ON fd.run_id = r.id WHERE r.session_id = ? AND fd.plan_id = ? ORDER BY fd.file_path, fd.timestamp DESC`,
    ),
    getDistinctSessionIds: db.prepare(
      `SELECT session_id as sessionId FROM runs WHERE session_id IS NOT NULL GROUP BY session_id ORDER BY MAX(started_at) DESC`,
    ),
    deleteFileDiffsByRunIds: db.prepare(
      `DELETE FROM file_diffs WHERE run_id IN (SELECT id FROM runs WHERE session_id = ?)`,
    ),
    deleteEventsByRunIds: db.prepare(
      `DELETE FROM events WHERE run_id IN (SELECT id FROM runs WHERE session_id = ?)`,
    ),
    deleteRunsBySession: db.prepare(
      `DELETE FROM runs WHERE session_id = ?`,
    ),
  };

  return {
    insertRun(run) {
      stmts.insertRun.run(run.id, run.sessionId ?? null, run.planSet, run.command, run.status, run.startedAt, run.cwd, run.pid ?? null);
    },

    insertEvent(event) {
      const result = stmts.insertEvent.run(
        event.runId,
        event.type,
        event.planId ?? null,
        event.agent ?? null,
        event.data,
        event.timestamp,
      );
      return Number(result.lastInsertRowid);
    },

    updateRunStatus(runId, status, completedAt?) {
      if (completedAt) {
        stmts.updateRunStatus.run(status, completedAt, runId);
      } else {
        stmts.updateRunStatusNoCa.run(status, runId);
      }
    },

    updateRunPlanSet(runId, planSet) {
      stmts.updateRunPlanSet.run(planSet, runId);
    },

    getRuns() {
      return (stmts.getRuns.all() as unknown as RunRow[]).map(rowToRunInfo);
    },

    getRunningRuns() {
      return (stmts.getRunningRuns.all() as unknown as RunRow[]).map(rowToRunInfo);
    },

    getRun(runId) {
      const row = stmts.getRun.get(runId) as unknown as RunRow | undefined;
      return row !== undefined ? rowToRunInfo(row) : undefined;
    },

    getRunById(runId) {
      const row = stmts.getRun.get(runId) as unknown as RunRow | undefined;
      return row !== undefined ? rowToRunInfo(row) : undefined;
    },

    getEvents(runId, afterId) {
      if (afterId !== undefined) {
        return stmts.getEventsAfter.all(runId, afterId) as unknown as EventRecord[];
      }
      return stmts.getEventsAll.all(runId) as unknown as EventRecord[];
    },

    getEventsByType(runId, type) {
      return stmts.getEventsByType.all(runId, type) as unknown as EventRecord[];
    },

    getRunsBySession(sessionId) {
      return (stmts.getRunsBySession.all(sessionId) as unknown as RunRow[]).map(rowToRunInfo);
    },

    getEventsBySession(sessionId, afterId) {
      if (afterId !== undefined) {
        return stmts.getEventsBySessionAfter.all(sessionId, afterId) as unknown as EventRecord[];
      }
      return stmts.getEventsBySessionAll.all(sessionId) as unknown as EventRecord[];
    },

    getEventsByTypeForSession(sessionId, type) {
      return stmts.getEventsByTypeForSession.all(sessionId, type) as unknown as EventRecord[];
    },

    getLatestSessionId() {
      const row = stmts.getLatestSessionId.get() as unknown as { sessionId: string | null } | undefined;
      return row?.sessionId ?? undefined;
    },

    getSessionRuns(sessionId) {
      return (stmts.getRunsBySession.all(sessionId) as unknown as RunRow[]).map(rowToRunInfo);
    },

    getSessionMetadataBatch() {
      const rows = stmts.getSessionMetadataEvents.all() as unknown as { type: string; data: string; sessionId: string }[];

      const result: Record<string, SessionMetadata> = {};

      for (const row of rows) {
        if (!row.sessionId) continue;
        if (!result[row.sessionId]) {
          result[row.sessionId] = { planCount: null, baseProfile: null };
        }
        const meta = result[row.sessionId];

        try {
          const data = JSON.parse(row.data);
          if (row.type === 'session:profile' && meta.baseProfile === null) {
            const profileName = data.profileName as string | null | undefined;
            if (profileName) {
              meta.baseProfile = profileName;
            }
          } else if (row.type === 'planning:complete') {
            const plans = data.plans as unknown[] | undefined;
            if (Array.isArray(plans)) {
              meta.planCount = plans.length;
            }
          }
        } catch {
          // skip unparseable events
        }
      }

      return result;
    },

    getLatestRunId() {
      const row = stmts.getLatestRunId.get() as unknown as { id: string } | undefined;
      return row?.id;
    },

    getLatestEventTimestamp() {
      const row = stmts.getLatestEventTimestamp.get() as unknown as { timestamp: string } | undefined;
      return row?.timestamp;
    },

    getMaxEventId() {
      const row = stmts.getMaxEventId.get() as unknown as { maxId: number } | undefined;
      return row?.maxId ?? 0;
    },

    getDaemonEventsAfter(afterId) {
      return stmts.getDaemonEventsAfter.all(...DAEMON_EVENT_TYPES, afterId) as unknown as EventRecord[];
    },

    getMaxDaemonEventId() {
      const row = stmts.getMaxDaemonEventId.get(...DAEMON_EVENT_TYPES) as unknown as { maxId: number } | undefined;
      return row?.maxId ?? 0;
    },

    insertFileDiffs(runId, planId, diffs, timestamp) {
      db.exec('BEGIN');
      try {
        for (const d of diffs) {
          stmts.insertFileDiff.run(runId, planId, d.path, d.diff, timestamp);
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },

    getFileDiff(sessionId, planId, filePath) {
      return stmts.getFileDiff.get(sessionId, planId, filePath) as unknown as FileDiffRecord | undefined;
    },

    getFileDiffs(sessionId, planId) {
      // Get all diffs, then deduplicate to latest per file path
      const rows = stmts.getFileDiffs.all(sessionId, planId) as unknown as FileDiffRecord[];
      // Since results are ordered by file_path, timestamp DESC, take first per file_path
      const seen = new Set<string>();
      const result: FileDiffRecord[] = [];
      for (const row of rows) {
        if (!seen.has(row.filePath)) {
          seen.add(row.filePath);
          result.push(row);
        }
      }
      return result;
    },

    cleanupOldSessions(keepCount) {
      const allSessions = stmts.getDistinctSessionIds.all() as unknown as { sessionId: string }[];
      if (allSessions.length <= keepCount) return;

      const sessionsToDelete = allSessions.slice(keepCount);
      db.exec('BEGIN');
      try {
        for (const { sessionId } of sessionsToDelete) {
          stmts.deleteFileDiffsByRunIds.run(sessionId);
          stmts.deleteEventsByRunIds.run(sessionId);
          stmts.deleteRunsBySession.run(sessionId);
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },

    // --- eforge:region plan-02-runtime-and-integration ---
    getProfileUsageSummary(profileName, windowMs) {
      const cutoff = new Date(Date.now() - windowMs).toISOString();

      // Find distinct run_ids for sessions using this profile within the window.
      const sessionRows = db
        .prepare(
          `SELECT DISTINCT e.run_id as runId
           FROM events e
           WHERE e.type = 'session:profile'
             AND json_extract(e.data, '$.profileName') = ?
             AND e.timestamp >= ?`,
        )
        .all(profileName, cutoff) as unknown as { runId: string }[];

      if (sessionRows.length === 0) return null;

      const runIds = sessionRows.map((r) => r.runId);
      const placeholders = runIds.map(() => '?').join(', ');

      // Last used timestamp
      const lastUsedRow = db
        .prepare(
          `SELECT MAX(e.timestamp) as lastUsedAt
           FROM events e
           WHERE e.type = 'session:profile'
             AND json_extract(e.data, '$.profileName') = ?
             AND e.run_id IN (${placeholders})`,
        )
        .get(profileName, ...runIds) as unknown as { lastUsedAt: string | null };

      // Aggregate agent:usage token totals
      const usageRow = db
        .prepare(
          `SELECT
             SUM(json_extract(e.data, '$.usage.input')) as totalInput,
             SUM(json_extract(e.data, '$.usage.output')) as totalOutput,
             SUM(json_extract(e.data, '$.usage.total')) as totalTokens
           FROM events e
           WHERE e.type = 'agent:usage'
             AND e.run_id IN (${placeholders})`,
        )
        .get(...runIds) as unknown as { totalInput: number | null; totalOutput: number | null; totalTokens: number | null };

      // Aggregate agent:result total cost
      const costRow = db
        .prepare(
          `SELECT SUM(json_extract(e.data, '$.result.totalCostUsd')) as totalCost
           FROM events e
           WHERE e.type = 'agent:result'
             AND e.run_id IN (${placeholders})`,
        )
        .get(...runIds) as unknown as { totalCost: number | null };

      // Count quota-style errors from agent:stop events with recognizable error messages
      const quotaRow = db
        .prepare(
          `SELECT COUNT(*) as count
           FROM events e
           WHERE e.type = 'agent:stop'
             AND e.run_id IN (${placeholders})
             AND json_extract(e.data, '$.error') IS NOT NULL
             AND (
               json_extract(e.data, '$.error') LIKE '%429%' OR
               json_extract(e.data, '$.error') LIKE '%rate_limit%' OR
               json_extract(e.data, '$.error') LIKE '%rate limit%' OR
               json_extract(e.data, '$.error') LIKE '%quota%'
             )`,
        )
        .get(...runIds) as unknown as { count: number };

      const hasTokens =
        usageRow.totalInput !== null || usageRow.totalOutput !== null || usageRow.totalTokens !== null;

      return {
        lastUsedAt: lastUsedRow.lastUsedAt ?? undefined,
        recentRunCount: runIds.length,
        ...(hasTokens
          ? {
              recentTokens: {
                input: usageRow.totalInput ?? undefined,
                output: usageRow.totalOutput ?? undefined,
                total: usageRow.totalTokens ?? undefined,
              },
            }
          : {}),
        recentCostUsd: costRow.totalCost ?? undefined,
        recentQuotaErrors: quotaRow.count ?? 0,
      };
    },
    // --- eforge:endregion plan-02-runtime-and-integration ---

    close() {
      db.close();
    },
  };
}
