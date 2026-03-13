import Langfuse from 'langfuse';
import type { AgentRole } from './events.js';
import type { ForgeConfig } from './config.js';

export interface SpanHandle {
  setInput(input: unknown): void;
  setOutput(output: unknown): void;
  setModel(model: string): void;
  setUsage(usage: { input: number; output: number; total: number }): void;
  setUsageDetails(details: Record<string, number>): void;
  setCostDetails(details: Record<string, number>): void;
  end(): void;
  error(err: Error | string): void;
}

export interface TracingContext {
  setInput(input: unknown): void;
  setOutput(output: unknown): void;
  createSpan(agent: AgentRole, metadata?: Record<string, unknown>): SpanHandle;
  flush(): Promise<void>;
}

/**
 * Create a no-op tracing context. All methods are safe stubs with no side effects.
 */
export function createNoopTracingContext(): TracingContext {
  const noopSpan: SpanHandle = {
    setInput() {},
    setOutput() {},
    setModel() {},
    setUsage() {},
    setUsageDetails() {},
    setCostDetails() {},
    end() {},
    error() {},
  };

  return {
    setInput() {},
    setOutput() {},
    createSpan() {
      return noopSpan;
    },
    async flush() {},
  };
}

/**
 * Create a tracing context backed by Langfuse when enabled, or a no-op when disabled.
 */
export function createTracingContext(
  config: ForgeConfig,
  runId: string,
  command: string,
  sessionId?: string,
): TracingContext {
  if (!config.langfuse.enabled || !config.langfuse.publicKey || !config.langfuse.secretKey) {
    return createNoopTracingContext();
  }

  const langfuse = new Langfuse({
    publicKey: config.langfuse.publicKey,
    secretKey: config.langfuse.secretKey,
    baseUrl: config.langfuse.host,
  });

  const trace = langfuse.trace({
    id: runId,
    name: `forge:${command}`,
    sessionId,
    metadata: { command },
  });

  return {
    setInput(input: unknown) {
      trace.update({ input });
    },
    setOutput(output: unknown) {
      trace.update({ output });
    },
    createSpan(agent: AgentRole, metadata?: Record<string, unknown>): SpanHandle {
      const gen = trace.generation({
        name: agent,
        metadata,
      });

      // Buffer all data and send in a single end()/update() call to avoid
      // Langfuse SDK issues with rapid-fire individual update() calls.
      const pending: Record<string, unknown> = {};

      return {
        setInput(input: unknown) {
          pending.input = input;
        },
        setOutput(output: unknown) {
          pending.output = output;
        },
        setModel(model: string) {
          pending.model = model;
        },
        setUsage(usage: { input: number; output: number; total: number }) {
          pending.usage = { input: usage.input, output: usage.output, total: usage.total, unit: 'TOKENS' };
        },
        setUsageDetails(details: Record<string, number>) {
          pending.usageDetails = details;
        },
        setCostDetails(details: Record<string, number>) {
          pending.costDetails = details;
        },
        end() {
          gen.end({ ...pending, level: 'DEFAULT' });
        },
        error(err: Error | string) {
          const message = typeof err === 'string' ? err : err.message;
          gen.end({ ...pending, level: 'ERROR', statusMessage: message });
        },
      };
    },
    async flush() {
      await langfuse.flushAsync();
    },
  };
}
