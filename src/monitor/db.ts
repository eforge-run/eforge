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
  getLatestEventTimestamp(): string | undefined;
  close(): void;
}

export interface SessionMetadata {
  planCount: number | null;
  baseProfile: string | null;
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
`;

export function openDatabase(dbPath: string): MonitorDB {
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
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
      `SELECT e.type, e.data, r.session_id as sessionId FROM events e JOIN runs r ON e.run_id = r.id WHERE e.type IN ('plan:profile', 'plan:complete') ORDER BY e.id`,
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
          result[row.sessionId] = { planCount: null, baseProfile: null };
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
          } else if (row.type === 'plan:complete') {
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

    close() {
      db.close();
    },
  };
}
