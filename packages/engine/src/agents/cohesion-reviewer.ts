import type { AgentBackend, SdkPassthroughConfig } from '../backend.js';
import { pickSdkOptions } from '../backend.js';
import { isAlwaysYieldedAgentEvent, type EforgeEvent } from '../events.js';
import { loadPrompt } from '../prompts.js';
import { parseReviewIssues } from './reviewer.js';
import { getPlanReviewIssueSchemaYaml } from '../schemas.js';

/**
 * Options for the cohesion reviewer agent.
 */
export interface CohesionReviewerOptions extends SdkPassthroughConfig {
  /** Backend for running the agent */
  backend: AgentBackend;
  /** The original source/PRD content to review plans against */
  sourceContent: string;
  /** The plan set name (directory under plans/) */
  planSetName: string;
  /** The architecture.md content for cross-module validation */
  architectureContent: string;
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
 * Run the cohesion reviewer agent as a one-shot query.
 *
 * Reviews all plan files in the plan set for cross-module cohesion:
 * file overlaps, integration contracts, dependency validation, and
 * vague verification criteria. Leaves any fixes unstaged for the
 * cohesion evaluator to accept/reject.
 *
 * Yields:
 * - `planning:cohesion:start` at the beginning
 * - `agent:message`, `agent:tool_use`, `agent:tool_result` events (when verbose)
 * - `planning:cohesion:complete` with parsed ReviewIssue[] at the end
 */
export async function* runCohesionReview(
  options: CohesionReviewerOptions,
): AsyncGenerator<EforgeEvent> {
  const { backend, sourceContent, planSetName, architectureContent, cwd, verbose, abortController } = options;

  yield { timestamp: new Date().toISOString(), type: 'planning:cohesion:start' };

  const prompt = await loadPrompt('cohesion-reviewer', {
    source_content: sourceContent,
    plan_set_name: planSetName,
    architecture_content: architectureContent,
    outputDir: options.outputDir ?? 'eforge/plans',
    review_issue_schema: getPlanReviewIssueSchemaYaml(),
  }, options.promptAppend);

  let fullText = '';

  for await (const event of backend.run(
    { prompt, cwd, maxTurns: 30, tools: 'coding', abortSignal: abortController?.signal, ...pickSdkOptions(options) },
    'cohesion-reviewer',
  )) {
    if (isAlwaysYieldedAgentEvent(event) || verbose) {
      yield event;
    }
    if (event.type === 'agent:message' && event.content) {
      fullText += event.content;
    }
  }

  const issues = parseReviewIssues(fullText);

  yield { timestamp: new Date().toISOString(), type: 'planning:cohesion:complete', issues };
}
