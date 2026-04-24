import type { AgentBackend, SdkPassthroughConfig } from '../backend.js';
import { pickSdkOptions } from '../backend.js';
import { isAlwaysYieldedAgentEvent, type EforgeEvent, type ReviewIssue } from '../events.js';
import { loadPrompt } from '../prompts.js';
import { getReviewIssueSchemaYaml } from '../schemas.js';

/**
 * Options for the reviewer agent.
 */
export interface ReviewerOptions extends SdkPassthroughConfig {
  /** Backend for running the agent */
  backend: AgentBackend;
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
}

/**
 * Compose the reviewer prompt by loading the template and substituting variables.
 */
export async function composeReviewPrompt(
  planContent: string,
  baseBranch: string,
  append?: string,
): Promise<string> {
  return loadPrompt('reviewer', {
    plan_content: planContent,
    base_branch: baseBranch,
    review_issue_schema: getReviewIssueSchemaYaml(),
  }, append);
}

/**
 * Parse `<review-issues>` XML blocks from text into structured ReviewIssue[].
 *
 * Handles:
 * - Multiple `<review-issues>` blocks (merges all issues)
 * - Missing optional attributes (line, fix)
 * - Malformed XML (returns empty array, never throws)
 * - No XML present (returns empty array)
 */
export function parseReviewIssues(text: string): ReviewIssue[] {
  const issues: ReviewIssue[] = [];

  try {
    const blockRegex = /<review-issues>([\s\S]*?)<\/review-issues>/g;
    let blockMatch: RegExpExecArray | null;

    while ((blockMatch = blockRegex.exec(text)) !== null) {
      const blockContent = blockMatch[1];
      const issueRegex = /<issue\s+([^>]*)>([\s\S]*?)<\/issue>/g;
      let issueMatch: RegExpExecArray | null;

      while ((issueMatch = issueRegex.exec(blockContent)) !== null) {
        const attrs = issueMatch[1];
        const inner = issueMatch[2];

        const severityMatch = attrs.match(/severity="([^"]+)"/);
        const categoryMatch = attrs.match(/category="([^"]+)"/);
        const fileMatch = attrs.match(/file="([^"]+)"/);
        const lineMatch = attrs.match(/line="([^"]+)"/);

        if (!severityMatch || !categoryMatch || !fileMatch) continue;

        const rawSeverity = severityMatch[1];
        const severity = mapSeverity(rawSeverity);
        if (!severity) continue;

        // Extract optional <fix> element
        const fixMatch = inner.match(/<fix>([\s\S]*?)<\/fix>/);
        const fix = fixMatch ? fixMatch[1].trim() : undefined;

        // Description is inner content with <fix> tags removed
        const description = inner
          .replace(/<fix>[\s\S]*?<\/fix>/g, '')
          .trim();

        if (!description) continue;

        const issue: ReviewIssue = {
          severity,
          category: categoryMatch[1],
          file: fileMatch[1],
          description,
        };

        if (lineMatch) {
          const lineNum = parseInt(lineMatch[1], 10);
          if (!isNaN(lineNum)) {
            issue.line = lineNum;
          }
        }

        if (fix) {
          issue.fix = fix;
        }

        issues.push(issue);
      }
    }
  } catch {
    // Malformed XML — return whatever we've parsed so far
    return issues;
  }

  return issues;
}

/**
 * Map raw severity string to the typed severity union.
 * Returns undefined for unrecognized values.
 */
function mapSeverity(raw: string): ReviewIssue['severity'] | undefined {
  switch (raw) {
    case 'critical':
    case 'warning':
    case 'suggestion':
      return raw;
    default:
      return undefined;
  }
}

/**
 * Run the reviewer agent as a one-shot query.
 *
 * Yields:
 * - `plan:build:review:start` at the beginning
 * - `agent:message`, `agent:tool_use`, `agent:tool_result` events (when verbose)
 * - `plan:build:review:complete` with parsed ReviewIssue[] at the end
 */
export async function* runReview(
  options: ReviewerOptions,
): AsyncGenerator<EforgeEvent> {
  const { backend, planContent, baseBranch, planId, cwd, verbose, abortController } = options;

  yield { timestamp: new Date().toISOString(), type: 'plan:build:review:start', planId };

  const prompt = await composeReviewPrompt(planContent, baseBranch, options.promptAppend);

  let fullText = '';

  for await (const event of backend.run(
    { prompt, cwd, maxTurns: 30, tools: 'coding', abortSignal: abortController?.signal, ...pickSdkOptions(options) },
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

  yield { timestamp: new Date().toISOString(), type: 'plan:build:review:complete', planId, issues };
}
