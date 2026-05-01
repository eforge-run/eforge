/**
 * Agent config resolution — single-axis tier recipes.
 *
 * Each tier (planning/implementation/review/evaluation) is a self-contained
 * recipe: harness + harness-specific config + model + effort + tuning. There
 * is no separate model-class table, no separate runtime registry. A role
 * picks a tier; the tier carries everything else.
 *
 * `resolveAgentConfig` is a 6-step algorithm:
 *   1. Determine tier name (role default → role override → plan override)
 *   2. Take the tier recipe from config
 *   3. Apply role-level field overrides
 *   4. Apply plan-level field overrides
 *   5. Clamp effort, coerce thinking
 *   6. Stamp provenance (`tier|role|plan`) for every overridable field
 */

import type { AgentRole } from '../events.js';
import type { EforgeConfig, ModelRef, ResolvedAgentConfig, AgentTier, ShardScope, TierConfig } from '../config.js';
import type { EffortLevel, ThinkingConfig } from '../harness.js';
import { clampEffort, lookupCapabilities } from '../model-capabilities.js';

/**
 * Maps each agent role to its built-in tier.
 * A user can override the tier for a single role via `agents.roles[role].tier`.
 * Compile-time check: `Record<AgentRole, AgentTier>` ensures all 24 roles are covered.
 */
export const AGENT_ROLE_TIERS: Record<AgentRole, AgentTier> = {
  // Planning tier — orchestration and composition agents
  planner: 'planning',
  'module-planner': 'planning',
  formatter: 'planning',
  'pipeline-composer': 'planning',
  'merge-conflict-resolver': 'planning',
  'doc-updater': 'planning',
  'gap-closer': 'planning',
  // Implementation tier — code-writing and transformation agents
  builder: 'implementation',
  'review-fixer': 'implementation',
  'validation-fixer': 'implementation',
  'test-writer': 'implementation',
  tester: 'implementation',
  'recovery-analyst': 'implementation',
  'dependency-detector': 'implementation',
  'prd-validator': 'implementation',
  'staleness-assessor': 'implementation',
  // Review tier — inspection and feedback agents
  reviewer: 'review',
  'architecture-reviewer': 'review',
  'cohesion-reviewer': 'review',
  'plan-reviewer': 'review',
  // Evaluation tier — verdict and acceptance agents
  evaluator: 'evaluation',
  'architecture-evaluator': 'evaluation',
  'cohesion-evaluator': 'evaluation',
  'plan-evaluator': 'evaluation',
};

/** Per-role default maxTurns for agents that have a non-default budget. */
export const AGENT_ROLE_DEFAULTS: Partial<Record<AgentRole, { maxTurns?: number }>> = {
  builder: { maxTurns: 80 },
  planner: { maxTurns: 80 },
  tester: { maxTurns: 40 },
  'module-planner': { maxTurns: 20 },
  'doc-updater': { maxTurns: 20 },
  'test-writer': { maxTurns: 30 },
  'gap-closer': { maxTurns: 20 },
};

/** Per-role default maxContinuations for agents that support continuation loops. */
export const AGENT_MAX_CONTINUATIONS_DEFAULTS: Partial<Record<AgentRole, number>> = {
  planner: 2,
  evaluator: 1,
  'plan-evaluator': 1,
  'cohesion-evaluator': 1,
  'architecture-evaluator': 1,
};

/** Provenance tag for a tunable field. `tier` = from tier recipe; `role` = role override; `plan` = plan-file override. */
type Provenance = 'tier' | 'role' | 'plan';

/**
 * Resolve the tier for a given role.
 * Precedence: plan-file tier override > user per-role tier override > built-in AGENT_ROLE_TIERS.
 */
function resolveTierForRole(
  role: AgentRole,
  config: EforgeConfig,
  planEntry?: { agents?: Record<string, { tier?: string; [key: string]: unknown }> },
): { tier: AgentTier; tierSource: Provenance } {
  const planTier = planEntry?.agents?.[role]?.tier as AgentTier | undefined;
  if (planTier !== undefined) {
    return { tier: planTier, tierSource: 'plan' };
  }
  const userRoleTier = (config.agents.roles?.[role] as { tier?: AgentTier } | undefined)?.tier;
  if (userRoleTier !== undefined) {
    return { tier: userRoleTier, tierSource: 'role' };
  }
  return { tier: AGENT_ROLE_TIERS[role], tierSource: 'tier' };
}

/** Plan-entry shape used by resolveAgentConfig. */
type PlanEntry = {
  agents?: Record<string, {
    effort?: string;
    thinking?: boolean | object;
    tier?: string;
    maxTurns?: number;
    allowedTools?: string[];
    disallowedTools?: string[];
    promptAppend?: string;
    shards?: ShardScope[];
    rationale?: string;
    [key: string]: unknown;
  }>;
  filePath?: string;
};

/** Coerce a raw `thinking` value into a ThinkingConfig, or undefined when absent. */
function coerceThinking(raw: unknown): ThinkingConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'boolean') {
    return raw ? { type: 'enabled' } : { type: 'disabled' };
  }
  if (typeof raw === 'object') {
    const t = (raw as { type?: unknown }).type;
    if (t === 'adaptive' || t === 'enabled' || t === 'disabled') {
      return raw as ThinkingConfig;
    }
  }
  return undefined;
}

/**
 * Resolve agent config for a given role.
 *
 * Six-step algorithm:
 *   1. Determine tier name (role default → role override → plan override)
 *   2. Take tier recipe from config
 *   3. Apply role-level field overrides
 *   4. Apply plan-level field overrides
 *   5. Clamp effort, coerce thinking
 *   6. Stamp provenance (`tier|role|plan`)
 */
export function resolveAgentConfig(
  role: AgentRole,
  config: EforgeConfig,
  planEntry?: PlanEntry,
): ResolvedAgentConfig {
  // Step 1: tier
  const { tier, tierSource } = resolveTierForRole(role, config, planEntry);

  // Step 2: tier recipe
  const tierRecipe = config.agents.tiers?.[tier] as TierConfig | undefined;
  if (!tierRecipe) {
    throw new Error(
      `Role "${role}" resolves to tier "${tier}" but no tier recipe is configured. ` +
      `Add agents.tiers.${tier} (with harness, model, effort) to eforge/config.yaml.`,
    );
  }

  // Step 3: role-level overrides
  const roleOverride = (config.agents.roles?.[role] ?? {}) as {
    effort?: EffortLevel;
    thinking?: boolean;
    maxTurns?: number;
    allowedTools?: string[];
    disallowedTools?: string[];
    promptAppend?: string;
    shards?: ShardScope[];
  };

  // Step 4: plan-level overrides
  const planOverride = planEntry?.agents?.[role] ?? {};

  // Resolve harness — always from the tier recipe.
  const harness: 'claude-sdk' | 'pi' = tierRecipe.harness;

  // Resolve model — always from the tier recipe; provider spliced for pi.
  const baseModel: ModelRef = { id: tierRecipe.model };
  const model: ModelRef = harness === 'pi'
    ? { ...baseModel, provider: tierRecipe.pi?.provider }
    : baseModel;

  // Resolve effort with provenance.
  let effort: EffortLevel = tierRecipe.effort;
  let effortSource: Provenance = 'tier';
  if (planOverride.effort !== undefined) {
    effort = planOverride.effort as EffortLevel;
    effortSource = 'plan';
  } else if (roleOverride.effort !== undefined) {
    effort = roleOverride.effort;
    effortSource = 'role';
  }

  // Resolve thinking with provenance.
  let thinking: ThinkingConfig | undefined = tierRecipe.thinking !== undefined
    ? (tierRecipe.thinking ? { type: 'enabled' as const } : { type: 'disabled' as const })
    : undefined;
  let thinkingSource: Provenance = 'tier';
  const planThinking = coerceThinking(planOverride.thinking);
  if (planThinking !== undefined) {
    thinking = planThinking;
    thinkingSource = 'plan';
  } else if (roleOverride.thinking !== undefined) {
    thinking = coerceThinking(roleOverride.thinking);
    thinkingSource = 'role';
  }

  // Resolve maxTurns: plan > role > builtin-role > tier > global
  const builtinRoleMaxTurns = AGENT_ROLE_DEFAULTS[role]?.maxTurns;
  const maxTurns =
    planOverride.maxTurns
    ?? roleOverride.maxTurns
    ?? builtinRoleMaxTurns
    ?? tierRecipe.maxTurns
    ?? config.agents.maxTurns;

  // Resolve other tunables: plan > role > tier
  const allowedTools = planOverride.allowedTools ?? roleOverride.allowedTools ?? tierRecipe.allowedTools;
  const disallowedTools = planOverride.disallowedTools ?? roleOverride.disallowedTools ?? tierRecipe.disallowedTools;
  const promptAppend = planOverride.promptAppend ?? roleOverride.promptAppend ?? tierRecipe.promptAppend;
  const fallbackModel = tierRecipe.fallbackModel;

  // Build initial result.
  const result: ResolvedAgentConfig = {
    harness,
    harnessSource: 'tier',
    tier,
    tierSource,
    model,
    effort,
    effortSource,
    thinkingSource,
    ...(thinking !== undefined ? { thinking } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(fallbackModel !== undefined ? { fallbackModel } : {}),
    ...(allowedTools !== undefined ? { allowedTools } : {}),
    ...(disallowedTools !== undefined ? { disallowedTools } : {}),
    ...(promptAppend !== undefined ? { promptAppend } : {}),
  };

  // Step 5: clamp effort + coerce thinking
  applyEffortClamp(result);
  applyThinkingCoercion(result);

  // Thread shards from plan / role for builder.
  if (role === 'builder') {
    const planShards = planOverride.shards;
    const roleShards = roleOverride.shards;
    const shards = planShards ?? roleShards;
    if (shards !== undefined && shards.length > 0) {
      const ids = shards.map((s) => s.id);
      const seen = new Set<string>();
      const duplicates = new Set<string>();
      for (const id of ids) {
        if (seen.has(id)) duplicates.add(id);
        seen.add(id);
      }
      if (duplicates.size > 0) {
        throw new Error(
          `Builder config has duplicate shard IDs: ${[...duplicates].join(', ')}. ` +
          `Each shard must have a unique id within the plan.`,
        );
      }
      result.shards = shards;
    }
  }

  return result;
}

/** Clamp effort to the model's maximum supported level (mutates result). */
function applyEffortClamp(result: ResolvedAgentConfig): void {
  if (result.effort === undefined) return;
  const modelId = result.model?.id ?? '';
  const clamped = clampEffort(modelId, result.effort);
  if (clamped) {
    if (clamped.clamped) {
      result.effortOriginal = result.effort;
      result.effort = clamped.value;
    }
    result.effortClamped = clamped.clamped;
  }
}

/** Coerce thinking from 'enabled' to 'adaptive' for models that only support adaptive thinking (mutates result). */
function applyThinkingCoercion(result: ResolvedAgentConfig): void {
  if (result.thinking?.type !== 'enabled') return;
  const modelId = result.model?.id ?? '';
  const caps = lookupCapabilities(modelId);
  if (caps?.thinkingMode === 'adaptive-only') {
    result.thinkingOriginal = result.thinking;
    result.thinking = { type: 'adaptive' };
    result.thinkingCoerced = true;
  }
}
