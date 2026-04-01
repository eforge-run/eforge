import type { AgentBackend, SdkPassthroughConfig } from '../backend.js';
import { pickSdkOptions } from '../backend.js';
import { isAlwaysYieldedAgentEvent, type EforgeEvent } from '../events.js';
import type { BuildStageSpec, ReviewProfileConfig } from '../config.js';
import { loadPrompt } from '../prompts.js';
import { pipelineCompositionSchema, getPipelineCompositionJsonSchema } from '../schemas.js';
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
 * Compose a pipeline from a PRD using structured output.
 *
 * Loads the pipeline-composer prompt with the stage registry injected,
 * calls the backend with outputFormat set to the PipelineComposition JSON Schema,
 * parses and validates the structured output, and yields a `plan:pipeline` event.
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

  const prompt = await loadPrompt('pipeline-composer', {
    source,
    stageRegistry,
  });

  const jsonSchema = getPipelineCompositionJsonSchema();

  let structuredOutput: unknown | undefined;

  for await (const event of backend.run(
    {
      prompt,
      cwd,
      maxTurns: 2, // structured output requires a tool-call + response cycle
      tools: 'none',
      outputFormat: { type: 'json_schema', schema: jsonSchema },
      abortSignal: abortController?.signal,
      ...pickSdkOptions(options),
    },
    'pipeline-composer',
  )) {
    if (isAlwaysYieldedAgentEvent(event) || verbose) {
      yield event;
    }
    // Capture structured output from the result event
    if (event.type === 'agent:result' && event.result.structuredOutput !== undefined) {
      structuredOutput = event.result.structuredOutput;
    }
  }

  if (structuredOutput === undefined) {
    throw new Error('Pipeline composer did not return structured output');
  }

  // Parse and validate with Zod
  const composition: PipelineComposition = pipelineCompositionSchema.parse(structuredOutput);

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
}
