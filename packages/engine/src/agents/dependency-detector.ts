import type { AgentBackend, SdkPassthroughConfig } from '../backend.js';
import { pickSdkOptions } from '../backend.js';
import { isAlwaysYieldedAgentEvent, type EforgeEvent } from '../events.js';
import { loadPrompt } from '../prompts.js';

/**
 * Summary of a queued PRD for dependency detection context.
 */
export interface QueueItemSummary {
  id: string;
  title: string;
  scopeSummary: string;
}

/**
 * Summary of a running build for dependency detection context.
 */
export interface RunningBuildSummary {
  planSetName: string;
  planTitles: string[];
}

/**
 * Options for the dependency detector agent.
 */
export interface DependencyDetectorOptions extends SdkPassthroughConfig {
  /** Backend for running the agent */
  backend: AgentBackend;
  /** The new PRD content to analyze */
  prdContent: string;
  /** Existing queue items */
  queueItems: QueueItemSummary[];
  /** Currently running builds */
  runningBuilds: RunningBuildSummary[];
  /** Whether to emit verbose agent-level events */
  verbose?: boolean;
  /** AbortController for cancellation */
  abortController?: AbortController;
}

/**
 * Result from the dependency detector agent.
 */
export interface DependencyDetectorResult {
  /** PRD ids that the new PRD should depend on */
  dependsOn: string[];
}

/**
 * Run the dependency detector agent as a one-shot, toolless query.
 *
 * Analyzes a new PRD against existing queue items and running builds
 * to produce a `depends_on` JSON array. Follows the formatter pattern:
 * maxTurns: 1, tools: 'none', parses JSON output.
 *
 * Yields:
 * - `agent:message`, `agent:tool_use`, `agent:tool_result` events (when verbose)
 * - `agent:start`, `agent:stop`, `agent:result` (always)
 *
 * Returns the depends_on array via parsed JSON output.
 */
export async function* runDependencyDetector(
  options: DependencyDetectorOptions,
): AsyncGenerator<EforgeEvent, DependencyDetectorResult> {
  const { backend, prdContent, queueItems, runningBuilds, verbose, abortController } = options;

  const prompt = await loadPrompt('dependency-detector', {
    prdContent,
    queueItems: JSON.stringify(queueItems, null, 2),
    runningBuilds: JSON.stringify(runningBuilds, null, 2),
  });

  let fullText = '';

  for await (const event of backend.run(
    { prompt, cwd: process.cwd(), maxTurns: 1, tools: 'none', abortSignal: abortController?.signal, ...pickSdkOptions(options) },
    'dependency-detector',
  )) {
    if (isAlwaysYieldedAgentEvent(event) || verbose) {
      yield event;
    }
    if (event.type === 'agent:message' && event.content) {
      fullText += event.content;
    }
  }

  // Parse JSON array from output - extract JSON from potential markdown fences
  const jsonMatch = fullText.match(/\[[\s\S]*?\]/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
        return { dependsOn: parsed };
      }
    } catch {
      // Fall through to empty result
    }
  }

  return { dependsOn: [] };
}
