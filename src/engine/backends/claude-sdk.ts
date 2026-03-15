/**
 * Claude Agent SDK backend — the sole file that imports @anthropic-ai/claude-agent-sdk.
 * All other engine code uses the AgentBackend interface.
 */
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKUserMessage,
  SDKToolUseSummaryMessage,
  McpServerConfig,
  SdkPluginConfig,
  SettingSource,
} from '@anthropic-ai/claude-agent-sdk';
import type { EforgeEvent, AgentRole, AgentResultData } from '../events.js';
import type { AgentBackend, AgentRunOptions } from '../backend.js';

export interface ClaudeSDKBackendOptions {
  /** MCP servers to make available to all agent runs. */
  mcpServers?: Record<string, McpServerConfig>;
  /** Claude Code plugins to load (skills, hooks, plugin MCP servers). */
  plugins?: SdkPluginConfig[];
  /** Which settings to load: 'user', 'project', 'local'. */
  settingSources?: SettingSource[];
}

export class ClaudeSDKBackend implements AgentBackend {
  private readonly mcpServers?: Record<string, McpServerConfig>;
  private readonly plugins?: SdkPluginConfig[];
  private readonly settingSources?: SettingSource[];

  constructor(options?: ClaudeSDKBackendOptions) {
    this.mcpServers = options?.mcpServers;
    this.plugins = options?.plugins;
    this.settingSources = options?.settingSources;
  }

  async *run(options: AgentRunOptions, agent: AgentRole, planId?: string): AsyncGenerator<EforgeEvent> {
    const agentId = crypto.randomUUID();
    yield { type: 'agent:start', planId, agent, agentId, timestamp: new Date().toISOString() };

    let error: string | undefined;
    try {
      const q = sdkQuery({
        prompt: options.prompt,
        options: {
          cwd: options.cwd,
          maxTurns: options.maxTurns,
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          tools: options.tools === 'coding'
            ? { type: 'preset', preset: 'claude_code' }
            : undefined,
          mcpServers: this.mcpServers,
          plugins: this.plugins,
          settingSources: this.settingSources,
          abortController: options.abortSignal
            ? abortControllerFromSignal(options.abortSignal)
            : undefined,
        },
      });

      yield* mapSDKMessages(q, agent, planId);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      yield { type: 'agent:stop', planId, agent, agentId, error, timestamp: new Date().toISOString() };
    }
  }
}

/**
 * Create an AbortController that mirrors an AbortSignal.
 * The SDK expects AbortController, but the backend interface uses AbortSignal.
 */
function abortControllerFromSignal(signal: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal.aborted) {
    controller.abort(signal.reason);
  } else {
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller;
}

/**
 * Map an async iterable of SDK messages to EforgeEvents.
 * Bridges the SDK's message stream to the engine's typed event system.
 * Yields an `agent:result` event with usage/cost/model data when the SDK query completes.
 */
export async function* mapSDKMessages(
  messages: AsyncIterable<SDKMessage>,
  agent: AgentRole,
  planId?: string,
): AsyncGenerator<EforgeEvent> {
  // Track toolUseId → toolName for resolving tool results
  const toolNameMap = new Map<string, string>();

  for await (const msg of messages) {
    switch (msg.type) {
      case 'assistant': {
        const assistantMsg = msg as SDKAssistantMessage;
        for (const block of assistantMsg.message.content) {
          if (block.type === 'text') {
            yield { type: 'agent:message', planId, agent, content: block.text };
          } else if (block.type === 'tool_use') {
            toolNameMap.set(block.id, block.name);
            yield {
              type: 'agent:tool_use',
              planId,
              agent,
              tool: block.name,
              toolUseId: block.id,
              input: block.input,
            };
          }
        }
        break;
      }

      case 'user': {
        // Extract tool results from user messages. This complements the tool_use_summary
        // path below: user messages carry per-tool results while summaries batch them.
        // The SDK may send one or both depending on preserveToolUseResults config.
        //
        // Skip replay messages — the SDK union sends both SDKUserMessage and
        // SDKUserMessageReplay under type 'user'.
        if ('isReplay' in msg && msg.isReplay) break;

        const userMsg = msg as SDKUserMessage;
        if (!userMsg.parent_tool_use_id) break;

        // SDK strips tool_use_result for built-in tools (preserveToolUseResults=false by default).
        // Prefer tool_use_result when available, fall back to message.content tool_result blocks.
        const rawOutput = userMsg.tool_use_result !== undefined
          ? (typeof userMsg.tool_use_result === 'string' ? userMsg.tool_use_result : JSON.stringify(userMsg.tool_use_result))
          : extractToolResultContent(userMsg.message, userMsg.parent_tool_use_id);

        if (rawOutput === undefined) {
          break;
        }

        const toolName = toolNameMap.get(userMsg.parent_tool_use_id) ?? 'unknown';
        yield {
          type: 'agent:tool_result',
          planId,
          agent,
          tool: toolName,
          toolUseId: userMsg.parent_tool_use_id,
          output: truncateOutput(rawOutput, 4096),
        };
        break;
      }

      case 'tool_use_summary': {
        const summaryMsg = msg as SDKToolUseSummaryMessage;
        // Emit a tool_result for each preceding tool_use_id with the combined summary
        for (const toolUseId of summaryMsg.preceding_tool_use_ids) {
          const toolName = toolNameMap.get(toolUseId) ?? 'unknown';
          yield {
            type: 'agent:tool_result',
            planId,
            agent,
            tool: toolName,
            toolUseId,
            output: truncateOutput(summaryMsg.summary, 4096),
          };
        }
        break;
      }

      case 'stream_event': {
        const partial = msg as SDKPartialAssistantMessage;
        const event = partial.event;
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield { type: 'agent:message', planId, agent, content: event.delta.text };
        }
        break;
      }

      case 'result': {
        const result = msg as SDKResultMessage;
        if (result.subtype === 'success') {
          // Don't yield agent:message here — the text was already emitted
          // from the assistant message. Duplicating it causes double-parsing
          // of XML blocks (scope, clarification, review issues, verdicts).
          yield { type: 'agent:result', planId, agent, result: extractResultData(result, result.result) };
        } else {
          const errorResult = result as SDKResultMessage & { errors?: string[] };
          const errorMsg = errorResult.errors?.join('; ') ?? `Agent ${agent} failed: ${result.subtype}`;
          // Yield result data even on error (usage is still tracked)
          yield { type: 'agent:result', planId, agent, result: extractResultData(result) };
          throw new Error(errorMsg);
        }
        break;
      }

      default:
        // Other SDK message types (system, hooks, etc.) are not mapped
        break;
    }
  }
}

/**
 * Truncate tool output to prevent bloated traces.
 * Exported for testing.
 */
export function truncateOutput(output: string, maxLength: number): string {
  if (output.length <= maxLength) return output;
  return output.slice(0, maxLength) + `... [truncated from ${output.length} chars]`;
}

/**
 * Extract tool result content from a user message's content blocks.
 * The SDK's message.content contains tool_result blocks with the actual output.
 */
function extractToolResultContent(
  message: { content?: unknown },
  toolUseId: string,
): string | undefined {
  const content = message?.content;
  if (!Array.isArray(content)) return undefined;

  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type !== 'tool_result' || b.tool_use_id !== toolUseId) continue;

    if (typeof b.content === 'string') return b.content;
    if (Array.isArray(b.content)) {
      return (b.content as Array<Record<string, unknown>>)
        .filter((c) => c.type === 'text')
        .map((c) => String(c.text ?? ''))
        .join('\n');
    }
    return ''; // tool_result present but no content
  }
  return undefined;
}

/**
 * Extract tracing-relevant data from an SDK result message.
 * Defensive against missing fields (e.g. in test fixtures).
 */
function extractResultData(result: SDKResultMessage, resultText?: string): AgentResultData {
  const modelUsage: AgentResultData['modelUsage'] = {};
  let inputTokens = 0;
  let outputTokens = 0;

  if (result.modelUsage) {
    for (const [model, usage] of Object.entries(result.modelUsage)) {
      modelUsage[model] = {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUSD: usage.costUSD,
      };
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
    }
  }

  // Fall back to SDK aggregate if modelUsage was empty
  if (inputTokens === 0 && outputTokens === 0) {
    inputTokens = result.usage?.input_tokens ?? 0;
    outputTokens = result.usage?.output_tokens ?? 0;
  }

  return {
    durationMs: result.duration_ms ?? 0,
    durationApiMs: result.duration_api_ms ?? 0,
    numTurns: result.num_turns ?? 0,
    totalCostUsd: result.total_cost_usd ?? 0,
    usage: {
      input: inputTokens,
      output: outputTokens,
      total: inputTokens + outputTokens,
    },
    modelUsage,
    resultText,
  };
}
