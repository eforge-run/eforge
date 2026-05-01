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
  /** Text appended to the agent prompt after variable substitution. Not passed to the backend SDK. */
  promptAppend?: string;
}

/** Keys that are part of resolved agent config but should NOT be forwarded to the backend SDK. */
const NON_SDK_KEYS = new Set([
  'promptAppend', 'effortClamped', 'effortOriginal', 'effortSource',
  'thinkingSource', 'thinkingCoerced', 'thinkingOriginal',
  'tier', 'tierSource', 'harness', 'harnessSource',
]);

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
 * Every `agent:tool_use` and `agent:tool_result` event on the `AgentHarness`
 * event stream carries a stable identifier under the name `toolUseId`.
 * Provider SDKs use different names natively:
 *
 *  - Claude Agent SDK: `block.id` on `tool_use` content blocks.
 *  - Pi coding agent: `toolCallId` on `tool_execution_start` / `tool_execution_end` events.
 *
 * Harnesses are responsible for mapping their provider-native name onto
 * `toolUseId` before emission. The shared helper `normalizeToolUseId` in
 * `./harnesses/common.ts` is the single source of truth for that mapping so
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
  /** Custom tools to inject into the agent run (e.g. submission tools for planners). */
  customTools?: CustomTool[];
  /** True when the resolved effort was clamped to the model's maximum supported level. */
  effortClamped?: boolean;
  /** The original effort level before clamping was applied. */
  effortOriginal?: EffortLevel;
  /** Provenance of the resolved effort value. */
  effortSource?: 'tier' | 'role' | 'plan';
  /** Provenance of the resolved thinking value. */
  thinkingSource?: 'tier' | 'role' | 'plan';
  /** True when thinking was coerced from 'enabled' to 'adaptive' for models that only support adaptive thinking. */
  thinkingCoerced?: boolean;
  /** The original thinking config before coercion was applied. */
  thinkingOriginal?: ThinkingConfig;
  /** The resolved tier for this role. Stamped from resolveAgentConfig. */
  tier?: string;
  /** Provenance of the resolved tier value. */
  tierSource?: 'tier' | 'role' | 'plan';
  /** Harness kind for this role. Stamped from resolveAgentConfig. */
  harness?: 'claude-sdk' | 'pi';
  /** Provenance of the resolved harness value. */
  harnessSource?: 'tier';
}

/**
 * Harness abstraction for running AI agents.
 * Agent runners consume this interface — they never import the AI SDK directly.
 */
export interface AgentHarness {
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
 */
export interface HarnessDebugPayload {
  /** Which harness produced this payload. */
  harness: 'claude-sdk' | 'pi';
  /** The agent role this payload is for (e.g. `'pipeline-composer'`). */
  agent: AgentRole;
  /** The user prompt string passed into the run. */
  userPrompt: string;
  /** The fully-constructed system prompt as the backend sees it. */
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

/** Callback fired by a harness just before it dispatches a run to its SDK. */
export type HarnessDebugCallback = (payload: HarnessDebugPayload) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Typed Terminal Errors
// ---------------------------------------------------------------------------

/**
 * Terminal error subtypes mirrored from the Claude Agent SDK's `SDKResultError`.
 */
export type AgentTerminalSubtype =
  | 'error_max_turns'
  | 'error_max_budget_usd'
  | 'error_max_structured_output_retries'
  | 'error_during_execution';

/**
 * Thrown by backends when an agent run ends with a terminal SDK error.
 */
export class AgentTerminalError extends Error {
  readonly subtype: AgentTerminalSubtype;

  constructor(subtype: AgentTerminalSubtype, detail: string) {
    super(detail);
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
 * calling a submission tool.
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
