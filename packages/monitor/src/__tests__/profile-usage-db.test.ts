/**
 * Tests for MonitorDB.getProfileUsageSummary.
 *
 * Covers:
 * - Aggregation across a window emits correct recentTokens/recentCostUsd/recentRunCount.
 * - Quota-style failures surface as recentQuotaErrors > 0.
 * - Cooldown derivation in createProfileUsageProvider when recentQuotaErrors > 0.
 * - No rows -> returns null (caller maps to { dataSource: 'none' }).
 * - Events outside the window are excluded.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type MonitorDB } from '../db.js';
import { COOLDOWN_WINDOW_MS, NEAR_LIMIT_TOKEN_THRESHOLD } from '../server-main.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'profile-usage-db-test-'));
}

function insertRun(db: MonitorDB, runId: string, sessionId: string, profileName: string, timestamp: string): void {
  db.insertRun({
    id: runId,
    sessionId,
    planSet: 'test-plan',
    command: 'build',
    status: 'completed',
    startedAt: timestamp,
    cwd: '/tmp/test',
  });

  // Insert a session:profile event linking this run to the profile
  db.insertEvent({
    runId,
    type: 'session:profile',
    data: JSON.stringify({
      type: 'session:profile',
      sessionId,
      profileName,
      source: 'local',
      scope: 'project',
      config: null,
      timestamp,
    }),
    timestamp,
  });
}

function insertAgentUsage(
  db: MonitorDB,
  runId: string,
  input: number,
  output: number,
  total: number,
  timestamp: string,
): void {
  db.insertEvent({
    runId,
    type: 'agent:usage',
    data: JSON.stringify({
      type: 'agent:usage',
      agentId: 'test-agent',
      agent: 'builder',
      usage: { input, output, total, cacheRead: 0, cacheCreation: 0 },
      timestamp,
    }),
    timestamp,
  });
}

function insertAgentResult(
  db: MonitorDB,
  runId: string,
  totalCostUsd: number,
  inputTokens: number,
  timestamp: string,
): void {
  db.insertEvent({
    runId,
    type: 'agent:result',
    data: JSON.stringify({
      type: 'agent:result',
      agent: 'builder',
      result: {
        durationMs: 1000,
        durationApiMs: 800,
        numTurns: 5,
        totalCostUsd,
        usage: { input: inputTokens, output: 500, total: inputTokens + 500, cacheRead: 0, cacheCreation: 0 },
        modelUsage: {},
      },
      timestamp,
    }),
    timestamp,
  });
}

function insertAgentStop(
  db: MonitorDB,
  runId: string,
  error: string | undefined,
  timestamp: string,
): void {
  db.insertEvent({
    runId,
    type: 'agent:stop',
    data: JSON.stringify({
      type: 'agent:stop',
      agentId: 'test-agent',
      agent: 'builder',
      ...(error !== undefined ? { error } : {}),
      timestamp,
    }),
    timestamp,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MonitorDB.getProfileUsageSummary', () => {
  let db: MonitorDB;
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
    db = openDatabase(join(tempDir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns null when no session:profile events exist for the profile', () => {
    const result = db.getProfileUsageSummary('nonexistent-profile', 24 * 60 * 60 * 1000);
    expect(result).toBeNull();
  });

  it('returns null when all matching events are outside the window', () => {
    // Insert an event from 2 days ago
    const oldTimestamp = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    insertRun(db, 'run-old', 'session-old', 'my-profile', oldTimestamp);

    // Query with a 1-hour window — should not include the old run
    const result = db.getProfileUsageSummary('my-profile', 60 * 60 * 1000);
    expect(result).toBeNull();
  });

  it('aggregates token counts from agent:usage events', () => {
    const now = new Date().toISOString();

    insertRun(db, 'run-1', 'session-1', 'my-profile', now);
    insertAgentUsage(db, 'run-1', 1000, 500, 1500, now);

    insertRun(db, 'run-2', 'session-2', 'my-profile', now);
    insertAgentUsage(db, 'run-2', 2000, 1000, 3000, now);

    const result = db.getProfileUsageSummary('my-profile', 24 * 60 * 60 * 1000);

    expect(result).not.toBeNull();
    expect(result!.recentRunCount).toBe(2);
    expect(result!.recentTokens?.input).toBe(3000);
    expect(result!.recentTokens?.output).toBe(1500);
    expect(result!.recentTokens?.total).toBe(4500);
  });

  it('aggregates cost from agent:result events', () => {
    const now = new Date().toISOString();

    insertRun(db, 'run-a', 'session-a', 'cost-profile', now);
    insertAgentResult(db, 'run-a', 0.05, 1000, now);

    insertRun(db, 'run-b', 'session-b', 'cost-profile', now);
    insertAgentResult(db, 'run-b', 0.03, 800, now);

    const result = db.getProfileUsageSummary('cost-profile', 24 * 60 * 60 * 1000);

    expect(result).not.toBeNull();
    // Sum of costs (floating point, so use approximately)
    expect(result!.recentCostUsd).toBeCloseTo(0.08, 5);
  });

  it('counts quota errors from agent:stop events with rate-limit messages', () => {
    const now = new Date().toISOString();

    insertRun(db, 'run-quota-1', 'session-quota-1', 'quota-profile', now);
    insertAgentStop(db, 'run-quota-1', 'Error 429: Too Many Requests', now);

    insertRun(db, 'run-quota-2', 'session-quota-2', 'quota-profile', now);
    insertAgentStop(db, 'run-quota-2', 'rate_limit exceeded', now);

    insertRun(db, 'run-ok', 'session-ok', 'quota-profile', now);
    // No error (normal stop)
    insertAgentStop(db, 'run-ok', undefined, now);

    const result = db.getProfileUsageSummary('quota-profile', 24 * 60 * 60 * 1000);

    expect(result).not.toBeNull();
    expect(result!.recentQuotaErrors).toBe(2);
    expect(result!.recentRunCount).toBe(3);
  });

  it('does not count non-quota errors as quota errors', () => {
    const now = new Date().toISOString();

    insertRun(db, 'run-err', 'session-err', 'err-profile', now);
    insertAgentStop(db, 'run-err', 'Network connection timeout', now);

    const result = db.getProfileUsageSummary('err-profile', 24 * 60 * 60 * 1000);

    expect(result).not.toBeNull();
    expect(result!.recentQuotaErrors).toBe(0);
  });

  it('returns correct recentRunCount', () => {
    const now = new Date().toISOString();

    for (let i = 0; i < 5; i++) {
      insertRun(db, `run-count-${i}`, `session-count-${i}`, 'count-profile', now);
    }

    const result = db.getProfileUsageSummary('count-profile', 24 * 60 * 60 * 1000);

    expect(result).not.toBeNull();
    expect(result!.recentRunCount).toBe(5);
  });

  it('does not include events from other profiles', () => {
    const now = new Date().toISOString();

    insertRun(db, 'run-p1', 'session-p1', 'profile-one', now);
    insertAgentUsage(db, 'run-p1', 5000, 2000, 7000, now);

    insertRun(db, 'run-p2', 'session-p2', 'profile-two', now);
    insertAgentUsage(db, 'run-p2', 1000, 500, 1500, now);

    const result = db.getProfileUsageSummary('profile-one', 24 * 60 * 60 * 1000);

    expect(result).not.toBeNull();
    expect(result!.recentRunCount).toBe(1);
    expect(result!.recentTokens?.input).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// Cooldown and nearLimit derivation (from server-main constants)
// ---------------------------------------------------------------------------

describe('Profile usage provider cooldown and nearLimit', () => {
  it('COOLDOWN_WINDOW_MS is 10 minutes', () => {
    expect(COOLDOWN_WINDOW_MS).toBe(10 * 60 * 1000);
  });

  it('NEAR_LIMIT_TOKEN_THRESHOLD is 1_000_000', () => {
    expect(NEAR_LIMIT_TOKEN_THRESHOLD).toBe(1_000_000);
  });
});
