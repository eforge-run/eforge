/**
 * Span wiring — createToolTracker, populateSpan, and createStageSpanWiring.
 *
 * These utilities encapsulate the span lifecycle (create → setInput → track tools →
 * cleanup/end/error) so stage bodies focus on agent invocation rather than tracing boilerplate.
 */

import type { EforgeEvent, AgentResultData } from '../events.js';
import type { AgentRole } from '../events.js';
import type { TracingContext, SpanHandle, ToolCallHandle } from '../tracing.js';

/**
 * Create a tool call tracker for a span.
 * Intercepts tool_use/tool_result/result events and manages Langfuse sub-spans.
 */
export function createToolTracker(span: SpanHandle) {
  const activeTools = new Map<string, ToolCallHandle>();

  return {
    handleEvent(event: EforgeEvent): void {
      if (event.type === 'agent:tool_use') {
        const handle = span.addToolCall(event.toolUseId, event.tool, event.input);
        activeTools.set(event.toolUseId, handle);
      }
      if (event.type === 'agent:tool_result') {
        const handle = activeTools.get(event.toolUseId);
        if (handle) {
          handle.end(event.output);
          activeTools.delete(event.toolUseId);
        }
      }
      if (event.type === 'agent:result') {
        populateSpan(span, event.result);
      }
    },
    cleanup(): void {
      for (const [, handle] of activeTools) {
        handle.end();
      }
      activeTools.clear();
    },
  };
}

/**
 * Populate a Langfuse span/generation with SDK result data.
 */
export function populateSpan(span: SpanHandle, data: AgentResultData): void {
  // Set the primary model (first key in modelUsage)
  const models = Object.keys(data.modelUsage);
  if (models.length > 0) {
    span.setModel(models[0]);
  }

  // Set generation output from agent result text
  if (data.resultText) {
    span.setOutput(data.resultText);
  }

  span.setUsage(data.usage);

  // Build detailed usage breakdown from per-model data
  const usageDetails: Record<string, number> = {
    input: data.usage.input,
    output: data.usage.output,
    total: data.usage.total,
    cacheRead: data.usage.cacheRead,
    cacheCreation: data.usage.cacheCreation,
  };
  for (const [model, mu] of Object.entries(data.modelUsage)) {
    usageDetails[`${model}:input`] = mu.inputTokens;
    usageDetails[`${model}:output`] = mu.outputTokens;
    usageDetails[`${model}:cacheRead`] = mu.cacheReadInputTokens;
    usageDetails[`${model}:cacheCreation`] = mu.cacheCreationInputTokens;
  }
  span.setUsageDetails(usageDetails);

  span.setCostDetails({
    total: data.totalCostUsd,
    ...Object.fromEntries(
      Object.entries(data.modelUsage).map(([model, mu]) => [model, mu.costUSD]),
    ),
  });

  // Capture duration and turn count as metadata
  span.setMetadata({
    durationMs: data.durationMs,
    durationApiMs: data.durationApiMs,
    numTurns: data.numTurns,
  });
}

/**
 * Create span + tracker wiring for a stage attempt.
 * Returns helpers that encapsulate the span lifecycle so stage bodies avoid
 * repetitive cleanup/end/error boilerplate.
 *
 * The span and tracker are created fresh per call so each retry attempt gets
 * its own span and a clean tool-call state (sharing accumulates stale state
 * from abandoned turns and collapses per-attempt telemetry).
 */
export function createStageSpanWiring(
  role: AgentRole,
  tracing: TracingContext,
  metadata: Record<string, unknown>,
): {
  span: SpanHandle;
  tracker: ReturnType<typeof createToolTracker>;
  end(): void;
  error(err: Error | string): void;
} {
  const span = tracing.createSpan(role, metadata);
  span.setInput(metadata);
  const tracker = createToolTracker(span);
  return {
    span,
    tracker,
    end() {
      tracker.cleanup();
      span.end();
    },
    error(err: Error | string) {
      tracker.cleanup();
      span.error(err);
    },
  };
}
