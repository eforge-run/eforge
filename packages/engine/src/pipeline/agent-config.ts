/**
 * Agent config resolution — role/model tables and resolveAgentConfig.
 *
 * resolveAgentConfig is split into focused sub-functions:
 *   resolveSdkPassthrough  — SDK field resolution with provenance tracking
 *   resolveModel           — per-role/global/class/fallback model resolution
 *   applyEffortClamp       — clamps effort to model maximum
 *   applyThinkingCoercion  — coerces thinking mode for adaptive-only models
 */

import type { AgentRole } from '../events.js';
import type { EforgeConfig, ModelRef, ModelClass, ResolvedAgentConfig } from '../config.js';
import { clampEffort, lookupCapabilities } from '../model-capabilities.js';

/** Per-role built-in defaults. Agents that need different settings than the global default declare them here. */
export const AGENT_ROLE_DEFAULTS: Partial<Record<AgentRole, Partial<ResolvedAgentConfig>>> = {
  planner: { effort: 'high' },
  builder: { maxTurns: 80, effort: 'high' },
  'module-planner': { maxTurns: 20, effort: 'high' },
  'architecture-reviewer': { effort: 'high' },
  'architecture-evaluator': { effort: 'high' },
  'cohesion-reviewer': { effort: 'high' },
  'cohesion-evaluator': { effort: 'high' },
  'plan-reviewer': { effort: 'high' },
  'plan-evaluator': { effort: 'high' },
  reviewer: { effort: 'high' },
  evaluator: { effort: 'high' },
  'review-fixer': { effort: 'medium' },
  'validation-fixer': { effort: 'medium' },
  'merge-conflict-resolver': { effort: 'medium' },
  'doc-updater': { maxTurns: 20, effort: 'medium' },
  'test-writer': { maxTurns: 30, effort: 'medium' },
  'tester': { maxTurns: 40, effort: 'medium' },
  'gap-closer': { maxTurns: 20, effort: 'medium' },
};

/** Per-role default maxContinuations for agents that support continuation loops. */
export const AGENT_MAX_CONTINUATIONS_DEFAULTS: Partial<Record<AgentRole, number>> = {
  planner: 2,
  evaluator: 1,
  'plan-evaluator': 1,
  'cohesion-evaluator': 1,
  'architecture-evaluator': 1,
};

/** Maps each agent role to its default model class. */
export const AGENT_MODEL_CLASSES: Record<AgentRole, ModelClass> = {
  planner: 'max',
  'architecture-reviewer': 'max',
  'architecture-evaluator': 'max',
  'cohesion-reviewer': 'max',
  'cohesion-evaluator': 'max',
  'module-planner': 'max',
  'plan-reviewer': 'max',
  'plan-evaluator': 'max',
  builder: 'balanced',
  reviewer: 'max',
  'review-fixer': 'balanced',
  evaluator: 'max',
  'validation-fixer': 'balanced',
  'merge-conflict-resolver': 'max',
  'doc-updater': 'max',
  'test-writer': 'balanced',
  tester: 'balanced',
  formatter: 'max',
  'staleness-assessor': 'balanced',
  'prd-validator': 'balanced',
  'dependency-detector': 'balanced',
  'pipeline-composer': 'max',
  'gap-closer': 'max',
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

type EffortSource = 'planner' | 'role-config' | 'global-config' | 'default';
type ThinkingSource = 'planner' | 'role-config' | 'global-config' | 'default';

/**
 * Resolve SDK passthrough fields (maxTurns + SDK_FIELDS) with provenance tracking.
 * Returns the resolved field values and effort/thinking provenance.
 */
function resolveSdkPassthrough(
  role: AgentRole,
  config: EforgeConfig,
  planEntry: { agents?: Record<string, { effort?: string; thinking?: object; rationale?: string }> } | undefined,
  builtinRoleDefaults: Partial<ResolvedAgentConfig>,
): { fields: Partial<ResolvedAgentConfig>; effortSource: EffortSource; thinkingSource: ThinkingSource } {
  const SDK_FIELDS = ['thinking', 'effort', 'maxBudgetUsd', 'fallbackModel', 'allowedTools', 'disallowedTools', 'promptAppend'] as const;
  const userRole = config.agents.roles?.[role] ?? {};
  const userGlobal: Partial<ResolvedAgentConfig> = {
    maxTurns: config.agents.maxTurns,
    model: config.agents.model,
    thinking: config.agents.thinking,
    effort: config.agents.effort,
  };
  const planOverride = planEntry?.agents?.[role];
  const fields: Partial<ResolvedAgentConfig> = {};

  // maxTurns: user per-role > built-in per-role > user global
  fields.maxTurns = userRole.maxTurns ?? builtinRoleDefaults.maxTurns ?? userGlobal.maxTurns;

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
      } else if (userGlobal[field] !== undefined) {
        value = userGlobal[field];
        if (field === 'effort') effortSource = 'global-config';
        if (field === 'thinking') thinkingSource = 'global-config';
      } else if (builtinRoleDefaults[field] !== undefined) {
        value = builtinRoleDefaults[field];
        // effortSource/thinkingSource stays 'default'
      }
    } else {
      value = userRole[field] ?? userGlobal[field] ?? builtinRoleDefaults[field];
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
 * Resolve the model for a given role via the five-tier chain:
 *   1. User per-role model
 *   2. User global model
 *   3. User model class override
 *   4. Harness model class default
 *   5. Fallback tier traversal (ascending then descending)
 */
function resolveModel(
  role: AgentRole,
  config: EforgeConfig,
  harness: 'claude-sdk' | 'pi' | undefined,
  builtinRoleDefaults: Partial<ResolvedAgentConfig>,
): { model?: ModelRef; fallbackFrom?: ModelClass; provenance?: string } {
  const userRole = config.agents.roles?.[role] ?? {};
  const perRoleModel = userRole.model ?? builtinRoleDefaults.model;
  const globalModel = config.agents.model;
  const effectiveClass: ModelClass = userRole.modelClass ?? AGENT_MODEL_CLASSES[role];

  if (perRoleModel !== undefined) return { model: perRoleModel, provenance: `agents.roles.${role}.model` };
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

  // Config-level role override
  const roleConfig = config.agents.roles?.[role];
  const runtimeName = roleConfig?.agentRuntime ?? config.defaultAgentRuntime;

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
 * Five-tier model resolution (highest → lowest):
 *   1. User per-role model (config.agents.roles[role].model)
 *   2. User global model (config.agents.model)
 *   3. User model class override (config.agents.models[effectiveClass])
 *   4. Harness model class default (MODEL_CLASS_DEFAULTS[harness][effectiveClass])
 *   5. undefined (no model set)
 *
 * Other fields use the existing four-tier priority:
 *   1. User per-role config (config.agents.roles[role])
 *   2. User global config (config.agents.{thinking,effort,...}, config.agents.maxTurns)
 *   3. Built-in per-role defaults (AGENT_ROLE_DEFAULTS[role])
 *   4. Built-in global default (DEFAULT_CONFIG.agents.maxTurns)
 */
export function resolveAgentConfig(
  role: AgentRole,
  config: EforgeConfig,
  planEntry?: { agents?: Record<string, { effort?: string; thinking?: object; rationale?: string; agentRuntime?: string }>; filePath?: string },
): ResolvedAgentConfig {
  const { agentRuntimeName, harness } = resolveAgentRuntimeForRole(role, config, planEntry);
  const builtinRoleDefaults = AGENT_ROLE_DEFAULTS[role] ?? {};
  const { fields, effortSource, thinkingSource } = resolveSdkPassthrough(role, config, planEntry, builtinRoleDefaults);
  const { model, fallbackFrom, provenance: modelProvenance } = resolveModel(role, config, harness, builtinRoleDefaults);

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

  const result: ResolvedAgentConfig = { ...fields, agentRuntimeName, harness };
  if (model !== undefined) result.model = model;
  if (fallbackFrom !== undefined) result.fallbackFrom = fallbackFrom;

  applyEffortClamp(result);
  applyThinkingCoercion(result);

  // Always stamp provenance so the UI always has source data
  result.effortSource = effortSource;
  result.thinkingSource = thinkingSource;

  return result;
}
