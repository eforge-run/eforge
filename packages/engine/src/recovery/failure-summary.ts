/**
 * Assembles a BuildFailureSummary from state.json + git on the surviving
 * feature branch. No event-log replay — state already captures what we need.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadState } from '../state.js';
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
 * Reads `.eforge/state.json` via `loadState`, then runs `git log` and
 * `git diff --stat` on the surviving feature branch to capture what landed
 * before the failure.
 *
 * @param setName - The plan set name (used to locate state if featureBranch is absent)
 * @param prdId - The PRD identifier being recovered
 * @param cwd - Repository root (must contain `.eforge/state.json`)
 */
export async function buildFailureSummary({ setName, prdId, cwd }: {
  setName: string;
  prdId: string;
  cwd: string;
}): Promise<BuildFailureSummary> {
  const state = loadState(cwd);
  if (!state) {
    throw new Error(`buildFailureSummary: no state file found at ${cwd}/.eforge/state.json`);
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
