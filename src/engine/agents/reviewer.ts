import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ForgeEvent, ReviewIssue } from '../events.js';
import { loadPrompt } from '../prompts.js';
import { mapSDKMessages } from './common.js';

/**
 * Options for the reviewer agent.
 */
export interface ReviewerOptions {
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
}

/**
 * Compose the reviewer prompt by loading the template and substituting variables.
 */
export async function composeReviewPrompt(
  planContent: string,
  baseBranch: string,
): Promise<string> {
  return loadPrompt('reviewer', {
    plan_content: planContent,
    base_branch: baseBranch,
  });
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
 * Run the reviewer agent as a one-shot SDK query.
 *
 * Yields:
 * - `build:review:start` at the beginning
 * - `agent:message`, `agent:tool_use`, `agent:tool_result` events (when verbose)
 * - `build:review:complete` with parsed ReviewIssue[] at the end
 */
export async function* runReview(
  options: ReviewerOptions,
): AsyncGenerator<ForgeEvent> {
  const { planContent, baseBranch, planId, cwd, verbose } = options;

  yield { type: 'build:review:start', planId };

  const prompt = await composeReviewPrompt(planContent, baseBranch);

  let fullText = '';

  const q = query({
    prompt,
    options: {
      cwd,
      maxTurns: 30,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    },
  });

  for await (const msg of q) {
    if (verbose) {
      for await (const event of mapSDKMessages(asAsyncIterable(msg), 'reviewer', planId)) {
        yield event;
      }
    }

    // Collect final text from result message for issue parsing (both modes)
    if (msg.type === 'result') {
      const resultMsg = msg as SDKResultMessage;
      if (resultMsg.subtype === 'success') {
        fullText += resultMsg.result;
      }
    }
  }

  const issues = parseReviewIssues(fullText);

  yield { type: 'build:review:complete', planId, issues };
}

/**
 * Wrap a single value in an async iterable for mapSDKMessages compatibility.
 */
async function* asAsyncIterable<T>(value: T): AsyncGenerator<T> {
  yield value;
}
