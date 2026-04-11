/**
 * Shared usage normalization helper for agent backends.
 *
 * Canonical convention: `input = uncachedInput + cacheRead + cacheCreation`.
 *
 * Every backend MUST funnel raw counters through `normalizeUsage` (for the
 * `usage` field on `agent:usage` events and `AgentResultData`) and through
 * `toModelUsageEntry` (for per-model `AgentResultData.modelUsage` entries)
 * before emitting. The `uncachedInput` parameter name is deliberate — it
 * prevents a caller from accidentally passing a pre-inflated number and
 * keeps the monitor UI formula `cacheRead / input` bounded to `[0, 1]`.
 */

import type { AgentResultData } from '../events.js';

/** Raw per-turn or per-model counters as reported by the provider SDK. */
export interface RawUsage {
  /** Uncached input tokens only. Must NOT already include cache tokens. */
  uncachedInput: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export type NormalizedUsage = AgentResultData['usage'];
export type ModelUsageEntry = AgentResultData['modelUsage'][string];

/**
 * Normalize raw counters into the event-shaped usage object, inflating
 * `input` to include cache tokens per the canonical convention.
 */
export function normalizeUsage(raw: RawUsage): NormalizedUsage {
  const input = raw.uncachedInput + raw.cacheRead + raw.cacheCreation;
  return {
    input,
    output: raw.output,
    total: input + raw.output,
    cacheRead: raw.cacheRead,
    cacheCreation: raw.cacheCreation,
  };
}

/**
 * Build a per-model `modelUsage` entry from raw counters. `inputTokens` is
 * inflated to match `normalizeUsage`'s convention so aggregate sums stay
 * consistent across the top-level `usage` field and the per-model breakdown.
 */
export function toModelUsageEntry(raw: RawUsage, costUSD: number): ModelUsageEntry {
  return {
    inputTokens: raw.uncachedInput + raw.cacheRead + raw.cacheCreation,
    outputTokens: raw.output,
    cacheReadInputTokens: raw.cacheRead,
    cacheCreationInputTokens: raw.cacheCreation,
    costUSD,
  };
}
