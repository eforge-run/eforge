/**
 * Pi coding agent backend — implements AgentBackend using @mariozechner/pi-coding-agent.
 * All Pi SDK imports are isolated to this file and pi-mcp-bridge.ts.
 */

import {
  createAgentSession,
  createCodingTools,
  createReadOnlyTools,
  SessionManager,
  SettingsManager,
  ModelRegistry,
  AuthStorage,
  discoverAndLoadExtensions,
  type AgentSessionEvent,
} from '@mariozechner/pi-coding-agent';
import { getModel } from '@mariozechner/pi-ai';
import type { Model, Api } from '@mariozechner/pi-ai';
import type { AgentTool, ThinkingLevel } from '@mariozechner/pi-agent-core';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { EforgeEvent, AgentRole, AgentResultData } from '../events.js';
import type { AgentBackend, AgentRunOptions, ThinkingConfig, EffortLevel } from '../backend.js';
import type { PiConfig } from '../config.js';
import { AsyncEventQueue } from '../concurrency.js';
import { PiMcpBridge } from './pi-mcp-bridge.js';
import { discoverPiExtensions, type PiExtensionConfig } from './pi-extensions.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PiBackendOptions {
  /** MCP servers to bridge as Pi AgentTools. */
  mcpServers?: Record<string, McpServerConfig>;
  /** Pi extension discovery configuration. */
  extensions?: PiExtensionConfig;
  /** When true, skip extension auto-discovery and Pi settings files. */
  bare?: boolean;
  /** Pi-specific configuration from eforge.yaml. */
  piConfig?: PiConfig;
}

// ---------------------------------------------------------------------------
// Thinking mapping
// ---------------------------------------------------------------------------

/**
 * Map eforge ThinkingConfig to Pi ThinkingLevel.
 *
 * - disabled -> 'off'
 * - adaptive -> 'medium'
 * - enabled -> 'high'
 */
function mapThinkingConfig(thinking: ThinkingConfig): ThinkingLevel {
  switch (thinking.type) {
    case 'disabled': return 'off';
    case 'adaptive': return 'medium';
    case 'enabled': return 'high';
  }
}

/**
 * Map eforge EffortLevel to Pi ThinkingLevel as fallback.
 *
 * - low -> 'off'
 * - medium -> 'medium'
 * - high -> 'high'
 * - max -> 'high'
 */
function mapEffortLevel(effort: EffortLevel): ThinkingLevel {
  switch (effort) {
    case 'low': return 'off';
    case 'medium': return 'medium';
    case 'high': return 'high';
    case 'max': return 'high';
  }
}

/**
 * Resolve thinking level from options, with Pi config as default fallback.
 */
function resolveThinkingLevel(options: AgentRunOptions, piConfig?: PiConfig): ThinkingLevel {
  if (options.thinking) return mapThinkingConfig(options.thinking);
  if (options.effort) return mapEffortLevel(options.effort);
  return piConfig?.thinkingLevel ?? 'medium';
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

/**
 * Parse a model string like "anthropic/claude-sonnet-4" into provider + modelId.
 * Falls back to "openrouter" provider if no slash is present.
 */
function parseModelString(model: string): { provider: string; modelId: string } {
  const slashIdx = model.indexOf('/');
  if (slashIdx > 0) {
    return { provider: model.slice(0, slashIdx), modelId: model.slice(slashIdx + 1) };
  }
  return { provider: 'openrouter', modelId: model };
}

/**
 * Resolve a Pi Model from an eforge model string.
 * Uses pi-ai's getModel for known provider/model combos.
 * Falls back to constructing a minimal model object for unknown combos.
 */
function resolveModel(modelStr: string | undefined, piConfig?: PiConfig): Model<Api> {
  const effectiveModel = modelStr ?? piConfig?.model;
  if (!effectiveModel) {
    // Default to anthropic/claude-sonnet-4
    return getModel('anthropic', 'claude-sonnet-4' as never) as Model<Api>;
  }

  const { provider, modelId } = parseModelString(effectiveModel);
  try {
    return getModel(provider as never, modelId as never) as Model<Api>;
  } catch {
    // Unknown model — construct a minimal model object for openrouter-style routing
    return {
      id: modelId,
      name: effectiveModel,
      api: 'openai-completions' as Api,
      provider,
      baseUrl: provider === 'openrouter' ? 'https://openrouter.ai/api/v1' : `https://api.${provider}.com`,
      reasoning: true,
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 16384,
    };
  }
}

// ---------------------------------------------------------------------------
// Tool filtering
// ---------------------------------------------------------------------------

/**
 * Filter tools based on allowedTools / disallowedTools lists.
 * Pi doesn't have built-in tool filtering, so we do it before passing to the session.
 */
function filterTools(
  tools: AgentTool[],
  allowedTools?: string[],
  disallowedTools?: string[],
): AgentTool[] {
  let filtered = tools;

  if (allowedTools && allowedTools.length > 0) {
    const allowed = new Set(allowedTools);
    filtered = filtered.filter(t => allowed.has(t.name));
  }

  if (disallowedTools && disallowedTools.length > 0) {
    const disallowed = new Set(disallowedTools);
    filtered = filtered.filter(t => !disallowed.has(t.name));
  }

  return filtered;
}

// ---------------------------------------------------------------------------
// Event translation
// ---------------------------------------------------------------------------

/**
 * Translate a Pi AgentEvent to EforgeEvent(s) and push them into the queue.
 */
function translatePiEvent(
  event: AgentSessionEvent,
  queue: AsyncEventQueue<EforgeEvent>,
  agent: AgentRole,
  agentId: string,
  planId?: string,
): void {
  const ts = new Date().toISOString();

  switch (event.type) {
    case 'message_start':
    case 'message_end':
      // message_start/end are lifecycle markers — we extract text from message_update
      break;

    case 'message_update': {
      // Extract text content from the partial assistant message
      const msg = event.assistantMessageEvent;
      if (msg.type === 'text_delta') {
        queue.push({
          timestamp: ts,
          type: 'agent:message',
          planId,
          agentId,
          agent,
          content: msg.delta,
        });
      }
      break;
    }

    case 'tool_execution_start': {
      queue.push({
        timestamp: ts,
        type: 'agent:tool_use',
        planId,
        agentId,
        agent,
        tool: event.toolName,
        toolUseId: event.toolCallId,
        input: event.args,
      });
      break;
    }

    case 'tool_execution_end': {
      const output = typeof event.result === 'string'
        ? event.result
        : JSON.stringify(event.result);
      queue.push({
        timestamp: ts,
        type: 'agent:tool_result',
        planId,
        agentId,
        agent,
        tool: event.toolName,
        toolUseId: event.toolCallId,
        output: truncateOutput(output, 4096),
      });
      break;
    }

    case 'agent_end': {
      // Extract final text from messages
      const messages = event.messages;
      let resultText = '';
      for (const m of messages) {
        if ('role' in m && m.role === 'assistant' && 'content' in m) {
          const content = m.content;
          if (typeof content === 'string') {
            resultText = content;
          } else if (Array.isArray(content)) {
            const texts = content
              .filter((c: { type: string }) => c.type === 'text')
              .map((c: { type: string; text?: string }) => c.text ?? '');
            if (texts.length > 0) resultText = texts.join('');
          }
        }
      }

      // We'll emit agent:result from the run() method after session stats are available
      break;
    }

    default:
      // turn_start, turn_end, agent_start, tool_execution_update — not mapped
      break;
  }
}

/**
 * Truncate tool output to prevent bloated traces.
 */
function truncateOutput(output: string, maxLength: number): string {
  if (output.length <= maxLength) return output;
  return output.slice(0, maxLength) + `... [truncated from ${output.length} chars]`;
}

// ---------------------------------------------------------------------------
// Auth resolution
// ---------------------------------------------------------------------------

/**
 * Resolve API key from config or environment variables.
 * Priority: piConfig.apiKey > provider-specific env vars > Pi's auth.json
 */
function resolveApiKey(provider: string, piConfig?: PiConfig): string | undefined {
  if (piConfig?.apiKey) return piConfig.apiKey;

  // Check provider-specific env vars
  const envVarMap: Record<string, string> = {
    openrouter: 'OPENROUTER_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    google: 'GOOGLE_API_KEY',
    mistral: 'MISTRAL_API_KEY',
    groq: 'GROQ_API_KEY',
    xai: 'XAI_API_KEY',
  };

  const envVar = envVarMap[provider];
  if (envVar && process.env[envVar]) {
    return process.env[envVar];
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// PiBackend
// ---------------------------------------------------------------------------

export class PiBackend implements AgentBackend {
  private readonly mcpServers?: Record<string, McpServerConfig>;
  private readonly extensions?: PiExtensionConfig;
  private readonly bare: boolean;
  private readonly piConfig?: PiConfig;
  private mcpBridge: PiMcpBridge | null = null;

  constructor(options?: PiBackendOptions) {
    this.mcpServers = options?.mcpServers;
    this.extensions = options?.extensions;
    this.bare = options?.bare ?? false;
    this.piConfig = options?.piConfig;
  }

  async *run(options: AgentRunOptions, agent: AgentRole, planId?: string): AsyncGenerator<EforgeEvent> {
    const agentId = crypto.randomUUID();
    yield { type: 'agent:start', planId, agent, agentId, timestamp: new Date().toISOString() };

    let error: string | undefined;
    const startTime = Date.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let session: any;

    try {
      // Resolve model
      const model = resolveModel(options.model, this.piConfig);
      const thinkingLevel = resolveThinkingLevel(options, this.piConfig);

      // Resolve API key
      const apiKey = resolveApiKey(model.provider, this.piConfig);

      // Build auth storage with resolved key
      const authStorage = apiKey
        ? AuthStorage.inMemory({ [model.provider]: { type: 'api_key', key: apiKey } })
        : AuthStorage.inMemory();

      // Build tools
      const isCoding = options.tools === 'coding';
      const baseTools = isCoding ? createCodingTools(options.cwd) : createReadOnlyTools(options.cwd);

      // Collect MCP tools (only for coding agents)
      let mcpTools: AgentTool[] = [];
      if (isCoding && this.mcpServers && Object.keys(this.mcpServers).length > 0) {
        if (!this.mcpBridge) {
          this.mcpBridge = new PiMcpBridge(this.mcpServers);
        }
        mcpTools = await this.mcpBridge.getTools();
      }

      // Collect extension tools (only for coding agents, skip in bare mode)
      let extensionPaths: string[] = [];
      if (isCoding && !this.bare) {
        extensionPaths = await discoverPiExtensions(options.cwd, this.extensions);
      }

      // Combine all tools and apply filtering
      let allTools = [...baseTools, ...mcpTools];
      allTools = filterTools(allTools, options.allowedTools, options.disallowedTools);

      // Create model registry
      const modelRegistry = new ModelRegistry(authStorage);

      // Create session manager (in-memory, no persistence needed for one-shot agents)
      const sessionManager = SessionManager.inMemory();

      // Create settings manager
      const settingsManager = SettingsManager.create(options.cwd);

      // Create agent session
      ({ session } = await createAgentSession({
        cwd: options.cwd,
        model,
        thinkingLevel,
        tools: baseTools,
        customTools: [],
        authStorage,
        modelRegistry,
        sessionManager,
        settingsManager,
      }));

      // Set up extension tools on the session if we have extensions
      if (extensionPaths.length > 0) {
        // Load extensions via Pi's discovery mechanism
        const extensionResult = await discoverAndLoadExtensions(extensionPaths, options.cwd);
        // Extension tools are registered through the session's extension runner
        if (extensionResult.extensions.length > 0) {
          await session.bindExtensions({});
        }
      }

      // Set up the event queue for bridging Pi events to EforgeEvents
      const eventQueue = new AsyncEventQueue<EforgeEvent>();
      eventQueue.addProducer();

      // Track usage for result
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let totalCacheRead = 0;
      let totalCacheWrite = 0;
      let totalCost = 0;
      let numTurns = 0;
      let resultText = '';

      // Subscribe to Pi agent events (session emits AgentSessionEvent which is a superset of AgentEvent)
      const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
        translatePiEvent(event, eventQueue, agent, agentId, planId);

        // Track turns and check budget per-turn
        if (event.type === 'turn_end') {
          numTurns++;
          // Update cumulative cost from session stats after each turn
          const stats = session.getSessionStats();
          totalInputTokens = stats.tokens.input;
          totalOutputTokens = stats.tokens.output;
          totalCacheRead = stats.tokens.cacheRead;
          totalCacheWrite = stats.tokens.cacheWrite;
          totalCost = stats.cost;

          // Enforce budget per-turn to abort early
          if (options.maxBudgetUsd !== undefined && totalCost > options.maxBudgetUsd) {
            session.abort();
            error = `Budget exceeded: $${totalCost.toFixed(4)} > $${options.maxBudgetUsd}`;
          }
        }

        // Handle error events — prevent the generator from hanging
        if ((event as { type: string }).type === 'error') {
          const errMsg = 'error' in event && (event as { error: unknown }).error instanceof Error
            ? ((event as { error: Error }).error).message
            : 'message' in event ? String((event as { message: unknown }).message) : 'Pi session error';
          error = errMsg;
        }

        // Capture final result text from agent_end
        if (event.type === 'agent_end') {
          const messages = event.messages;
          for (const m of messages) {
            if ('role' in m && m.role === 'assistant' && 'content' in m) {
              const content = m.content;
              if (typeof content === 'string') {
                resultText = content;
              } else if (Array.isArray(content)) {
                const texts = (content as Array<{ type: string; text?: string }>)
                  .filter(c => c.type === 'text')
                  .map(c => c.text ?? '');
                if (texts.length > 0) resultText = texts.join('');
              }
            }
          }
        }
      });

      // Wire abort signal
      if (options.abortSignal) {
        options.abortSignal.addEventListener('abort', () => {
          session.abort();
        }, { once: true });
      }

      // Send prompt — non-blocking so events stream through the queue concurrently
      const promptDone = session.prompt(options.prompt).then(() => {
        // Final stats update (in case turn_end didn't fire for the last turn)
        const stats = session.getSessionStats();
        totalInputTokens = stats.tokens.input;
        totalOutputTokens = stats.tokens.output;
        totalCacheRead = stats.tokens.cacheRead;
        totalCacheWrite = stats.tokens.cacheWrite;
        totalCost = stats.cost;
      }).catch((err: unknown) => {
        error = err instanceof Error ? err.message : String(err);
      }).finally(() => {
        unsubscribe();
        eventQueue.removeProducer();
      });

      // Yield events as they stream in from the queue
      for await (const event of eventQueue) {
        yield event;
        // If budget was exceeded in the subscriber, stop yielding
        if (error) break;
      }

      // Wait for prompt to finish
      await promptDone;

      // Emit agent:result
      const durationMs = Date.now() - startTime;
      const resultData: AgentResultData = {
        durationMs,
        durationApiMs: durationMs, // Pi doesn't separate API time
        numTurns,
        totalCostUsd: totalCost,
        usage: {
          input: totalInputTokens,
          output: totalOutputTokens,
          total: totalInputTokens + totalOutputTokens,
          cacheRead: totalCacheRead,
          cacheCreation: totalCacheWrite,
        },
        modelUsage: {
          [model.id]: {
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            cacheReadInputTokens: totalCacheRead,
            cacheCreationInputTokens: totalCacheWrite,
            costUSD: totalCost,
          },
        },
        resultText: resultText || undefined,
      };

      yield { timestamp: new Date().toISOString(), type: 'agent:result', planId, agent, result: resultData };

      if (error) {
        throw new Error(error);
      }

      // Handle fallback model retry
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);

      // Attempt fallback model if configured and this looks like a model error
      if (options.fallbackModel && isModelError(error)) {
        // Re-run with fallback model
        const fallbackOptions = { ...options, model: options.fallbackModel, fallbackModel: undefined };
        yield* this.run(fallbackOptions, agent, planId);
        return;
      }

      throw err;
    } finally {
      // Abort the session to prevent orphaned background processes
      try { session?.abort(); } catch { /* ignore abort errors */ }

      yield { type: 'agent:stop', planId, agent, agentId, error, timestamp: new Date().toISOString() };

      // Clean up MCP bridge if we created one
      // Note: we keep the bridge alive across runs for connection reuse
    }
  }
}

/**
 * Check if an error message suggests a model-related issue (not found, unauthorized, etc.)
 */
function isModelError(errorMsg: string): boolean {
  const modelErrorPatterns = [
    'model not found',
    'model_not_found',
    'invalid model',
    'unsupported model',
    'model not available',
    '404',
    '401',
    '403',
  ];
  const lower = errorMsg.toLowerCase();
  return modelErrorPatterns.some(p => lower.includes(p));
}
