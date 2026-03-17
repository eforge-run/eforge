import type { AgentBackend } from '../backend.js';
import { isAlwaysYieldedAgentEvent, type EforgeEvent } from '../events.js';
import { loadPrompt } from '../prompts.js';
import { parseScopeBlock, parseProfileBlock } from './common.js';
import type { ResolvedProfileConfig } from '../config.js';
import { formatProfileDescriptions } from './planner.js';

/**
 * Options for the assessor agent.
 */
export interface AssessorOptions {
  /** Backend for running the agent */
  backend: AgentBackend;
  /** The source plan content to assess */
  sourceContent: string;
  /** Working directory */
  cwd: string;
  /** Whether to emit verbose agent-level events */
  verbose?: boolean;
  /** AbortController for cancellation */
  abortController?: AbortController;
  /** Available workflow profiles for profile selection. */
  profiles?: Record<string, ResolvedProfileConfig>;
}

/**
 * Run the assessor agent as a one-shot query.
 *
 * Explores the codebase and determines the scope assessment for an
 * adopted plan (errand/excursion/expedition/complete). Does not create
 * or modify any files.
 *
 * Yields:
 * - `agent:message`, `agent:tool_use`, `agent:tool_result` events (when verbose)
 * - `agent:result` (always)
 * - `plan:scope` when scope block found (defaults to errand if none found)
 */
export async function* runAssessor(
  options: AssessorOptions,
): AsyncGenerator<EforgeEvent> {
  const { backend, sourceContent, cwd, verbose, abortController, profiles } = options;

  const prompt = await loadPrompt('assessor', {
    source: sourceContent,
    cwd,
    profiles: profiles ? formatProfileDescriptions(profiles) : '',
  });

  let fullText = '';

  for await (const event of backend.run(
    { prompt, cwd, maxTurns: 20, tools: 'coding', abortSignal: abortController?.signal },
    'assessor',
  )) {
    // Always yield agent:result, agent:tool_use, agent:tool_result; gate agent:message on verbose
    if (isAlwaysYieldedAgentEvent(event) || verbose) {
      yield event;
    }
    if (event.type === 'agent:message' && event.content) {
      fullText += event.content;
    }
  }

  // Parse profile block from accumulated text
  const profile = parseProfileBlock(fullText);
  if (profile) {
    yield {
      type: 'plan:profile',
      profileName: profile.profileName,
      rationale: profile.rationale,
      config: options.profiles?.[profile.profileName],
    };
  }

  // Parse scope block from accumulated text
  const scope = parseScopeBlock(fullText);

  if (scope) {
    yield { type: 'plan:scope', assessment: scope.assessment, justification: scope.justification };
  } else {
    // Default to errand if no scope block found (safe fallback - matches current adopt behavior)
    yield { type: 'plan:scope', assessment: 'errand', justification: 'No scope assessment found — defaulting to errand.' };
  }
}
