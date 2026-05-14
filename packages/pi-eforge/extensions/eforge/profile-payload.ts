/**
 * Pure helper for building the daemon profileCreate payload from per-tier
 * agent runtime selections collected by the /eforge:profile:new wizard.
 *
 * This module contains no TUI overlay calls and is fully unit-testable.
 */

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export type HarnessType = 'claude-sdk' | 'pi';

/** A harness + model + effort selection for a single tier. */
export interface TierSelection {
  /** Which harness to use for this tier. */
  harness: HarnessType;
  /** Provider name — required when harness is 'pi'. */
  provider?: string;
  /** Model identifier (e.g. "claude-opus-4-7"). */
  modelId: string;
  /** Effort level (e.g. "high", "medium", "low"). */
  effort: string;
}

/** Input to buildProfileCreatePayload. */
export interface ProfileCreateInput {
  /** Profile name (e.g. "pi-anthropic"). */
  name: string;
  /** Where the profile file is written. */
  scope: 'project' | 'user' | 'local';
  /** Per-tier selections for each of the four built-in tiers. */
  tiers: {
    planning: TierSelection;
    implementation: TierSelection;
    review: TierSelection;
    evaluation: TierSelection;
  };
  /** Descriptive metadata for the profile. Does not affect runtime behavior. */
  metadata?: {
    description?: string;
    whenToUse?: string[];
    tags?: string[];
  };
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

/** A single tier recipe entry in the create payload. */
export interface TierRecipeEntry {
  harness: HarnessType;
  pi?: { provider: string };
  model: string;
  effort: string;
}

/** The payload sent to POST /api/profile/create. */
export interface ProfileCreatePayload {
  name: string;
  scope: 'project' | 'user' | 'local';
  agents: {
    tiers: {
      planning: TierRecipeEntry;
      implementation: TierRecipeEntry;
      review: TierRecipeEntry;
      evaluation: TierRecipeEntry;
    };
  };
  /** Descriptive metadata for the profile. Does not affect runtime behavior. */
  metadata?: {
    description?: string;
    whenToUse?: string[];
    tags?: string[];
  };
}

// ---------------------------------------------------------------------------
// Payload builder
// ---------------------------------------------------------------------------

function toTierEntry(sel: TierSelection): TierRecipeEntry {
  const entry: TierRecipeEntry = {
    harness: sel.harness,
    model: sel.modelId,
    effort: sel.effort,
  };
  if (sel.harness === 'pi' && sel.provider) {
    entry.pi = { provider: sel.provider };
  }
  return entry;
}

/**
 * Build a daemon profileCreate payload from per-tier selections.
 *
 * Returns an object whose top-level keys are exactly `name`, `scope`, `agents`,
 * with `agents` containing only `tiers`. No `agentRuntimes`, no
 * `defaultAgentRuntime`, no `agents.models`. When `metadata` is provided in
 * the input, it is preserved as a top-level `metadata` key in the payload.
 */
export function buildProfileCreatePayload(input: ProfileCreateInput): ProfileCreatePayload {
  const { name, scope, tiers, metadata } = input;

  const payload: ProfileCreatePayload = {
    name,
    scope,
    agents: {
      tiers: {
        planning: toTierEntry(tiers.planning),
        implementation: toTierEntry(tiers.implementation),
        review: toTierEntry(tiers.review),
        evaluation: toTierEntry(tiers.evaluation),
      },
    },
  };

  if (metadata !== undefined) {
    payload.metadata = metadata;
  }

  return payload;
}
