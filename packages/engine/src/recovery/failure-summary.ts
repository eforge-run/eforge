/**
 * Assembles a BuildFailureSummary from monitor.db events and git history
 * on the surviving feature branch. There is no state.json path — active
 * build state lives in memory only. All recovery synthesis is via
 * monitor DB event history + git log/diff.
 *
 * When monitor DB events are found for the setName, returns a summary
 * with `partial` omitted (full synthesis succeeded). When no monitor DB
 * events are available, returns a summary with `partial: true`.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
 * Derive the base branch from git remote tracking info.
 * Tries `git symbolic-ref refs/remotes/origin/HEAD --short`, falls back to `main`.
 */
async function deriveBaseBranch(cwd: string): Promise<string> {
  try {
    const { stdout } = await exec('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'], { cwd });
    const ref = stdout.trim();
    // Strip "origin/" prefix (e.g., "origin/main" → "main")
    return ref.replace(/^origin\//, '') || 'main';
  } catch {
    return 'main';
  }
}

/**
 * Build a failure summary for a PRD that failed during an eforge build session.
 *
 * Always synthesizes from:
 * - monitor.db event history (via `synthesizeFromEvents`, when `dbPath` supplied)
 * - git log/diff against `eforge/<setName>` (when the branch exists)
 *
 * Returns `partial: true` when no monitor DB events are found for the setName.
 * Returns with `partial` omitted when monitor DB synthesis succeeded.
 *
 * Never throws — callers can rely on always receiving a summary.
 *
 * @param setName - The plan set name
 * @param prdId - The PRD identifier being recovered
 * @param cwd - Repository root
 * @param dbPath - Optional path to monitor.db for event-history synthesis
 * @param prdContent - Optional PRD file content (unused currently, reserved for future)
 */
export async function buildFailureSummary({ setName, prdId, cwd, dbPath, prdContent }: {
  setName: string;
  prdId: string;
  cwd: string;
  dbPath?: string;
  prdContent?: string;
}): Promise<BuildFailureSummary> {
  const featureBranch = `eforge/${setName}`;
  const baseBranch = await deriveBaseBranch(cwd);

  // Try event-history synthesis from monitor DB
  const eventFragment = synthesizeFromEvents({ setName, prdId, dbPath });

  // Try git log/diff against feature branch if it exists
  let landedCommits: LandedCommit[] = [];
  let diffStat = '';
  let modelsUsed: string[] = [];

  try {
    const { stdout } = await exec(
      'git',
      ['log', `--format=%H%x00%s%x00%an%x00%aI`, `${baseBranch}..${featureBranch}`],
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
      ['diff', '--stat', `${baseBranch}...${featureBranch}`],
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
        ['log', '--format=%B', `${baseBranch}..${featureBranch}`],
        { cwd },
      );
      modelsUsed = parseModelsFromLog(stdout);
    } catch {
      // Ignore
    }
  }

  // Merge event-history models with git-derived models
  if (eventFragment?.modelsUsed && eventFragment.modelsUsed.length > 0) {
    const merged = new Set([...modelsUsed, ...eventFragment.modelsUsed]);
    modelsUsed = [...merged].sort();
  }

  const failingPlan: FailingPlanEntry = eventFragment?.failingPlan ?? { planId: 'unknown' };
  const plans: PlanSummaryEntry[] = eventFragment?.plans ?? [];

  // failedAt derivation (Decision #11):
  // - If monitor DB has events → use the event timestamp
  // - Else if landed commits exist → use the most recent commit's date
  // - Else use current time
  let failedAt: string;
  if (eventFragment?.failedAt) {
    failedAt = eventFragment.failedAt;
  } else if (landedCommits.length > 0) {
    // landedCommits are ordered newest-first (git log default)
    failedAt = landedCommits[0].date;
  } else {
    failedAt = new Date().toISOString();
  }

  const result: BuildFailureSummary = {
    prdId,
    setName,
    featureBranch,
    baseBranch,
    plans,
    failingPlan,
    landedCommits,
    diffStat,
    modelsUsed,
    failedAt,
    ...(prdContent !== undefined ? { prdContent } : {}),
  };

  // Only set partial: true when no monitor DB events were found
  if (!eventFragment) {
    result.partial = true;
  }

  return result;
}
