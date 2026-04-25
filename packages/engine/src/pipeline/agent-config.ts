/**
 * Agent config resolution — role/model tables and resolveAgentConfig.
 *
 * resolveAgentConfig is split into focused sub-functions:
 *   resolveSdkPassthrough  — SDK field resolution with provenance tracking
 *   resolveModel           — per-role/global/class/fallback model resolution
 *   applyEffortClamp       — clamps effort to model maximum
 *   applyThinkingCoercion  — coerces thinking mode for adaptive-only models
 *
 * Resolution precedence (highest → lowest) for every field:
 *   1. Plan-file override (planEntry.agents[role])
 *   2. User per-role override (config.agents.roles[role])
 *   3. User per-tier (config.agents.tiers[tierForRole(role)])
 *   4. User global (config.agents.{model,thinking,effort,maxTurns})
 *   5. Built-in per-role defaults (AGENT_ROLE_DEFAULTS[role]) — exceptions only
 *   6. Built-in per-tier defaults (BUILTIN_TIER_DEFAULTS[tier])
 */

import type { AgentRole } from '../events.js';
import type { EforgeConfig, ModelRef, ModelClass, ResolvedAgentConfig, AgentTier } from '../config.js';
import type { EffortLevel } from '../harness.js';
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
  'dependency-detector': 'planning',
  // Implementation tier — code-writing and transformation agents
  builder: 'implementation',
  'review-fixer': 'implementation',
  'validation-fixer': 'implementation',
  'merge-conflict-resolver': 'implementation',
  'doc-updater': 'implementation',
  'test-writer': 'implementation',
  tester: 'implementation',
  'gap-closer': 'implementation',
  'recovery-analyst': 'implementation',
  // Review tier — inspection and feedback agents
  reviewer: 'review',
  'architecture-reviewer': 'review',
  'cohesion-reviewer': 'review',
  'plan-reviewer': 'review',
  'staleness-assessor': 'review',
  'prd-validator': 'review',
  // Evaluation tier — verdict and acceptance agents
  evaluator: 'evaluation',
  'architecture-evaluator': 'evaluation',
  'cohesion-evaluator': 'evaluation',
  'plan-evaluator': 'evaluation',
};

/**
 * Built-in per-tier defaults applied when no higher-precedence source sets a value.
 * - planning/review/evaluation: effort=high, modelClass=max
 * - implementation: effort=medium, modelClass=balanced
 */
export const BUILTIN_TIER_DEFAULTS: Record<AgentTier, { effort: EffortLevel; modelClass: ModelClass }> = {
  planning: { effort: 'high', modelClass: 'max' },
  implementation: { effort: 'medium', modelClass: 'balanced' },
  review: { effort: 'high', modelClass: 'max' },
  evaluation: { effort: 'high', modelClass: 'max' },
};

/**
 * Per-role model class overrides for roles whose built-in class differs from their tier default.
 * Only roles that DON'T match their tier's default modelClass appear here.
 * - implementation tier defaults to `balanced`, but these roles use `max`:
 * - planning/review tier defaults to `max`, but these roles use `balanced` (historical):
 */
export const AGENT_ROLE_MODEL_CLASS_OVERRIDES: Partial<Record<AgentRole, ModelClass>> = {
  'merge-conflict-resolver': 'max',
  'doc-updater': 'max',
  'gap-closer': 'max',
  'dependency-detector': 'balanced',
  'prd-validator': 'balanced',
  'staleness-assessor': 'balanced',
};

/**
 * Per-role built-in defaults. Only genuine per-role exceptions: turn budgets
 * and the builder effort outlier (implementation tier defaults to medium, but
 * builder's historical default is high — preserved for backward compatibility).
 * All per-role effort entries that match their tier default have been removed.
 */
export const AGENT_ROLE_DEFAULTS: Partial<Record<AgentRole, Partial<ResolvedAgentConfig>>> = {
  builder: { maxTurns: 80, effort: 'high' },  // effort exception: implementation tier default is medium
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

/** Per-backend default ModelRef objects for each model class. `undefined` means the SDK picks its own model. */
export const MODEL_CLASS_DEFAULTS: Record<string, Record<ModelClass, ModelRef | undefined>> = {
  'claude-sdk': {
    max: { id: 'claude-opus-4-7' },
    balanced: { id: 'claude-sonnet-4-6' },
    fast: { id: 'claude-haiku-4-5' },
  },
  pi: {
    max: undefined,
    balanced: undefined,
    fast: undefined,
  },
};

/** Ordered tier list for fallback resolution: index 0 is the most capable. */
const MODEL_CLASS_TIER: ModelClass[] = ['max', 'balanced', 'fast'];

type EffortSource = 'planner' | 'role-config' | 'tier-config' | 'global-config' | 'default';
type ThinkingSource = 'planner' | 'role-config' | 'tier-config' | 'global-config' | 'default';

/**
 * Resolve the tier for a given role.
 * Precedence: user per-role tier override > built-in AGENT_ROLE_TIERS.
 */
function resolveTierForRole(
  role: AgentRole,
  config: EforgeConfig,
): { tier: AgentTier; tierSource: 'role-config' | 'role-default' } {
  const userRoleTier = config.agents.roles?.[role]?.tier as AgentTier | undefined;
  if (userRoleTier !== undefined) {
    return { tier: userRoleTier, tierSource: 'role-config' };
  }
  return { tier: AGENT_ROLE_TIERS[role], tierSource: 'role-default' };
}

/**
 * Resolve SDK passthrough fields (maxTurns + SDK_FIELDS) with provenance tracking.
 * Returns the resolved field values and effort/thinking provenance.
 *
 * Resolution order for effort/thinking (highest → lowest):
 *   1. Plan-file override
 *   2. User per-role (config.agents.roles[role])
 *   3. User per-tier (config.agents.tiers[tier])
 *   4. User global (config.agents.effort / thinking)
 *   5. Built-in per-role (AGENT_ROLE_DEFAULTS[role])
 *   6. Built-in per-tier (BUILTIN_TIER_DEFAULTS[tier])
 */
function resolveSdkPassthrough(
  role: AgentRole,
  config: EforgeConfig,
  planEntry: { agents?: Record<string, { effort?: string; thinking?: object; rationale?: string }> } | undefined,
  builtinRoleDefaults: Partial<ResolvedAgentConfig>,
  tier: AgentTier,
): { fields: Partial<ResolvedAgentConfig>; effortSource: EffortSource; thinkingSource: ThinkingSource } {
  const SDK_FIELDS = ['thinking', 'effort', 'maxBudgetUsd', 'fallbackModel', 'allowedTools', 'disallowedTools', 'promptAppend'] as const;
  const userRole = config.agents.roles?.[role] ?? {};
  const userTier = (config.agents.tiers?.[tier] ?? {}) as Record<string, unknown>;
  const builtinTierDefaults = BUILTIN_TIER_DEFAULTS[tier] as Record<string, unknown>;
  const userGlobal: Partial<ResolvedAgentConfig> = {
    maxTurns: config.agents.maxTurns,
    model: config.agents.model,
    thinking: config.agents.thinking,
    effort: config.agents.effort,
  };
  const planOverride = planEntry?.agents?.[role];
  const fields: Partial<ResolvedAgentConfig> = {};

  // maxTurns: user per-role > user per-tier > built-in per-role > user global
  fields.maxTurns = userRole.maxTurns ?? (userTier['maxTurns'] as number | undefined) ?? builtinRoleDefaults.maxTurns ?? userGlobal.maxTurns;

  let effortSource: EffortSource = 'default';
  let thinkingSource: ThinkingSource = 'default';

  for (const field of SDK_FIELDS) {
    let value: unknown;
    if (field === 'effort' || field === 'thinking') {
      const planVal = planOverride?.[field];
      if (planVal !== undefined) {
        value = planVal;
        if (field === 'effort') effortSource = 'planner';
        if (field === 'thinking') thinkingSource = 'planner';
      } else if (userRole[field] !== undefined) {
        value = userRole[field];
        if (field === 'effort') effortSource = 'role-config';
        if (field === 'thinking') thinkingSource = 'role-config';
      } else if (userTier[field] !== undefined) {
        value = userTier[field];
        if (field === 'effort') effortSource = 'tier-config';
        if (field === 'thinking') thinkingSource = 'tier-config';
      } else if (userGlobal[field] !== undefined) {
        value = userGlobal[field];
        if (field === 'effort') effortSource = 'global-config';
        if (field === 'thinking') thinkingSource = 'global-config';
      } else if (builtinRoleDefaults[field] !== undefined) {
        value = builtinRoleDefaults[field];
        // effortSource/thinkingSource stays 'default'
      } else if (builtinTierDefaults[field] !== undefined) {
        value = builtinTierDefaults[field];
        // stays 'default'
      }
    } else {
      value = userRole[field] ?? userTier[field] ?? userGlobal[field] ?? builtinRoleDefaults[field];
    }
    if (value !== undefined) {
      (fields as Record<string, unknown>)[field] = value;
    }
  }

  return { fields, effortSource, thinkingSource };
}

/** Walk MODEL_CLASS_TIER ascending then descending from effectiveClass to find any configured model. */
function resolveFallbackModel(
  harness: 'claude-sdk' | 'pi',
  effectiveClass: ModelClass,
  config: EforgeConfig,
): { model?: ModelRef; fallbackFrom?: ModelClass; attempted: ModelClass[] } {
  const effectiveIdx = MODEL_CLASS_TIER.indexOf(effectiveClass);
  const attempted: ModelClass[] = [];

  // Ascending (toward more capable)
  for (let i = effectiveIdx - 1; i >= 0; i--) {
    const tier = MODEL_CLASS_TIER[i];
    attempted.push(tier);
    const userModel = config.agents.models?.[tier];
    if (userModel !== undefined) return { model: userModel, fallbackFrom: effectiveClass, attempted };
    const harnessModel = MODEL_CLASS_DEFAULTS[harness]?.[tier];
    if (harnessModel !== undefined) return { model: harnessModel, fallbackFrom: effectiveClass, attempted };
  }

  // Descending (toward less capable)
  for (let i = effectiveIdx + 1; i < MODEL_CLASS_TIER.length; i++) {
    const tier = MODEL_CLASS_TIER[i];
    attempted.push(tier);
    const userModel = config.agents.models?.[tier];
    if (userModel !== undefined) return { model: userModel, fallbackFrom: effectiveClass, attempted };
    const harnessModel = MODEL_CLASS_DEFAULTS[harness]?.[tier];
    if (harnessModel !== undefined) return { model: harnessModel, fallbackFrom: effectiveClass, attempted };
  }

  return { model: undefined, attempted };
}

/**
 * Resolve the model for a given role via the six-tier chain:
 *   1. User per-role model
 *   2. User global model
 *   3. User model class override (agents.models[effectiveClass])
 *   4. Harness model class default (MODEL_CLASS_DEFAULTS[harness][effectiveClass])
 *   5. Fallback tier traversal (ascending then descending)
 *   6. undefined (no model set)
 *
 * effectiveClass resolution (highest → lowest):
 *   1. User per-role modelClass
 *   2. User per-tier modelClass
 *   3. Built-in per-role outlier (AGENT_ROLE_MODEL_CLASS_OVERRIDES)
 *   4. Built-in per-tier default (BUILTIN_TIER_DEFAULTS[tier].modelClass)
 */
function resolveModel(
  role: AgentRole,
  config: EforgeConfig,
  harness: 'claude-sdk' | 'pi' | undefined,
  builtinRoleDefaults: Partial<ResolvedAgentConfig>,
  tier: AgentTier,
): { model?: ModelRef; fallbackFrom?: ModelClass; provenance?: string } {
  const userRole = config.agents.roles?.[role] ?? {};
  const userTier = config.agents.tiers?.[tier] ?? {};
  const perRoleModel = userRole.model ?? builtinRoleDefaults.model;
  const globalModel = config.agents.model;
  const effectiveClass: ModelClass =
    userRole.modelClass ??
    (userTier as { modelClass?: ModelClass }).modelClass ??
    AGENT_ROLE_MODEL_CLASS_OVERRIDES[role] ??
    BUILTIN_TIER_DEFAULTS[tier].modelClass;

  if (perRoleModel !== undefined) return { model: perRoleModel, provenance: `agents.roles.${role}.model` };
  if ((userTier as { model?: ModelRef }).model !== undefined) return { model: (userTier as { model?: ModelRef }).model, provenance: `agents.tiers.${tier}.model` };
  if (globalModel !== undefined) return { model: globalModel, provenance: 'agents.model' };

  const userClassModel = config.agents.models?.[effectiveClass];
  if (userClassModel !== undefined) return { model: userClassModel, provenance: `agents.models.${effectiveClass}` };

  if (harness) {
    const harnessModel = MODEL_CLASS_DEFAULTS[harness]?.[effectiveClass];
    if (harnessModel !== undefined) return { model: harnessModel };
    const fallback = resolveFallbackModel(harness, effectiveClass, config);
    if (fallback.model !== undefined) return { model: fallback.model, fallbackFrom: fallback.fallbackFrom };
    if (harness !== 'claude-sdk') {
      throw new Error(
        `No model configured for role "${role}" (model class "${effectiveClass}") on harness "${harness}". ` +
        `Tried fallback: ${fallback.attempted.join(', ')}. ` +
        `Set agents.models.${effectiveClass} in eforge/config.yaml.`,
      );
    }
  }

  // Non-claude-sdk harnesses without built-in defaults require user-configured model mappings.
  if (harness !== 'claude-sdk' && harness !== undefined) {
    throw new Error(
      `No model configured for role "${role}" (model class "${effectiveClass}") on harness "${harness}". ` +
      `Set agents.models.${effectiveClass} in eforge/config.yaml.`,
    );
  }

  return { model: undefined };
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

/**
 * Resolve the agentRuntime name and harness kind for a given role.
 *
 * Precedence (highest → lowest):
 *   1. Plan-file agentRuntime override (planEntry.agents[role].agentRuntime)
 *   2. Per-role agentRuntime (config.agents.roles[role].agentRuntime)
 *   3. defaultAgentRuntime
 *
 * Requires config.agentRuntimes + config.defaultAgentRuntime to be present.
 * Throws when a plan-file references an undeclared runtime name (includes plan file path in error).
 */
export function resolveAgentRuntimeForRole(
  role: AgentRole,
  config: EforgeConfig,
  planEntry?: { agents?: Record<string, { agentRuntime?: string; [key: string]: unknown }>; filePath?: string },
): { agentRuntimeName: string; harness: 'claude-sdk' | 'pi' } {
  const agentRuntimes = config.agentRuntimes;

  if (!agentRuntimes || Object.keys(agentRuntimes).length === 0) {
    throw new Error(
      `Role "${role}" could not resolve an agentRuntime: "agentRuntimes" is not declared in config. ` +
      `Add "agentRuntimes" and "defaultAgentRuntime" to eforge/config.yaml or the active profile.`,
    );
  }

  // Plan-file override takes top precedence
  const planAgentRuntime = planEntry?.agents?.[role]?.agentRuntime;
  if (planAgentRuntime !== undefined) {
    const entry = agentRuntimes[planAgentRuntime];
    if (!entry) {
      const planDesc = planEntry?.filePath ? `plan file ${planEntry.filePath}` : 'plan entry';
      throw new Error(
        `${planDesc}: role "${role}" references agentRuntime "${planAgentRuntime}" which is not declared in agentRuntimes. ` +
        `Declared: ${Object.keys(agentRuntimes).join(', ')}.`,
      );
    }
    return { agentRuntimeName: planAgentRuntime, harness: entry.harness };
  }

  // Config-level role override, then tier override, then default
  const roleConfig = config.agents.roles?.[role];
  const { tier } = resolveTierForRole(role, config);
  const tierConfig = config.agents.tiers?.[tier];
  const runtimeName = roleConfig?.agentRuntime ?? (tierConfig as { agentRuntime?: string } | undefined)?.agentRuntime ?? config.defaultAgentRuntime;

  if (!runtimeName) {
    throw new Error(
      `Role "${role}" could not resolve an agentRuntime: no agentRuntime set on the role and no defaultAgentRuntime configured.`,
    );
  }

  const entry = agentRuntimes[runtimeName];
  if (!entry) {
    throw new Error(
      `Role "${role}" has agentRuntime "${runtimeName}" which is not declared in agentRuntimes. ` +
      `Declared: ${Object.keys(agentRuntimes).join(', ')}.`,
    );
  }

  return { agentRuntimeName: runtimeName, harness: entry.harness };
}

/**
 * Resolve agent config for a given role.
 *
 * Six-tier precedence (highest → lowest) for all fields:
 *   1. Plan-file override (planEntry.agents[role])
 *   2. User per-role config (config.agents.roles[role])
 *   3. User per-tier config (config.agents.tiers[tier])
 *   4. User global config (config.agents.{thinking,effort,...})
 *   5. Built-in per-role defaults (AGENT_ROLE_DEFAULTS[role]) — exceptions only
 *   6. Built-in per-tier defaults (BUILTIN_TIER_DEFAULTS[tier])
 *
 * The resolved tier is always stamped onto the result along with its provenance.
 */
export function resolveAgentConfig(
  role: AgentRole,
  config: EforgeConfig,
  planEntry?: { agents?: Record<string, { effort?: string; thinking?: object; rationale?: string; agentRuntime?: string }>; filePath?: string },
): ResolvedAgentConfig {
  const { agentRuntimeName, harness } = resolveAgentRuntimeForRole(role, config, planEntry);
  const builtinRoleDefaults = AGENT_ROLE_DEFAULTS[role] ?? {};

  // Resolve tier for this role
  const { tier, tierSource } = resolveTierForRole(role, config);

  const { fields, effortSource, thinkingSource } = resolveSdkPassthrough(role, config, planEntry, builtinRoleDefaults, tier);
  const { model, fallbackFrom, provenance: modelProvenance } = resolveModel(role, config, harness, builtinRoleDefaults, tier);

  // Per-role provider-ness validation at resolve time (moved from schema-time)
  if (model !== undefined) {
    if (harness === 'pi' && !model.provider) {
      throw new Error(
        `Role "${role}" resolved to agentRuntime "${agentRuntimeName}" (harness "pi") ` +
        `but the model ref at ${modelProvenance ?? 'unknown'} is missing "provider". ` +
        `Got { id: "${model.id}" }.`,
      );
    }
    if (harness === 'claude-sdk' && model.provider !== undefined) {
      throw new Error(
        `Role "${role}" resolved to agentRuntime "${agentRuntimeName}" (harness "claude-sdk") ` +
        `but the model ref at ${modelProvenance ?? 'unknown'} has a forbidden "provider" field. ` +
        `Got { provider: "${model.provider}", id: "${model.id}" }.`,
      );
    }
  }

  const result: ResolvedAgentConfig = { ...fields, agentRuntimeName, harness, tier, tierSource };
  if (model !== undefined) result.model = model;
  if (fallbackFrom !== undefined) result.fallbackFrom = fallbackFrom;

  applyEffortClamp(result);
  applyThinkingCoercion(result);

  // Always stamp provenance so the UI always has source data
  result.effortSource = effortSource;
  result.thinkingSource = thinkingSource;

  return result;
}
