import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface RunRecord {
  id: string;
  planSet: string;
  command: string;
  status: string;
  startedAt: string;
  completedAt?: string;
  cwd: string;
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
    planSet: string;
    command: string;
    status: string;
    startedAt: string;
    cwd: string;
  }): void;
  insertEvent(event: {
    runId: string;
    type: string;
    planId?: string;
    agent?: string;
    data: string;
    timestamp: string;
  }): number;
  updateRunStatus(runId: string, status: string, completedAt: string): void;
  getRuns(): RunRecord[];
  getEvents(runId: string, afterId?: number): EventRecord[];
  getEventsByType(runId: string, type: string): EventRecord[];
  getLatestRunId(): string | undefined;
  close(): void;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    plan_set TEXT NOT NULL,
    command TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    started_at TEXT NOT NULL,
    completed_at TEXT,
    cwd TEXT NOT NULL
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
`;

export function openDatabase(dbPath: string): MonitorDB {
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);

  const stmts = {
    insertRun: db.prepare(
      `INSERT INTO runs (id, plan_set, command, status, started_at, cwd) VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    insertEvent: db.prepare(
      `INSERT INTO events (run_id, type, plan_id, agent, data, timestamp) VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    updateRunStatus: db.prepare(
      `UPDATE runs SET status = ?, completed_at = ? WHERE id = ?`,
    ),
    getRuns: db.prepare(
      `SELECT id, plan_set as planSet, command, status, started_at as startedAt, completed_at as completedAt, cwd FROM runs ORDER BY started_at DESC`,
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
    getLatestRunId: db.prepare(
      `SELECT id FROM runs ORDER BY started_at DESC LIMIT 1`,
    ),
  };

  return {
    insertRun(run) {
      stmts.insertRun.run(run.id, run.planSet, run.command, run.status, run.startedAt, run.cwd);
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

    updateRunStatus(runId, status, completedAt) {
      stmts.updateRunStatus.run(status, completedAt, runId);
    },

    getRuns() {
      return stmts.getRuns.all() as RunRecord[];
    },

    getEvents(runId, afterId) {
      if (afterId !== undefined) {
        return stmts.getEventsAfter.all(runId, afterId) as EventRecord[];
      }
      return stmts.getEventsAll.all(runId) as EventRecord[];
    },

    getEventsByType(runId, type) {
      return stmts.getEventsByType.all(runId, type) as EventRecord[];
    },

    getLatestRunId() {
      const row = stmts.getLatestRunId.get() as { id: string } | undefined;
      return row?.id;
    },

    close() {
      db.close();
    },
  };
}
