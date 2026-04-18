/**
 * Data-driven model capability map.
 *
 * Provides a regex-keyed lookup table for model capabilities and a
 * `clampEffort()` function that returns the highest supported effort
 * level <= the requested level. Unknown models pass through without
 * clamping.
 */

import type { EffortLevel } from './backend.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Thinking level for capability descriptors. */
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'xhigh';

/** Capability descriptor for a model family. */
export interface ModelCapabilities {
  /** Human-readable label for this model family (e.g. "Opus 4.7"). */
  label: string;
  /** Ordered list of supported effort levels (low-to-high). */
  supportedEffort: readonly EffortLevel[];
  /** Default effort level for this model family. */
  defaultEffort?: EffortLevel;
  /** Maximum thinking level supported. */
  maxThinking?: ThinkingLevel;
  /** Thinking mode supported by this model: 'budgeted' supports fixed-budget thinking, 'adaptive-only' only supports adaptive. */
  thinkingMode?: 'budgeted' | 'adaptive-only';
}

/** Internal entry pairing a regex pattern to its capabilities. */
interface CapabilityEntry {
  match: RegExp;
  capabilities: ModelCapabilities;
}

// ---------------------------------------------------------------------------
// Effort level ordering — used by clampEffort
// ---------------------------------------------------------------------------

/** Canonical ordering of all effort levels from lowest to highest. */
const EFFORT_ORDER: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

// ---------------------------------------------------------------------------
// Model capability table
// ---------------------------------------------------------------------------

/**
 * Regex-keyed lookup table of model capabilities.
 * Entries are evaluated in order; first match wins.
 */
const MODEL_CAPABILITIES: readonly CapabilityEntry[] = [
  {
    match: /^claude-opus-4-7/,
    capabilities: {
      label: 'Opus 4.7',
      supportedEffort: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'high',
      thinkingMode: 'adaptive-only',
    },
  },
  {
    match: /^claude-opus-4-6/,
    capabilities: {
      label: 'Opus 4.6',
      supportedEffort: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'high',
    },
  },
  {
    match: /^claude-opus-4(\.|-)/,
    capabilities: {
      label: 'Opus 4',
      supportedEffort: ['low', 'medium', 'high'],
      defaultEffort: 'high',
    },
  },
  {
    match: /^claude-sonnet-4/,
    capabilities: {
      label: 'Sonnet 4',
      supportedEffort: ['low', 'medium', 'high', 'xhigh'],
      defaultEffort: 'high',
    },
  },
  {
    match: /^claude-haiku-4/,
    capabilities: {
      label: 'Haiku 4',
      supportedEffort: ['low', 'medium', 'high'],
      defaultEffort: 'medium',
    },
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Look up capabilities for a model by its ID.
 * Returns `undefined` for unknown models (no clamping applied).
 */
export function lookupCapabilities(modelId: string): ModelCapabilities | undefined {
  for (const entry of MODEL_CAPABILITIES) {
    if (entry.match.test(modelId)) {
      return entry.capabilities;
    }
  }
  return undefined;
}

/**
 * Clamp an effort level to the highest supported level for the given model.
 *
 * Returns a `{ value, clamped }` tuple:
 * - `value`: the effective effort level (may be lower than requested)
 * - `clamped`: `true` when the value was reduced from the requested level
 *
 * When `requested` is `undefined`, returns `undefined`.
 * When the model is unknown (no capability entry), the requested level
 * passes through without clamping.
 */
export function clampEffort(
  modelId: string,
  requested: EffortLevel | undefined,
): { value: EffortLevel; clamped: boolean } | undefined {
  if (requested === undefined) return undefined;

  const caps = lookupCapabilities(modelId);
  if (!caps) {
    // Unknown model — passthrough
    return { value: requested, clamped: false };
  }

  const supported = caps.supportedEffort;
  if (supported.includes(requested)) {
    return { value: requested, clamped: false };
  }

  // Find the highest supported level that is <= the requested level
  const requestedIdx = EFFORT_ORDER.indexOf(requested);
  let best: EffortLevel | undefined;
  for (const level of supported) {
    const levelIdx = EFFORT_ORDER.indexOf(level);
    if (levelIdx <= requestedIdx) {
      best = level;
    }
  }

  // Fallback: if somehow no level is <= requested (shouldn't happen with
  // 'low' always present), use the lowest supported level
  const value = best ?? supported[0];
  return { value, clamped: value !== requested };
}
