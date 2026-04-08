import type { AgentBackend, SdkPassthroughConfig } from '../backend.js';
import { pickSdkOptions } from '../backend.js';
import { isAlwaysYieldedAgentEvent, type EforgeEvent } from '../events.js';
import { loadPrompt } from '../prompts.js';

export interface ValidationFixerOptions extends SdkPassthroughConfig {
  backend: AgentBackend;
  cwd: string;
  failures: Array<{ command: string; exitCode: number; output: string }>;
  attempt: number;
  maxAttempts: number;
  verbose?: boolean;
  abortController?: AbortController;
}

/**
 * Validation fixer agent — attempts to fix post-merge validation failures.
 * Receives failed command output, diagnoses the issue, and makes minimal fixes.
 */
export async function* runValidationFixer(
  options: ValidationFixerOptions,
): AsyncGenerator<EforgeEvent> {
  yield { timestamp: new Date().toISOString(), type: 'validation:fix:start', attempt: options.attempt, maxAttempts: options.maxAttempts };

  const failureContext = options.failures
    .map(
      (f) =>
        `Command: ${f.command}\nExit code: ${f.exitCode}\nOutput:\n${f.output}`,
    )
    .join('\n\n---\n\n');

  const prompt = await loadPrompt('validation-fixer', {
    failures: failureContext,
    attempt: String(options.attempt),
    max_attempts: String(options.maxAttempts),
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
      'validation-fixer',
    )) {
      if (isAlwaysYieldedAgentEvent(event) || options.verbose) {
        yield event;
      }
    }
  } catch (err) {
    // Re-throw abort errors so the orchestrator can respect cancellation
    if (err instanceof Error && err.name === 'AbortError') throw err;
    // Other fixer failures are non-fatal — validation will just fail on re-run
  }

  yield { timestamp: new Date().toISOString(), type: 'validation:fix:complete', attempt: options.attempt };
}
