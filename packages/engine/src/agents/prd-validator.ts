import type { AgentBackend, SdkPassthroughConfig } from '../backend.js';
import { pickSdkOptions } from '../backend.js';
import { isAlwaysYieldedAgentEvent, type EforgeEvent, type PrdValidationGap } from '../events.js';
import { loadPrompt } from '../prompts.js';

export interface PrdValidatorOptions extends SdkPassthroughConfig {
  backend: AgentBackend;
  cwd: string;
  prdContent: string;
  diff: string;
  verbose?: boolean;
  abortController?: AbortController;
}

/**
 * PRD validator agent — compares original PRD requirements against the full
 * worktree diff and reports substantive gaps.
 */
export async function* runPrdValidator(
  options: PrdValidatorOptions,
): AsyncGenerator<EforgeEvent> {
  yield { timestamp: new Date().toISOString(), type: 'prd_validation:start' };

  const prompt = await loadPrompt('prd-validator', {
    prd: options.prdContent,
    diff: options.diff,
  });

  let gaps: PrdValidationGap[] = [];
  let completionPercent: number | undefined;

  try {
    let accumulatedText = '';

    for await (const event of options.backend.run(
      {
        prompt,
        cwd: options.cwd,
        maxTurns: 15,
        tools: 'coding',
        abortSignal: options.abortController?.signal,
        ...pickSdkOptions(options),
      },
      'prd-validator',
    )) {
      if (isAlwaysYieldedAgentEvent(event) || options.verbose) {
        yield event;
      }

      // Accumulate text from agent messages
      if (event.type === 'agent:message' && 'content' in event) {
        accumulatedText += event.content;
      }
    }

    // Parse structured JSON output from accumulated text
    const parsed = parseGaps(accumulatedText);
    gaps = parsed.gaps;
    completionPercent = parsed.completionPercent;
  } catch (err) {
    // Re-throw abort errors so the orchestrator can respect cancellation
    if (err instanceof Error && err.name === 'AbortError') throw err;
    // Agent errors are non-fatal — the build continues
  }

  const passed = gaps.length === 0;
  yield { timestamp: new Date().toISOString(), type: 'prd_validation:complete', passed, gaps, completionPercent };
}

const VALID_COMPLEXITIES = new Set(['trivial', 'moderate', 'significant']);

/**
 * Parse gap analysis JSON from agent output.
 * Looks for a JSON block containing { "gaps": [...] } and optional completionPercent.
 */
export function parseGaps(text: string): { gaps: PrdValidationGap[]; completionPercent: number | undefined } {
  // Try to find a JSON block (fenced or raw)
  const jsonMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/) ?? text.match(/(\{[\s\S]*"gaps"[\s\S]*\})/);
  if (!jsonMatch) return { gaps: [], completionPercent: undefined };

  try {
    const parsed = JSON.parse(jsonMatch[1]);
    const completionPercent = typeof parsed.completionPercent === 'number' ? parsed.completionPercent : undefined;

    if (Array.isArray(parsed.gaps)) {
      const gaps = parsed.gaps
        .filter((g: unknown): g is { requirement: string; explanation: string; complexity?: string } =>
          typeof g === 'object' && g !== null &&
          typeof (g as Record<string, unknown>).requirement === 'string' &&
          typeof (g as Record<string, unknown>).explanation === 'string',
        )
        .map((g: { requirement: string; explanation: string; complexity?: string }) => {
          const gap: PrdValidationGap = {
            requirement: g.requirement,
            explanation: g.explanation,
          };
          if (typeof g.complexity === 'string' && VALID_COMPLEXITIES.has(g.complexity)) {
            gap.complexity = g.complexity as PrdValidationGap['complexity'];
          }
          return gap;
        });
      return { gaps, completionPercent };
    }

    return { gaps: [], completionPercent };
  } catch {
    // JSON parse failure — treat as no gaps
  }

  return { gaps: [], completionPercent: undefined };
}
