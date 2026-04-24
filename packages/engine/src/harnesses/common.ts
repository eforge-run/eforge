/**
 * Shared helpers for agent harnesses.
 *
 * Both `ClaudeSDKHarness` and `PiHarness` emit the same `EforgeEvent` union;
 * this module is the single source of truth for event construction patterns
 * that would otherwise drift between the two harnesses.
 *
 * - `buildAgentStartEvent` constructs the `agent:start` event with an
 *   option-bag API that keeps call sites greppable and trivially extended as
 *   new runtime-decision fields (effort/thinking/etc.) land on the event.
 * - `normalizeToolUseId` is the single point where provider-native tool-call
 *   identifiers (`block.id` for the Claude SDK, `toolCallId` for Pi) are
 *   mapped onto the unified `toolUseId` name used on the event stream.
 */

import type { EforgeEvent, AgentRole } from '../events.js';
import type { ThinkingConfig, EffortLevel } from '../harness.js';
import type { ModelClass } from '../config.js';

/** The concrete shape of an `agent:start` event on the eforge event stream. */
export type AgentStartEvent = Extract<EforgeEvent, { type: 'agent:start' }>;

/**
 * Options for {@link buildAgentStartEvent}. Mirrors the agent:start variant
 * of `EforgeEvent` plus the surrounding wrapper's `planId`/`timestamp`.
 */
export interface BuildAgentStartEventOptions {
  planId?: string;
  agentId: string;
  agent: AgentRole;
  model: string;
  /** The resolved agentRuntime config name (e.g. "opus", "pi-anthropic"). */
  agentRuntime: string;
  /** The harness kind for this runtime entry. */
  harness: 'claude-sdk' | 'pi';
  fallbackFrom?: ModelClass;
  effort?: EffortLevel;
  thinking?: ThinkingConfig;
  effortClamped?: boolean;
  effortOriginal?: EffortLevel;
  effortSource?: 'planner' | 'role-config' | 'global-config' | 'default';
  thinkingSource?: 'planner' | 'role-config' | 'global-config' | 'default';
  thinkingCoerced?: boolean;
  thinkingOriginal?: ThinkingConfig;
}

/**
 * Build an `agent:start` event without emitting any keys with `undefined`
 * values. Optional fields are copied through only when explicitly set so
 * downstream consumers (monitor UI, tracing) can use `in`-checks and
 * JSON round-trips without spurious nullish fields polluting the payload.
 *
 * The `timestamp` is captured at call time.
 */
export function buildAgentStartEvent(opts: BuildAgentStartEventOptions): AgentStartEvent {
  const event: AgentStartEvent = {
    type: 'agent:start',
    agentId: opts.agentId,
    agent: opts.agent,
    model: opts.model,
    agentRuntime: opts.agentRuntime,
    harness: opts.harness,
    timestamp: new Date().toISOString(),
  };
  if (opts.planId !== undefined) event.planId = opts.planId;
  if (opts.fallbackFrom !== undefined) event.fallbackFrom = opts.fallbackFrom;
  if (opts.effort !== undefined) event.effort = opts.effort;
  if (opts.thinking !== undefined) event.thinking = opts.thinking;
  if (opts.effortClamped !== undefined) event.effortClamped = opts.effortClamped;
  if (opts.effortOriginal !== undefined) event.effortOriginal = opts.effortOriginal;
  if (opts.effortSource !== undefined) event.effortSource = opts.effortSource;
  if (opts.thinkingSource !== undefined) event.thinkingSource = opts.thinkingSource;
  if (opts.thinkingCoerced !== undefined) event.thinkingCoerced = opts.thinkingCoerced;
  if (opts.thinkingOriginal !== undefined) event.thinkingOriginal = opts.thinkingOriginal;
  return event;
}

/**
 * Provider-native payload shapes that carry a tool-call identifier under
 * different field names. The Claude SDK emits tool-use content blocks with
 * an `id` field; Pi's agent events carry `toolCallId`.
 */
export interface ToolUseIdSource {
  /** Claude SDK tool_use block identifier. */
  id?: string;
  /** Pi agent-event tool-call identifier. */
  toolCallId?: string;
}

/**
 * Normalize a provider-native tool-call identifier onto the unified
 * `toolUseId` value used on eforge's event stream. Prefers `id` over
 * `toolCallId` when both are present. Throws when neither is set so that
 * the failure mode (missing identifier) is loud and localized instead of
 * propagating `undefined` into tool_use / tool_result events.
 */
export function normalizeToolUseId(raw: ToolUseIdSource): string {
  if (raw.id !== undefined) return raw.id;
  if (raw.toolCallId !== undefined) return raw.toolCallId;
  throw new Error(
    'normalizeToolUseId: missing tool-call identifier - neither "id" (Claude SDK) nor "toolCallId" (Pi) was present on the provider payload.',
  );
}
