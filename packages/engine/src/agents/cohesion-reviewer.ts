import type { AgentHarness, SdkPassthroughConfig, CustomTool } from '../harness.js';
import { pickSdkOptions } from '../harness.js';
import { isAlwaysYieldedAgentEvent, type EforgeEvent } from '../events.js';
import { loadPrompt } from '../prompts.js';
import { parseReviewIssues } from './reviewer.js';
import {
  getPlanReviewIssueSchemaYaml,
  getCohesionReviewSubmissionSchemaYaml,
  cohesionReviewSubmissionSchema,
  type CohesionReviewSubmission,
} from '../schemas.js';
import { applyCohesionReviewFixes } from '../plan.js';
import { formatSubmissionValidationError } from './planner.js';

/**
 * Options for the cohesion reviewer agent.
 */
export interface CohesionReviewerOptions extends SdkPassthroughConfig {
  /** Harness for running the agent */
  harness: AgentHarness;
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
 * Create a custom tool for submitting cohesion-reviewer fixes.
 * The handler validates the payload against the schema and captures it via the callback.
 */
function createCohesionReviewSubmissionTool(
  onSubmit: (payload: CohesionReviewSubmission) => boolean,
): CustomTool {
  return {
    name: 'submit_cohesion_review_fixes',
    description: 'Submit fixes for module plan artifacts. Use this tool to apply all fixes you identified during cohesion review. Pass an empty fixes array if no fixes are needed.',
    inputSchema: cohesionReviewSubmissionSchema,
    handler: async (input: unknown) => {
      const result = cohesionReviewSubmissionSchema.safeParse(input);
      if (!result.success) {
        return formatSubmissionValidationError(result.error.issues);
      }
      if (!onSubmit(result.data)) {
        return 'Error: a submission tool was already called. Only one submission per review turn is allowed.';
      }
      return 'Cohesion review fixes submitted successfully.';
    },
  };
}

/**
 * Run the cohesion reviewer agent as a one-shot query.
 *
 * Reviews all plan files in the plan set for cross-module cohesion:
 * file overlaps, integration contracts, dependency validation, and
 * vague verification criteria. Submits any fixes through the structured
 * submission tool (Write/Edit/NotebookEdit are disallowed) so all writes
 * go through stringifyYaml.
 *
 * Yields:
 * - `planning:cohesion:start` at the beginning
 * - `agent:message`, `agent:tool_use`, `agent:tool_result` events (when verbose)
 * - `planning:cohesion:complete` with parsed ReviewIssue[] at the end
 */
export async function* runCohesionReview(
  options: CohesionReviewerOptions,
): AsyncGenerator<EforgeEvent> {
  const { harness, sourceContent, planSetName, architectureContent, cwd, verbose, abortController } = options;

  yield { timestamp: new Date().toISOString(), type: 'planning:cohesion:start' };

  const outputDir = options.outputDir ?? 'eforge/plans';

  // Mutable container for submission payload — set by custom tool handler via closure
  let captured: CohesionReviewSubmission | null = null;

  const submissionTool = createCohesionReviewSubmissionTool((payload) => {
    if (captured !== null) return false;
    captured = payload;
    return true;
  });

  const customTools: CustomTool[] = [submissionTool];
  const submitTool = harness.effectiveCustomToolName(submissionTool.name);

  const prompt = await loadPrompt('cohesion-reviewer', {
    source_content: sourceContent,
    plan_set_name: planSetName,
    architecture_content: architectureContent,
    outputDir,
    review_issue_schema: getPlanReviewIssueSchemaYaml(),
    submitTool,
    submission_schema: getCohesionReviewSubmissionSchemaYaml(),
  }, options.promptAppend);

  let fullText = '';

  for await (const event of harness.run(
    {
      prompt,
      cwd,
      maxTurns: 30,
      tools: 'coding',
      abortSignal: abortController?.signal,
      customTools,
      disallowedTools: ['Write', 'Edit', 'NotebookEdit'],
      ...pickSdkOptions(options),
    },
    'cohesion-reviewer',
  )) {
    if (isAlwaysYieldedAgentEvent(event) || verbose) {
      yield event;
    }
    if (event.type === 'agent:message' && event.content) {
      fullText += event.content;
    }
  }

  // Apply any captured fixes before parsing issues
  if (captured !== null) {
    await applyCohesionReviewFixes({ cwd, outputDir, planSetName, fixes: (captured as CohesionReviewSubmission).fixes });
  }

  const issues = parseReviewIssues(fullText);

  yield { timestamp: new Date().toISOString(), type: 'planning:cohesion:complete', issues };
}
