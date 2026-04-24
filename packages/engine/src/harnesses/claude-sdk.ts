/**
 * Claude Agent SDK harness — the sole file that imports @anthropic-ai/claude-agent-sdk.
 * All other engine code uses the AgentHarness interface.
 */
import { query as sdkQuery, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
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
import type { AgentHarness, AgentRunOptions, AgentTerminalSubtype, HarnessDebugCallback, HarnessDebugPayload } from '../harness.js';
import { AgentTerminalError } from '../harness.js';
import { normalizeUsage, toModelUsageEntry, type RawUsage } from './usage.js';
import { buildAgentStartEvent, normalizeToolUseId } from './common.js';
import { EFORGE_DISALLOWED_TOOL_PATTERNS } from './eforge-resource-filter.js';

export interface ClaudeSDKHarnessOptions {
  /** MCP servers to make available to all agent runs. */
  mcpServers?: Record<string, McpServerConfig>;
  /** Claude Code plugins to load (skills, hooks, plugin MCP servers). */
  plugins?: SdkPluginConfig[];
  /** Which settings to load: 'user', 'project', 'local'. */
  settingSources?: SettingSource[];
  /** Pass --bare to Claude Code subprocess to suppress auto-loading of default settings/tools. */
  bare?: boolean;
  /**
   * When true, the backend appends the `Task` tool to every agent run's
   * `disallowedTools` list so agents cannot spawn subagents. Claude SDK-only —
   * Pi has no Task tool / subagent concept.
   */
  disableSubagents?: boolean;
  /**
   * Optional callback fired just before each `sdkQuery` dispatch with a snapshot
   * of the request (system prompt, tools, model, etc.). Used by diagnostic
   * tooling like `eforge debug-composer` to compare framing across backends.
   */
  onDebugPayload?: HarnessDebugCallback;
}

/** The tool name Claude Code exposes for subagent spawning. */
export const SUBAGENT_TOOL_NAME = 'Task';

/**
 * Compute the effective `disallowedTools` list for a single agent run by
 * combining three sources:
 *
 *  1. Whatever the role explicitly set (`roleDisallowed`).
 *  2. `Task` when `disableSubagents` is true — blocks subagent spawning,
 *     Claude SDK-only (Pi has no Task tool).
 *  3. eforge's own Claude Code plugin tool patterns (`mcp__eforge__*`),
 *     ALWAYS injected so that if the user brings the eforge Claude Code
 *     plugin into an agent context via `settingSources` / installed plugins,
 *     those tools still cannot be invoked recursively by any agent eforge
 *     runs. Note this targets the *plugin's* MCP server name (`eforge`), not
 *     the engine's own in-process SDK MCP server (`eforge_engine`) which
 *     hosts the planner submission tools.
 *
 * The result is always a non-empty list (since the eforge patterns are
 * always added), de-duplicated. Exported for testing.
 */
export function resolveDisallowedTools(
  roleDisallowed: readonly string[] | undefined,
  disableSubagents: boolean,
): string[] {
  const acc = new Set<string>(roleDisallowed ?? []);
  if (disableSubagents) {
    acc.add(SUBAGENT_TOOL_NAME);
  }
  for (const pattern of EFORGE_DISALLOWED_TOOL_PATTERNS) {
    acc.add(pattern);
  }
  return Array.from(acc);
}

export class ClaudeSDKHarness implements AgentHarness {
  private readonly mcpServers?: Record<string, McpServerConfig>;
  private readonly plugins?: SdkPluginConfig[];
  private readonly settingSources?: SettingSource[];
  private readonly bare: boolean;
  private readonly disableSubagents: boolean;
  private readonly onDebugPayload?: HarnessDebugCallback;

  constructor(options?: ClaudeSDKHarnessOptions) {
    this.mcpServers = options?.mcpServers;
    this.plugins = options?.plugins;
    this.settingSources = options?.settingSources;
    this.bare = options?.bare ?? false;
    this.disableSubagents = options?.disableSubagents ?? false;
    this.onDebugPayload = options?.onDebugPayload;
  }

  /**
   * Claude Agent SDK exposes custom tools registered via `createSdkMcpServer`
   * under the prefix `mcp__<serverName>__<toolName>`. The engine's in-process
   * MCP server is named `eforge_engine`, so a bare `CustomTool.name` like
   * `submit_plan_set` becomes `mcp__eforge_engine__submit_plan_set` from the
   * model's perspective.
   */
  effectiveCustomToolName(name: string): string {
    return `mcp__eforge_engine__${name}`;
  }

  async *run(options: AgentRunOptions, agent: AgentRole, planId?: string): AsyncGenerator<EforgeEvent> {
    const agentId = crypto.randomUUID();
    yield buildAgentStartEvent({
      planId,
      agentId,
      agent,
      model: options.model?.id ?? 'default',
      agentRuntime: options.agentRuntimeName ?? 'claude-sdk',
      harness: 'claude-sdk',
      fallbackFrom: options.fallbackFrom,
      effort: options.effort,
      thinking: options.thinking,
      effortClamped: options.effortClamped,
      effortOriginal: options.effortOriginal,
      effortSource: options.effortSource,
      thinkingSource: options.thinkingSource,
      thinkingCoerced: options.thinkingCoerced,
      thinkingOriginal: options.thinkingOriginal,
    });

    if (options.thinkingCoerced) {
      yield { type: 'agent:warning', planId, agentId, agent, code: 'thinking-coerced', message: `Thinking coerced from 'enabled' to 'adaptive': model ${options.model?.id ?? 'unknown'} only supports adaptive thinking`, timestamp: new Date().toISOString() };
    }

    let error: string | undefined;
    try {
      // Register custom tools as an in-process SDK MCP server per the official docs:
      // https://code.claude.com/docs/en/agent-sdk/custom-tools
      // Tools registered this way are exposed with the name mcp__<serverName>__<toolName>.
      // The in-process SDK MCP server is named `eforge_engine` (not `eforge`)
      // to avoid a namespace collision with the eforge Claude Code plugin's
      // MCP server, which is also named `eforge`. The plugin's tools are
      // always blocked via `mcp__eforge__*` in disallowedTools; the engine's
      // own tools (planner submissions, etc.) live under `mcp__eforge_engine__*`
      // so they remain callable.
      const customMcpServers: Record<string, McpServerConfig> = {};
      if (options.customTools && options.customTools.length > 0) {
        customMcpServers.eforge_engine = createSdkMcpServer({
          name: 'eforge_engine',
          version: '1.0.0',
          tools: options.customTools.map((ct) =>
            tool(
              ct.name,
              ct.description,
              ct.inputSchema.shape,
              async (args: unknown) => {
                const text = await ct.handler(args);
                return { content: [{ type: 'text' as const, text }] };
              },
            ),
          ),
        });
      }

      const mergedMcpServers: Record<string, McpServerConfig> | undefined =
        this.mcpServers || Object.keys(customMcpServers).length > 0
          ? { ...(this.mcpServers ?? {}), ...customMcpServers }
          : undefined;

      const effectiveDisallowed = resolveDisallowedTools(options.disallowedTools, this.disableSubagents);
      const usesPreset = options.tools === 'coding';

      // Fire debug capture hook with the request eforge is about to hand to the SDK.
      // The Claude Code CLI subprocess may add its own preset preamble on top when
      // `tools === 'coding'`; that extra framing is not visible here.
      if (this.onDebugPayload) {
        const debugPayload: HarnessDebugPayload = {
          harness: 'claude-sdk',
          agent,
          userPrompt: options.prompt,
          systemPrompt: '', // eforge never sets systemPrompt; SDK coerces undefined to ""
          tools: usesPreset
            ? [{ name: '<preset:claude_code>', description: 'Claude Code built-in tool preset (Read/Write/Edit/Bash/Grep/Glob/Task/...)' }]
            : [],
          model: { id: options.model?.id ?? 'default' },
          ...(options.effort !== undefined ? { effort: options.effort } : {}),
          ...(options.thinking !== undefined ? { thinking: options.thinking } : {}),
          maxTurns: options.maxTurns,
          ...(options.allowedTools !== undefined ? { allowedTools: options.allowedTools } : {}),
          disallowedTools: effectiveDisallowed,
          extra: {
            toolsMode: options.tools,
            usesPreset,
            disableSubagents: this.disableSubagents,
            bare: this.bare,
            mcpServerNames: mergedMcpServers ? Object.keys(mergedMcpServers) : [],
            pluginCount: this.plugins?.length ?? 0,
            settingSources: usesPreset ? (this.settingSources ?? null) : null,
            customToolCount: options.customTools?.length ?? 0,
            eforgeDisallowedPatterns: [...EFORGE_DISALLOWED_TOOL_PATTERNS],
            note: 'systemPrompt is empty because eforge does not set one; the Claude Code CLI may inject its preset preamble downstream when usesPreset=true. disallowedTools always includes mcp__eforge__* to block the eforge Claude Code plugin; the engine hosts its own tools (e.g. planner submissions) under mcp__eforge_engine__* which remain callable.',
          },
        };
        await this.onDebugPayload(debugPayload);
      }

      const q = sdkQuery({
        prompt: options.prompt,
        options: {
          cwd: options.cwd,
          maxTurns: options.maxTurns,
          model: options.model?.id,
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          tools: options.tools === 'coding'
            ? { type: 'preset', preset: 'claude_code' }
            : [],
          ...(options.tools === 'coding' ? {
            mcpServers: mergedMcpServers,
            plugins: this.plugins,
            settingSources: this.settingSources,
          } : {}),
          abortController: options.abortSignal
            ? abortControllerFromSignal(options.abortSignal)
            : undefined,
          ...(this.bare ? { extraArgs: { bare: null } } : {}),
          // SDK passthrough fields — only include when defined
          ...(options.thinking !== undefined ? { thinking: options.thinking } : {}),
          ...(options.effort !== undefined ? { effort: options.effort } : {}),
          ...(options.maxBudgetUsd !== undefined ? { maxBudgetUsd: options.maxBudgetUsd } : {}),
          ...(options.fallbackModel !== undefined ? { fallbackModel: options.fallbackModel } : {}),
          ...(options.allowedTools !== undefined ? { allowedTools: options.allowedTools } : {}),
          disallowedTools: effectiveDisallowed,
        },
      });

      yield* mapSDKMessages(q, agent, agentId, planId);
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
  agentId: string,
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
            yield { timestamp: new Date().toISOString(), type: 'agent:message', planId, agentId: agentId!, agent, content: block.text };
          } else if (block.type === 'tool_use') {
            toolNameMap.set(block.id, block.name);
            yield {
              timestamp: new Date().toISOString(),
              type: 'agent:tool_use',
              planId,
              agentId: agentId!,
              agent,
              tool: block.name,
              toolUseId: normalizeToolUseId({ id: block.id }),
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
          timestamp: new Date().toISOString(),
          type: 'agent:tool_result',
          planId,
          agentId: agentId!,
          agent,
          tool: toolName,
          toolUseId: normalizeToolUseId({ id: userMsg.parent_tool_use_id }),
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
            timestamp: new Date().toISOString(),
            type: 'agent:tool_result',
            planId,
            agentId: agentId!,
            agent,
            tool: toolName,
            toolUseId: normalizeToolUseId({ id: toolUseId }),
            output: truncateOutput(summaryMsg.summary, 4096),
          };
        }
        break;
      }

      case 'stream_event': {
        const partial = msg as SDKPartialAssistantMessage;
        const event = partial.event;
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield { timestamp: new Date().toISOString(), type: 'agent:message', planId, agentId: agentId!, agent, content: event.delta.text };
        }
        break;
      }

      case 'result': {
        const result = msg as SDKResultMessage;
        if (result.subtype === 'success') {
          // Don't yield agent:message here — the text was already emitted
          // from the assistant message. Duplicating it causes double-parsing
          // of XML blocks (scope, clarification, review issues, verdicts).
          const resultData = extractResultData(result, result.result);
          // Authoritative cumulative usage for this session. Emitted right
          // before agent:result so consumers have a single `final: true`
          // checkpoint in the usage channel co-located with the rest of the
          // lifecycle sequence.
          yield {
            timestamp: new Date().toISOString(),
            type: 'agent:usage',
            planId,
            agentId,
            agent,
            usage: resultData.usage,
            costUsd: resultData.totalCostUsd,
            numTurns: resultData.numTurns,
            final: true,
          };
          yield { timestamp: new Date().toISOString(), type: 'agent:result', planId, agent, result: resultData };
        } else {
          const errorResult = result as SDKResultMessage & { errors?: string[] };
          const detail = errorResult.errors?.join('; ') || `Agent ${agent} failed`;
          // Yield result data even on error (usage is still tracked)
          yield { timestamp: new Date().toISOString(), type: 'agent:result', planId, agent, result: extractResultData(result) };
          throw new AgentTerminalError(result.subtype as AgentTerminalSubtype, detail);
        }
        break;
      }

      default: {
        // Handle task_progress system messages for live usage tracking
        const anyMsg = msg as { type: string; subtype?: string; usage?: { total_tokens?: number; tool_uses?: number } };
        if (anyMsg.type === 'system' && anyMsg.subtype === 'task_progress' && anyMsg.usage) {
          yield {
            timestamp: new Date().toISOString(),
            type: 'agent:usage',
            planId,
            agentId: agentId!,
            agent,
            usage: {
              input: 0,
              output: 0,
              total: anyMsg.usage.total_tokens ?? 0,
              cacheRead: 0,
              cacheCreation: 0,
            },
            costUsd: 0,
            numTurns: anyMsg.usage.tool_uses ?? 0,
          };
        }
        break;
      }
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
  const aggregate: RawUsage = {
    uncachedInput: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
  };

  if (result.modelUsage) {
    for (const [model, usage] of Object.entries(result.modelUsage)) {
      const raw: RawUsage = {
        uncachedInput: usage.inputTokens,
        output: usage.outputTokens,
        cacheRead: usage.cacheReadInputTokens ?? 0,
        cacheCreation: usage.cacheCreationInputTokens ?? 0,
      };
      modelUsage[model] = toModelUsageEntry(raw, usage.costUSD);
      aggregate.uncachedInput += raw.uncachedInput;
      aggregate.output += raw.output;
      aggregate.cacheRead += raw.cacheRead;
      aggregate.cacheCreation += raw.cacheCreation;
    }
  }

  // Fall back to SDK aggregate if modelUsage produced zero totals
  if (
    aggregate.uncachedInput === 0 &&
    aggregate.output === 0 &&
    aggregate.cacheRead === 0 &&
    aggregate.cacheCreation === 0
  ) {
    aggregate.uncachedInput = result.usage?.input_tokens ?? 0;
    aggregate.output = result.usage?.output_tokens ?? 0;
  }

  return {
    durationMs: result.duration_ms ?? 0,
    durationApiMs: result.duration_api_ms ?? 0,
    numTurns: result.num_turns ?? 0,
    totalCostUsd: result.total_cost_usd ?? 0,
    usage: normalizeUsage(aggregate),
    modelUsage,
    resultText,
  };
}
