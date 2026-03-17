import type { AgentBackend } from '../backend.js';
import { isAlwaysYieldedAgentEvent, type EforgeEvent, type PlanFile } from '../events.js';
import { loadPrompt } from '../prompts.js';

/**
 * Options for builder agent functions.
 */
export interface BuilderOptions {
  /** Backend for running the agent */
  backend: AgentBackend;
  /** Working directory (typically a worktree path) */
  cwd: string;
  /** Stream verbose agent-level events */
  verbose?: boolean;
  /** AbortController for cancellation */
  abortController?: AbortController;
  /** Override max conversation turns (defaults: implement=50, evaluate=30) */
  maxTurns?: number;
  /** Evaluator strictness level — controls the accept/reject threshold text injected into the prompt */
  strictness?: 'strict' | 'standard' | 'lenient';
}

/**
 * Strictness text blocks injected into the evaluator prompt via {{strictness}}.
 * Exported for testability.
 */
export const STRICTNESS_BLOCKS: Record<string, string> = {
  strict: `\n### Strictness: Strict\n\nApply a high bar for acceptance. Only accept fixes that are unambiguously correct — fixing a clear bug, crash, or security vulnerability. When in doubt, reject. Treat "review" verdicts as rejects.\n`,
  standard: '',
  lenient: `\n### Strictness: Lenient\n\nApply a low bar for acceptance. Accept fixes unless they clearly damage the implementation's intent or remove functionality. When in doubt, accept. Treat "review" verdicts as accepts.\n`,
};

/**
 * Structured evidence extracted from evaluation verdict child elements.
 * Present when the evaluator uses the structured format with `<staged>`/`<original>`,
 * `<fix>`, `<rationale>`, `<if-accepted>`, and `<if-rejected>` child elements.
 */
export interface EvaluationEvidence {
  /** What the staged/original code does (from `<staged>` or `<original>` tag) */
  staged: string;
  /** What the reviewer's fix does */
  fix: string;
  /** Why the verdict was chosen */
  rationale: string;
  /** Consequence if the fix is accepted */
  ifAccepted: string;
  /** Consequence if the fix is rejected */
  ifRejected: string;
}

/**
 * A single evaluation verdict from the evaluator's XML output.
 */
export interface EvaluationVerdict {
  file: string;
  action: 'accept' | 'reject' | 'review';
  reason: string;
  /** Structured evidence when the evaluator uses child elements */
  evidence?: EvaluationEvidence;
  /** Hunk number for per-hunk evaluation (1-indexed) */
  hunk?: number;
}

/**
 * Turn 1: Implement a plan. The agent reads the plan, implements it,
 * runs verification, and commits all changes in a single commit.
 */
export async function* builderImplement(
  plan: PlanFile,
  options: BuilderOptions,
): AsyncGenerator<EforgeEvent> {
  yield { type: 'build:implement:start', planId: plan.id };

  const prompt = await loadPrompt('builder', {
    plan_id: plan.id,
    plan_name: plan.name,
    plan_content: plan.body,
    plan_branch: plan.branch,
  });

  try {
    for await (const event of options.backend.run(
      { prompt, cwd: options.cwd, maxTurns: options.maxTurns ?? 50, tools: 'coding', abortSignal: options.abortController?.signal },
      'builder',
      plan.id,
    )) {
      if (isAlwaysYieldedAgentEvent(event) || options.verbose) {
        yield event;
      }
    }
  } catch (err) {
    yield { type: 'build:failed', planId: plan.id, error: (err as Error).message };
    return;
  }

  yield { type: 'build:implement:progress', planId: plan.id, message: 'Implementation complete' };
  yield { type: 'build:implement:complete', planId: plan.id };
}

/**
 * Turn 2: Evaluate reviewer's unstaged fixes. The agent runs
 * `git reset --soft HEAD~1`, inspects staged (implementation) vs unstaged
 * (reviewer fixes), applies verdicts, and commits the final result.
 */
export async function* builderEvaluate(
  plan: PlanFile,
  options: BuilderOptions,
): AsyncGenerator<EforgeEvent> {
  yield { type: 'build:evaluate:start', planId: plan.id };

  const strictnessKey = options.strictness ?? 'standard';
  const prompt = await loadPrompt('evaluator', {
    plan_id: plan.id,
    plan_name: plan.name,
    strictness: STRICTNESS_BLOCKS[strictnessKey] ?? '',
  });

  let fullText = '';
  try {
    for await (const event of options.backend.run(
      { prompt, cwd: options.cwd, maxTurns: options.maxTurns ?? 30, tools: 'coding', abortSignal: options.abortController?.signal },
      'evaluator',
      plan.id,
    )) {
      if (isAlwaysYieldedAgentEvent(event) || options.verbose) {
        yield event;
      }
      if (event.type === 'agent:message' && event.content) {
        fullText += event.content;
      }
    }
  } catch (err) {
    yield { type: 'build:failed', planId: plan.id, error: (err as Error).message };
    return;
  }

  const verdicts = parseEvaluationBlock(fullText);
  const accepted = verdicts.filter((v) => v.action === 'accept').length;
  const rejected = verdicts.filter((v) => v.action === 'reject' || v.action === 'review').length;

  yield { type: 'build:evaluate:complete', planId: plan.id, accepted, rejected };
}

/**
 * Extract text content of a child element from XML content.
 * Returns undefined if the element is not found.
 */
function extractChildElement(content: string, tagName: string): string | undefined {
  const regex = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`);
  const match = content.match(regex);
  return match ? match[1].trim() : undefined;
}

/**
 * Parse `<evaluation>` XML blocks from agent output into structured verdicts.
 * Returns an empty array if no evaluation block is found or XML is malformed.
 *
 * Supports two formats:
 *
 * Plain text (backwards compatible):
 * ```xml
 * <evaluation>
 *   <verdict file="path/to/file.ts" action="accept">Reason text</verdict>
 * </evaluation>
 * ```
 *
 * Structured evidence:
 * ```xml
 * <evaluation>
 *   <verdict file="path/to/file.ts" action="accept" hunk="2">
 *     <staged>What the staged code does</staged>
 *     <fix>What the fix does</fix>
 *     <rationale>Why this verdict</rationale>
 *     <if-accepted>Consequence if accepted</if-accepted>
 *     <if-rejected>Consequence if rejected</if-rejected>
 *   </verdict>
 * </evaluation>
 * ```
 *
 * The plan-evaluator uses `<original>` instead of `<staged>` — both are supported.
 */
export function parseEvaluationBlock(text: string): EvaluationVerdict[] {
  const verdicts: EvaluationVerdict[] = [];

  const blockRegex = /<evaluation>([\s\S]*?)<\/evaluation>/g;
  let blockMatch: RegExpExecArray | null;

  while ((blockMatch = blockRegex.exec(text)) !== null) {
    const blockContent = blockMatch[1];
    const verdictRegex = /<verdict\s+([^>]*)>([\s\S]*?)<\/verdict>/g;
    let verdictMatch: RegExpExecArray | null;

    while ((verdictMatch = verdictRegex.exec(blockContent)) !== null) {
      const attrs = verdictMatch[1];
      const innerContent = verdictMatch[2];

      const fileMatch = attrs.match(/file="([^"]+)"/);
      const actionMatch = attrs.match(/action="([^"]+)"/);

      if (!fileMatch || !actionMatch) continue;

      const action = actionMatch[1];
      if (action !== 'accept' && action !== 'reject' && action !== 'review') continue;

      // Extract optional hunk attribute
      const hunkMatch = attrs.match(/hunk="(\d+)"/);
      const hunk = hunkMatch ? parseInt(hunkMatch[1], 10) : undefined;

      // Try to extract structured evidence child elements
      const staged = extractChildElement(innerContent, 'staged') ?? extractChildElement(innerContent, 'original');
      const fix = extractChildElement(innerContent, 'fix');
      const rationale = extractChildElement(innerContent, 'rationale');
      const ifAccepted = extractChildElement(innerContent, 'if-accepted');
      const ifRejected = extractChildElement(innerContent, 'if-rejected');

      // Build evidence if structured elements are present
      let evidence: EvaluationEvidence | undefined;
      if (staged && fix && rationale && ifAccepted && ifRejected) {
        evidence = { staged, fix, rationale, ifAccepted, ifRejected };
      }

      // For reason: if structured elements are present, strip them out and use remaining text;
      // otherwise use the full inner content as plain text reason
      let reason: string;
      if (evidence) {
        reason = innerContent
          .replace(/<staged>[\s\S]*?<\/staged>/g, '')
          .replace(/<original>[\s\S]*?<\/original>/g, '')
          .replace(/<fix>[\s\S]*?<\/fix>/g, '')
          .replace(/<rationale>[\s\S]*?<\/rationale>/g, '')
          .replace(/<if-accepted>[\s\S]*?<\/if-accepted>/g, '')
          .replace(/<if-rejected>[\s\S]*?<\/if-rejected>/g, '')
          .trim();
        // If no remaining text after stripping, use rationale as reason
        if (!reason) {
          reason = rationale!;
        }
      } else {
        reason = innerContent.trim();
      }

      verdicts.push({
        file: fileMatch[1],
        action,
        reason,
        ...(evidence && { evidence }),
        ...(hunk !== undefined && { hunk }),
      });
    }
  }

  return verdicts;
}
