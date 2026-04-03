/**
 * StubBackend — test helper that implements AgentBackend with scripted responses.
 * Lives in test/ (not src/) since it's only for testing.
 */
import type { AgentBackend, AgentRunOptions } from '../src/engine/backend.js';
import type { EforgeEvent, AgentRole, AgentResultData } from '../src/engine/events.js';

export interface StubToolCall {
  tool: string;
  toolUseId: string;
  input: unknown;
  output: string;
}

export interface StubResponse {
  /** Text content the "agent" produces (emitted as agent:message events) */
  text?: string;
  /** Tool use/result events to emit before the text */
  toolCalls?: StubToolCall[];
  /** Throw this error instead of completing normally */
  error?: Error;
}

const STUB_RESULT: AgentResultData = {
  durationMs: 100,
  durationApiMs: 80,
  numTurns: 1,
  totalCostUsd: 0,
  usage: { input: 0, output: 0, total: 0, cacheRead: 0, cacheCreation: 0 },
  modelUsage: {},
};

/**
 * A test backend that yields scripted EforgeEvents.
 *
 * Responses are consumed sequentially across multiple `run()` calls.
 * This enables testing multi-iteration flows (e.g., planner clarification
 * restarts) by providing a response for each call.
 *
 * Fidelity notes vs. real ClaudeSDKBackend:
 * - Text is emitted as a single agent:message, not streamed as many small deltas.
 *   XML parsers run on accumulated text so single-vs-chunked doesn't affect wiring tests.
 * - Tool calls are emitted before text. Real backends interleave text and tool_use
 *   blocks within a single assistant turn. No wiring logic depends on ordering.
 */
export class StubBackend implements AgentBackend {
  private readonly responses: StubResponse[];
  private callIndex = 0;

  /** Every prompt passed to `run()`, in order. Use for assertion. */
  readonly prompts: string[] = [];
  /** Every AgentRunOptions passed to `run()`, in order. */
  readonly calls: AgentRunOptions[] = [];

  constructor(responses: StubResponse[]) {
    this.responses = responses;
  }

  async *run(
    options: AgentRunOptions,
    agent: AgentRole,
    planId?: string,
  ): AsyncGenerator<EforgeEvent> {
    this.prompts.push(options.prompt);
    this.calls.push(options);

    const agentId = crypto.randomUUID();
    yield { type: 'agent:start', planId, agent, agentId, model: options.model?.id ?? 'stub-model', backend: 'stub', timestamp: new Date().toISOString() };

    let error: string | undefined;
    try {
      const response = this.responses[this.callIndex++];
      if (!response) {
        throw new Error(`StubBackend: no response at index ${this.callIndex - 1} (only ${this.responses.length} responses provided)`);
      }

      if (response.error) {
        throw response.error;
      }

      // Emit tool calls
      if (response.toolCalls) {
        for (const tc of response.toolCalls) {
          yield { type: 'agent:tool_use', planId, agentId, agent, tool: tc.tool, toolUseId: tc.toolUseId, input: tc.input };
          yield { type: 'agent:tool_result', planId, agentId, agent, tool: tc.tool, toolUseId: tc.toolUseId, output: tc.output };
        }
      }

      // Emit text as agent:message
      if (response.text) {
        yield { type: 'agent:message', planId, agentId, agent, content: response.text };
      }

      // Always emit agent:result to match real backend behavior
      yield { type: 'agent:result', planId, agent, result: STUB_RESULT };
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      yield { type: 'agent:stop', planId, agent, agentId, error, timestamp: new Date().toISOString() };
    }
  }
}
