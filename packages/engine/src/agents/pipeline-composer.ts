import type { AgentBackend, SdkPassthroughConfig } from '../backend.js';
import { pickSdkOptions } from '../backend.js';
import { isAlwaysYieldedAgentEvent, type EforgeEvent } from '../events.js';
import type { BuildStageSpec, ReviewProfileConfig } from '../config.js';
import { loadPrompt } from '../prompts.js';
import { pipelineCompositionSchema, getPipelineCompositionSchemaYaml } from '../schemas.js';
import type { PipelineComposition } from '../schemas.js';
import { formatStageRegistry, validatePipeline } from '../pipeline.js';

/**
 * Options for the pipeline composer agent.
 */
export interface PipelineComposerOptions extends SdkPassthroughConfig {
  /** Backend for running the agent */
  backend: AgentBackend;
  /** The PRD / source document content */
  source: string;
  /** Working directory */
  cwd: string;
  /** Whether to emit verbose agent-level events */
  verbose?: boolean;
  /** AbortController for cancellation */
  abortController?: AbortController;
}

/**
 * Extract a JSON object from a text response.
 * Strips markdown code fences and finds the first `{...}` block.
 */
function extractJson(text: string): unknown {
  // Strip markdown code fences (```json ... ``` or ``` ... ```)
  const fencePattern = /```(?:json)?\s*\n?([\s\S]*?)```/;
  const fenceMatch = text.match(fencePattern);
  const cleaned = fenceMatch ? fenceMatch[1].trim() : text.trim();

  // Try parsing the cleaned text directly first (handles clean JSON or fence-extracted content)
  try {
    return JSON.parse(cleaned);
  } catch {
    // Fall back to finding the JSON object in surrounding text
  }

  // Find the first JSON object
  const startIdx = cleaned.indexOf('{');
  if (startIdx === -1) {
    throw new Error('No JSON object found in response');
  }

  // Try parsing from startIdx, trimming from the end until JSON.parse succeeds
  for (let endIdx = cleaned.length; endIdx > startIdx; endIdx--) {
    if (cleaned[endIdx - 1] !== '}') continue;
    try {
      return JSON.parse(cleaned.slice(startIdx, endIdx));
    } catch {
      // Try a shorter substring
    }
  }

  throw new Error('No valid JSON object found in response');
}

/**
 * Compose a pipeline from a PRD using text-based JSON extraction.
 *
 * Loads the pipeline-composer prompt with the stage registry and schema injected,
 * calls the backend with maxTurns: 1, extracts JSON from the text response,
 * validates it against the PipelineComposition schema, and yields a `plan:pipeline` event.
 * Retries up to 3 times on parse failure, feeding the error back to the model.
 *
 * Yields:
 * - `agent:start`, `agent:stop`, `agent:result` (always)
 * - `agent:message` events (when verbose)
 * - `plan:pipeline` event with the composition result
 */
export async function* composePipeline(
  options: PipelineComposerOptions,
): AsyncGenerator<EforgeEvent> {
  const { backend, source, cwd, verbose, abortController } = options;

  const stageRegistry = formatStageRegistry();
  const schema = getPipelineCompositionSchemaYaml();

  const maxAttempts = 3;
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let promptText = await loadPrompt('pipeline-composer', {
      source,
      stageRegistry,
      schema,
    });

    // On retry, append the error so the model can self-correct
    if (lastError) {
      promptText += `\n\nYour previous response could not be parsed. Error: ${lastError}\n\nPlease return valid JSON matching the schema above.`;
    }

    let resultText: string | undefined;

    for await (const event of backend.run(
      {
        prompt: promptText,
        cwd,
        maxTurns: 1,
        tools: 'none',
        abortSignal: abortController?.signal,
        ...pickSdkOptions(options),
      },
      'pipeline-composer',
    )) {
      if (isAlwaysYieldedAgentEvent(event) || verbose) {
        yield event;
      }
      // Capture result text from the result event
      if (event.type === 'agent:result' && event.result.resultText !== undefined) {
        resultText = event.result.resultText;
      }
    }

    if (resultText === undefined) {
      throw new Error('Pipeline composer did not return any text');
    }

    // Try to extract and validate JSON
    try {
      const parsed = extractJson(resultText);
      const composition: PipelineComposition = pipelineCompositionSchema.parse(parsed);

      // Validate the composed pipeline against registered stages
      const validation = validatePipeline(composition.compile, composition.defaultBuild);
      if (!validation.valid) {
        throw new Error(`Pipeline composition is invalid: ${validation.errors.join('; ')}`);
      }

      yield {
        timestamp: new Date().toISOString(),
        type: 'plan:pipeline',
        scope: composition.scope,
        compile: composition.compile,
        defaultBuild: composition.defaultBuild as BuildStageSpec[],
        defaultReview: composition.defaultReview as ReviewProfileConfig,
        rationale: composition.rationale,
      };

      return; // Success - exit the retry loop
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt === maxAttempts) {
        throw new Error(`Pipeline composer failed after ${maxAttempts} attempts: ${lastError}`);
      }
      // Continue to next attempt
    }
  }
}
