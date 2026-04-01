import type { AgentBackend, SdkPassthroughConfig } from '../backend.js';
import { pickSdkOptions } from '../backend.js';
import { isAlwaysYieldedAgentEvent, type EforgeEvent, type PrdValidationGap } from '../events.js';
import { loadPrompt } from '../prompts.js';

export interface GapCloserOptions extends SdkPassthroughConfig {
  backend: AgentBackend;
  cwd: string;
  gaps: PrdValidationGap[];
  prdContent: string;
  verbose?: boolean;
  abortController?: AbortController;
}

/**
 * Gap closer agent — attempts to fix PRD validation gaps by making minimal
 * targeted changes. Receives gap descriptions and the original PRD content,
 * explores relevant files, and commits fixes.
 */
export async function* runGapCloser(
  options: GapCloserOptions,
): AsyncGenerator<EforgeEvent> {
  yield { timestamp: new Date().toISOString(), type: 'gap_close:start' };

  const gapsContext = options.gaps
    .map(
      (g) =>
        `Requirement: ${g.requirement}\nGap: ${g.explanation}`,
    )
    .join('\n\n---\n\n');

  const prompt = await loadPrompt('gap-closer', {
    prd: options.prdContent,
    gaps: gapsContext,
  });

  try {
    for await (const event of options.backend.run(
      {
        prompt,
        cwd: options.cwd,
        maxTurns: 30,
        tools: 'coding',
        abortSignal: options.abortController?.signal,
        ...pickSdkOptions(options),
      },
      'gap-closer',
    )) {
      if (isAlwaysYieldedAgentEvent(event) || options.verbose) {
        yield event;
      }
    }
  } catch (err) {
    // Re-throw abort errors so the orchestrator can respect cancellation
    if (err instanceof Error && err.name === 'AbortError') throw err;
    // Other gap closer failures are non-fatal — PRD validation will just fail
  }

  yield { timestamp: new Date().toISOString(), type: 'gap_close:complete' };
}
