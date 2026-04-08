import type { AgentBackend, SdkPassthroughConfig } from '../backend.js';
import { pickSdkOptions } from '../backend.js';
import { isAlwaysYieldedAgentEvent, type EforgeEvent } from '../events.js';
import { loadPrompt } from '../prompts.js';
import { getStalenessSchemaYaml } from '../schemas.js';
import { parseStalenessBlock } from './common.js';

/**
 * Options for the staleness assessor agent.
 */
export interface StalenessAssessorOptions extends SdkPassthroughConfig {
  /** Backend for running the agent */
  backend: AgentBackend;
  /** Full PRD file content */
  prdContent: string;
  /** Git diff --stat summary since the PRD was last committed */
  diffSummary: string;
  /** Working directory */
  cwd: string;
  /** Whether to emit verbose agent-level events */
  verbose?: boolean;
  /** AbortController for cancellation */
  abortController?: AbortController;
}

/**
 * Run the staleness assessor agent as a one-shot query.
 *
 * Reads the PRD content, reviews the git diff summary, explores the
 * codebase if needed, and emits a staleness verdict.
 *
 * Yields:
 * - `agent:message`, `agent:tool_use`, `agent:tool_result` events (when verbose)
 * - `agent:result` (always)
 * - `queue:prd:stale` when staleness block found
 */
export async function* runStalenessAssessor(
  options: StalenessAssessorOptions,
): AsyncGenerator<EforgeEvent> {
  const { backend, prdContent, diffSummary, cwd, verbose, abortController } = options;

  const prompt = await loadPrompt('staleness-assessor', {
    prdContent,
    diffSummary,
    cwd,
    staleness_schema: getStalenessSchemaYaml(),
  });

  let fullText = '';

  for await (const event of backend.run(
    { prompt, cwd, maxTurns: 20, tools: 'coding', abortSignal: abortController?.signal, ...pickSdkOptions(options) },
    'staleness-assessor',
  )) {
    // Always yield agent:result, agent:tool_use, agent:tool_result; gate agent:message on verbose
    if (isAlwaysYieldedAgentEvent(event) || verbose) {
      yield event;
    }
    if (event.type === 'agent:message' && event.content) {
      fullText += event.content;
    }
  }

  // Parse staleness block from accumulated text
  const staleness = parseStalenessBlock(fullText);

  if (staleness) {
    yield {
      timestamp: new Date().toISOString(),
      type: 'queue:prd:stale',
      verdict: staleness.verdict,
      justification: staleness.justification,
      revision: staleness.revision,
    };
  }
}
