import { query } from '@anthropic-ai/claude-agent-sdk';
import type { ForgeEvent, PlanFile } from '../events.js';
import { loadPrompt } from '../prompts.js';
import { mapSDKMessages } from './common.js';

/**
 * Options for builder agent functions.
 */
export interface BuilderOptions {
  /** Working directory (typically a worktree path) */
  cwd: string;
  /** Stream verbose agent-level events */
  verbose?: boolean;
  /** AbortController for cancellation */
  abortController?: AbortController;
}

/**
 * A single evaluation verdict from the evaluator's XML output.
 */
export interface EvaluationVerdict {
  file: string;
  action: 'accept' | 'reject' | 'review';
  reason: string;
}

/**
 * Turn 1: Implement a plan. The SDK agent reads the plan, implements it,
 * runs verification, and commits all changes in a single commit.
 */
export async function* builderImplement(
  plan: PlanFile,
  options: BuilderOptions,
): AsyncGenerator<ForgeEvent> {
  yield { type: 'build:implement:start', planId: plan.id };

  const prompt = await loadPrompt('builder', {
    plan_id: plan.id,
    plan_name: plan.name,
    plan_content: plan.body,
    plan_branch: plan.branch,
  });

  const q = query({
    prompt,
    options: {
      cwd: options.cwd,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxTurns: 50,
      abortController: options.abortController,
    },
  });

  try {
    for await (const event of mapSDKMessages(q, 'builder', plan.id)) {
      if (options.verbose) {
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
 * Turn 2: Evaluate reviewer's unstaged fixes. The SDK agent runs
 * `git reset --soft HEAD~1`, inspects staged (implementation) vs unstaged
 * (reviewer fixes), applies verdicts, and commits the final result.
 */
export async function* builderEvaluate(
  plan: PlanFile,
  options: BuilderOptions,
): AsyncGenerator<ForgeEvent> {
  yield { type: 'build:evaluate:start', planId: plan.id };

  const prompt = await loadPrompt('evaluator', {
    plan_id: plan.id,
    plan_name: plan.name,
  });

  const q = query({
    prompt,
    options: {
      cwd: options.cwd,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxTurns: 30,
      abortController: options.abortController,
    },
  });

  let fullText = '';
  try {
    for await (const event of mapSDKMessages(q, 'evaluator', plan.id)) {
      if (options.verbose) {
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
 * Parse `<evaluation>` XML blocks from agent output into structured verdicts.
 * Returns an empty array if no evaluation block is found or XML is malformed.
 *
 * Expected format:
 * ```xml
 * <evaluation>
 *   <verdict file="path/to/file.ts" action="accept">Reason text</verdict>
 *   <verdict file="path/to/file.ts" action="reject">Reason text</verdict>
 * </evaluation>
 * ```
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
      const reason = verdictMatch[2].trim();

      const fileMatch = attrs.match(/file="([^"]+)"/);
      const actionMatch = attrs.match(/action="([^"]+)"/);

      if (!fileMatch || !actionMatch) continue;

      const action = actionMatch[1];
      if (action !== 'accept' && action !== 'reject' && action !== 'review') continue;

      verdicts.push({
        file: fileMatch[1],
        action,
        reason,
      });
    }
  }

  return verdicts;
}
