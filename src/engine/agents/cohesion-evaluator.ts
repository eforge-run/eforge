import type { AgentBackend } from '../backend.js';
import { isAlwaysYieldedAgentEvent, type EforgeEvent } from '../events.js';
import { loadPrompt } from '../prompts.js';
import { getEvaluationSchemaYaml } from '../schemas.js';
import { parseEvaluationBlock } from './builder.js';

/**
 * Options for the cohesion evaluator agent.
 */
export interface CohesionEvaluatorOptions {
  /** Backend for running the agent */
  backend: AgentBackend;
  /** The plan set name */
  planSetName: string;
  /** The original source/PRD content for context */
  sourceContent: string;
  /** Working directory */
  cwd: string;
  /** Whether to emit verbose agent-level events */
  verbose?: boolean;
  /** AbortController for cancellation */
  abortController?: AbortController;
}

/**
 * Evaluate the cohesion reviewer's unstaged fixes. Runs `git reset --soft HEAD~1`
 * to expose staged (planner's plans) vs unstaged (reviewer's fixes), applies
 * verdicts, and commits the final result.
 *
 * Yields:
 * - `plan:cohesion:evaluate:start` at the beginning
 * - `agent:message`, `agent:tool_use`, `agent:tool_result` events (when verbose)
 * - `plan:cohesion:evaluate:complete` with accepted/rejected counts at the end
 */
export async function* runCohesionEvaluate(
  options: CohesionEvaluatorOptions,
): AsyncGenerator<EforgeEvent> {
  const { backend, planSetName, sourceContent, cwd, verbose, abortController } = options;

  yield { type: 'plan:cohesion:evaluate:start' };

  const prompt = await loadPrompt('cohesion-evaluator', {
    plan_set_name: planSetName,
    source_content: sourceContent,
    evaluation_schema: getEvaluationSchemaYaml(),
  });

  let fullText = '';
  try {
    for await (const event of backend.run(
      { prompt, cwd, maxTurns: 30, tools: 'coding', abortSignal: abortController?.signal },
      'cohesion-evaluator',
    )) {
      if (isAlwaysYieldedAgentEvent(event) || verbose) {
        yield event;
      }
      if (event.type === 'agent:message' && event.content) {
        fullText += event.content;
      }
    }
  } catch (err) {
    yield { type: 'plan:cohesion:evaluate:complete', accepted: 0, rejected: 0 };
    throw err;
  }

  const verdicts = parseEvaluationBlock(fullText);
  const accepted = verdicts.filter((v) => v.action === 'accept').length;
  const rejected = verdicts.filter((v) => v.action === 'reject' || v.action === 'review').length;

  yield { type: 'plan:cohesion:evaluate:complete', accepted, rejected };
}
