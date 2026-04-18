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
}

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
