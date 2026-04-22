import type { EforgeEvent, AgentRole } from './events.js';
import type { ModelRef } from './config.js';
import type { z } from 'zod/v4';

export type ToolPreset = 'coding' | 'none';

// ---------------------------------------------------------------------------
// SDK Passthrough Types
// ---------------------------------------------------------------------------

/** Controls Claude's thinking/reasoning behavior. */
export type ThinkingConfig =
  | { type: 'adaptive' }
  | { type: 'enabled'; budgetTokens?: number }
  | { type: 'disabled' };

/** Effort level for controlling how much thinking/reasoning Claude applies. */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * SDK passthrough fields that can be configured per-agent.
 * All fields are optional — when `undefined`, the SDK uses its own defaults.
 */
export interface SdkPassthroughConfig {
  model?: ModelRef;
  thinking?: ThinkingConfig;
  effort?: EffortLevel;
  maxBudgetUsd?: number;
  fallbackModel?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  /** Set when the resolved model came from a fallback class instead of the role's effective class. */
  fallbackFrom?: import('./config.js').ModelClass;
  /** Text appended to the agent prompt after variable substitution. Not passed to the backend SDK. */
  promptAppend?: string;
}

/** Keys that are part of SdkPassthroughConfig but should NOT be forwarded to the backend SDK. */
const NON_SDK_KEYS = new Set(['promptAppend', 'effortClamped', 'effortOriginal', 'effortSource', 'thinkingSource', 'thinkingCoerced', 'thinkingOriginal']);

/**
 * Strip `undefined` values from an SdkPassthroughConfig so the SDK
 * doesn't receive explicit `undefined` keys, and omit non-SDK keys
 * like `promptAppend`. Returns a new object containing only the keys
 * that have defined values and are safe to forward to the backend.
 */

export function pickSdkOptions(config: SdkPassthroughConfig): Partial<SdkPassthroughConfig> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (value !== undefined && !NON_SDK_KEYS.has(key)) {
      result[key] = value;
    }
  }
  return result as Partial<SdkPassthroughConfig>;
}

// ---------------------------------------------------------------------------
// Event-Stream Naming Contracts
// ---------------------------------------------------------------------------

/**
 * Tool-call identifier normalization.
 *
 * Every `agent:tool_use` and `agent:tool_result` event on the `AgentBackend`
 * event stream carries a stable identifier under the name `toolUseId`.
 * Provider SDKs use different names natively:
 *
 *  - Claude Agent SDK: `block.id` on `tool_use` content blocks.
 *  - Pi coding agent: `toolCallId` on `tool_execution_start` / `tool_execution_end` events.
 *
 * Backends are responsible for mapping their provider-native name onto
 * `toolUseId` before emission. The shared helper `normalizeToolUseId` in
 * `./backends/common.ts` is the single source of truth for that mapping so
 * downstream consumers (monitor UI, CLI renderer, tracing) only ever see the
 * unified `toolUseId` name.
 */

// ---------------------------------------------------------------------------
// Custom Tools
// ---------------------------------------------------------------------------

/**
 * A custom tool that can be injected into an agent run.
 * The handler captures submission state via closure - no state management needed in the backend.
 */
export interface CustomTool {
  name: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  handler: (input: unknown) => Promise<string>;
}

// ---------------------------------------------------------------------------
// Agent Run Options & Backend Interface
// ---------------------------------------------------------------------------

export interface AgentRunOptions {
  prompt: string;
  cwd: string;
  maxTurns: number;
  tools: ToolPreset;
  model?: ModelRef;
  thinking?: ThinkingConfig;
  effort?: EffortLevel;
  maxBudgetUsd?: number;
  fallbackModel?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  abortSignal?: AbortSignal;
  /** Set when the resolved model came from a fallback class instead of the role's effective class. */
  fallbackFrom?: import('./config.js').ModelClass;
  /** Custom tools to inject into the agent run (e.g. submission tools for planners). */
  customTools?: CustomTool[];
  /** True when the resolved effort was clamped to the model's maximum supported level. */
  effortClamped?: boolean;
  /** The original effort level before clamping was applied. */
  effortOriginal?: EffortLevel;
  /** Provenance of the resolved effort value. */
  effortSource?: 'planner' | 'role-config' | 'global-config' | 'default';
  /** Provenance of the resolved thinking value. */
  thinkingSource?: 'planner' | 'role-config' | 'global-config' | 'default';
  /** True when thinking was coerced from 'enabled' to 'adaptive' for models that only support adaptive thinking. */
  thinkingCoerced?: boolean;
  /** The original thinking config before coercion was applied. */
  thinkingOriginal?: ThinkingConfig;
}

/**
 * Backend abstraction for running AI agents.
 * Agent runners consume this interface — they never import the AI SDK directly.
 */
export interface AgentBackend {
  /** Run an agent with the given prompt and yield EforgeEvents. */
  run(options: AgentRunOptions, agent: AgentRole, planId?: string): AsyncGenerator<EforgeEvent>;
  /**
   * Translate a bare `CustomTool.name` into the name the model will actually
   * see when the backend registers the tool. Agent runners (e.g. the planner)
   * use this to inject the correct backend-visible identifier into prompts so
   * the model calls the tool by its real name.
   *
   * - Claude SDK wraps custom tools in an in-process MCP server, so it
   *   prepends the SDK's MCP-server prefix to the bare name.
   * - Pi registers custom tools directly by their bare name, so it returns
   *   `name` unchanged.
   */
  effectiveCustomToolName(name: string): string;
}

// ---------------------------------------------------------------------------
// Debug Payload Capture
// ---------------------------------------------------------------------------

/**
 * Snapshot of the request a backend is about to send. Used by the
 * `eforge debug-composer` command and other diagnostic tooling to compare how
 * different backends frame the same agent run (system prompt, tools, model,
 * etc.) without needing to proxy the actual HTTP traffic.
 *
 * The payload captures what the backend hands off to its SDK / subprocess.
 * Downstream layers (the Claude Code CLI, pi-ai transport) may add their own
 * framing on top; for those cases, use native SDK debug facilities.
 */
export interface BackendDebugPayload {
  /** Which backend produced this payload. */
  backend: 'claude-sdk' | 'pi';
  /** The agent role this payload is for (e.g. `'pipeline-composer'`). */
  agent: AgentRole;
  /** The user prompt string passed into the run. */
  userPrompt: string;
  /**
   * The fully-constructed system prompt as the backend sees it.
   *
   * - Claude SDK: this is what eforge passes to the SDK. `""` means eforge
   *   did not set one and the SDK coerces `undefined` to `""`. The Claude
   *   Code CLI subprocess may still inject its own preset preamble on top
   *   of this when `systemPreset` is `'claude_code'`.
   * - Pi: this is the full prompt including the pi-coding-agent preamble,
   *   tool snippets, ancestor AGENTS.md/CLAUDE.md context, skills, date, cwd.
   */
  systemPrompt: string;
  /** Tool definitions the backend will expose to the model. Empty array means no tools. */
  tools: Array<{ name: string; description?: string; parameters?: unknown }>;
  /** Model identifier (id plus provider for pi). */
  model: { id: string; provider?: string };
  /** Effort level, if set. */
  effort?: EffortLevel;
  /** Thinking config, if set. */
  thinking?: ThinkingConfig;
  /** Max turns for the run. */
  maxTurns: number;
  /** Tool allowlist, if any. */
  allowedTools?: string[];
  /** Tool denylist (after `disableSubagents` is applied on claude-sdk), if any. */
  disallowedTools?: string[];
  /** Arbitrary backend-specific context (e.g. settingSources, contextFiles, thinkingLevel). */
  extra?: Record<string, unknown>;
}

/** Callback fired by a backend just before it dispatches a run to its SDK. */
export type BackendDebugCallback = (payload: BackendDebugPayload) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Typed Terminal Errors
// ---------------------------------------------------------------------------

/**
 * Terminal error subtypes mirrored from the Claude Agent SDK's `SDKResultError`.
 * Backends should throw `AgentTerminalError` with one of these values so the
 * pipeline can make structured decisions (e.g. continuation on `error_max_turns`)
 * without parsing error message strings.
 */
export type AgentTerminalSubtype =
  | 'error_max_turns'
  | 'error_max_budget_usd'
  | 'error_max_structured_output_retries'
  | 'error_during_execution';

/**
 * Thrown by backends when an agent run ends with a terminal SDK error.
 * Carries the machine-readable subtype so downstream continuation loops can
 * branch on the exact cause without inspecting `.message`.
 */
export class AgentTerminalError extends Error {
  readonly subtype: AgentTerminalSubtype;

  constructor(subtype: AgentTerminalSubtype, detail: string) {
    super(`${subtype}: ${detail}`);
    this.name = 'AgentTerminalError';
    this.subtype = subtype;
  }
}

/** True when `err` is an `AgentTerminalError` with subtype `error_max_turns`. */
export function isMaxTurnsError(err: unknown): err is AgentTerminalError {
  return err instanceof AgentTerminalError && err.subtype === 'error_max_turns';
}

/**
 * Thrown by the planner agent runner when the agent stream ends without ever
 * calling a submission tool (`submit_plan_set` / `submit_architecture`) and
 * without emitting a `<skip>` block. This is an engine-level detection — not
 * an SDK-level `AgentTerminalError` subtype — because eforge is observing that
 * the required structured-tool-use did not occur, rather than the SDK reporting
 * a structural failure.
 *
 * The pipeline's planner continuation loop treats this as retryable, sharing
 * the existing `AGENT_MAX_CONTINUATIONS_DEFAULTS['planner']` budget with
 * `error_max_turns` retries.
 */
export class PlannerSubmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlannerSubmissionError';
  }
}

/** True when `err` is a `PlannerSubmissionError`. */
export function isPlannerSubmissionError(err: unknown): err is PlannerSubmissionError {
  return err instanceof PlannerSubmissionError;
}
