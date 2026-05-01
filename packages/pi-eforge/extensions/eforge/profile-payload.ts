/**
 * Pure helper for building the daemon profileCreate payload from per-model-class
 * agent runtime selections collected by the /eforge:profile:new wizard.
 *
 * This module contains no TUI overlay calls and is fully unit-testable.
 */

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export type HarnessType = 'claude-sdk' | 'pi';

/** A runtime + model selection for a single model class (max, balanced, or fast). */
export interface ModelClassSelection {
  /** Which harness to use for this model class. */
  harness: HarnessType;
  /** Provider name — required when harness is 'pi'. */
  provider?: string;
  /** Model identifier (e.g. "claude-opus-4-7"). */
  modelId: string;
}

/** Input to buildProfileCreatePayload. */
export interface ProfileCreateInput {
  /** Profile name (e.g. "pi-anthropic"). */
  name: string;
  /** Where the profile file is written. */
  scope: 'project' | 'user' | 'local';
  /** Selection for the max model class. */
  max: ModelClassSelection;
  /** Selection for the balanced model class. */
  balanced: ModelClassSelection;
  /** Selection for the fast model class. */
  fast: ModelClassSelection;
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

/** A single agentRuntime registry entry in the create payload. */
export interface AgentRuntimeEntryPayload {
  harness: HarnessType;
  pi?: { provider: string };
}

/** The payload sent to POST /api/profile/create. */
export interface ProfileCreatePayload {
  name: string;
  scope: 'project' | 'user' | 'local';
  agentRuntimes: Record<string, AgentRuntimeEntryPayload>;
  defaultAgentRuntime: string;
  agents: {
    models: {
      max: { id: string };
      balanced: { id: string };
      fast: { id: string };
    };
    tiers?: {
      implementation: { agentRuntime: string };
    };
  };
}

// ---------------------------------------------------------------------------
// Runtime name derivation
// ---------------------------------------------------------------------------

/**
 * Derive a stable agentRuntimes map key from a harness + provider selection.
 *
 * - claude-sdk -> "claude-sdk"
 * - pi + "anthropic" -> "pi-anthropic"
 * - pi + "openrouter" -> "pi-openrouter"
 */
export function runtimeName(harness: HarnessType, provider?: string): string {
  if (harness === 'claude-sdk') return 'claude-sdk';
  return `pi-${provider ?? 'unknown'}`;
}

// ---------------------------------------------------------------------------
// Payload builder
// ---------------------------------------------------------------------------

/**
 * Build a daemon profileCreate payload from per-model-class selections.
 *
 * Key behaviors:
 * - De-duplicates agentRuntimes by derived name (claude-sdk or pi-<provider>)
 * - Sets defaultAgentRuntime to the max runtime name
 * - Emits agents.tiers.implementation.agentRuntime ONLY when balanced runtime
 *   differs from max runtime
 * - fast is declared in agentRuntimes but never gets a tier override (it is
 *   not currently used by default by any built-in tier)
 * - Never emits agents.effort, pi.thinkingLevel, or invalid tier keys
 *   (max/balanced/fast)
 * - Pi provider is placed only on agentRuntimes.<name>.pi.provider, not on
 *   model refs
 */
export function buildProfileCreatePayload(input: ProfileCreateInput): ProfileCreatePayload {
  const { name, scope, max, balanced, fast } = input;

  const maxRtName = runtimeName(max.harness, max.provider);
  const balancedRtName = runtimeName(balanced.harness, balanced.provider);

  // Build agentRuntimes map — de-duplicate by name
  const agentRuntimes: Record<string, AgentRuntimeEntryPayload> = {};
  for (const sel of [max, balanced, fast]) {
    const rtName = runtimeName(sel.harness, sel.provider);
    if (!(rtName in agentRuntimes)) {
      const entry: AgentRuntimeEntryPayload = { harness: sel.harness };
      if (sel.harness === 'pi' && sel.provider) {
        entry.pi = { provider: sel.provider };
      }
      agentRuntimes[rtName] = entry;
    }
  }

  // Tier override for implementation only when balanced runtime differs from max
  let tiers: ProfileCreatePayload['agents']['tiers'] | undefined;
  if (balancedRtName !== maxRtName) {
    tiers = { implementation: { agentRuntime: balancedRtName } };
  }

  return {
    name,
    scope,
    agentRuntimes,
    defaultAgentRuntime: maxRtName,
    agents: {
      models: {
        max: { id: max.modelId },
        balanced: { id: balanced.modelId },
        fast: { id: fast.modelId },
      },
      ...(tiers !== undefined ? { tiers } : {}),
    },
  };
}
