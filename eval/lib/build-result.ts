#!/usr/bin/env tsx
// Build a structured result.json from eval scenario output.
// Usage: npx tsx build-result.ts <output> <scenario> <version> <commit> <exitCode> <duration> <logFile> <validationJson> [monitorDbPath]

import { readFileSync, writeFileSync, existsSync } from 'fs';
import Database from 'better-sqlite3';
import type { AgentResultData, AgentRole, ReviewIssue } from '../../src/engine/events.js';

const [, , outputFile, scenario, eforgeVersion, eforgeCommit, exitCodeStr, durationStr, logFile, validationJson, monitorDbPath] =
  process.argv;

// Parse the eforge log to extract the run ID
let langfuseTraceId: string | undefined;
try {
  const log = readFileSync(logFile, 'utf8');
  const match = log.match(/Run:\s+([a-f0-9-]+)/);
  if (match) langfuseTraceId = match[1];
} catch {
  // Log file may not exist if eforge failed to start
}

// Parse validation results
let validation: Record<string, unknown> = {};
try {
  validation = JSON.parse(validationJson);
} catch {
  // Empty or malformed validation
}

interface PhaseTimestamps {
  start?: string;
  end?: string;
}

interface AgentAggregate {
  count: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  durationMs: number;
  turns: number;
}

interface ModelAggregate {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

interface Metrics {
  profile?: string;
  tokens: { input: number; output: number; total: number };
  costUsd: number;
  phases: Record<string, { durationMs: number }>;
  agents: Record<string, AgentAggregate>;
  review: {
    issueCount: number;
    bySeverity: Record<string, number>;
    accepted: number;
    rejected: number;
  };
  models: Record<string, ModelAggregate>;
}

function extractMetrics(dbPath: string): Metrics | undefined {
  if (!existsSync(dbPath)) return undefined;

  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return undefined;
  }

  try {
    // Verify the events table exists (DB may be empty if WAL wasn't copied)
    const tableCheck = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='events'`
    ).get() as { name: string } | undefined;
    if (!tableCheck) return undefined;
    // Extract profile from plan:profile event
    let profile: string | undefined;
    const profileRows = db.prepare(
      `SELECT data FROM events WHERE type = 'plan:profile' LIMIT 1`
    ).all() as Array<{ data: string }>;
    if (profileRows.length > 0) {
      try {
        const parsed = JSON.parse(profileRows[0].data);
        profile = parsed.profileName;
      } catch { /* ignore */ }
    }

    // Extract agent results
    const agentResultRows = db.prepare(
      `SELECT agent, data FROM events WHERE type = 'agent:result'`
    ).all() as Array<{ agent: string; data: string }>;

    let totalInput = 0;
    let totalOutput = 0;
    let totalTotal = 0;
    let totalCost = 0;
    const agents: Record<string, AgentAggregate> = {};
    const models: Record<string, ModelAggregate> = {};

    for (const row of agentResultRows) {
      let result: AgentResultData;
      try {
        const parsed = JSON.parse(row.data);
        result = parsed.result as AgentResultData;
        if (!result) continue;
      } catch {
        continue;
      }

      const role = row.agent as AgentRole;

      // Accumulate totals
      totalInput += result.usage.input;
      totalOutput += result.usage.output;
      totalTotal += result.usage.total;
      totalCost += result.totalCostUsd;

      // Per-agent aggregates
      if (!agents[role]) {
        agents[role] = { count: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, durationMs: 0, turns: 0 };
      }
      agents[role].count += 1;
      agents[role].inputTokens += result.usage.input;
      agents[role].outputTokens += result.usage.output;
      agents[role].totalTokens += result.usage.total;
      agents[role].costUsd += result.totalCostUsd;
      agents[role].durationMs += result.durationMs;
      agents[role].turns += result.numTurns;

      // Per-model aggregates
      if (result.modelUsage) {
        for (const [model, usage] of Object.entries(result.modelUsage)) {
          if (!models[model]) {
            models[model] = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
          }
          models[model].inputTokens += usage.inputTokens;
          models[model].outputTokens += usage.outputTokens;
          models[model].costUsd += usage.costUSD;
        }
      }
    }

    // Extract phase durations from phase:start/phase:end
    const phaseRows = db.prepare(
      `SELECT type, data, timestamp FROM events WHERE type IN ('phase:start', 'phase:end') ORDER BY id`
    ).all() as Array<{ type: string; data: string; timestamp: string }>;

    const phaseTimestamps: Record<string, PhaseTimestamps> = {};
    const runIdToCommand: Record<string, string> = {};
    for (const row of phaseRows) {
      try {
        const parsed = JSON.parse(row.data);
        if (row.type === 'phase:start') {
          const command = parsed.command as string | undefined;
          const runId = parsed.runId as string | undefined;
          if (command) {
            phaseTimestamps[command] = { ...phaseTimestamps[command], start: row.timestamp };
            if (runId) runIdToCommand[runId] = command;
          }
        } else if (row.type === 'phase:end') {
          const runId = parsed.runId as string | undefined;
          const command = runId ? runIdToCommand[runId] : undefined;
          if (command && phaseTimestamps[command]) {
            phaseTimestamps[command] = { ...phaseTimestamps[command], end: row.timestamp };
          }
        }
      } catch { /* ignore */ }
    }

    const phases: Record<string, { durationMs: number }> = {};
    for (const [command, ts] of Object.entries(phaseTimestamps)) {
      if (ts.start && ts.end) {
        const durationMs = new Date(ts.end).getTime() - new Date(ts.start).getTime();
        phases[command] = { durationMs };
      }
    }

    // Extract review issues from build:review:complete events
    let issueCount = 0;
    const bySeverity: Record<string, number> = {};
    const reviewCompleteRows = db.prepare(
      `SELECT data FROM events WHERE type = 'build:review:complete'`
    ).all() as Array<{ data: string }>;

    for (const row of reviewCompleteRows) {
      try {
        const parsed = JSON.parse(row.data);
        const issues = parsed.issues as ReviewIssue[] | undefined;
        if (issues) {
          issueCount += issues.length;
          for (const issue of issues) {
            bySeverity[issue.severity] = (bySeverity[issue.severity] ?? 0) + 1;
          }
        }
      } catch { /* ignore */ }
    }

    // Extract accepted/rejected from build:evaluate:complete events
    let accepted = 0;
    let rejected = 0;
    const evaluateCompleteRows = db.prepare(
      `SELECT data FROM events WHERE type = 'build:evaluate:complete'`
    ).all() as Array<{ data: string }>;

    for (const row of evaluateCompleteRows) {
      try {
        const parsed = JSON.parse(row.data);
        accepted += parsed.accepted ?? 0;
        rejected += parsed.rejected ?? 0;
      } catch { /* ignore */ }
    }

    return {
      ...(profile && { profile }),
      tokens: { input: totalInput, output: totalOutput, total: totalTotal },
      costUsd: totalCost,
      phases,
      agents,
      review: { issueCount, bySeverity, accepted, rejected },
      models,
    };
  } finally {
    db.close();
  }
}

// Build the result object
const result: Record<string, unknown> = {
  scenario,
  timestamp: new Date().toISOString(),
  eforgeVersion,
  eforgeCommit,
  eforgeExitCode: parseInt(exitCodeStr, 10),
  validation,
  durationSeconds: parseInt(durationStr, 10),
  ...(langfuseTraceId && { langfuseTraceId }),
};

// Extract metrics from monitor DB if available
if (monitorDbPath) {
  const metrics = extractMetrics(monitorDbPath);
  if (metrics) {
    result.metrics = metrics;
  }
}

writeFileSync(outputFile, JSON.stringify(result, null, 2) + '\n');
