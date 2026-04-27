/**
 * Synthesize a partial BuildFailureSummary from monitor.db event history.
 *
 * Used when state.json is unavailable (e.g. when running manual recovery
 * after the build process has already cleaned up). Opens the SQLite DB
 * read-only and queries recent plan:build:failed + agent:start events.
 *
 * Never throws — returns null on any error or when no relevant events exist.
 */

import { DatabaseSync } from 'node:sqlite';
import type { BuildFailureSummary, FailingPlanEntry, PlanSummaryEntry, LandedCommit } from '../events.js';

export interface SynthesizeOptions {
  setName: string;
  prdId: string;
  dbPath?: string;
}

/**
 * Synthesize a partial BuildFailureSummary fragment from monitor.db event history.
 *
 * @param options.setName - The plan set name (matches runs.plan_set)
 * @param options.prdId - The PRD identifier being recovered
 * @param options.dbPath - Path to the monitor SQLite database (optional)
 * @returns A partial BuildFailureSummary, or null when no data is findable
 */
export function synthesizeFromEvents(options: SynthesizeOptions): Partial<BuildFailureSummary> | null {
  const { setName, prdId, dbPath } = options;
  if (!dbPath) return null;

  try {
    const db = new DatabaseSync(dbPath);
    try {
      // Find the most recent run for this setName
      const runStmt = db.prepare(
        `SELECT id, started_at as startedAt FROM runs WHERE plan_set = ? ORDER BY started_at DESC LIMIT 1`,
      );
      const run = runStmt.get(setName) as { id: string; startedAt: string } | undefined;

      if (!run) return null;

      const runId = run.id;

      // Find the most recent plan:build:failed event for this run
      const failedStmt = db.prepare(
        `SELECT id, plan_id as planId, data, timestamp FROM events WHERE run_id = ? AND type = 'plan:build:failed' ORDER BY id DESC LIMIT 1`,
      );
      const failedEvent = failedStmt.get(runId) as {
        id: number;
        planId: string | null;
        data: string;
        timestamp: string;
      } | undefined;

      if (!failedEvent) return null;

      const failingPlanId = failedEvent.planId ?? 'unknown';
      let errorMessage: string | undefined;
      try {
        const parsed = JSON.parse(failedEvent.data) as Record<string, unknown>;
        errorMessage = typeof parsed.error === 'string' ? parsed.error : undefined;
      } catch { /* ignore malformed data */ }

      // Find agent:start events to extract model IDs
      const agentStmt = db.prepare(
        `SELECT data FROM events WHERE run_id = ? AND type = 'agent:start' ORDER BY id`,
      );
      const agentEvents = agentStmt.all(runId) as { data: string }[];

      const modelSet = new Set<string>();
      for (const ae of agentEvents) {
        try {
          const parsed = JSON.parse(ae.data) as Record<string, unknown>;
          const model = parsed.model;
          if (typeof model === 'string' && model) {
            modelSet.add(model);
          }
        } catch { /* ignore malformed data */ }
      }
      const modelsUsed = [...modelSet].sort();

      const failingPlan: FailingPlanEntry = {
        planId: failingPlanId,
        errorMessage,
      };

      const plans: PlanSummaryEntry[] = [{
        planId: failingPlanId,
        status: 'failed',
        error: errorMessage,
      }];

      return {
        prdId,
        setName,
        featureBranch: `eforge/${setName}`,
        baseBranch: 'main',
        plans,
        failingPlan,
        landedCommits: [] as LandedCommit[],
        diffStat: '',
        modelsUsed,
        failedAt: failedEvent.timestamp,
        partial: true,
      };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}
