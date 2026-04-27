import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface RunRecord {
  id: string;
  sessionId?: string;
  planSet: string;
  command: string;
  status: string;
  startedAt: string;
  completedAt?: string;
  cwd: string;
  pid?: number;
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
  getRuns(): RunRecord[];
  getRunningRuns(): RunRecord[];
  getRun(runId: string): RunRecord | undefined;
  getEvents(runId: string, afterId?: number): EventRecord[];
  getEventsByType(runId: string, type: string): EventRecord[];
  getLatestRunId(): string | undefined;
  getRunsBySession(sessionId: string): RunRecord[];
  getEventsBySession(sessionId: string, afterId?: number): EventRecord[];
  getEventsByTypeForSession(sessionId: string, type: string): EventRecord[];
  getLatestSessionId(): string | undefined;
  getSessionRuns(sessionId: string): RunRecord[];
  getSessionMetadataBatch(): Record<string, SessionMetadata>;
  insertFileDiffs(runId: string, planId: string, diffs: Array<{ path: string; diff: string }>, timestamp: string): void;
  getFileDiff(sessionId: string, planId: string, filePath: string): FileDiffRecord | undefined;
  getFileDiffs(sessionId: string, planId: string): FileDiffRecord[];
  cleanupOldSessions(keepCount: number): void;
  getLatestEventTimestamp(): string | undefined;
  /** Returns the highest event row id in the events table, or 0 if empty. */
  getMaxEventId(): number;
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

export interface SessionMetadata {
  planCount: number | null;
  baseProfile: string | null;
  backend: string | null;
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
      `SELECT id, session_id as sessionId, plan_set as planSet, command, status, started_at as startedAt, completed_at as completedAt, cwd, pid FROM runs ORDER BY started_at DESC`,
    ),
    getRunningRuns: db.prepare(
      `SELECT id, session_id as sessionId, plan_set as planSet, command, status, started_at as startedAt, completed_at as completedAt, cwd, pid FROM runs WHERE status = 'running' ORDER BY started_at DESC`,
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
      `SELECT id, session_id as sessionId, plan_set as planSet, command, status, started_at as startedAt, completed_at as completedAt, cwd, pid FROM runs WHERE id = ?`,
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
    getRunsBySession: db.prepare(
      `SELECT id, session_id as sessionId, plan_set as planSet, command, status, started_at as startedAt, completed_at as completedAt, cwd, pid FROM runs WHERE session_id = ? ORDER BY started_at`,
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
      `SELECT e.type, e.data, r.session_id as sessionId FROM events e JOIN runs r ON e.run_id = r.id WHERE e.type IN ('plan:profile', 'planning:complete', 'agent:start') ORDER BY e.id`,
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
      return stmts.getRuns.all() as unknown as RunRecord[];
    },

    getRunningRuns() {
      return stmts.getRunningRuns.all() as unknown as RunRecord[];
    },

    getRun(runId) {
      return stmts.getRun.get(runId) as unknown as RunRecord | undefined;
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
      return stmts.getRunsBySession.all(sessionId) as unknown as RunRecord[];
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
      return stmts.getRunsBySession.all(sessionId) as unknown as RunRecord[];
    },

    getSessionMetadataBatch() {
      const BUILTIN_PROFILES = ['errand', 'excursion', 'expedition'];
      const rows = stmts.getSessionMetadataEvents.all() as unknown as { type: string; data: string; sessionId: string }[];

      const result: Record<string, SessionMetadata> = {};

      for (const row of rows) {
        if (!row.sessionId) continue;
        if (!result[row.sessionId]) {
          result[row.sessionId] = { planCount: null, baseProfile: null, backend: null };
        }
        const meta = result[row.sessionId];

        try {
          const data = JSON.parse(row.data);
          if (row.type === 'plan:profile' && meta.baseProfile === null) {
            const profileName = data.profileName as string | undefined;
            const config = data.config as { extends?: string } | undefined;
            if (profileName && BUILTIN_PROFILES.includes(profileName)) {
              meta.baseProfile = profileName;
            } else if (config?.extends && BUILTIN_PROFILES.includes(config.extends)) {
              meta.baseProfile = config.extends;
            } else if (profileName) {
              meta.baseProfile = profileName;
            }
          } else if (row.type === 'agent:start' && meta.backend === null) {
            // Use new harness field; fall back to legacy backend field for stored events
            const harness = (data.harness as string | undefined) ?? (data.backend as string | undefined);
            if (harness) {
              meta.backend = harness;
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

    close() {
      db.close();
    },
  };
}
