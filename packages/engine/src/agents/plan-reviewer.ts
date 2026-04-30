import type { AgentHarness, SdkPassthroughConfig, CustomTool } from '../harness.js';
import { pickSdkOptions } from '../harness.js';
import { isAlwaysYieldedAgentEvent, type EforgeEvent } from '../events.js';
import { loadPrompt } from '../prompts.js';
import { parseReviewIssues } from './reviewer.js';
import {
  getPlanReviewIssueSchemaYaml,
  getPlanReviewSubmissionSchemaYaml,
  planReviewSubmissionSchema,
  type PlanReviewSubmission,
} from '../schemas.js';
import { applyPlanReviewFixes } from '../plan.js';
import { formatSubmissionValidationError } from './planner.js';

/**
 * Options for the plan reviewer agent.
 */
export interface PlanReviewerOptions extends SdkPassthroughConfig {
  /** Harness for running the agent */
  harness: AgentHarness;
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
 * Create a custom tool for submitting plan-reviewer fixes.
 * The handler validates the payload against the schema and captures it via the callback.
 */
function createPlanReviewSubmissionTool(
  onSubmit: (payload: PlanReviewSubmission) => boolean,
): CustomTool {
  return {
    name: 'submit_plan_review_fixes',
    description: 'Submit fixes for plan artifacts. Use this tool to apply all fixes you identified during review. Pass an empty fixes array if no fixes are needed.',
    inputSchema: planReviewSubmissionSchema,
    handler: async (input: unknown) => {
      const result = planReviewSubmissionSchema.safeParse(input);
      if (!result.success) {
        return formatSubmissionValidationError(result.error.issues);
      }
      if (!onSubmit(result.data)) {
        return 'Error: a submission tool was already called. Only one submission per review turn is allowed.';
      }
      return 'Plan review fixes submitted successfully.';
    },
  };
}

/**
 * Run the plan reviewer agent as a one-shot query.
 *
 * Reviews all plan files in the plan set for cohesion, completeness,
 * correctness, feasibility, dependency ordering, and scope. Submits
 * any fixes through the structured submission tool (Write/Edit/NotebookEdit
 * are disallowed) so all writes go through stringifyYaml.
 *
 * Yields:
 * - `planning:review:start` at the beginning
 * - `agent:message`, `agent:tool_use`, `agent:tool_result` events (when verbose)
 * - `planning:review:complete` with parsed ReviewIssue[] at the end
 */
export async function* runPlanReview(
  options: PlanReviewerOptions,
): AsyncGenerator<EforgeEvent> {
  const { harness, sourceContent, planSetName, cwd, verbose, abortController } = options;

  yield { timestamp: new Date().toISOString(), type: 'planning:review:start' };

  const outputDir = options.outputDir ?? 'eforge/plans';

  // Mutable container for submission payload — set by custom tool handler via closure
  let captured: PlanReviewSubmission | null = null;

  const submissionTool = createPlanReviewSubmissionTool((payload) => {
    if (captured !== null) return false;
    captured = payload;
    return true;
  });

  const customTools: CustomTool[] = [submissionTool];
  const submitTool = harness.effectiveCustomToolName(submissionTool.name);

  const prompt = await loadPrompt('plan-reviewer', {
    source_content: sourceContent,
    plan_set_name: planSetName,
    outputDir,
    review_issue_schema: getPlanReviewIssueSchemaYaml(),
    submitTool,
    submission_schema: getPlanReviewSubmissionSchemaYaml(),
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
    'plan-reviewer',
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
    await applyPlanReviewFixes({ cwd, outputDir, planSetName, fixes: (captured as PlanReviewSubmission).fixes });
  }

  const issues = parseReviewIssues(fullText);

  yield { timestamp: new Date().toISOString(), type: 'planning:review:complete', issues };
}
