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
import { classifyAgentTerminalSubtype } from '../harness.js';

export interface SynthesizeOptions {
  setName: string;
  prdId: string;
  dbPath?: string;
}

// --- eforge:region plan-01-transport-resilience ---
interface EventHistoryRow {
  id: number;
  planId: string | null;
  agent: string | null;
  data: string;
  timestamp: string;
}

function parseEventData(data: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(data);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function terminalSubtypeFromMessage(message: string | undefined): string | undefined {
  if (!message) return undefined;
  return classifyAgentTerminalSubtype(new Error(message));
}
// --- eforge:endregion plan-01-transport-resilience ---

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
        `SELECT id, command, started_at as startedAt FROM runs WHERE plan_set = ? ORDER BY started_at DESC LIMIT 1`,
      );
      const run = runStmt.get(setName) as { id: string; command: string; startedAt: string } | undefined;

      if (!run) return null;

      const runId = run.id;

      // Find agent:start events to extract model IDs
      const agentStmt = db.prepare(
        `SELECT data FROM events WHERE run_id = ? AND type = 'agent:start' ORDER BY id`,
      );
      const agentEvents = agentStmt.all(runId) as { data: string }[];

      const modelSet = new Set<string>();
      for (const ae of agentEvents) {
        const parsed = parseEventData(ae.data);
        const model = parsed.model;
        if (typeof model === 'string' && model) {
          modelSet.add(model);
        }
      }
      const modelsUsed = [...modelSet].sort();

      // Find the most recent plan:build:failed event for this run
      const failedStmt = db.prepare(
        `SELECT id, plan_id as planId, agent, data, timestamp FROM events WHERE run_id = ? AND type = 'plan:build:failed' ORDER BY id DESC LIMIT 1`,
      );
      const failedEvent = failedStmt.get(runId) as EventHistoryRow | undefined;

      let failingPlan: FailingPlanEntry;
      let plans: PlanSummaryEntry[];
      let failedAt: string;

      if (failedEvent) {
        const failingPlanId = failedEvent.planId ?? 'unknown';
        const parsed = parseEventData(failedEvent.data);
        const errorMessage = typeof parsed.error === 'string' ? parsed.error : undefined;
        const terminalSubtype = typeof parsed.terminalSubtype === 'string'
          ? parsed.terminalSubtype
          : terminalSubtypeFromMessage(errorMessage);

        failingPlan = {
          planId: failingPlanId,
          errorMessage,
          ...(terminalSubtype && { terminalSubtype }),
        };

        plans = [{
          planId: failingPlanId,
          status: 'failed',
          error: errorMessage,
          ...(terminalSubtype && { terminalSubtype }),
        }];
        failedAt = failedEvent.timestamp;
      } else {
        // --- eforge:region plan-01-transport-resilience ---
        if (run.command !== 'compile') return null;

        const phaseStmt = db.prepare(
          `SELECT id, plan_id as planId, agent, data, timestamp FROM events WHERE run_id = ? AND type = 'phase:end' ORDER BY id DESC LIMIT 20`,
        );
        const phaseEvents = phaseStmt.all(runId) as unknown as EventHistoryRow[];
        const failedPhase = phaseEvents.find((event) => {
          const parsed = parseEventData(event.data);
          const result = parsed.result;
          return Boolean(
            result &&
            typeof result === 'object' &&
            (result as Record<string, unknown>).status === 'failed',
          );
        });
        if (!failedPhase) return null;

        const stopStmt = db.prepare(
          `SELECT id, plan_id as planId, agent, data, timestamp FROM events WHERE run_id = ? AND type = 'agent:stop' AND id <= ? ORDER BY id DESC LIMIT 20`,
        );
        const stopEvents = stopStmt.all(runId, failedPhase.id) as unknown as EventHistoryRow[];
        const failedStop = stopEvents.find((event) => {
          const parsed = parseEventData(event.data);
          return typeof parsed.error === 'string' && parsed.error.length > 0;
        });
        if (!failedStop) return null;

        const parsedStop = parseEventData(failedStop.data);
        const errorMessage = typeof parsedStop.error === 'string' ? parsedStop.error : undefined;
        const agentId = typeof parsedStop.agentId === 'string' ? parsedStop.agentId : undefined;
        const agentRole = typeof parsedStop.agent === 'string'
          ? parsedStop.agent
          : failedStop.agent ?? undefined;
        const terminalSubtype = terminalSubtypeFromMessage(errorMessage);

        failingPlan = {
          planId: 'compile',
          agentId,
          agentRole,
          errorMessage,
          ...(terminalSubtype && { terminalSubtype }),
        };
        plans = [{
          planId: 'compile',
          status: 'failed',
          error: errorMessage,
          ...(terminalSubtype && { terminalSubtype }),
        }];
        failedAt = failedPhase.timestamp;
        // --- eforge:endregion plan-01-transport-resilience ---
      }

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
        failedAt,
        partial: true,
      };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}
