import type { AgentBackend, SdkPassthroughConfig } from '../backend.js';
import { pickSdkOptions } from '../backend.js';
import { isAlwaysYieldedAgentEvent, type EforgeEvent } from '../events.js';
import { loadPrompt } from '../prompts.js';

/**
 * Options for the formatter agent.
 */
export interface FormatterOptions extends SdkPassthroughConfig {
  /** Backend for running the agent */
  backend: AgentBackend;
  /** The raw source content to format */
  sourceContent: string;
  /** Whether to emit verbose agent-level events */
  verbose?: boolean;
  /** AbortController for cancellation */
  abortController?: AbortController;
}

/**
 * Result from the formatter agent - the formatted PRD body.
 */
export interface FormatterResult {
  /** The formatted PRD content */
  body: string;
}

/**
 * Run the formatter agent as a one-shot, toolless query.
 *
 * Takes raw input content and reformats it into standard PRD sections.
 * The agent has no tools - it only reformats text.
 *
 * Yields:
 * - `agent:message`, `agent:tool_use`, `agent:tool_result` events (when verbose)
 * - `agent:start`, `agent:stop`, `agent:result` (always)
 *
 * Returns the formatted body via the last yielded event's accumulated text.
 */
export async function* runFormatter(
  options: FormatterOptions,
): AsyncGenerator<EforgeEvent, FormatterResult> {
  const { backend, sourceContent, verbose, abortController } = options;

  const prompt = await loadPrompt('formatter', {
    source: sourceContent,
  });

  let fullText = '';

  for await (const event of backend.run(
    { prompt, cwd: process.cwd(), maxTurns: 1, tools: 'none', abortSignal: abortController?.signal, ...pickSdkOptions(options) },
    'formatter',
  )) {
    // Always yield agent:result, agent:tool_use, agent:tool_result; gate agent:message on verbose
    if (isAlwaysYieldedAgentEvent(event) || verbose) {
      yield event;
    }
    if (event.type === 'agent:message' && event.content) {
      fullText += event.content;
    }
  }

  return { body: fullText };
}
