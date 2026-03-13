import Langfuse from 'langfuse';
import type { AgentRole } from './events.js';
import type { ForgeConfig } from './config.js';

export interface SpanHandle {
  setInput(input: unknown): void;
  setOutput(output: unknown): void;
  setUsage(usage: { input: number; output: number; total: number }): void;
  end(): void;
  error(err: Error | string): void;
}

export interface TracingContext {
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
    setUsage() {},
    end() {},
    error() {},
  };

  return {
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
    metadata: { command },
  });

  return {
    createSpan(agent: AgentRole, metadata?: Record<string, unknown>): SpanHandle {
      const span = trace.span({
        name: agent,
        metadata,
      });

      return {
        setInput(input: unknown) {
          span.update({ input });
        },
        setOutput(output: unknown) {
          span.update({ output });
        },
        setUsage(usage: { input: number; output: number; total: number }) {
          span.update({
            metadata: { ...metadata, usage },
          });
        },
        end() {
          span.update({ level: 'DEFAULT' });
          span.end();
        },
        error(err: Error | string) {
          const message = typeof err === 'string' ? err : err.message;
          span.update({ level: 'ERROR', statusMessage: message });
          span.end();
        },
      };
    },
    async flush() {
      await langfuse.flushAsync();
    },
  };
}
