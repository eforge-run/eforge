import type { AgentBackend, SdkPassthroughConfig } from '../backend.js';
import { pickSdkOptions } from '../backend.js';
import { isAlwaysYieldedAgentEvent, type EforgeEvent } from '../events.js';
import { loadPrompt } from '../prompts.js';
import { parseReviewIssues } from './reviewer.js';
import { getPlanReviewIssueSchemaYaml } from '../schemas.js';

/**
 * Options for the plan reviewer agent.
 */
export interface PlanReviewerOptions extends SdkPassthroughConfig {
  /** Backend for running the agent */
  backend: AgentBackend;
  /** The original source/PRD content to review plans against */
  sourceContent: string;
  /** The plan set name (directory under plans/) */
  planSetName: string;
  /** Working directory */
  cwd: string;
  /** Whether to emit verbose agent-level events */
  verbose?: boolean;
  /** AbortController for cancellation */
  abortController?: AbortController;
  /** Plan output directory (defaults to 'eforge/plans'). */
  outputDir?: string;
}

/**
 * Run the plan reviewer agent as a one-shot query.
 *
 * Reviews all plan files in the plan set for cohesion, completeness,
 * correctness, feasibility, dependency ordering, and scope. Leaves
 * any fixes unstaged for the plan evaluator to accept/reject.
 *
 * Yields:
 * - `plan:review:start` at the beginning
 * - `agent:message`, `agent:tool_use`, `agent:tool_result` events (when verbose)
 * - `plan:review:complete` with parsed ReviewIssue[] at the end
 */
export async function* runPlanReview(
  options: PlanReviewerOptions,
): AsyncGenerator<EforgeEvent> {
  const { backend, sourceContent, planSetName, cwd, verbose, abortController } = options;

  yield { timestamp: new Date().toISOString(), type: 'plan:review:start' };

  const prompt = await loadPrompt('plan-reviewer', {
    source_content: sourceContent,
    plan_set_name: planSetName,
    outputDir: options.outputDir ?? 'eforge/plans',
    review_issue_schema: getPlanReviewIssueSchemaYaml(),
  });

  let fullText = '';

  for await (const event of backend.run(
    { prompt, cwd, maxTurns: 30, tools: 'coding', abortSignal: abortController?.signal, ...pickSdkOptions(options) },
    'plan-reviewer',
  )) {
    if (isAlwaysYieldedAgentEvent(event) || verbose) {
      yield event;
    }
    if (event.type === 'agent:message' && event.content) {
      fullText += event.content;
    }
  }

  const issues = parseReviewIssues(fullText);

  yield { timestamp: new Date().toISOString(), type: 'plan:review:complete', issues };
}
