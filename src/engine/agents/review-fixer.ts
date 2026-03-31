/**
 * Review fixer agent - applies fixes for aggregated review issues.
 * Runs after parallel specialist reviewers to apply their findings.
 * Uses tools: 'coding' to write fixes, but does NOT stage or commit.
 */

import type { AgentBackend, SdkPassthroughConfig } from '../backend.js';
import { pickSdkOptions } from '../backend.js';
import { SEVERITY_ORDER, isAlwaysYieldedAgentEvent, type EforgeEvent, type ReviewIssue } from '../events.js';
import { loadPrompt } from '../prompts.js';

export interface ReviewFixerOptions extends SdkPassthroughConfig {
  /** Backend for running the agent */
  backend: AgentBackend;
  /** Plan identifier for event correlation */
  planId: string;
  /** Working directory */
  cwd: string;
  /** Aggregated issues from parallel reviewers */
  issues: ReviewIssue[];
  /** Whether to emit verbose agent-level events */
  verbose?: boolean;
  /** AbortController for cancellation */
  abortController?: AbortController;
}

/**
 * Format issues into a human-readable list for the prompt, sorted by severity.
 */
function formatIssuesForPrompt(issues: ReviewIssue[]): string {
  const sorted = [...issues].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );

  return sorted
    .map((issue, i) => {
      const line = issue.line ? `:${issue.line}` : '';
      const fix = issue.fix ? `\n   Fix: ${issue.fix}` : '';
      return `${i + 1}. [${issue.severity.toUpperCase()}] ${issue.file}${line} — ${issue.category}\n   ${issue.description}${fix}`;
    })
    .join('\n\n');
}

/**
 * Run the review fixer agent as a one-shot coding agent.
 *
 * Yields:
 * - `build:review:fix:start` at the beginning
 * - agent lifecycle events
 * - `build:review:fix:complete` at the end
 */
export async function* runReviewFixer(
  options: ReviewFixerOptions,
): AsyncGenerator<EforgeEvent> {
  const { backend, planId, cwd, issues, verbose, abortController } = options;

  yield { timestamp: new Date().toISOString(), type: 'build:review:fix:start', planId, issueCount: issues.length };

  const issuesText = formatIssuesForPrompt(issues);
  const prompt = await loadPrompt('review-fixer', {
    issues: issuesText,
  });

  try {
    for await (const event of backend.run(
      {
        prompt,
        cwd,
        maxTurns: 30,
        tools: 'coding',
        abortSignal: abortController?.signal,
        ...pickSdkOptions(options),
      },
      'review-fixer',
      planId,
    )) {
      if (isAlwaysYieldedAgentEvent(event) || verbose) {
        yield event;
      }
    }
  } catch (err) {
    // Re-throw abort errors so the orchestrator can respect cancellation
    if (err instanceof Error && err.name === 'AbortError') throw err;
    // Other fixer failures are non-fatal
  }

  yield { timestamp: new Date().toISOString(), type: 'build:review:fix:complete', planId };
}
