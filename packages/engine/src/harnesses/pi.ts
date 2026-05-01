/**
 * Pi coding agent harness — implements AgentHarness using @mariozechner/pi-coding-agent.
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
  DefaultResourceLoader,
  discoverAndLoadExtensions,
  getAgentDir,
  type AgentSessionEvent,
  type ToolDefinition,
} from '@mariozechner/pi-coding-agent';
import { getModel } from '@mariozechner/pi-ai';
import type { Model, Api } from '@mariozechner/pi-ai';
import type { AgentTool, ThinkingLevel } from '@mariozechner/pi-agent-core';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { EforgeEvent, AgentRole, AgentResultData } from '../events.js';
import type { AgentHarness, AgentRunOptions, ThinkingConfig, EffortLevel, HarnessDebugCallback, HarnessDebugPayload } from '../harness.js';
import type { PiConfig } from '../config.js';
import { AsyncEventQueue } from '../concurrency.js';
import { PiMcpBridge } from './pi-mcp-bridge.js';
import { discoverPiExtensions, type PiExtensionConfig } from './pi-extensions.js';
import { normalizeUsage, toModelUsageEntry } from './usage.js';
import { buildAgentStartEvent, normalizeToolUseId } from './common.js';
import { isEforgePiResource, EFORGE_PI_PACKAGE_NAME } from './eforge-resource-filter.js';
import { z } from 'zod/v4';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PiHarnessOptions {
  /** MCP servers to bridge as Pi AgentTools. */
  mcpServers?: Record<string, McpServerConfig>;
  /** Pi extension discovery configuration. */
  extensions?: PiExtensionConfig;
  /** When true, skip extension auto-discovery and Pi settings files. */
  bare?: boolean;
  /** Pi-specific configuration from eforge/config.yaml. */
  piConfig?: PiConfig;
  /**
   * Optional callback fired just before each `session.prompt` dispatch with a
   * snapshot of the request (system prompt, tools, model, etc.). Used by
   * diagnostic tooling like `eforge debug-composer` to compare framing across
   * harnesses.
   */
  onDebugPayload?: HarnessDebugCallback;
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
 * Map eforge EffortLevel to Pi ThinkingLevel.
 *
 * pi-ai's ThinkingLevel range is 'off' | 'low' | 'medium' | 'high' | 'xhigh'.
 * pi-ai has no 'max' level; its 'xhigh' is adaptive-max for Opus 4.6+,
 * which semantically matches eforge's 'max'.
 *
 * - low -> 'low'
 * - medium -> 'medium'
 * - high -> 'high'
 * - xhigh -> 'xhigh'
 * - max -> 'xhigh'
 */
function mapEffortLevel(effort: EffortLevel): ThinkingLevel {
  switch (effort) {
    case 'low': return 'low';
    case 'medium': return 'medium';
    case 'high': return 'high';
    case 'xhigh': return 'xhigh';
    case 'max': return 'xhigh';
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
// Tool filtering
// ---------------------------------------------------------------------------

/**
 * Filter tools based on allowedTools / disallowedTools lists.
 * Pi doesn't have built-in tool filtering, so we do it before passing to the session.
 *
 * Generic over any object with a `name` field so that the same filter logic
 * applies to both Pi built-in/bridged `AgentTool`s and `ToolDefinition`s
 * without commingling them into a single array.
 */
function filterTools<T extends { name: string }>(
  tools: T[],
  allowedTools?: string[],
  disallowedTools?: string[],
): T[] {
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
        toolUseId: normalizeToolUseId({ toolCallId: event.toolCallId }),
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
        toolUseId: normalizeToolUseId({ toolCallId: event.toolCallId }),
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
// PiHarness
// ---------------------------------------------------------------------------

export class PiHarness implements AgentHarness {
  private readonly mcpServers?: Record<string, McpServerConfig>;
  private readonly extensions?: PiExtensionConfig;
  private readonly bare: boolean;
  private readonly piConfig?: PiConfig;
  private readonly onDebugPayload?: HarnessDebugCallback;
  private mcpBridge: PiMcpBridge | null = null;

  constructor(options?: PiHarnessOptions) {
    this.mcpServers = options?.mcpServers;
    this.extensions = options?.extensions;
    this.bare = options?.bare ?? false;
    this.piConfig = options?.piConfig;
    this.onDebugPayload = options?.onDebugPayload;
  }

  /**
   * Pi registers custom tools directly by their bare name — there is no
   * MCP-wrapper convention like the Claude SDK's `mcp__<server>__<tool>`
   * prefix. The model calls the tool by exactly `CustomTool.name`.
   */
  effectiveCustomToolName(name: string): string {
    return name;
  }

  async *run(options: AgentRunOptions, agent: AgentRole, planId?: string): AsyncGenerator<EforgeEvent> {
    const agentId = crypto.randomUUID();

    // Validate model ref before proceeding
    if (!options.model) {
      yield buildAgentStartEvent({
        planId,
        agentId,
        agent,
        model: 'unknown',
        harness: 'pi',
        harnessSource: options.harnessSource ?? 'tier',
        tier: options.tier ?? 'unknown',
        tierSource: options.tierSource ?? 'tier',
        effort: options.effort,
        effortSource: options.effortSource,
        thinking: options.thinking,
        thinkingSource: options.thinkingSource,
        effortClamped: options.effortClamped,
        effortOriginal: options.effortOriginal,
        thinkingCoerced: options.thinkingCoerced,
        thinkingOriginal: options.thinkingOriginal,
      });
      yield { type: 'agent:stop', planId, agent, agentId, error: 'No model configured for Pi backend. Set the model on the tier recipe in eforge/config.yaml.', timestamp: new Date().toISOString() };
      return;
    }

    if (!options.model.provider) {
      yield buildAgentStartEvent({
        planId,
        agentId,
        agent,
        model: options.model.id,
        harness: 'pi',
        harnessSource: options.harnessSource ?? 'tier',
        tier: options.tier ?? 'unknown',
        tierSource: options.tierSource ?? 'tier',
        effort: options.effort,
        effortSource: options.effortSource,
        thinking: options.thinking,
        thinkingSource: options.thinkingSource,
        effortClamped: options.effortClamped,
        effortOriginal: options.effortOriginal,
        thinkingCoerced: options.thinkingCoerced,
        thinkingOriginal: options.thinkingOriginal,
      });
      yield { type: 'agent:stop', planId, agent, agentId, error: `No provider in model ref for Pi backend. Tier recipes with harness "pi" must set pi.provider.`, timestamp: new Date().toISOString() };
      return;
    }

    const thinkingLevel = resolveThinkingLevel(options, this.piConfig);

    yield buildAgentStartEvent({
      planId,
      agentId,
      agent,
      model: options.model.id,
      harness: 'pi',
      harnessSource: options.harnessSource ?? 'tier',
      tier: options.tier ?? 'unknown',
      tierSource: options.tierSource ?? 'tier',
      effort: options.effort,
      effortSource: options.effortSource,
      thinking: options.thinking,
      thinkingSource: options.thinkingSource,
      effortClamped: options.effortClamped,
      effortOriginal: options.effortOriginal,
      thinkingCoerced: options.thinkingCoerced,
      thinkingOriginal: options.thinkingOriginal,
    });

    if (options.thinkingCoerced) {
      yield { type: 'agent:warning', planId, agentId, agent, code: 'thinking-coerced', message: `Thinking coerced from 'enabled' to 'adaptive': model ${options.model.id} only supports adaptive thinking`, timestamp: new Date().toISOString() };
    }

    let error: string | undefined;
    const startTime = Date.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let session: any;

    try {
      // Build file-backed auth storage (reads ~/.pi/agent/auth.json, env vars, and OAuth tokens)
      const authStorage = AuthStorage.create();

      // Resolve model via ModelRegistry (async) with fallback to getModel then synthetic
      const modelRegistry = ModelRegistry.create(authStorage);
      let model: Model<Api>;
      const registryModel = await modelRegistry.find(options.model.provider!, options.model.id) as Model<Api> | undefined;
      if (registryModel) {
        model = registryModel;
      } else {
        const knownModel = getModel(options.model.provider as never, options.model.id as never) as Model<Api> | undefined;
        if (knownModel) {
          model = knownModel;
        } else {
          // Unknown model id for this provider — crib transport metadata (baseUrl,
          // api, compat) from any sibling model already registered under the same
          // provider. This is essential for aggregator providers like OpenRouter,
          // where any model id is valid as long as the endpoint is right, so new
          // ids work the day they ship without waiting for pi-ai's static list
          // to catch up.
          const sibling = (modelRegistry.getAll() as Model<Api>[]).find(
            (m) => m.provider === options.model!.provider,
          );
          if (!sibling) {
            throw new Error(
              `Unknown model "${options.model.id}" and no models registered for provider "${options.model.provider}". ` +
              `Register the provider in ~/.pi/agent/models.json or choose a known model.`,
            );
          }
          model = {
            ...sibling,
            id: options.model.id,
            name: options.model.id,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          };
        }
      }

      // Apply explicit API key override from piConfig if set
      if (this.piConfig?.apiKey) {
        authStorage.setRuntimeApiKey(model.provider, this.piConfig.apiKey);
      }

      // Build tools
      const isCoding = options.tools === 'coding';
      const baseTools = isCoding ? createCodingTools(options.cwd) : createReadOnlyTools(options.cwd);

      // Collect bridged MCP tools (only for coding agents). These come from
      // `PiMcpBridge` and are kept strictly separate from planner-supplied
      // `customTools` so each tool source can be filtered independently and
      // no cast is needed when handing them to the Pi session.
      let bridgedMcpTools: AgentTool[] = [];
      if (isCoding && this.mcpServers && Object.keys(this.mcpServers).length > 0) {
        if (!this.mcpBridge) {
          this.mcpBridge = new PiMcpBridge(this.mcpServers);
        }
        bridgedMcpTools = await this.mcpBridge.getTools();
      }

      // Collect extension tools (only for coding agents, skip in bare mode)
      let extensionPaths: string[] = [];
      if (isCoding && !this.bare) {
        extensionPaths = await discoverPiExtensions(options.cwd, this.extensions);
      }

      // Convert eforge CustomTools to Pi 0.68 ToolDefinition objects. The
      // execute callback matches Pi's arity-5 signature
      // `(toolCallId, params, signal, onUpdate, ctx)`; the planner handler
      // only uses `params`, the rest are accepted and ignored.
      const eforgeCustomTools: ToolDefinition[] = [];
      if (options.customTools && options.customTools.length > 0) {
        const { jsonSchemaToTypeBox } = await import('./pi-mcp-bridge.js');
        for (const ct of options.customTools) {
          const jsonSchema = z.toJSONSchema(ct.inputSchema) as Record<string, unknown>;
          const parameters = jsonSchemaToTypeBox(jsonSchema);
          const execute: ToolDefinition['execute'] = async (
            _toolCallId,
            params,
            _signal,
            _onUpdate,
            _ctx,
          ) => {
            try {
              const result = await ct.handler(params);
              return {
                content: [{ type: 'text' as const, text: result }],
                details: {},
              };
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              return {
                content: [{ type: 'text' as const, text: `Error: ${message}` }],
                details: {},
              };
            }
          };
          eforgeCustomTools.push({
            name: ct.name,
            label: ct.name,
            description: ct.description,
            parameters,
            execute,
          });
        }
      }

      // Filter built-in, bridged, and eforge custom tools independently so
      // each respects `allowedTools`/`disallowedTools` without interfering
      // with the others.
      const filteredBaseTools = filterTools(baseTools, options.allowedTools, options.disallowedTools);
      const filteredBridgedMcpTools = filterTools(bridgedMcpTools, options.allowedTools, options.disallowedTools);
      const filteredEforgeCustomTools = filterTools(eforgeCustomTools, options.allowedTools, options.disallowedTools);

      // Create session manager (in-memory, no persistence needed for one-shot agents)
      const sessionManager = SessionManager.inMemory();

      // Create settings manager
      const settingsManager = SettingsManager.create(options.cwd);

      // Build a resource loader with overrides that strip anything contributed
      // by the `@eforge-build/pi-eforge` package (extension + skills + prompts
      // + themes). Without this, Pi's DefaultPackageManager auto-discovers any
      // user-installed pi-eforge package from ~/.pi/agent/settings.json and
      // registers its `eforge_*` tools into every agent session — which would
      // let eforge-run agents recursively invoke eforge itself. User-installed
      // packages that are NOT pi-eforge are left untouched so users can still
      // bring their own skills / extensions into eforge agent contexts.
      let eforgeExtensionsFiltered = 0;
      let eforgeSkillsFiltered = 0;
      let eforgePromptsFiltered = 0;
      let eforgeThemesFiltered = 0;
      const resourceLoader = new DefaultResourceLoader({
        cwd: options.cwd,
        agentDir: getAgentDir(),
        settingsManager,
        extensionsOverride: (base) => ({
          ...base,
          extensions: base.extensions.filter((ext) => {
            const drop = isEforgePiResource({
              resolvedPath: ext.resolvedPath,
              sourceInfoSource: ext.sourceInfo?.source,
            });
            if (drop) eforgeExtensionsFiltered += 1;
            return !drop;
          }),
        }),
        skillsOverride: (base) => ({
          ...base,
          skills: base.skills.filter((skill) => {
            const drop = isEforgePiResource({
              resolvedPath: skill.filePath,
              sourceInfoSource: skill.sourceInfo?.source,
            });
            if (drop) eforgeSkillsFiltered += 1;
            return !drop;
          }),
        }),
        promptsOverride: (base) => ({
          ...base,
          prompts: base.prompts.filter((prompt) => {
            const drop = isEforgePiResource({
              resolvedPath: prompt.filePath,
              sourceInfoSource: prompt.sourceInfo?.source,
            });
            if (drop) eforgePromptsFiltered += 1;
            return !drop;
          }),
        }),
        themesOverride: (base) => ({
          ...base,
          themes: base.themes.filter((theme) => {
            // Themes carry their sourceInfo at the top level.
            const resolvedPath = theme.sourceInfo?.path ?? '';
            const drop = isEforgePiResource({
              resolvedPath,
              sourceInfoSource: theme.sourceInfo?.source,
            });
            if (drop) eforgeThemesFiltered += 1;
            return !drop;
          }),
        }),
      });
      await resourceLoader.reload();

      // Create agent session using the filtered resource loader.
      //
      // `tools` on `createAgentSession` is an allowlist that gates BOTH
      // built-in tools AND the `customTools` array (see pi-coding-agent
      // `agent-session.ts#_refreshToolRegistry`: `isAllowedTool(name)` is
      // applied to every custom tool). If we only pass built-in tool names,
      // pi strips every bridged MCP tool and every planner submission tool
      // before the model ever sees them - the model then reads the planner
      // prompt, tries to call `submit_plan_set`, gets a "tool not registered"
      // response from pi's dispatch, and declares the tool "isn't available
      // in this environment" before falling back to Write.
      //
      // Include the bridged + eforge custom tool names in the allowlist so
      // they survive pi's filter.
      ({ session } = await createAgentSession({
        cwd: options.cwd,
        model,
        thinkingLevel,
        tools: [
          ...filteredBaseTools.map((t) => t.name),
          ...filteredBridgedMcpTools.map((t) => t.name),
          ...filteredEforgeCustomTools.map((t) => t.name),
        ],
        customTools: [...filteredBridgedMcpTools, ...filteredEforgeCustomTools],
        authStorage,
        modelRegistry,
        sessionManager,
        settingsManager,
        resourceLoader,
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

      // Cumulative snapshot captured at the end of each turn. Pi's
      // `session.getSessionStats()` reports cumulative session totals; we
      // subtract the previous snapshot to emit per-turn deltas on
      // `agent:usage`, matching the unified cadence contract (deltas per
      // turn plus one `final: true` cumulative at session end).
      const prevCumulative = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
      };

      // Subscribe to Pi agent events (session emits AgentSessionEvent which is a superset of AgentEvent)
      const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
        translatePiEvent(event, eventQueue, agent, agentId, planId);

        // Track turns and check budget per-turn
        if (event.type === 'turn_end') {
          // Detect SDK-level backend errors reported via the assistant message's
          // stopReason. pi-ai does not throw on unreachable backends; it returns
          // an AssistantMessage with stopReason='error' and errorMessage set.
          const turnMsg = (event as { message?: { stopReason?: string; errorMessage?: string } }).message;
          if (turnMsg && turnMsg.stopReason === 'error') {
            const backendMsg = turnMsg.errorMessage && turnMsg.errorMessage.length > 0
              ? `Backend error: ${turnMsg.errorMessage}`
              : 'Backend returned an error response with no message';
            error = backendMsg;
            try { session.abort(); } catch { /* ignore */ }
            return;
          }
          numTurns++;
          // Update cumulative cost from session stats after each turn
          const stats = session.getSessionStats();
          totalInputTokens = stats.tokens.input;
          totalOutputTokens = stats.tokens.output;
          totalCacheRead = stats.tokens.cacheRead;
          totalCacheWrite = stats.tokens.cacheWrite;
          totalCost = stats.cost;

          // Compute per-turn deltas by subtracting the previously observed
          // cumulative snapshot, then advance the snapshot. Per the unified
          // cadence contract, non-final `agent:usage` events carry deltas;
          // the authoritative cumulative total is emitted once at session
          // end with `final: true`.
          const deltaUncachedInput = totalInputTokens - prevCumulative.input;
          const deltaOutput = totalOutputTokens - prevCumulative.output;
          const deltaCacheRead = totalCacheRead - prevCumulative.cacheRead;
          const deltaCacheWrite = totalCacheWrite - prevCumulative.cacheWrite;
          const deltaCost = totalCost - prevCumulative.cost;
          prevCumulative.input = totalInputTokens;
          prevCumulative.output = totalOutputTokens;
          prevCumulative.cacheRead = totalCacheRead;
          prevCumulative.cacheWrite = totalCacheWrite;
          prevCumulative.cost = totalCost;

          // Emit agent:usage event (per-turn delta) for live monitoring
          eventQueue.push({
            timestamp: new Date().toISOString(),
            type: 'agent:usage',
            planId,
            agentId,
            agent,
            usage: normalizeUsage({
              uncachedInput: deltaUncachedInput,
              output: deltaOutput,
              cacheRead: deltaCacheRead,
              cacheCreation: deltaCacheWrite,
            }),
            costUsd: deltaCost,
            numTurns: 1,
          });

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

      // Fire debug capture hook with the fully-constructed request. At this
      // point session.state.systemPrompt includes the pi-coding-agent preamble,
      // tool snippets, ancestor AGENTS.md/CLAUDE.md context, skills, and
      // date/cwd metadata. session.state.tools is the final tool list visible
      // to the model.
      if (this.onDebugPayload) {
        const sessionState = session.state as { systemPrompt?: string; tools?: Array<{ name: string; description?: string; parameters?: unknown }> };
        const sessionTools = Array.isArray(sessionState.tools) ? sessionState.tools : [];
        const debugPayload: HarnessDebugPayload = {
          harness: 'pi',
          agent,
          userPrompt: options.prompt,
          systemPrompt: sessionState.systemPrompt ?? '',
          tools: sessionTools.map((t) => ({
            name: t.name,
            ...(t.description !== undefined ? { description: t.description } : {}),
            ...(t.parameters !== undefined ? { parameters: t.parameters } : {}),
          })),
          model: { id: options.model.id, provider: options.model.provider },
          ...(options.effort !== undefined ? { effort: options.effort } : {}),
          ...(options.thinking !== undefined ? { thinking: options.thinking } : {}),
          maxTurns: options.maxTurns,
          ...(options.allowedTools !== undefined ? { allowedTools: options.allowedTools } : {}),
          ...(options.disallowedTools !== undefined ? { disallowedTools: options.disallowedTools } : {}),
          extra: {
            toolsMode: options.tools,
            thinkingLevel,
            bare: this.bare,
            mcpServerNames: this.mcpServers ? Object.keys(this.mcpServers) : [],
            extensionPathCount: extensionPaths.length,
            baseToolCount: filteredBaseTools.length,
            bridgedMcpToolCount: filteredBridgedMcpTools.length,
            customToolCount: filteredEforgeCustomTools.length,
            systemPromptBytes: (sessionState.systemPrompt ?? '').length,
            eforgePackageName: EFORGE_PI_PACKAGE_NAME,
            eforgeExtensionsFiltered,
            eforgeSkillsFiltered,
            eforgePromptsFiltered,
            eforgeThemesFiltered,
            note: 'systemPrompt reflects what pi-coding-agent constructed: the coding-assistant preamble + tool snippets + ancestor AGENTS.md/CLAUDE.md + skills + date/cwd. Any resources contributed by @eforge-build/pi-eforge were filtered out via resourceLoader overrides to prevent eforge recursion.',
          },
        };
        await this.onDebugPayload(debugPayload);
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
        if (!error) {
          error = err instanceof Error ? err.message : String(err);
        }
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

      // Zero-token backstop: if the session completed turns but reported no
      // token usage at all, the backend likely failed silently (e.g. provider
      // swallowed the error without setting stopReason='error'). Legitimate
      // turns always consume at least the prompt's input tokens.
      if (!error && numTurns > 0 && totalInputTokens === 0 && totalOutputTokens === 0) {
        error = `Agent completed ${numTurns} turn(s) with zero token usage — backend may be unreachable or misconfigured`;
      }

      // Emit agent:result
      const durationMs = Date.now() - startTime;
      const resultData: AgentResultData = {
        durationMs,
        durationApiMs: durationMs, // Pi doesn't separate API time
        numTurns,
        totalCostUsd: totalCost,
        usage: normalizeUsage({
          uncachedInput: totalInputTokens,
          output: totalOutputTokens,
          cacheRead: totalCacheRead,
          cacheCreation: totalCacheWrite,
        }),
        modelUsage: {
          [model.id]: toModelUsageEntry(
            {
              uncachedInput: totalInputTokens,
              output: totalOutputTokens,
              cacheRead: totalCacheRead,
              cacheCreation: totalCacheWrite,
            },
            totalCost,
          ),
        },
        resultText: resultText || undefined,
      };

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

      if (error) {
        throw new Error(error);
      }

      // Handle fallback model retry
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);

      // Attempt fallback model if configured and this looks like a model error
      if (options.fallbackModel && isModelError(error)) {
        // Re-run with fallback model — wrap string in ModelRef, preserving original provider
        const fallbackModelRef = { id: options.fallbackModel, provider: options.model?.provider };
        const fallbackOptions = { ...options, model: fallbackModelRef, fallbackModel: undefined };
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
