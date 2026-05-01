/**
 * Shared helpers for agent harnesses.
 *
 * Both `ClaudeSDKHarness` and `PiHarness` emit the same `EforgeEvent` union;
 * this module is the single source of truth for event construction patterns
 * that would otherwise drift between the two harnesses.
 */

import type { EforgeEvent, AgentRole } from '../events.js';
import type { ThinkingConfig, EffortLevel } from '../harness.js';

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
  /** The harness kind for this role. */
  harness: 'claude-sdk' | 'pi';
  /** Always 'tier' — harness flows from the tier recipe. */
  harnessSource: 'tier';
  /** Tier this role belongs to. */
  tier: string;
  /** Provenance of the tier value. */
  tierSource: 'tier' | 'role' | 'plan';
  effort?: EffortLevel;
  effortSource?: 'tier' | 'role' | 'plan';
  thinking?: ThinkingConfig;
  thinkingSource?: 'tier' | 'role' | 'plan';
  effortClamped?: boolean;
  effortOriginal?: EffortLevel;
  thinkingCoerced?: boolean;
  thinkingOriginal?: ThinkingConfig;
}

/**
 * Build an `agent:start` event without emitting any keys with `undefined`
 * values.
 */
export function buildAgentStartEvent(opts: BuildAgentStartEventOptions): AgentStartEvent {
  const event: AgentStartEvent = {
    type: 'agent:start',
    agentId: opts.agentId,
    agent: opts.agent,
    model: opts.model,
    harness: opts.harness,
    harnessSource: opts.harnessSource,
    tier: opts.tier,
    tierSource: opts.tierSource,
    timestamp: new Date().toISOString(),
  };
  if (opts.planId !== undefined) event.planId = opts.planId;
  if (opts.effort !== undefined) event.effort = opts.effort;
  if (opts.effortSource !== undefined) event.effortSource = opts.effortSource;
  if (opts.thinking !== undefined) event.thinking = opts.thinking;
  if (opts.thinkingSource !== undefined) event.thinkingSource = opts.thinkingSource;
  if (opts.effortClamped !== undefined) event.effortClamped = opts.effortClamped;
  if (opts.effortOriginal !== undefined) event.effortOriginal = opts.effortOriginal;
  if (opts.thinkingCoerced !== undefined) event.thinkingCoerced = opts.thinkingCoerced;
  if (opts.thinkingOriginal !== undefined) event.thinkingOriginal = opts.thinkingOriginal;
  return event;
}

/**
 * Provider-native payload shapes that carry a tool-call identifier under
 * different field names.
 */
export interface ToolUseIdSource {
  /** Claude SDK tool_use block identifier. */
  id?: string;
  /** Pi agent-event tool-call identifier. */
  toolCallId?: string;
}

/**
 * Normalize a provider-native tool-call identifier onto the unified
 * `toolUseId` value used on eforge's event stream.
 */
export function normalizeToolUseId(raw: ToolUseIdSource): string {
  if (raw.id !== undefined) return raw.id;
  if (raw.toolCallId !== undefined) return raw.toolCallId;
  throw new Error(
    'normalizeToolUseId: missing tool-call identifier - neither "id" (Claude SDK) nor "toolCallId" (Pi) was present on the provider payload.',
  );
}
