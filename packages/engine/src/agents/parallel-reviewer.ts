/**
 * Parallel review orchestrator - fans out to specialist reviewers when
 * the changeset is large enough, otherwise delegates to the single reviewer.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { AgentHarness, SdkPassthroughConfig } from '../harness.js';
import { pickSdkOptions } from '../harness.js';
import { SEVERITY_ORDER, isAlwaysYieldedAgentEvent, type EforgeEvent, type ReviewIssue } from '../events.js';
import type { ReviewPerspective } from '../review-heuristics.js';
import { categorizeFiles, determineApplicableReviewsWithRules, shouldParallelizeReview, FILE_COUNT_THRESHOLD, LINE_COUNT_THRESHOLD } from '../review-heuristics.js';
import { emitBuildDecisionForPlan } from '../decisions.js';
import { runParallel, type ParallelTask } from '../concurrency.js';
import { loadPrompt } from '../prompts.js';
import { runReview, parseReviewIssues } from './reviewer.js';
import {
  getCodeReviewIssueSchemaYaml,
  getSecurityReviewIssueSchemaYaml,
  getApiReviewIssueSchemaYaml,
  getDocsReviewIssueSchemaYaml,
  getTestsReviewIssueSchemaYaml,
  getVerifyReviewIssueSchemaYaml,
} from '../schemas.js';

const exec = promisify(execFile);

/**
 * Compute the changeset metrics used by the auto-threshold parallelization
 * heuristic. Returns file count, changed-line count, and the threshold values
 * so callers can populate the `auto` block of a `review-strategy` decision.
 */
export async function computeReviewThresholdSnapshot(
  cwd: string,
  baseBranch: string,
): Promise<{
  changedFiles: string[];
  changedLines: number;
  willParallelize: boolean;
  threshold: { files: number; lines: number };
}> {
  let changedFiles: string[] = [];
  let changedLines = 0;

  try {
    const { stdout } = await exec('git', ['diff', `${baseBranch}...HEAD`, '--name-only'], { cwd });
    changedFiles = stdout.trim().split('\n').filter(Boolean);
  } catch {
    // Non-git directory or git unavailable — default to empty
  }

  try {
    const { stdout } = await exec('git', ['diff', `${baseBranch}...HEAD`, '--stat'], { cwd });
    const statLine = stdout.trim().split('\n').pop() ?? '';
    const insertMatch = statLine.match(/(\d+)\s+insertion/);
    const deleteMatch = statLine.match(/(\d+)\s+deletion/);
    changedLines = (insertMatch ? parseInt(insertMatch[1], 10) : 0) +
      (deleteMatch ? parseInt(deleteMatch[1], 10) : 0);
  } catch {
    // Non-critical — default to 0
  }

  return {
    changedFiles,
    changedLines,
    willParallelize: shouldParallelizeReview(changedFiles, { lines: changedLines }),
    threshold: { files: FILE_COUNT_THRESHOLD, lines: LINE_COUNT_THRESHOLD },
  };
}

export interface ParallelReviewerOptions extends SdkPassthroughConfig {
  /** Harness for running agents */
  harness: AgentHarness;
  /** The plan content (full markdown body) to review against */
  planContent: string;
  /** The base branch to diff against */
  baseBranch: string;
  /** Plan identifier for event correlation */
  planId: string;
  /** Working directory for the review */
  cwd: string;
  /** Whether to emit verbose agent-level events */
  verbose?: boolean;
  /** AbortController for cancellation */
  abortController?: AbortController;
  /** Override review strategy. 'auto' = existing heuristic, 'single' = always single, 'parallel' = always parallel */
  strategy?: 'auto' | 'single' | 'parallel';
  /** Override which review perspectives to use (only applies when parallel path is taken) */
  perspectives?: string[];
}

/** Map perspective names to prompt file names */
const PERSPECTIVE_PROMPTS: Record<ReviewPerspective, string> = {
  code: 'reviewer-code',
  security: 'reviewer-security',
  api: 'reviewer-api',
  docs: 'reviewer-docs',
  test: 'reviewer-tests',
  verify: 'reviewer-verify',
};

/** Map perspective names to schema YAML getters */
const PERSPECTIVE_SCHEMA_YAML: Record<ReviewPerspective, () => string> = {
  code: getCodeReviewIssueSchemaYaml,
  security: getSecurityReviewIssueSchemaYaml,
  api: getApiReviewIssueSchemaYaml,
  docs: getDocsReviewIssueSchemaYaml,
  test: getTestsReviewIssueSchemaYaml,
  verify: getVerifyReviewIssueSchemaYaml,
};

/**
 * Run parallel review if the changeset is large enough, otherwise delegate
 * to the existing single `runReview()`.
 *
 * Always yields `plan:build:review:start` and `plan:build:review:complete` with issues.
 * When parallelized, also yields parallel lifecycle events in between.
 */
export async function* runParallelReview(
  options: ParallelReviewerOptions,
): AsyncGenerator<EforgeEvent> {
  const { harness, planContent, baseBranch, planId, cwd, verbose, abortController, strategy, perspectives: perspectivesOverride } = options;

  // Short-circuit: strategy 'single' always delegates to single reviewer
  if (strategy === 'single') {
    yield* runReview({
      harness,
      planContent,
      baseBranch,
      planId,
      cwd,
      verbose,
      abortController,
      ...pickSdkOptions(options),
    });
    return;
  }

  // Get changeset metrics (delegates to shared helper to avoid duplication)
  const snapshot = await computeReviewThresholdSnapshot(cwd, baseBranch);
  const changedFiles = snapshot.changedFiles;
  const changedLines = snapshot.changedLines;

  // Check threshold: strategy 'parallel' skips the heuristic, 'auto' (default) uses it
  if (strategy !== 'parallel' && !shouldParallelizeReview(changedFiles, { lines: changedLines })) {
    // Below threshold - delegate to existing single reviewer
    yield* runReview({
      harness,
      planContent,
      baseBranch,
      planId,
      cwd,
      verbose,
      abortController,
      ...pickSdkOptions(options),
    });
    return;
  }

  // Above threshold (or forced parallel) - run parallel specialist reviewers
  // Use perspectives override if provided, otherwise determine from file categories
  let perspectives: ReviewPerspective[];
  if (perspectivesOverride) {
    perspectives = perspectivesOverride as ReviewPerspective[];
  } else {
    const categories = categorizeFiles(changedFiles);
    const { perspectives: inferred, rules } = determineApplicableReviewsWithRules(categories);
    perspectives = inferred;

    // Emit perspectives-inferred decision — only when inference ran (no override supplied)
    const activeCategories = Object.entries(categories)
      .filter(([, files]) => files.length > 0)
      .map(([cat]) => cat);
    yield emitBuildDecisionForPlan(planId, {
      kind: 'perspectives-inferred',
      rationale: `Perspectives inferred from ${changedFiles.length} changed files: ${inferred.length > 0 ? inferred.join(', ') : 'none (falling back to single reviewer)'}`,
      perspectives: inferred,
      categories: activeCategories,
      rules,
    });
  }

  if (perspectives.length === 0) {
    // No applicable perspectives - fall back to single reviewer
    yield* runReview({
      harness,
      planContent,
      baseBranch,
      planId,
      cwd,
      verbose,
      abortController,
    });
    return;
  }

  yield { timestamp: new Date().toISOString(), type: 'plan:build:review:start', planId };
  yield { timestamp: new Date().toISOString(), type: 'plan:build:review:parallel:start', planId, perspectives };

  // Build parallel tasks for each perspective
  const allIssues: Array<{ perspective: ReviewPerspective; issues: ReviewIssue[] }> = [];

  const tasks: ParallelTask<EforgeEvent>[] = perspectives.map((perspective) => ({
    id: `review-${perspective}`,
    run: async function* (): AsyncGenerator<EforgeEvent> {
      yield { timestamp: new Date().toISOString(), type: 'plan:build:review:parallel:perspective:start', planId, perspective };

      try {
        const prompt = await loadPrompt(PERSPECTIVE_PROMPTS[perspective], {
          plan_content: planContent,
          base_branch: baseBranch,
          review_issue_schema: PERSPECTIVE_SCHEMA_YAML[perspective](),
        }, options.promptAppend);

        let fullText = '';

        for await (const event of harness.run(
          { prompt, cwd, maxTurns: 30, tools: 'coding', abortSignal: abortController?.signal, ...pickSdkOptions(options), perspective },
          'reviewer',
          planId,
        )) {
          if (isAlwaysYieldedAgentEvent(event) || verbose) {
            yield event;
          }
          if (event.type === 'agent:message' && event.content) {
            fullText += event.content;
          }
        }

        const issues = parseReviewIssues(fullText);
        allIssues.push({ perspective, issues });

        yield { timestamp: new Date().toISOString(), type: 'plan:build:review:parallel:perspective:complete', planId, perspective, issues };
      } catch (err) {
        yield {
          timestamp: new Date().toISOString(),
          type: 'plan:build:review:parallel:perspective:error',
          planId,
          perspective,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  }));

  // Run all perspective reviews in parallel
  for await (const event of runParallel(tasks)) {
    yield event;
  }

  // Aggregate and deduplicate issues
  const mergedIssues = deduplicateIssues(
    allIssues.flatMap((r) => r.issues),
  );

  yield { timestamp: new Date().toISOString(), type: 'plan:build:review:complete', planId, issues: mergedIssues };
}

/**
 * Deduplicate issues that appear across multiple perspectives.
 * Two issues are considered duplicates if they share the same file, line, and
 * a similar description. When duplicates are found, the highest severity wins.
 */
export function deduplicateIssues(issues: ReviewIssue[]): ReviewIssue[] {
  const seen = new Map<string, ReviewIssue>();

  for (const issue of issues) {
    const key = `${issue.file}:${issue.line ?? ''}:${issue.description}`;

    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, issue);
    } else if (SEVERITY_ORDER[issue.severity] < SEVERITY_ORDER[existing.severity]) {
      // Higher severity wins
      seen.set(key, issue);
    }
  }

  return Array.from(seen.values());
}
