/**
 * Git helpers — diff capture, file-change emission, status checks, plan artifact commits.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import type { EforgeEvent } from '../events.js';
import type { BuildStageContext } from './types.js';
import { forgeCommit } from '../git.js';
import type { ModelTracker } from '../model-tracker.js';
import { composeCommitMessage } from '../model-tracker.js';

const exec = promisify(execFile);

/** Interval (ms) between periodic file-change checks during long-running build stages. */
export const FILE_CHECK_INTERVAL_MS = 15_000;

/**
 * Check if there are unstaged changes in a directory.
 */
export async function hasUnstagedChanges(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await exec('git', ['diff', '--name-only'], { cwd });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Capture per-file diffs between the working tree and a base branch.
 * Runs a single `git diff <baseBranch>` and splits the output on `diff --git a/` headers.
 * Returns an empty array on failure (non-critical).
 */
export async function captureFileDiffs(cwd: string, baseBranch: string): Promise<Array<{ path: string; diff: string }>> {
  try {
    const { stdout } = await exec('git', ['diff', baseBranch], { cwd });
    if (!stdout.trim()) return [];

    const chunks = stdout.split(/(?=^diff --git a\/)/m).filter(Boolean);
    return chunks.map((chunk) => {
      // Extract path from "diff --git a/<path> b/<path>"
      const match = chunk.match(/^diff --git a\/(.+?) b\//);
      const path = match?.[1] ?? 'unknown';
      return { path, diff: chunk };
    });
  } catch {
    return [];
  }
}

/** Compare two sorted string arrays for equality. */
function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Build a continuation diff string from a worktree, truncating large diffs
 * to a file-list summary to avoid filling the continuation builder's context.
 */
async function buildContinuationDiff(cwd: string, baseBranch: string): Promise<string> {
  const DIFF_CHAR_LIMIT = 50_000;
  const { stdout: diff } = await exec('git', ['diff', `${baseBranch}...HEAD`], { cwd });
  if (diff.length <= DIFF_CHAR_LIMIT) return diff;

  // Large diff — fall back to file-list summary with per-file stats
  const { stdout: stat } = await exec('git', ['diff', '--stat', `${baseBranch}...HEAD`], { cwd });
  return `[Diff too large (${diff.length} chars) — showing file summary instead]\n\n${stat}`;
}

/**
 * Wrap an inner agent async generator to periodically check for file changes
 * and interleave `build:files_changed` events. Uses `Promise.race` between
 * the next agent event and a timer so checks happen even during long agent turns.
 *
 * Non-critical — silently skips on git failure. Deduplicates by comparing sorted file lists.
 */
export async function* withPeriodicFileCheck(
  inner: AsyncGenerator<EforgeEvent>,
  ctx: BuildStageContext,
  intervalMs: number = FILE_CHECK_INTERVAL_MS,
): AsyncGenerator<EforgeEvent> {
  const iterator = inner[Symbol.asyncIterator]();
  let lastFiles: string[] = [];
  let pending: Promise<IteratorResult<EforgeEvent>> | null = null;

  try {
    while (true) {
      if (!pending) {
        pending = iterator.next();
      }

      // Race between the next agent event and a timer
      let timerId: ReturnType<typeof setTimeout>;
      const timer = new Promise<'tick'>((resolve) => {
        timerId = setTimeout(() => resolve('tick'), intervalMs);
        timerId.unref();
      });

      const result = await Promise.race([
        pending.then((r) => ({ kind: 'event' as const, result: r })),
        timer.then((t) => ({ kind: t })),
      ]);

      if (result.kind === 'tick') {
        // Timer fired — check for file changes
        try {
          const { stdout } = await exec('git', ['diff', '--name-only', ctx.orchConfig.baseBranch], { cwd: ctx.worktreePath });
          const files = stdout.trim().split('\n').filter(Boolean).sort();
          if (files.length > 0 && !arraysEqual(files, lastFiles)) {
            lastFiles = files;
            const diffs = await captureFileDiffs(ctx.worktreePath, ctx.orchConfig.baseBranch);
            yield { timestamp: new Date().toISOString(), type: 'plan:build:files_changed', planId: ctx.planId, files, diffs, baseBranch: ctx.orchConfig.baseBranch };
          }
        } catch {
          // Non-critical — skip silently
        }
        continue;
      }

      // Agent event arrived — clear the losing timer to avoid accumulating pending callbacks
      clearTimeout(timerId!);
      const { result: iterResult } = result;
      pending = null;

      if (iterResult.done) break;
      yield iterResult.value;
    }
  } finally {
    await iterator.return?.(undefined);
  }
}

/**
 * Emit a build:files_changed event listing all files changed vs the base branch.
 * Uses two-dot diff (baseBranch) to capture committed, staged, and unstaged changes.
 * Non-critical — silently skips on failure.
 */
export async function* emitFilesChanged(ctx: BuildStageContext): AsyncGenerator<EforgeEvent> {
  try {
    const { stdout } = await exec('git', ['diff', '--name-only', ctx.orchConfig.baseBranch], { cwd: ctx.worktreePath });
    const files = stdout.trim().split('\n').filter(Boolean);
    if (files.length > 0) {
      const diffs = await captureFileDiffs(ctx.worktreePath, ctx.orchConfig.baseBranch);
      yield { timestamp: new Date().toISOString(), type: 'plan:build:files_changed', planId: ctx.planId, files, diffs, baseBranch: ctx.orchConfig.baseBranch };
    }
  } catch {
    // Non-critical - skip silently
  }
}

/**
 * Commit plan artifacts to git (required for worktree-based builds).
 * @param commitCwd - Working directory for git operations (may differ from plan file location)
 * @param planSetName - Name of the plan set
 * @param planFilesCwd - Optional directory where plan files live (defaults to commitCwd)
 * @param outputDir - Optional output directory for plan files (defaults to 'eforge/plans')
 * @param modelTracker - Optional tracker for Models-Used: commit trailer
 */
export async function commitPlanArtifacts(commitCwd: string, planSetName: string, planFilesCwd?: string, outputDir?: string, modelTracker?: ModelTracker): Promise<void> {
  const planDir = resolve(planFilesCwd ?? commitCwd, outputDir ?? 'eforge/plans', planSetName);
  // Skip silently if no plan files exist yet — happens when the planner exhausted
  // its turn budget before submitting. The original (max_turns) error must
  // propagate from the caller; we must not mask it with a "git add" pathspec error.
  if (!existsSync(planDir)) return;
  await exec('git', ['add', planDir], { cwd: commitCwd });
  // Guard: only commit if there are staged changes (prevents "nothing to commit" errors
  // when artifacts were already committed by a previous continuation checkpoint)
  const { stdout: staged } = await exec('git', ['diff', '--cached', '--name-only'], { cwd: commitCwd });
  if (staged.trim().length === 0) return;
  await forgeCommit(commitCwd, composeCommitMessage(`plan(${planSetName}): initial planning artifacts`, modelTracker));
}
