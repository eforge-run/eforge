/**
 * Assembles a BuildFailureSummary from state.json + git on the surviving
 * feature branch. When state.json is missing, falls back to a partial
 * summary synthesized from monitor.db events and git history.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadState } from '../state.js';
import { synthesizeFromEvents } from './event-history.js';
import type { BuildFailureSummary, LandedCommit, PlanSummaryEntry, FailingPlanEntry } from '../events.js';

const exec = promisify(execFile);

/**
 * Parse the `Models-Used:` trailer values from git log `--format=%B` output.
 * Each commit body may contain a line like:
 *   Models-Used: model-a, model-b
 *
 * Returns a deduplicated, sorted list of model IDs.
 */
function parseModelsFromLog(logBody: string): string[] {
  const models = new Set<string>();
  const lineRegex = /^Models-Used:\s*(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = lineRegex.exec(logBody)) !== null) {
    for (const part of m[1].split(',')) {
      const id = part.trim();
      if (id) models.add(id);
    }
  }
  return [...models].sort();
}

/**
 * Build a failure summary for a PRD that failed during an eforge build session.
 *
 * When `state.json` is present, reads from it to produce a full summary.
 * When `state.json` is missing, synthesizes a partial summary from:
 * - monitor.db event history (via `synthesizeFromEvents`, when `dbPath` supplied)
 * - git log/diff against `eforge/<setName>` (when the branch exists)
 * Returns `partial: true` for the synthesized path.
 *
 * Never throws — callers can rely on always receiving a summary.
 *
 * @param setName - The plan set name
 * @param prdId - The PRD identifier being recovered
 * @param cwd - Repository root
 * @param dbPath - Optional path to monitor.db for event-history synthesis
 * @param prdContent - Optional PRD file content (unused currently, reserved for future)
 */
export async function buildFailureSummary({ setName, prdId, cwd, dbPath }: {
  setName: string;
  prdId: string;
  cwd: string;
  dbPath?: string;
  prdContent?: string;
}): Promise<BuildFailureSummary> {
  const state = loadState(cwd);
  if (!state) {
    // Partial path: state.json is missing — synthesize from available sources
    return buildPartialSummary({ setName, prdId, cwd, dbPath });
  }

  const baseBranch = state.baseBranch;
  const featureBranch = state.featureBranch ?? `eforge/${state.setName}`;

  // Summarise all plans from state
  const plans: PlanSummaryEntry[] = Object.entries(state.plans).map(([planId, planState]) => {
    const entry: PlanSummaryEntry = {
      planId,
      status: planState.status,
    };
    if (planState.error !== undefined) entry.error = planState.error;
    return entry;
  });

  // Identify the failing plan (first plan with status === 'failed')
  const failingEntry = Object.entries(state.plans).find(([, planState]) => planState.status === 'failed');
  const failingPlan: FailingPlanEntry = failingEntry
    ? { planId: failingEntry[0], errorMessage: failingEntry[1].error }
    : { planId: 'unknown' };

  // --- git log: landed commits on feature branch beyond base ---
  let landedCommits: LandedCommit[] = [];
  try {
    const { stdout } = await exec(
      'git',
      ['log', `--format=%H%x00%s%x00%an%x00%aI`, `${baseBranch}..${featureBranch}`],
      { cwd },
    );
    landedCommits = stdout.trim().split('\n').filter(Boolean).map(line => {
      const parts = line.split('\x00');
      return {
        sha: parts[0] ?? '',
        subject: parts[1] ?? '',
        author: parts[2] ?? '',
        date: parts[3] ?? '',
      };
    });
  } catch {
    // Feature branch may not exist or have no commits beyond base — leave empty
  }

  // --- git diff --stat: overall change summary ---
  let diffStat = '';
  try {
    const { stdout } = await exec(
      'git',
      ['diff', '--stat', `${baseBranch}...${featureBranch}`],
      { cwd },
    );
    diffStat = stdout.trim();
  } catch {
    // Ignore — diff stat is informational
  }

  // --- models used: parse Models-Used: trailers from commit bodies ---
  let modelsUsed: string[] = [];
  try {
    const { stdout } = await exec(
      'git',
      ['log', '--format=%B', `${baseBranch}..${featureBranch}`],
      { cwd },
    );
    modelsUsed = parseModelsFromLog(stdout);
  } catch {
    // Ignore
  }

  return {
    prdId,
    setName: state.setName,
    featureBranch,
    baseBranch,
    plans,
    failingPlan,
    landedCommits,
    diffStat,
    modelsUsed,
    failedAt: state.completedAt ?? state.startedAt,
  };
}

/**
 * Build a partial failure summary when state.json is not available.
 * Synthesizes from monitor.db events and git history on the feature branch.
 * Returns `partial: true` always.
 */
async function buildPartialSummary({ setName, prdId, cwd, dbPath }: {
  setName: string;
  prdId: string;
  cwd: string;
  dbPath?: string;
}): Promise<BuildFailureSummary> {
  const featureBranch = `eforge/${setName}`;

  // Try event-history synthesis
  const eventFragment = synthesizeFromEvents({ setName, prdId, dbPath });

  // Try git log/diff against feature branch if it exists
  let landedCommits: LandedCommit[] = [];
  let diffStat = '';
  let modelsUsed: string[] = [];

  try {
    const { stdout } = await exec(
      'git',
      ['log', `--format=%H%x00%s%x00%an%x00%aI`, `main..${featureBranch}`],
      { cwd },
    );
    if (stdout.trim()) {
      landedCommits = stdout.trim().split('\n').filter(Boolean).map(line => {
        const parts = line.split('\x00');
        return {
          sha: parts[0] ?? '',
          subject: parts[1] ?? '',
          author: parts[2] ?? '',
          date: parts[3] ?? '',
        };
      });
    }
  } catch {
    // Branch may not exist — leave empty
  }

  try {
    const { stdout } = await exec(
      'git',
      ['diff', '--stat', `main...${featureBranch}`],
      { cwd },
    );
    diffStat = stdout.trim();
  } catch {
    // Ignore
  }

  if (landedCommits.length > 0) {
    try {
      const { stdout } = await exec(
        'git',
        ['log', '--format=%B', `main..${featureBranch}`],
        { cwd },
      );
      modelsUsed = parseModelsFromLog(stdout);
    } catch {
      // Ignore
    }
  }

  // Merge event-history models
  if (eventFragment?.modelsUsed && eventFragment.modelsUsed.length > 0) {
    const merged = new Set([...modelsUsed, ...eventFragment.modelsUsed]);
    modelsUsed = [...merged].sort();
  }

  const failingPlan: FailingPlanEntry = eventFragment?.failingPlan ?? { planId: 'unknown' };
  const plans: PlanSummaryEntry[] = eventFragment?.plans ?? [];
  const failedAt = eventFragment?.failedAt ?? new Date().toISOString();

  return {
    prdId,
    setName,
    featureBranch,
    baseBranch: 'main',
    plans,
    failingPlan,
    landedCommits,
    diffStat,
    modelsUsed,
    failedAt,
    partial: true,
  };
}
