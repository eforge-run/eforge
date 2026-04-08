import type { AgentBackend, SdkPassthroughConfig } from '../backend.js';
import { pickSdkOptions } from '../backend.js';
import { isAlwaysYieldedAgentEvent, type EforgeEvent } from '../events.js';
import { loadPrompt } from '../prompts.js';
import { parseReviewIssues } from './reviewer.js';
import { getPlanReviewIssueSchemaYaml } from '../schemas.js';

/**
 * Options for the architecture reviewer agent.
 */
export interface ArchitectureReviewerOptions extends SdkPassthroughConfig {
  /** Backend for running the agent */
  backend: AgentBackend;
  /** The original source/PRD content to review architecture against */
  sourceContent: string;
  /** The plan set name (directory under plans/) */
  planSetName: string;
  /** The architecture.md content */
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
 * Run the architecture reviewer agent as a one-shot query.
 *
 * Reviews the architecture.md document against the PRD for module boundary
 * soundness, integration contract completeness, shared file registry clarity,
 * data model feasibility, and PRD alignment. Leaves any fixes unstaged for
 * the architecture evaluator to accept/reject.
 *
 * Yields:
 * - `plan:architecture:review:start` at the beginning
 * - `agent:message`, `agent:tool_use`, `agent:tool_result` events (when verbose)
 * - `plan:architecture:review:complete` with parsed ReviewIssue[] at the end
 */
export async function* runArchitectureReview(
  options: ArchitectureReviewerOptions,
): AsyncGenerator<EforgeEvent> {
  const { backend, sourceContent, planSetName, architectureContent, cwd, verbose, abortController } = options;

  yield { timestamp: new Date().toISOString(), type: 'plan:architecture:review:start' };

  const prompt = await loadPrompt('architecture-reviewer', {
    source_content: sourceContent,
    plan_set_name: planSetName,
    architecture_content: architectureContent,
    outputDir: options.outputDir ?? 'eforge/plans',
    review_issue_schema: getPlanReviewIssueSchemaYaml(),
  });

  let fullText = '';

  for await (const event of backend.run(
    { prompt, cwd, maxTurns: 30, tools: 'coding', abortSignal: abortController?.signal, ...pickSdkOptions(options) },
    'architecture-reviewer',
  )) {
    if (isAlwaysYieldedAgentEvent(event) || verbose) {
      yield event;
    }
    if (event.type === 'agent:message' && event.content) {
      fullText += event.content;
    }
  }

  const issues = parseReviewIssues(fullText);

  yield { timestamp: new Date().toISOString(), type: 'plan:architecture:review:complete', issues };
}
