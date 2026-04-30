import type { AgentHarness, SdkPassthroughConfig, CustomTool } from '../harness.js';
import { pickSdkOptions } from '../harness.js';
import { isAlwaysYieldedAgentEvent, type EforgeEvent } from '../events.js';
import { loadPrompt } from '../prompts.js';
import { parseReviewIssues } from './reviewer.js';
import {
  getPlanReviewIssueSchemaYaml,
  getArchitectureReviewSubmissionSchemaYaml,
  architectureReviewSubmissionSchema,
  type ArchitectureReviewSubmission,
} from '../schemas.js';
import { applyArchitectureReviewFixes } from '../plan.js';
import { formatSubmissionValidationError } from './planner.js';

/**
 * Options for the architecture reviewer agent.
 */
export interface ArchitectureReviewerOptions extends SdkPassthroughConfig {
  /** Harness for running the agent */
  harness: AgentHarness;
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
 * Create a custom tool for submitting architecture-reviewer fixes.
 * The handler validates the payload against the schema and captures it via the callback.
 */
function createArchitectureReviewSubmissionTool(
  onSubmit: (payload: ArchitectureReviewSubmission) => boolean,
): CustomTool {
  return {
    name: 'submit_architecture_review_fixes',
    description: 'Submit fixes for the architecture document. Use this tool to apply all fixes you identified during architecture review. Pass an empty fixes array if no fixes are needed.',
    inputSchema: architectureReviewSubmissionSchema,
    handler: async (input: unknown) => {
      const result = architectureReviewSubmissionSchema.safeParse(input);
      if (!result.success) {
        return formatSubmissionValidationError(result.error.issues);
      }
      if (!onSubmit(result.data)) {
        return 'Error: a submission tool was already called. Only one submission per review turn is allowed.';
      }
      return 'Architecture review fixes submitted successfully.';
    },
  };
}

/**
 * Run the architecture reviewer agent as a one-shot query.
 *
 * Reviews the architecture.md document against the PRD for module boundary
 * soundness, integration contract completeness, shared file registry clarity,
 * data model feasibility, and PRD alignment. Submits any fixes through the
 * structured submission tool (Write/Edit/NotebookEdit are disallowed) so all
 * writes go through stringifyYaml.
 *
 * Yields:
 * - `planning:architecture:review:start` at the beginning
 * - `agent:message`, `agent:tool_use`, `agent:tool_result` events (when verbose)
 * - `planning:architecture:review:complete` with parsed ReviewIssue[] at the end
 */
export async function* runArchitectureReview(
  options: ArchitectureReviewerOptions,
): AsyncGenerator<EforgeEvent> {
  const { harness, sourceContent, planSetName, architectureContent, cwd, verbose, abortController } = options;

  yield { timestamp: new Date().toISOString(), type: 'planning:architecture:review:start' };

  const outputDir = options.outputDir ?? 'eforge/plans';

  // Mutable container for submission payload — set by custom tool handler via closure
  let captured: ArchitectureReviewSubmission | null = null;

  const submissionTool = createArchitectureReviewSubmissionTool((payload) => {
    if (captured !== null) return false;
    captured = payload;
    return true;
  });

  const customTools: CustomTool[] = [submissionTool];
  const submitTool = harness.effectiveCustomToolName(submissionTool.name);

  const prompt = await loadPrompt('architecture-reviewer', {
    source_content: sourceContent,
    plan_set_name: planSetName,
    architecture_content: architectureContent,
    outputDir,
    review_issue_schema: getPlanReviewIssueSchemaYaml(),
    submitTool,
    submission_schema: getArchitectureReviewSubmissionSchemaYaml(),
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
    'architecture-reviewer',
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
    await applyArchitectureReviewFixes({ cwd, outputDir, planSetName, fixes: (captured as ArchitectureReviewSubmission).fixes });
  }

  const issues = parseReviewIssues(fullText);

  yield { timestamp: new Date().toISOString(), type: 'planning:architecture:review:complete', issues };
}
