/**
 * Recovery analyst agent runner.
 *
 * One-shot read-only agent (`tools: 'none'`) that forensically reviews a
 * failed build session and emits a typed recovery verdict. Mirrors the
 * staleness-assessor pattern exactly.
 */

import type { AgentHarness, SdkPassthroughConfig } from '../harness.js';
import { pickSdkOptions } from '../harness.js';
import { isAlwaysYieldedAgentEvent, type EforgeEvent, type BuildFailureSummary } from '../events.js';
import { loadPrompt } from '../prompts.js';
import { getRecoveryVerdictSchemaYaml } from '../schemas.js';
import { parseRecoveryVerdictBlock } from './common.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Options for the recovery analyst agent.
 */
export interface RecoveryAnalystOptions extends SdkPassthroughConfig {
  /** Harness for running the agent */
  harness: AgentHarness;
  /** Full PRD file content */
  prdContent: string;
  /** Build failure summary assembled from state + git */
  summary: BuildFailureSummary;
  /** PRD identifier — propagated into recovery events */
  prdId: string;
  /** Working directory */
  cwd: string;
  /** Whether to emit verbose agent-level events */
  verbose?: boolean;
  /** AbortController for cancellation */
  abortController?: AbortController;
}

// ---------------------------------------------------------------------------
// Agent runner
// ---------------------------------------------------------------------------

/**
 * Run the recovery analyst agent as a one-shot forensic query.
 *
 * Reads the PRD content and build failure summary, then emits a recovery
 * verdict. `tools: 'none'` — the agent is strictly read-only.
 *
 * Yields:
 * - `agent:message`, `agent:tool_use`, `agent:tool_result` events (when verbose)
 * - `agent:result` (always)
 * - `recovery:summary` carrying the BuildFailureSummary
 * - `recovery:complete` carrying the parsed RecoveryVerdict on success
 * - `recovery:error` when the agent output cannot be parsed
 */
export async function* runRecoveryAnalyst(
  options: RecoveryAnalystOptions,
): AsyncGenerator<EforgeEvent> {
  const { harness, prdContent, summary, prdId, cwd, verbose, abortController } = options;

  const prompt = await loadPrompt(
    'recovery-analyst',
    {
      prdContent,
      summary: JSON.stringify(summary, null, 2),
      recovery_schema: getRecoveryVerdictSchemaYaml(),
    },
    options.promptAppend,
  );

  let fullText = '';

  for await (const event of harness.run(
    {
      prompt,
      cwd,
      maxTurns: 20,
      tools: 'none',
      abortSignal: abortController?.signal,
      ...pickSdkOptions(options),
    },
    'recovery-analyst',
  )) {
    // Always yield agent:result, agent:tool_use, agent:tool_result; gate agent:message on verbose
    if (isAlwaysYieldedAgentEvent(event) || verbose) {
      yield event;
    }
    if (event.type === 'agent:message' && event.content) {
      fullText += event.content;
    }
  }

  // Parse recovery verdict from accumulated text
  const verdict = parseRecoveryVerdictBlock(fullText);

  if (verdict) {
    yield {
      timestamp: new Date().toISOString(),
      type: 'recovery:summary',
      prdId,
      summary,
    };
    yield {
      timestamp: new Date().toISOString(),
      type: 'recovery:complete',
      prdId,
      verdict,
    };
  } else {
    yield {
      timestamp: new Date().toISOString(),
      type: 'recovery:error',
      prdId,
      error: 'Failed to parse recovery verdict from agent output',
      rawOutput: fullText.slice(0, 500),
    };
  }
}
