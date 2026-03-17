import type { AgentBackend } from '../backend.js';
import { isAlwaysYieldedAgentEvent, type EforgeEvent } from '../events.js';
import { loadPrompt } from '../prompts.js';

export interface DocUpdaterOptions {
  backend: AgentBackend;
  cwd: string;
  planId: string;
  planContent: string;
  verbose?: boolean;
  abortController?: AbortController;
  maxTurns?: number;
}

/**
 * Parse `<doc-update-summary count="N">` from agent output.
 * Returns the count of docs updated, or 0 if no summary block is found.
 */
function parseDocUpdateSummary(text: string): number {
  const match = text.match(/<doc-update-summary\s+count="(\d+)">/);
  if (!match) return 0;
  return parseInt(match[1], 10);
}

/**
 * Doc-updater agent — updates existing documentation based on plan content.
 * One-shot coding agent that discovers and updates docs affected by the plan.
 * Non-fatal: errors are caught (except AbortError), complete event always yielded.
 */
export async function* runDocUpdater(
  options: DocUpdaterOptions,
): AsyncGenerator<EforgeEvent> {
  yield { type: 'build:doc-update:start', planId: options.planId };

  let docsUpdated = 0;

  try {
    const prompt = await loadPrompt('doc-updater', {
      plan_id: options.planId,
      plan_content: options.planContent,
    });

    let fullText = '';

    for await (const event of options.backend.run(
      {
        prompt,
        cwd: options.cwd,
        maxTurns: options.maxTurns ?? 20,
        tools: 'coding',
        abortSignal: options.abortController?.signal,
      },
      'doc-updater',
      options.planId,
    )) {
      if (event.type === 'agent:message' && event.content) {
        fullText += event.content;
      }

      if (isAlwaysYieldedAgentEvent(event) || options.verbose) {
        yield event;
      }
    }

    docsUpdated = parseDocUpdateSummary(fullText);
  } catch (err) {
    // Re-throw abort errors so the pipeline can respect cancellation
    if (err instanceof Error && err.name === 'AbortError') throw err;
    // Other doc-updater failures are non-fatal
  }

  yield { type: 'build:doc-update:complete', planId: options.planId, docsUpdated };
}
