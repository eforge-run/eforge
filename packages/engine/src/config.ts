import { readFile, readdir, rename, rm, unlink, writeFile, mkdir, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, dirname, basename, extname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

const execFileAsync = promisify(execFile);
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod/v4';

import { sanitizeProfileName, parseRawConfigLegacy } from '@eforge-build/client';
import type { ReviewProfileConfig, BuildStageSpec } from '@eforge-build/client';
import type { AgentRole } from './events.js';
import { shardScopeSchema } from './schemas.js';
import type { ShardScope } from './schemas.js';
export type { ShardScope } from './schemas.js';

// Re-export shared types from @eforge-build/client so engine-internal callers
// (plan.ts, eforge.ts, pipeline.ts, compiler.ts, events.ts, agents/*) can keep
// importing from this module. The client package is the single owner.
export type { ReviewProfileConfig, BuildStageSpec } from '@eforge-build/client';

// ---------------------------------------------------------------------------
// Zod Schemas — single source of truth for config types
// ---------------------------------------------------------------------------

/** Agent roles matching the AgentRole union in events.ts. */
export const AGENT_ROLES = [
  'planner', 'builder', 'reviewer', 'review-fixer', 'evaluator', 'module-planner',
  'plan-reviewer', 'plan-evaluator', 'architecture-reviewer', 'architecture-evaluator',
  'cohesion-reviewer', 'cohesion-evaluator',
  'validation-fixer', 'merge-conflict-resolver',
  'staleness-assessor', 'formatter', 'doc-updater',
  'test-writer', 'tester', 'prd-validator', 'dependency-detector', 'pipeline-composer',
  'gap-closer',
  'recovery-analyst',
] as const;

const agentRoleSchema = z.enum(AGENT_ROLES);

/** Agent tiers group agent roles by workload type for batch configuration. */
export const AGENT_TIERS = ['planning', 'implementation', 'review', 'evaluation'] as const;
export type AgentTier = (typeof AGENT_TIERS)[number];
export const agentTierSchema = z.enum(AGENT_TIERS).describe('Agent tier for grouping roles by workload type');

/** Model classes group agents by workload type. */
export const MODEL_CLASSES = ['max', 'balanced', 'fast'] as const;
export type ModelClass = (typeof MODEL_CLASSES)[number];

export const modelClassSchema = z.enum(MODEL_CLASSES).describe('Model class for agent workload grouping');

const toolPresetConfigSchema = z.enum(['coding', 'none']);

// ---------------------------------------------------------------------------
// ModelRef — model references
// ---------------------------------------------------------------------------

/** A model reference: id is always required. When resolved for a Pi harness, `provider` is spliced
 * in by the resolver from `agentRuntimes.<name>.pi.provider`. Do not set `provider` on config model refs. */
export interface ModelRef {
  id: string;
  provider?: string;
}

export const modelRefSchema = z.object({
  id: z.string().describe('Model identifier (e.g. "claude-opus-4-7", "gpt-5.4")'),
  provider: z.string().optional(),
}).superRefine((data, ctx) => {
  if (data.provider !== undefined) {
    ctx.addIssue({
      code: 'custom',
      message: '"provider" must not be set on model refs. Set provider on agentRuntimes.<name>.pi.provider instead.',
      path: ['provider'],
    });
  }
}).describe('Model reference (provider must not be set here; use agentRuntimes.<name>.pi.provider)');

// ---------------------------------------------------------------------------
// SDK Passthrough Config Schemas
// ---------------------------------------------------------------------------

export const thinkingConfigSchema = z.union([
  z.object({ type: z.literal('adaptive') }),
  z.object({ type: z.literal('enabled'), budgetTokens: z.number().int().positive().optional() }),
  z.object({ type: z.literal('disabled') }),
]).describe('Controls Claude\'s thinking/reasoning behavior');

export const effortLevelSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']).describe('Effort level for controlling thinking depth');

export const sdkPassthroughConfigSchema = z.object({
  model: modelRefSchema.optional().describe('Model override'),
  thinking: thinkingConfigSchema.optional().describe('Thinking/reasoning behavior'),
  effort: effortLevelSchema.optional().describe('Effort level'),
  maxBudgetUsd: z.number().positive().optional().describe('Maximum budget in USD'),
  fallbackModel: z.string().optional().describe('Fallback model if primary is unavailable'),
  allowedTools: z.array(z.string()).optional().describe('Whitelist of allowed tool names'),
  disallowedTools: z.array(z.string()).optional().describe('Blacklist of disallowed tool names'),
});

const STRATEGIES = ['auto', 'single', 'parallel'] as const;
const STRICTNESS = ['strict', 'standard', 'lenient'] as const;
const AUTO_ACCEPT = ['suggestion', 'warning'] as const;

// Bound to `z.ZodType<ReviewProfileConfig>` so a drift between this schema and
// the shared TypeScript type in `@eforge-build/client` produces a compile error.
export const reviewProfileConfigSchema: z.ZodType<ReviewProfileConfig> = z.object({
  strategy: z.enum(STRATEGIES).describe('Review strategy: "auto" picks based on perspective count, "single" uses one reviewer, "parallel" runs all perspectives concurrently'),
  perspectives: z.array(z.string()).nonempty().describe('Review perspective names, e.g. ["code", "security", "performance"]'),
  maxRounds: z.number().int().positive().describe('Number of review-fix-evaluate cycles (default 1)'),
  autoAcceptBelow: z.enum(AUTO_ACCEPT).optional().describe('Auto-accept issues at or below this severity'),
  evaluatorStrictness: z.enum(STRICTNESS).describe('How strictly the evaluator judges fixes: "strict", "standard", or "lenient"'),
});

/** A build stage spec: either a single stage name or an array of stage names to run in parallel. */
export const buildStageSpecSchema = z.union([
  z.string().describe('A single stage name'),
  z.array(z.string()).describe('Stage names to run in parallel'),
]).describe('A stage name or array of stage names to run in parallel');

const hookConfigSchema = z.object({
  event: z.string(),
  command: z.string(),
  timeout: z.number().positive().default(5000),
});

const pluginConfigSchema = z.object({
  enabled: z.boolean().optional(),
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
  paths: z.array(z.string()).optional(),
});

const SETTING_SOURCES = ['user', 'project', 'local'] as const;

export const harnessSchema = z.enum(['claude-sdk', 'pi']).describe('Harness kind for agent runtime entry');

export const piThinkingLevelSchema = z.enum(['off', 'low', 'medium', 'high', 'xhigh']).describe('Pi-native thinking level');

export const claudeSdkConfigSchema = z.object({
  disableSubagents: z.boolean().optional().describe('Disable the Task tool so agents cannot spawn subagents. Claude SDK backend only.'),
}).describe('Configuration specific to the Claude SDK backend');

export const piConfigSchema = z.object({
  provider: z.string().optional().describe('Pi provider name (required when used as an agentRuntime entry)'),
  apiKey: z.string().optional().describe('API key for the Pi provider'),
  thinkingLevel: piThinkingLevelSchema.optional().describe('Thinking level for Pi agents'),
  extensions: z.object({
    autoDiscover: z.boolean().optional().describe('Automatically discover Pi extensions'),
    include: z.array(z.string()).optional().describe('Extension names to include'),
    exclude: z.array(z.string()).optional().describe('Extension names to exclude'),
    paths: z.array(z.string()).optional().describe('Explicit extension directory paths to load'),
  }).optional().describe('Pi extension configuration'),
  compaction: z.object({
    enabled: z.boolean().optional().describe('Enable context compaction'),
    threshold: z.number().int().positive().optional().describe('Token threshold before compaction triggers'),
  }).optional().describe('Context compaction settings'),
  retry: z.object({
    maxRetries: z.number().int().nonnegative().optional().describe('Maximum retry attempts'),
    backoffMs: z.number().int().positive().optional().describe('Initial backoff in milliseconds'),
  }).optional().describe('Retry configuration for Pi API calls'),
}).describe('Configuration for the Pi coding agent backend');

export const agentRuntimeEntrySchema = z.object({
  harness: harnessSchema.describe('Which harness to use for this runtime'),
  pi: piConfigSchema.optional(),
  claudeSdk: claudeSdkConfigSchema.optional(),
}).superRefine((data, ctx) => {
  if (data.harness === 'pi' && data.claudeSdk !== undefined) {
    ctx.addIssue({
      code: 'custom',
      message: `agentRuntime with harness "pi" cannot include "claudeSdk" configuration.`,
    });
  }
  if (data.harness === 'claude-sdk' && data.pi !== undefined) {
    ctx.addIssue({
      code: 'custom',
      message: `agentRuntime with harness "claude-sdk" cannot include "pi" configuration.`,
    });
  }
  if (data.harness === 'pi' && (!data.pi?.provider || data.pi.provider.trim() === '')) {
    ctx.addIssue({
      code: 'custom',
      message: 'agentRuntime with harness "pi" requires non-empty "pi.provider".',
      path: ['pi', 'provider'],
    });
  }
}).describe('An agent runtime entry declaring harness kind and its configuration');

/** Base object schema without refinements — .partial() is derived from this. */
const eforgeConfigBaseSchema = z.object({
  maxConcurrentBuilds: z.number().int().positive().optional(),
  langfuse: z.object({
    enabled: z.boolean().optional(),
    publicKey: z.string().optional(),
    secretKey: z.string().optional(),
    host: z.string().optional(),
  }).optional(),
  agents: z.object({
    maxTurns: z.number().int().positive().optional(),
    maxContinuations: z.number().int().nonnegative().optional(),
    permissionMode: z.enum(['bypass', 'default']).optional(),
    settingSources: z.array(z.enum(SETTING_SOURCES)).nonempty().optional(),
    bare: z.boolean().optional(),
    model: modelRefSchema.optional().describe('Global model override for all agents'),
    thinking: thinkingConfigSchema.optional().describe('Global thinking config for all agents'),
    effort: effortLevelSchema.optional().describe('Global effort level for all agents'),
    models: z.record(modelClassSchema, modelRefSchema.optional()).optional().describe('Map model class names to model refs'),
    promptDir: z.string().optional().describe('Directory of .md files that shadow bundled prompts by name match'),
    roles: z.record(agentRoleSchema, sdkPassthroughConfigSchema.extend({
      maxTurns: z.number().int().positive().optional(),
      modelClass: modelClassSchema.optional().describe('Override the model class for this role'),
      promptAppend: z.string().optional().describe('Text appended to the agent prompt after variable substitution'),
      agentRuntime: z.string().optional().describe('Name of the agentRuntime entry to use for this role'),
      tier: agentTierSchema.optional().describe('Override the tier assignment for this role'),
      shards: z.array(shardScopeSchema).optional().describe('Parallel implementation shards (builder role only)'),
    }).optional()).optional().describe('Per-agent role overrides'),
    tiers: z.record(modelClassSchema, sdkPassthroughConfigSchema.extend({
      maxTurns: z.number().int().positive().optional(),
      modelClass: modelClassSchema.optional().describe('Override the model class for all roles in this tier'),
      agentRuntime: z.string().optional().describe('Name of the agentRuntime entry to use for this tier'),
    }).optional()).optional().describe('Per-model-class tier overrides'),
  }).optional(),
  build: z.object({
    worktreeDir: z.string().optional(),
    postMergeCommands: z.array(z.string()).optional(),
    postMergeCommandTimeoutMs: z.number().int().positive().optional(),
    maxValidationRetries: z.number().int().nonnegative().optional(),
    cleanupPlanFiles: z.boolean().optional(),
  }).optional(),
  plan: z.object({
    outputDir: z.string().optional(),
  }).optional(),
  plugins: pluginConfigSchema.optional(),
  prdQueue: z.object({
    dir: z.string().optional(),
    autoBuild: z.boolean().optional(),
    watchPollIntervalMs: z.number().int().positive().optional(),
  }).optional(),
  daemon: z.object({
    idleShutdownMs: z.number().int().nonnegative().optional(),
  }).optional(),
  monitor: z.object({
    retentionCount: z.number().int().positive().optional(),
  }).optional(),
  pi: piConfigSchema.optional(),
  claudeSdk: claudeSdkConfigSchema.optional(),
  hooks: z.array(hookConfigSchema).optional(),
  agentRuntimes: z.record(z.string(), agentRuntimeEntrySchema).optional().describe('Named agent runtime configurations'),
  defaultAgentRuntime: z.string().optional().describe('Default agent runtime name used when a role does not specify one'),
});

/** Exported schema with agentRuntimes cross-field validation. */
export const eforgeConfigSchema = eforgeConfigBaseSchema.superRefine((data, ctx) => {
  const agentRuntimes = data.agentRuntimes;
  const runtimeKeys = agentRuntimes ? Object.keys(agentRuntimes) : [];

  // When agentRuntimes is present (non-empty), defaultAgentRuntime is required.
  if (runtimeKeys.length > 0 && !data.defaultAgentRuntime) {
    ctx.addIssue({
      code: 'custom',
      message: '"defaultAgentRuntime" is required when "agentRuntimes" is declared.',
      path: ['defaultAgentRuntime'],
    });
  }

  // defaultAgentRuntime must reference an existing agentRuntimes entry.
  if (data.defaultAgentRuntime && runtimeKeys.length > 0 && !agentRuntimes![data.defaultAgentRuntime]) {
    ctx.addIssue({
      code: 'custom',
      message: `"defaultAgentRuntime" references "${data.defaultAgentRuntime}" which is not declared in "agentRuntimes". Declared: ${runtimeKeys.join(', ')}.`,
      path: ['defaultAgentRuntime'],
    });
  }

  // Every agents.roles.*.agentRuntime must reference an existing agentRuntimes entry.
  if (runtimeKeys.length > 0 && data.agents?.roles) {
    for (const [role, roleConfig] of Object.entries(data.agents.roles)) {
      const roleRuntime = (roleConfig as { agentRuntime?: string } | undefined)?.agentRuntime;
      if (roleRuntime && !agentRuntimes![roleRuntime]) {
        ctx.addIssue({
          code: 'custom',
          message: `agents.roles.${role}.agentRuntime references "${roleRuntime}" which is not declared in "agentRuntimes". Declared: ${runtimeKeys.join(', ')}.`,
          path: ['agents', 'roles', role, 'agentRuntime'],
        });
      }
    }
  }

  // Every agents.tiers.*.agentRuntime must reference an existing agentRuntimes entry.
  if (runtimeKeys.length > 0 && data.agents?.tiers) {
    for (const [tier, tierConfig] of Object.entries(data.agents.tiers)) {
      const tierRuntime = (tierConfig as { agentRuntime?: string } | undefined)?.agentRuntime;
      if (tierRuntime && !agentRuntimes![tierRuntime]) {
        ctx.addIssue({
          code: 'custom',
          message: `agents.tiers.${tier}.agentRuntime references "${tierRuntime}" which is not declared in "agentRuntimes". Declared: ${runtimeKeys.join(', ')}.`,
          path: ['agents', 'tiers', tier, 'agentRuntime'],
        });
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Derived TypeScript types — from schemas, not hand-written
// ---------------------------------------------------------------------------

export type ToolPresetConfig = z.output<typeof toolPresetConfigSchema>;
// `ReviewProfileConfig` and `BuildStageSpec` are owned by `@eforge-build/client`
// and re-exported at the top of this file.
export type HookConfig = z.output<typeof hookConfigSchema>;
export type PluginConfig = z.output<typeof pluginConfigSchema>;
export type AgentRuntimeEntry = z.output<typeof agentRuntimeEntrySchema>;

/** Resolved agent config for a specific role, combining SDK passthrough fields with maxTurns. */
export interface ResolvedAgentConfig {
  maxTurns?: number;
  model?: ModelRef;
  modelClass?: ModelClass;
  thinking?: import('./harness.js').ThinkingConfig;
  effort?: import('./harness.js').EffortLevel;
  maxBudgetUsd?: number;
  fallbackModel?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  /** Set when the resolved model came from a fallback class instead of the role's effective class. */
  fallbackFrom?: ModelClass;
  /** Text appended to the agent prompt after variable substitution. */
  promptAppend?: string;
  /** True when the resolved effort was clamped to the model's maximum supported level. */
  effortClamped?: boolean;
  /** The original effort level before clamping was applied. */
  effortOriginal?: import('./harness.js').EffortLevel;
  /** Provenance of the resolved effort value. */
  effortSource?: 'planner' | 'role-config' | 'tier-config' | 'global-config' | 'default';
  /** Provenance of the resolved thinking value. */
  thinkingSource?: 'planner' | 'role-config' | 'tier-config' | 'global-config' | 'default';
  /** True when thinking was coerced from 'enabled' to 'adaptive' for models that only support adaptive thinking. */
  thinkingCoerced?: boolean;
  /** The original thinking config before coercion was applied. */
  thinkingOriginal?: import('./harness.js').ThinkingConfig;
  /** The name of the resolved agentRuntime entry (from agentRuntimes map or legacy backend name). */
  agentRuntimeName: string;
  /** The harness kind resolved for this role. */
  harness: 'claude-sdk' | 'pi';
  /** Per-role agentRuntime name override from config (input field, used during resolution). */
  agentRuntime?: string;
  /** The resolved tier for this role. Always set. */
  tier: AgentTier;
  /** Provenance of the resolved tier value. */
  tierSource: 'role-config' | 'role-default';
  /** Parallel implementation shards for the builder role. When present, the implement stage fans out. */
  shards?: ShardScope[];
}

export interface PiConfig {
  /** Optional explicit API key override. When set, takes highest priority via setRuntimeApiKey. When omitted, Pi's file-backed AuthStorage handles auth automatically (env vars, ~/.pi/agent/auth.json, OAuth tokens). */
  apiKey?: string;
  thinkingLevel: 'off' | 'low' | 'medium' | 'high' | 'xhigh';
  extensions: { autoDiscover: boolean; include?: string[]; exclude?: string[]; paths?: string[] };
  compaction: { enabled: boolean; threshold: number };
  retry: { maxRetries: number; backoffMs: number };
}

/** Resolved Claude SDK backend config. Only applied when `backend: claude-sdk`. */
export interface ClaudeSdkConfig {
  /** When true, the backend appends `'Task'` to `disallowedTools` on every agent run so subagents cannot be spawned. */
  disableSubagents: boolean;
}

export interface EforgeConfig {
  maxConcurrentBuilds: number;
  langfuse: { enabled: boolean; publicKey?: string; secretKey?: string; host: string };
  agents: {
    maxTurns: number;
    maxContinuations: number;
    permissionMode: 'bypass' | 'default';
    settingSources?: string[];
    bare: boolean;
    model?: ModelRef;
    thinking?: import('./harness.js').ThinkingConfig;
    effort?: import('./harness.js').EffortLevel;
    models?: Partial<Record<ModelClass, ModelRef>>;
    roles?: Record<string, Partial<ResolvedAgentConfig>>;
    tiers?: Partial<Record<AgentTier, {
      model?: ModelRef;
      thinking?: import('./harness.js').ThinkingConfig;
      effort?: import('./harness.js').EffortLevel;
      maxBudgetUsd?: number;
      fallbackModel?: string;
      allowedTools?: string[];
      disallowedTools?: string[];
      maxTurns?: number;
      modelClass?: ModelClass;
      agentRuntime?: string;
    }>>;
    /** Directory of .md files that shadow bundled prompts by name match. */
    promptDir?: string;
  };
  build: { worktreeDir?: string; postMergeCommands?: string[]; postMergeCommandTimeoutMs?: number; maxValidationRetries: number; cleanupPlanFiles: boolean };
  plan: { outputDir: string };
  plugins: PluginConfig;
  prdQueue: { dir: string; autoBuild: boolean; watchPollIntervalMs: number };
  daemon: { idleShutdownMs: number };
  monitor: { retentionCount: number };
  pi: PiConfig;
  claudeSdk: ClaudeSdkConfig;
  hooks: readonly HookConfig[];
  /** Named agent runtime configurations. When present, roles resolve their harness from this map. */
  agentRuntimes?: Record<string, AgentRuntimeEntry>;
  /** Default agent runtime name used when a role does not specify one. Required when agentRuntimes is non-empty. */
  defaultAgentRuntime?: string;
}

/** Deep-partial version of EforgeConfig used for parsing and merging — derived from the zod schema. */
const partialEforgeConfigSchema = eforgeConfigBaseSchema.partial();
export type PartialEforgeConfig = z.output<typeof partialEforgeConfigSchema>;

/**
 * Set of top-level keys recognized by config.yaml. Derived from the base schema's
 * shape so it stays in sync with the source of truth — adding a new top-level
 * field updates this automatically.
 */
const knownConfigYamlKeys = new Set(Object.keys(eforgeConfigBaseSchema.shape));

/**
 * Schema for config.yaml validation. Unknown top-level keys are rejected.
 * The three legacy keys (`backend:`, `pi:`, `claudeSdk:`) get a migration hint
 * pointing to agentRuntimes + defaultAgentRuntime. Other unknown keys get a
 * generic "unrecognized key" error with the recognized-key list.
 *
 * Implemented via .passthrough() + superRefine rather than .strict() so the
 * legacy migration hint always wins over the generic message and ordering is
 * fully under our control.
 */
export const configYamlSchema = eforgeConfigBaseSchema.partial().passthrough().superRefine((data, ctx) => {
  if (!data || typeof data !== 'object') return;
  const legacyFields = new Set(['backend', 'pi', 'claudeSdk']);
  for (const key of Object.keys(data as Record<string, unknown>)) {
    if (legacyFields.has(key)) {
      ctx.addIssue({
        code: 'custom',
        message: `"${key}:" is no longer valid in config.yaml. Use agentRuntimes + defaultAgentRuntime instead.`,
        path: [key],
      });
    } else if (!knownConfigYamlKeys.has(key)) {
      ctx.addIssue({
        code: 'custom',
        message: `Unrecognized key "${key}" in config.yaml. Recognized keys: ${Array.from(knownConfigYamlKeys).sort().join(', ')}.`,
        path: [key],
      });
    }
  }
});

/** Minimum allowed value for postMergeCommandTimeoutMs. Values below this are clamped. */
export const MIN_POST_MERGE_COMMAND_TIMEOUT_MS = 10_000;

export const DEFAULT_REVIEW: ReviewProfileConfig = Object.freeze({
  strategy: 'auto' as const,
  perspectives: Object.freeze(['code']) as unknown as string[],
  maxRounds: 1,
  evaluatorStrictness: 'standard' as const,
});

export const DEFAULT_CONFIG: EforgeConfig = Object.freeze({
  maxConcurrentBuilds: 2,
  langfuse: Object.freeze({ enabled: false, host: 'https://cloud.langfuse.com' }),
  agents: Object.freeze({ maxTurns: 30, maxContinuations: 3, permissionMode: 'bypass' as const, settingSources: ['project'] as string[], bare: false }),
  build: Object.freeze({ worktreeDir: undefined, postMergeCommands: undefined, postMergeCommandTimeoutMs: 300_000, maxValidationRetries: 2, cleanupPlanFiles: true }),
  plan: Object.freeze({ outputDir: 'eforge/plans' }),
  plugins: Object.freeze({ enabled: true }),
  prdQueue: Object.freeze({ dir: 'eforge/queue', autoBuild: true, watchPollIntervalMs: 5000 }),
  daemon: Object.freeze({ idleShutdownMs: 7_200_000 }),
  monitor: Object.freeze({ retentionCount: 20 }),
  pi: Object.freeze({
    thinkingLevel: 'medium' as const,
    extensions: Object.freeze({ autoDiscover: true }),
    compaction: Object.freeze({ enabled: true, threshold: 100_000 }),
    retry: Object.freeze({ maxRetries: 3, backoffMs: 1000 }),
  }),
  claudeSdk: Object.freeze({ disableSubagents: false }),
  hooks: Object.freeze([]),
  agentRuntimes: Object.freeze({ 'claude-sdk': Object.freeze({ harness: 'claude-sdk' as const }) }) as Record<string, AgentRuntimeEntry>,
  defaultAgentRuntime: 'claude-sdk',
});

/**
 * Walk up the directory tree looking for eforge/config.yaml.
 * Returns the absolute path if found, null otherwise.
 */
export async function findConfigFile(startDir: string): Promise<string | null> {
  let dir = resolve(startDir);

  while (true) {
    const candidate = resolve(dir, 'eforge', 'config.yaml');
    try {
      await access(candidate);
      return candidate;
    } catch {
      // not found, move up
    }

    const parent = dirname(dir);
    if (parent === dir) {
      break; // reached filesystem root
    }
    dir = parent;
  }

  return null;
}

/**
 * Merge file-based config with env vars. Env vars take precedence.
 * Sets langfuse.enabled = true only when both keys are present.
 */
export function resolveConfig(
  fileConfig: PartialEforgeConfig,
  env: Record<string, string | undefined> = process.env,
): EforgeConfig {
  const langfusePublicKey = env.LANGFUSE_PUBLIC_KEY ?? fileConfig.langfuse?.publicKey;
  const langfuseSecretKey = env.LANGFUSE_SECRET_KEY ?? fileConfig.langfuse?.secretKey;
  const langfuseHost = env.LANGFUSE_BASE_URL ?? fileConfig.langfuse?.host ?? DEFAULT_CONFIG.langfuse.host;
  const langfuseEnabled = !!(langfusePublicKey && langfuseSecretKey);

  return Object.freeze({
    maxConcurrentBuilds: fileConfig.maxConcurrentBuilds ?? DEFAULT_CONFIG.maxConcurrentBuilds,
    langfuse: Object.freeze({
      enabled: langfuseEnabled,
      publicKey: langfusePublicKey,
      secretKey: langfuseSecretKey,
      host: langfuseHost,
    }),
    agents: Object.freeze({
      maxTurns: fileConfig.agents?.maxTurns ?? DEFAULT_CONFIG.agents.maxTurns,
      maxContinuations: fileConfig.agents?.maxContinuations ?? DEFAULT_CONFIG.agents.maxContinuations,
      permissionMode: fileConfig.agents?.permissionMode ?? DEFAULT_CONFIG.agents.permissionMode,
      settingSources: fileConfig.agents?.settingSources ?? DEFAULT_CONFIG.agents.settingSources,
      bare: fileConfig.agents?.bare ?? !!env.ANTHROPIC_API_KEY,
      model: fileConfig.agents?.model,
      thinking: fileConfig.agents?.thinking,
      effort: fileConfig.agents?.effort,
      models: fileConfig.agents?.models,
      roles: fileConfig.agents?.roles as Record<string, Partial<ResolvedAgentConfig>> | undefined,
      tiers: fileConfig.agents?.tiers as EforgeConfig['agents']['tiers'],
      promptDir: fileConfig.agents?.promptDir,
    }),
    build: Object.freeze({
      worktreeDir: fileConfig.build?.worktreeDir ?? DEFAULT_CONFIG.build.worktreeDir,
      postMergeCommands: fileConfig.build?.postMergeCommands ?? DEFAULT_CONFIG.build.postMergeCommands,
      postMergeCommandTimeoutMs: fileConfig.build?.postMergeCommandTimeoutMs ?? DEFAULT_CONFIG.build.postMergeCommandTimeoutMs,
      maxValidationRetries: fileConfig.build?.maxValidationRetries ?? DEFAULT_CONFIG.build.maxValidationRetries,
      cleanupPlanFiles: fileConfig.build?.cleanupPlanFiles ?? DEFAULT_CONFIG.build.cleanupPlanFiles,
    }),
    plan: Object.freeze({
      outputDir: fileConfig.plan?.outputDir ?? DEFAULT_CONFIG.plan.outputDir,
    }),
    plugins: Object.freeze({
      enabled: fileConfig.plugins?.enabled ?? DEFAULT_CONFIG.plugins.enabled,
      include: fileConfig.plugins?.include,
      exclude: fileConfig.plugins?.exclude,
      paths: fileConfig.plugins?.paths,
    }),
    prdQueue: Object.freeze({
      dir: fileConfig.prdQueue?.dir ?? DEFAULT_CONFIG.prdQueue.dir,
      autoBuild: fileConfig.prdQueue?.autoBuild ?? DEFAULT_CONFIG.prdQueue.autoBuild,
      watchPollIntervalMs: fileConfig.prdQueue?.watchPollIntervalMs ?? DEFAULT_CONFIG.prdQueue.watchPollIntervalMs,
    }),
    daemon: Object.freeze({
      idleShutdownMs: fileConfig.daemon?.idleShutdownMs ?? DEFAULT_CONFIG.daemon.idleShutdownMs,
    }),
    monitor: Object.freeze({
      retentionCount: fileConfig.monitor?.retentionCount ?? DEFAULT_CONFIG.monitor.retentionCount,
    }),
    pi: Object.freeze({
      apiKey: fileConfig.pi?.apiKey,
      thinkingLevel: fileConfig.pi?.thinkingLevel ?? DEFAULT_CONFIG.pi.thinkingLevel,
      extensions: Object.freeze({
        autoDiscover: fileConfig.pi?.extensions?.autoDiscover ?? DEFAULT_CONFIG.pi.extensions.autoDiscover,
        include: fileConfig.pi?.extensions?.include,
        exclude: fileConfig.pi?.extensions?.exclude,
        paths: fileConfig.pi?.extensions?.paths,
      }),
      compaction: Object.freeze({
        enabled: fileConfig.pi?.compaction?.enabled ?? DEFAULT_CONFIG.pi.compaction.enabled,
        threshold: fileConfig.pi?.compaction?.threshold ?? DEFAULT_CONFIG.pi.compaction.threshold,
      }),
      retry: Object.freeze({
        maxRetries: fileConfig.pi?.retry?.maxRetries ?? DEFAULT_CONFIG.pi.retry.maxRetries,
        backoffMs: fileConfig.pi?.retry?.backoffMs ?? DEFAULT_CONFIG.pi.retry.backoffMs,
      }),
    }),
    claudeSdk: Object.freeze({
      disableSubagents: fileConfig.claudeSdk?.disableSubagents ?? DEFAULT_CONFIG.claudeSdk.disableSubagents,
    }),
    hooks: Object.freeze(fileConfig.hooks ?? DEFAULT_CONFIG.hooks) as HookConfig[],
    agentRuntimes: fileConfig.agentRuntimes as Record<string, AgentRuntimeEntry> | undefined,
    defaultAgentRuntime: fileConfig.defaultAgentRuntime,
  });
}

/**
 * Error thrown when config.yaml contains `backend:` which must be migrated
 * to a named profile under eforge/profiles/.
 */
export class ConfigMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigMigrationError';
  }
}

/**
 * Parse and validate a raw YAML object into a partial EforgeConfig.
 * Uses zod schema for validation — invalid fields are dropped and
 * a warning is returned so users get feedback on typos.
 *
 * @param context  `'config'` (default) for config.yaml parsing — rejects and strips `backend:`.
 *                 `'profile'` for profile file parsing — keeps `backend:`.
 */
export function parseRawConfig(data: Record<string, unknown>, context: 'config' | 'profile' = 'config'): { config: PartialEforgeConfig; warnings: string[] } {
  // Config.yaml context: reject legacy top-level fields that must migrate to agentRuntimes.
  if (context === 'config') {
    const offending: string[] = [];
    if (data.backend !== undefined) offending.push('backend');
    if (data.pi !== undefined) offending.push('pi');
    if (data.claudeSdk !== undefined) offending.push('claudeSdk');

    if (offending.length > 0) {
      const fieldList = offending.map((f) => `"${f}:"`).join(', ');
      const backendValue = typeof data.backend === 'string' ? data.backend : 'claude-sdk';
      const harnessValue = backendValue === 'pi' ? 'pi' : 'claude-sdk';
      const exampleName = harnessValue === 'pi' ? 'my-pi' : 'main';
      throw new ConfigMigrationError(
        `Legacy field(s) ${fieldList} are no longer valid in config.yaml. ` +
        `Use agentRuntimes + defaultAgentRuntime instead. Example:\n\n` +
        `  agentRuntimes:\n` +
        `    ${exampleName}:\n` +
        `      harness: ${harnessValue}\n` +
        `  defaultAgentRuntime: ${exampleName}\n\n` +
        `Offending field(s): ${offending.join(', ')}`,
      );
    }
  }

  const result = partialEforgeConfigSchema.safeParse(data);
  if (result.success) {
    return { config: stripUndefinedSections(result.data), warnings: [] };
  }
  // Collect validation errors so callers can surface them to users
  const warning = 'eforge config warning: some fields were invalid and will be ignored:\n' + z.prettifyError(result.error);
  // Parse again with passthrough to salvage valid fields —
  // safeParse is all-or-nothing per property, so re-parse each section independently
  return { config: parseRawConfigFallback(data, context), warnings: [warning] };
}

/**
 * Fallback parser: parse each top-level section independently so that
 * one bad section doesn't nuke the rest. Mirrors the schema structure.
 */
function parseRawConfigFallback(data: Record<string, unknown>, context: 'config' | 'profile' = 'config'): PartialEforgeConfig {
  const result: PartialEforgeConfig = {};
  // Suppress unused-parameter warning: context is retained for future profile-specific handling
  void context;
  if (data.maxConcurrentBuilds !== undefined) {
    const mcbSchema = z.number().int().positive();
    const mcbResult = mcbSchema.safeParse(data.maxConcurrentBuilds);
    if (mcbResult.success) {
      (result as Record<string, unknown>).maxConcurrentBuilds = mcbResult.data;
    }
  }
  const sections = ['langfuse', 'agents', 'build', 'plan', 'plugins', 'prdQueue', 'daemon', 'pi', 'claudeSdk', 'hooks'] as const;
  for (const key of sections) {
    if (data[key] === undefined) continue;
    const sectionSchema = eforgeConfigSchema.shape[key];
    const parsed = sectionSchema.safeParse(data[key]);
    if (parsed.success) {
      (result as Record<string, unknown>)[key] = parsed.data;
    }
    // If a section fails, it's silently dropped (warning already logged above)
  }
  return stripUndefinedSections(result);
}

/**
 * Remove top-level keys that are undefined or empty objects so that
 * mergePartialConfigs treats absent sections correctly.
 */
function stripUndefinedSections(config: PartialEforgeConfig): PartialEforgeConfig {
  const out: PartialEforgeConfig = {};
  if (config.maxConcurrentBuilds !== undefined) out.maxConcurrentBuilds = config.maxConcurrentBuilds;
  if (config.langfuse !== undefined) out.langfuse = config.langfuse;
  if (config.agents !== undefined) out.agents = config.agents;
  if (config.build !== undefined) out.build = config.build;
  if (config.plan !== undefined) out.plan = config.plan;
  if (config.plugins !== undefined) out.plugins = config.plugins;
  if (config.prdQueue !== undefined) out.prdQueue = config.prdQueue;
  if (config.daemon !== undefined) out.daemon = config.daemon;
  if (config.pi !== undefined) out.pi = config.pi;
  if (config.claudeSdk !== undefined) out.claudeSdk = config.claudeSdk;
  if (config.hooks !== undefined) out.hooks = config.hooks;
  if (config.agentRuntimes !== undefined) out.agentRuntimes = config.agentRuntimes;
  if (config.defaultAgentRuntime !== undefined) out.defaultAgentRuntime = config.defaultAgentRuntime;
  return out;
}

/**
 * Return the path to the user-level (global) config file.
 * Respects $XDG_CONFIG_HOME when set, else falls back to ~/.config.
 */
export function getUserConfigPath(
  env: Record<string, string | undefined> = process.env,
): string {
  const base = env.XDG_CONFIG_HOME || resolve(homedir(), '.config');
  return resolve(base, 'eforge', 'config.yaml');
}

/**
 * Merge two partial configs (global + project) into one.
 * - Scalar fields: project wins over global
 * - Object sections: shallow merge per-field, project overrides global
 * - `hooks`: concatenate (global first, then project)
 * - Other arrays (postMergeCommands, plugins.include/exclude/paths, settingSources): project replaces
 */
export function mergePartialConfigs(
  global: PartialEforgeConfig,
  project: PartialEforgeConfig,
): PartialEforgeConfig {
  const result: PartialEforgeConfig = {};

  // Scalar fields: project wins
  if (project.maxConcurrentBuilds !== undefined || global.maxConcurrentBuilds !== undefined) {
    result.maxConcurrentBuilds = project.maxConcurrentBuilds ?? global.maxConcurrentBuilds;
  }

  // Object sections: shallow merge
  if (global.langfuse || project.langfuse) {
    result.langfuse = { ...global.langfuse, ...project.langfuse };
  }
  if (global.agents || project.agents) {
    const mergedAgents = { ...global.agents, ...project.agents };
    // Deep-merge roles: per-role shallow merge (project role fields override global, global-only fields survive)
    const globalRoles = global.agents?.roles;
    const projectRoles = project.agents?.roles;
    if (globalRoles || projectRoles) {
      const mergedRoles: Record<string, Record<string, unknown>> = {};
      const allRoleNames = new Set([
        ...Object.keys(globalRoles ?? {}),
        ...Object.keys(projectRoles ?? {}),
      ]);
      for (const roleName of allRoleNames) {
        const g = (globalRoles as Record<string, Record<string, unknown>> | undefined)?.[roleName];
        const p = (projectRoles as Record<string, Record<string, unknown>> | undefined)?.[roleName];
        if (g && p) {
          mergedRoles[roleName] = { ...g, ...p };
        } else {
          mergedRoles[roleName] = (p ?? g)!;
        }
      }
      mergedAgents.roles = mergedRoles;
    }
    // Deep-merge tiers: per-tier shallow merge (project tier fields override global, global-only fields survive)
    const globalTiers = global.agents?.tiers;
    const projectTiers = project.agents?.tiers;
    if (globalTiers || projectTiers) {
      const mergedTiers: Record<string, Record<string, unknown>> = {};
      const allTierNames = new Set([
        ...Object.keys(globalTiers ?? {}),
        ...Object.keys(projectTiers ?? {}),
      ]);
      for (const tierName of allTierNames) {
        const g = (globalTiers as Record<string, Record<string, unknown>> | undefined)?.[tierName];
        const p = (projectTiers as Record<string, Record<string, unknown>> | undefined)?.[tierName];
        if (g && p) {
          mergedTiers[tierName] = { ...g, ...p };
        } else {
          mergedTiers[tierName] = (p ?? g)!;
        }
      }
      mergedAgents.tiers = mergedTiers as typeof mergedAgents.tiers;
    }
    result.agents = mergedAgents;
  }
  if (global.build || project.build) {
    result.build = { ...global.build, ...project.build };
  }
  if (global.plan || project.plan) {
    result.plan = { ...global.plan, ...project.plan };
  }
  if (global.plugins || project.plugins) {
    result.plugins = { ...global.plugins, ...project.plugins };
  }
  if (global.prdQueue || project.prdQueue) {
    result.prdQueue = { ...global.prdQueue, ...project.prdQueue };
  }
  if (global.daemon || project.daemon) {
    result.daemon = { ...global.daemon, ...project.daemon };
  }
  if (global.monitor || project.monitor) {
    result.monitor = { ...global.monitor, ...project.monitor };
  }
  if (global.pi || project.pi) {
    result.pi = { ...global.pi, ...project.pi };
  }
  if (global.claudeSdk || project.claudeSdk) {
    result.claudeSdk = { ...global.claudeSdk, ...project.claudeSdk };
  }

  // hooks: concatenate (global first, then project)
  if (global.hooks || project.hooks) {
    result.hooks = [...(global.hooks ?? []), ...(project.hooks ?? [])];
  }

  // agentRuntimes: shallow-merge by entry name, project overrides global on collision
  if (global.agentRuntimes || project.agentRuntimes) {
    result.agentRuntimes = { ...global.agentRuntimes, ...project.agentRuntimes };
  }

  // defaultAgentRuntime scalar: project wins
  if (project.defaultAgentRuntime !== undefined || global.defaultAgentRuntime !== undefined) {
    result.defaultAgentRuntime = project.defaultAgentRuntime ?? global.defaultAgentRuntime;
  }

  return result;
}

/**
 * Load the user-level (global) config file.
 * Returns an empty partial on any failure (missing file, bad YAML, etc.).
 */
export async function loadUserConfig(
  env: Record<string, string | undefined> = process.env,
): Promise<PartialEforgeConfig> {
  const configPath = getUserConfigPath(env);
  try {
    const raw = await readFile(configPath, 'utf-8');
    const data = parseYaml(raw);
    if (!data || typeof data !== 'object') {
      return {};
    }
    const { config } = parseRawConfig(data as Record<string, unknown>);
    return config;
  } catch (err) {
    // Re-throw migration errors so callers surface a hard error
    if (err instanceof ConfigMigrationError) throw err;
    return {};
  }
}

/**
 * Load eforge/config.yaml from the given directory (searching upward),
 * merged with user-level global config (~/.config/eforge/config.yaml).
 * Returns DEFAULT_CONFIG when no config files exist.
 *
 * When an active profile is found (via `eforge/.active-profile`
 * marker), the profile is merged on top of the project config before
 * env-var resolution.
 *
 * Throws `ConfigMigrationError` if a legacy `eforge.yaml` is detected at
 * the start directory and no `eforge/config.yaml` is found. Users must run:
 *   mkdir -p eforge && mv eforge.yaml eforge/config.yaml
 *
 * Returns `{ config, warnings }` where `warnings` is a list of user-facing
 * diagnostic messages about invalid config fields or migration issues.
 * Consumers with an active event stream should yield `config:warning` events;
 * bootstrap consumers (CLI startup, daemon startup) should write to stderr.
 */
export async function loadConfig(cwd?: string): Promise<{ config: EforgeConfig; warnings: string[]; profile: { name: string | null; source: ActiveProfileSource; scope: 'project' | 'user' | null; config: PartialEforgeConfig | null } }> {
  const globalConfig = await loadUserConfig();
  const allWarnings: string[] = [];

  const startDir = cwd ?? process.cwd();
  const configPath = await findConfigFile(startDir);

  // Detect legacy eforge.yaml and abort with a migration error
  if (!configPath) {
    const legacyCandidate = resolve(startDir, 'eforge.yaml');
    try {
      await access(legacyCandidate);
      throw new ConfigMigrationError(
        `Found legacy config at ${legacyCandidate}. ` +
        `eforge/config.yaml is now required. ` +
        `Run: mkdir -p eforge && mv eforge.yaml eforge/config.yaml`,
      );
    } catch (err) {
      if (err instanceof ConfigMigrationError) throw err;
      // no legacy config either — continue with defaults
    }
  }

  let projectConfig: PartialEforgeConfig = {};
  if (configPath) {
    try {
      const raw = await readFile(configPath, 'utf-8');
      const data = parseYaml(raw);
      if (data && typeof data === 'object') {
        const { config, warnings } = parseRawConfig(data as Record<string, unknown>);
        projectConfig = config;
        allWarnings.push(...warnings);
      }
    } catch (err) {
      // Re-throw migration errors so callers surface a hard error
      if (err instanceof ConfigMigrationError) throw err;
      // malformed YAML — treat as empty
    }
  }

  // Auto-migrate eforge/backends/ -> eforge/profiles/ on first load after upgrade
  if (configPath) {
    const configDir = dirname(configPath);
    try {
      await migrateBackendsToProfiles(configDir);
    } catch {
      // best-effort: migration failure should not break config loading
    }
  }
  // Auto-migrate user-scope backends/ -> profiles/ (always, independent of project config)
  try {
    await migrateUserBackendsToProfiles();
  } catch {
    // best-effort: migration failure should not break config loading
  }

  // Resolve and merge active profile, if present
  let profileConfig: PartialEforgeConfig | null = null;
  let resolvedProfileName: string | null = null;
  let resolvedProfileSource: ActiveProfileSource = 'none';
  let resolvedProfileScope: 'project' | 'user' | null = null;
  if (configPath) {
    const configDir = dirname(configPath);
    try {
      const { name, source, warnings } = await resolveActiveProfileName(configDir, projectConfig, globalConfig);
      allWarnings.push(...warnings);
      resolvedProfileName = name;
      resolvedProfileSource = source;
      if (name) {
        const result = await loadProfile(configDir, name);
        if (result) {
          profileConfig = result.profile;
          resolvedProfileScope = result.scope;
        }
      }
    } catch {
      // best-effort: profile resolution should not break config loading
    }
  }

  const baseMerged = mergePartialConfigs(globalConfig, projectConfig);
  const merged = profileConfig ? mergePartialConfigs(baseMerged, profileConfig) : baseMerged;
  return {
    config: resolveConfig(merged),
    warnings: allWarnings,
    profile: {
      name: resolvedProfileName,
      source: resolvedProfileSource,
      scope: resolvedProfileScope,
      config: profileConfig,
    },
  };
}

// ---------------------------------------------------------------------------
// Profile Loader
// ---------------------------------------------------------------------------

/**
 * Source of the active profile resolution.
 *
 * - `local`: marker file `eforge/.active-profile` selected the profile (dev-local override)
 * - `user-local`: user-scope marker `~/.config/eforge/.active-profile` selected the profile
 * - `missing`: marker present, but the referenced profile file is missing
 *   (a one-shot stderr warning is logged; fallback to user-marker or none)
 * - `none`: no profile applied (no marker found)
 */
export type ActiveProfileSource = 'local' | 'user-local' | 'missing' | 'none';

/** Marker filename inside the eforge config directory. */
const ACTIVE_PROFILE_MARKER = '.active-profile';

/** Profile subdirectory inside the eforge config directory. */
const PROFILES_SUBDIR = 'profiles';

function profilePath(configDir: string, name: string): string {
  return resolve(configDir, PROFILES_SUBDIR, `${name}.yaml`);
}

function profilesDir(configDir: string): string {
  return resolve(configDir, PROFILES_SUBDIR);
}

function markerPath(configDir: string): string {
  return resolve(configDir, ACTIVE_PROFILE_MARKER);
}

/** Return the user eforge config directory (~/.config/eforge/). */
function userEforgeConfigDir(): string {
  const base = process.env.XDG_CONFIG_HOME || resolve(homedir(), '.config');
  return resolve(base, 'eforge');
}

/** Return the user-scope profiles directory (~/.config/eforge/profiles/). */
function userProfilesDir(): string {
  return resolve(userEforgeConfigDir(), PROFILES_SUBDIR);
}

/** Return the path to a user-scope profile file. */
function userProfilePath(name: string): string {
  return resolve(userProfilesDir(), `${name}.yaml`);
}

/** Return the path to the user-scope active-profile marker file. */
function userMarkerPath(): string {
  return resolve(userEforgeConfigDir(), ACTIVE_PROFILE_MARKER);
}

/** Check whether a profile file exists in either project or user scope. */
async function profileExistsInAnyScope(configDir: string, name: string): Promise<boolean> {
  if (await fileExists(profilePath(configDir, name))) return true;
  if (await fileExists(userProfilePath(name))) return true;
  return false;
}

/** Read a marker file and return the trimmed name, or null if absent/empty. */
async function readMarkerName(path: string): Promise<string | null> {
  try {
    const raw = await readFile(path, 'utf-8');
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Auto-migrate `eforge/backends/` -> `eforge/profiles/` and
 * `.active-backend` -> `.active-profile` on first load after upgrade.
 *
 * Strategy:
 * - If only `backends/` exists: perform migration (git mv with fs.rename fallback).
 * - If both directories exist: log a warning and leave `backends/` untouched.
 * - If only `profiles/` or neither: do nothing.
 * - If `profiles/` exists and `.active-backend` exists without `.active-profile`:
 *   the directory was previously migrated but the marker rename failed — retry
 *   the marker migration (idempotent recovery).
 * Marker file migration is tied to directory migration.
 */
async function migrateBackendsToProfiles(configDir: string): Promise<void> {
  const oldDir = resolve(configDir, 'backends');
  const newDir = profilesDir(configDir);
  const oldMarker = resolve(configDir, '.active-backend');
  const newMarker = markerPath(configDir);

  const [oldDirExists, newDirExists, oldMarkerExists, newMarkerExists] = await Promise.all([
    fileExists(oldDir),
    fileExists(newDir),
    fileExists(oldMarker),
    fileExists(newMarker),
  ]);

  if (!oldDirExists) {
    // Detect orphaned marker: directory already migrated but marker rename failed previously
    if (newDirExists && oldMarkerExists && !newMarkerExists) {
      try {
        await rename(oldMarker, newMarker);
        process.stderr.write('[eforge] Migrated orphaned eforge/.active-backend -> .active-profile\n');
      } catch {
        process.stderr.write(
          '[eforge] Failed to migrate orphaned eforge/.active-backend marker. ' +
          'To fix manually, run: mv eforge/.active-backend eforge/.active-profile\n',
        );
      }
    }
    return;
  }

  if (newDirExists) {
    // Both directories exist — warn and leave backends/ untouched for manual resolution
    process.stderr.write(
      '[eforge] Both eforge/backends/ and eforge/profiles/ exist. ' +
      'Migration skipped; please resolve manually and remove eforge/backends/.\n',
    );
    return;
  }

  // Migrate directory: try git mv, fall back to fs.rename
  const projectRoot = dirname(configDir);
  let migrated = false;
  try {
    await execFileAsync('git', ['-C', projectRoot, 'mv', 'eforge/backends', 'eforge/profiles']);
    migrated = true;
  } catch {
    // git mv failed (not a git repo, or other error) — try fs.rename
    try {
      await rename(oldDir, newDir);
      migrated = true;
    } catch {
      process.stderr.write('[eforge] Failed to migrate eforge/backends/ to eforge/profiles/.\n');
      return;
    }
  }

  if (migrated) {
    process.stderr.write('[eforge] Migrated eforge/backends/ -> eforge/profiles/\n');

    // Also migrate the marker file (tied to directory migration)
    if (oldMarkerExists) {
      try {
        await rename(oldMarker, newMarker);
        process.stderr.write('[eforge] Migrated .active-backend -> .active-profile\n');
      } catch {
        process.stderr.write(
          '[eforge] Failed to migrate .active-backend marker. ' +
          'To fix manually, run: mv eforge/.active-backend eforge/.active-profile\n',
        );
      }
    }
  }
}

/**
 * Auto-migrate user-scope `~/.config/eforge/backends/` -> `~/.config/eforge/profiles/` and
 * `~/.config/eforge/.active-backend` -> `~/.config/eforge/.active-profile` on first load after upgrade.
 *
 * Strategy mirrors `migrateBackendsToProfiles` but operates on the user config directory
 * and uses only `fs.rename` (the user config dir is not a git repo).
 */
async function migrateUserBackendsToProfiles(): Promise<void> {
  const userDir = userEforgeConfigDir();
  const oldDir = resolve(userDir, 'backends');
  const newDir = userProfilesDir();
  const oldMarker = resolve(userDir, '.active-backend');
  const newMarker = userMarkerPath();

  const [oldDirExists, newDirExists, oldMarkerExists, newMarkerExists] = await Promise.all([
    fileExists(oldDir),
    fileExists(newDir),
    fileExists(oldMarker),
    fileExists(newMarker),
  ]);

  if (!oldDirExists) {
    // Detect orphaned marker: directory already migrated but marker rename failed previously
    if (newDirExists && oldMarkerExists && !newMarkerExists) {
      try {
        await rename(oldMarker, newMarker);
        process.stderr.write('[eforge] Migrated orphaned ~/.config/eforge/.active-backend -> .active-profile\n');
      } catch {
        process.stderr.write(
          '[eforge] Failed to migrate orphaned ~/.config/eforge/.active-backend marker. ' +
          'To fix manually, run: mv ~/.config/eforge/.active-backend ~/.config/eforge/.active-profile\n',
        );
      }
    }
    return;
  }

  if (newDirExists) {
    // Both directories exist — warn and leave backends/ untouched for manual resolution
    process.stderr.write(
      '[eforge] Both ~/.config/eforge/backends/ and ~/.config/eforge/profiles/ exist. ' +
      'Migration skipped; please resolve manually and remove ~/.config/eforge/backends/.\n',
    );
    return;
  }

  // Migrate using fs.rename (user config dir is not a git repo)
  try {
    await rename(oldDir, newDir);
  } catch {
    process.stderr.write('[eforge] Failed to migrate ~/.config/eforge/backends/ to ~/.config/eforge/profiles/.\n');
    return;
  }

  process.stderr.write('[eforge] Migrated ~/.config/eforge/backends/ -> ~/.config/eforge/profiles/\n');

  // Also migrate the marker file (tied to directory migration)
  if (oldMarkerExists) {
    try {
      await rename(oldMarker, newMarker);
      process.stderr.write('[eforge] Migrated ~/.config/eforge/.active-backend -> .active-profile\n');
    } catch {
      process.stderr.write(
        '[eforge] Failed to migrate ~/.config/eforge/.active-backend marker. ' +
        'To fix manually, run: mv ~/.config/eforge/.active-backend ~/.config/eforge/.active-profile\n',
      );
    }
  }
}

/**
 * Return the directory containing `eforge/config.yaml` from the given start
 * directory, or null when no config file is found.
 */
export async function getConfigDir(cwd?: string): Promise<string | null> {
  const startDir = cwd ?? process.cwd();
  const configPath = await findConfigFile(startDir);
  return configPath ? dirname(configPath) : null;
}

/**
 * Resolve the active agent runtime profile name and how it was selected.
 *
 * Resolution precedence:
 * 1. Project marker `eforge/.active-profile` (dev-local) — wins when present and the
 *    referenced profile file exists in either project or user scope.
 * 2. User marker `~/.config/eforge/.active-profile` — user-level dev-local override.
 * 3. Otherwise no profile is applied.
 *
 * Returns `{ name, source, warnings }` where `warnings` carries any diagnostic
 * messages (e.g. stale marker warnings). Consumers should surface these to the user.
 */
export async function resolveActiveProfileName(
  configDir: string,
  projectConfig: PartialEforgeConfig,
  userConfig?: PartialEforgeConfig,
): Promise<{ name: string | null; source: ActiveProfileSource; warnings: string[] }> {
  const warnings: string[] = [];

  // Step 1: Project marker
  const projectMarkerName = await readMarkerName(markerPath(configDir));

  if (projectMarkerName !== null) {
    if (await profileExistsInAnyScope(configDir, projectMarkerName)) {
      return { name: projectMarkerName, source: 'local', warnings };
    }
    // Marker is stale — collect warning, then attempt fallbacks
    warnings.push(
      `[eforge] Active profile marker ${markerPath(configDir)} points at ` +
      `"${projectMarkerName}" but no profile file exists in project or user scope. ` +
      `Falling back to next available source.`,
    );
    // Try user marker as fallback
    const userMarker = await readMarkerName(userMarkerPath());
    if (userMarker && await profileExistsInAnyScope(configDir, userMarker)) {
      return { name: userMarker, source: 'user-local', warnings };
    }
    return { name: null, source: 'missing', warnings };
  }

  // Step 2: User marker
  const userMarker = await readMarkerName(userMarkerPath());
  if (userMarker && await profileExistsInAnyScope(configDir, userMarker)) {
    return { name: userMarker, source: 'user-local', warnings };
  }

  // Step 3: None
  return { name: null, source: 'none', warnings };
}

/**
 * Load and parse an agent runtime profile file from a specific path. Returns null
 * when the file does not exist or is unparseable.
 */
async function loadProfileFromPath(path: string): Promise<PartialEforgeConfig | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    return null;
  }
  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') {
    return {};
  }
  const { config } = parseRawConfig(data as Record<string, unknown>, 'profile');
  return config;
}

/**
 * Load and parse a profile file. Looks up in project scope first
 * (`eforge/profiles/`), then user scope (`~/.config/eforge/profiles/`).
 * Returns null when the profile file does not exist in either scope.
 * Profile files use the same partial-config schema as `config.yaml`.
 */
export async function loadProfile(
  configDir: string,
  name: string,
): Promise<{ profile: PartialEforgeConfig; scope: 'project' | 'user' } | null> {
  // Try project scope first
  const projectResult = await loadProfileFromPath(profilePath(configDir, name));
  if (projectResult !== null) {
    return { profile: projectResult, scope: 'project' };
  }
  // Try user scope fallback
  const userResult = await loadProfileFromPath(userProfilePath(name));
  if (userResult !== null) {
    return { profile: userResult, scope: 'user' };
  }
  return null;
}

/**
 * List all profile files from both project (`eforge/profiles/`) and
 * user (`~/.config/eforge/profiles/`) scopes. Each entry includes the profile
 * name, its declared `backend`, the absolute file path, the scope it belongs to,
 * and `shadowedBy: 'project'` when a user-scope entry is shadowed by a
 * project-scope entry with the same name. Unreadable or non-YAML files are
 * skipped silently.
 */
export async function listProfiles(
  configDir: string,
): Promise<Array<{ name: string; harness: 'claude-sdk' | 'pi' | undefined; path: string; scope: 'project' | 'user'; shadowedBy?: 'project' }>> {
  type ProfileEntry = { name: string; harness: 'claude-sdk' | 'pi' | undefined; path: string; scope: 'project' | 'user'; shadowedBy?: 'project' };

  async function scanDir(dir: string, scope: 'project' | 'user'): Promise<ProfileEntry[]> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return [];
    }
    const out: ProfileEntry[] = [];
    for (const entry of entries.sort()) {
      if (extname(entry) !== '.yaml') continue;
      const name = basename(entry, '.yaml');
      const path = resolve(dir, entry);
      let harness: 'claude-sdk' | 'pi' | undefined;
      try {
        const raw = await readFile(path, 'utf-8');
        const data = parseYaml(raw);
        if (data && typeof data === 'object') {
          // Support both new `harness:` key and legacy `backend:` key in profile files.
          const raw_data = data as Record<string, unknown>;
          const harnessVal = raw_data.harness ?? raw_data.backend;
          const parsed = harnessSchema.safeParse(harnessVal);
          if (parsed.success) {
            harness = parsed.data;
          }
        }
      } catch {
        // unreadable — still include the entry with harness=undefined
      }
      out.push({ name, harness, path, scope });
    }
    return out;
  }

  const projectEntries = await scanDir(profilesDir(configDir), 'project');
  const userEntries = await scanDir(userProfilesDir(), 'user');

  // Mark user entries that are shadowed by project entries with the same name
  const projectNames = new Set(projectEntries.map((e) => e.name));
  for (const entry of userEntries) {
    if (projectNames.has(entry.name)) {
      entry.shadowedBy = 'project';
    }
  }

  return [...projectEntries, ...userEntries];
}

/**
 * Set the active profile by writing the marker file atomically.
 * Validates that the profile file exists (in at least one scope) and that
 * the merged result (global + project + profile) passes `eforgeConfigSchema`.
 *
 * When `opts.scope` is `'user'`, the user-scope marker
 * (`~/.config/eforge/.active-profile`) is written instead of the project marker.
 */
export async function setActiveProfile(
  configDir: string,
  name: string,
  opts?: { scope?: 'project' | 'user' },
): Promise<void> {
  const scope = opts?.scope ?? 'project';
  name = name.trim();
  if (name.length === 0) {
    throw new Error('Profile name must be a non-empty string');
  }

  // Validate profile exists in at least one scope
  if (!(await profileExistsInAnyScope(configDir, name))) {
    throw new Error(`Profile "${name}" not found in project or user scope`);
  }

  // Load project config and global config to validate the merged result
  const globalConfig = await loadUserConfig();
  let projectConfig: PartialEforgeConfig = {};
  const cfgPath = resolve(configDir, 'config.yaml');
  try {
    const raw = await readFile(cfgPath, 'utf-8');
    const data = parseYaml(raw);
    if (data && typeof data === 'object') {
      const { config } = parseRawConfig(data as Record<string, unknown>);
      projectConfig = config;
    }
  } catch {
    // no project config
  }

  const profileResult = await loadProfile(configDir, name);
  if (!profileResult) {
    throw new Error(`Profile "${name}" could not be parsed`);
  }

  const baseMerged = mergePartialConfigs(globalConfig, projectConfig);
  const merged = mergePartialConfigs(baseMerged, profileResult.profile);

  const result = eforgeConfigSchema.safeParse(merged);
  if (!result.success) {
    throw new Error(
      `Profile "${name}" produces an invalid merged config: ` +
      z.prettifyError(result.error),
    );
  }

  // Atomic write: tmp file + rename
  const target = scope === 'user' ? userMarkerPath() : markerPath(configDir);
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, `${name}\n`, 'utf-8');
  await rename(tmp, target);
}

/**
 * Discriminated union input for `createAgentRuntimeProfile`.
 *
 * - Legacy single-runtime shape: `{ harness, pi?, ... }` — unchanged behavior.
 * - New multi-runtime shape: `{ agentRuntimes, defaultAgentRuntime, ... }`.
 */
export type CreateProfileInput =
  // Legacy single-runtime input - unchanged behavior
  | {
      name: string;
      harness: 'claude-sdk' | 'pi';
      pi?: PartialEforgeConfig['pi'];
      agents?: PartialEforgeConfig['agents'];
      overwrite?: boolean;
      scope?: 'project' | 'user';
    }
  // New multi-runtime input
  | {
      name: string;
      agentRuntimes: Record<string, AgentRuntimeEntry>;
      defaultAgentRuntime: string;
      agents?: PartialEforgeConfig['agents'];
      overwrite?: boolean;
      scope?: 'project' | 'user';
    };

/**
 * Create an agent runtime profile file. Validates the partial-config shape and
 * the merged result (global + project + profile) before writing. Refuses
 * to overwrite an existing profile unless `overwrite: true` is supplied.
 *
 * When `scope` is `'user'`, writes to the user-scope profiles directory
 * (`~/.config/eforge/profiles/`) instead of the project directory.
 *
 * Accepts either a legacy single-runtime input `{ harness, pi?, ... }` or a
 * new multi-runtime input `{ agentRuntimes, defaultAgentRuntime, ... }`.
 */
export async function createAgentRuntimeProfile(
  configDir: string,
  input: CreateProfileInput,
): Promise<{ path: string }> {
  const { name, agents, overwrite, scope: inputScope } = input;
  const scope = inputScope ?? 'project';
  if (!name || typeof name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(
      `Invalid profile name "${name}": must contain only letters, digits, dot, underscore, or dash.`,
    );
  }

  const targetDir = scope === 'user' ? userProfilesDir() : profilesDir(configDir);
  const path = resolve(targetDir, `${name}.yaml`);
  if (await fileExists(path)) {
    if (!overwrite) {
      throw new Error(`Profile "${name}" already exists at ${path}. Pass overwrite: true to replace it.`);
    }
  }

  // Build the partial config — branch on discriminated input shape.
  let partial: PartialEforgeConfig;
  if ('agentRuntimes' in input) {
    // Multi-runtime input shape
    partial = {
      agentRuntimes: input.agentRuntimes,
      defaultAgentRuntime: input.defaultAgentRuntime,
    };
  } else {
    // Legacy single-runtime input shape — unchanged behavior
    const { harness, pi } = input;
    const runtimeEntry: AgentRuntimeEntry = { harness, ...(pi && { pi }) };
    partial = {
      agentRuntimes: { main: runtimeEntry },
      defaultAgentRuntime: 'main',
    };
  }
  if (agents !== undefined) partial.agents = agents as PartialEforgeConfig['agents'];

  // Validate against the partial schema first
  const partialResult = partialEforgeConfigSchema.safeParse(partial);
  if (!partialResult.success) {
    throw new Error(
      `Profile "${name}" failed partial-config validation: ` +
      z.prettifyError(partialResult.error),
    );
  }

  // Validate against the merged schema (global + project + profile)
  const globalConfig = await loadUserConfig();
  let projectConfig: PartialEforgeConfig = {};
  const cfgPath = resolve(configDir, 'config.yaml');
  try {
    const raw = await readFile(cfgPath, 'utf-8');
    const data = parseYaml(raw);
    if (data && typeof data === 'object') {
      const { config } = parseRawConfig(data as Record<string, unknown>);
      projectConfig = config;
    }
  } catch {
    // no project config
  }

  const baseMerged = mergePartialConfigs(globalConfig, projectConfig);
  const merged = mergePartialConfigs(baseMerged, partialResult.data);
  const mergedResult = eforgeConfigSchema.safeParse(merged);
  if (!mergedResult.success) {
    throw new Error(
      `Profile "${name}" produces an invalid merged config: ` +
      z.prettifyError(mergedResult.error),
    );
  }

  // Serialize via yaml.stringify, omitting undefined sections
  const yamlOut = stringifyYaml(stripUndefinedSections(partialResult.data));

  await mkdir(targetDir, { recursive: true });
  // Atomic write: tmp file + rename
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, yamlOut, 'utf-8');
  await rename(tmp, path);

  // Round-trip verify: parse the written file and re-validate
  try {
    const verifyRaw = await readFile(path, 'utf-8');
    const verifyData = parseYaml(verifyRaw);
    if (verifyData && typeof verifyData === 'object') {
      const verifyResult = partialEforgeConfigSchema.safeParse(verifyData);
      if (!verifyResult.success) {
        throw new Error(
          `Profile "${name}" failed round-trip validation after write: ` +
          z.prettifyError(verifyResult.error),
        );
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(`Profile "${name}"`)) {
      throw err;
    }
    // ignore verify-read errors
  }

  return { path };
}

// Re-export profile utilities from the shared client package
export { sanitizeProfileName, parseRawConfigLegacy } from '@eforge-build/client';

/**
 * Spec passed to `deriveProfileName` describing the runtime/model configuration
 * for which a deterministic profile name should be computed.
 */
export interface DeriveProfileNameSpec {
  agentRuntimes: Record<string, AgentRuntimeEntry>;
  defaultAgentRuntime: string;
  models?: {
    max?: { id: string };
    balanced?: { id: string };
    fast?: { id: string };
  };
  tiers?: {
    max?: { agentRuntime?: string };
    balanced?: { agentRuntime?: string };
    fast?: { agentRuntime?: string };
  };
}

/**
 * Sanitize a raw string into a valid profile-name fragment by lowercasing,
 * replacing dots with dashes, stripping `claude-` prefix from model IDs, and
 * collapsing repeated dashes.
 */
function sanitizeFragment(raw: string): string {
  return raw.toLowerCase().replace(/\./g, '-').replace(/^claude-/, '').replace(/-{2,}/g, '-');
}

/**
 * Derive a deterministic profile name from a multi-runtime spec.
 *
 * Rules:
 * - Single runtime, same model id across all three tiers → `<sanitized-model-id>`.
 * - Single runtime, model varies across tiers → `<harness>` or `<harness>-<provider>`.
 * - Multiple runtimes → `mixed-<runtime-backing-max>` where the backing runtime is
 *   `tiers.max.agentRuntime` if set, otherwise `defaultAgentRuntime`.
 */
export function deriveProfileName(spec: DeriveProfileNameSpec): string {
  const runtimeKeys = Object.keys(spec.agentRuntimes);
  const isMultiRuntime = runtimeKeys.length > 1;

  if (isMultiRuntime) {
    // Multiple runtimes: use the runtime assigned to the max tier (or defaultAgentRuntime).
    // Runtime names are used verbatim (lowercased, dots→dashes) — the claude- prefix is
    // meaningful and must NOT be stripped (it would turn 'claude-sdk' into 'sdk').
    const maxRuntime = spec.tiers?.max?.agentRuntime ?? spec.defaultAgentRuntime;
    const sanitizedRuntime = maxRuntime.toLowerCase().replace(/\./g, '-').replace(/-{2,}/g, '-');
    return `mixed-${sanitizedRuntime}`;
  }

  // Single runtime
  const runtimeKey = runtimeKeys[0] ?? spec.defaultAgentRuntime;
  const entry = spec.agentRuntimes[runtimeKey];
  const harness = entry?.harness ?? 'claude-sdk';
  const provider = entry?.pi?.provider;

  const maxId = spec.models?.max?.id;
  const balancedId = spec.models?.balanced?.id;
  const fastId = spec.models?.fast?.id;

  // If all three tier model IDs are the same (and present), use the sanitized model ID
  if (maxId !== undefined && maxId === balancedId && maxId === fastId) {
    return sanitizeFragment(maxId);
  }

  // Model varies (or not specified) — use harness + optional provider
  const parts: string[] = [harness];
  if (provider) parts.push(provider);
  return parts.join('-').replace(/-{2,}/g, '-');
}

/**
 * Delete an agent runtime profile file. Refuses to delete the currently active
 * profile unless `force: true` is supplied; in that case, the marker file
 * is also removed when it pointed at the deleted profile.
 *
 * When `scope` is omitted and the profile exists in both project and user
 * scopes, throws an error requesting explicit scope. When `scope` is specified,
 * deletes only from that scope.
 */
export async function deleteAgentRuntimeProfile(
  configDir: string,
  name: string,
  force?: boolean,
  scope?: 'project' | 'user',
): Promise<void> {
  name = name.trim();
  if (name.length === 0) {
    throw new Error('Profile name must be a non-empty string');
  }

  const projectPath = profilePath(configDir, name);
  const userPath = userProfilePath(name);
  const existsInProject = await fileExists(projectPath);
  const existsInUser = await fileExists(userPath);

  if (scope === undefined) {
    // Infer scope — error if ambiguous
    if (existsInProject && existsInUser) {
      throw new Error(
        `Profile "${name}" exists in both project and user scope. ` +
        `Specify scope: 'project' or 'user' to disambiguate.`,
      );
    }
    if (existsInProject) {
      scope = 'project';
    } else if (existsInUser) {
      scope = 'user';
    } else {
      throw new Error(`Profile "${name}" not found in project or user scope`);
    }
  }

  const targetPath = scope === 'user' ? userPath : projectPath;
  if (!(await fileExists(targetPath))) {
    throw new Error(`Profile "${name}" not found in ${scope} scope at ${targetPath}`);
  }

  // Determine if this profile is currently active via either marker
  const projectMarkerName = await readMarkerName(markerPath(configDir));
  const userMarkerName = await readMarkerName(userMarkerPath());

  if ((projectMarkerName === name || userMarkerName === name) && !force) {
    throw new Error(
      `Profile "${name}" is currently active. ` +
      `Pass force: true to delete it.`,
    );
  }

  await rm(targetPath);

  // If we forced, clear any marker(s) that pointed at this profile
  if (force) {
    if (projectMarkerName === name) {
      try {
        await unlink(markerPath(configDir));
      } catch {
        // marker already gone
      }
    }
    if (userMarkerName === name) {
      try {
        await unlink(userMarkerPath());
      } catch {
        // marker already gone
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Config File Validation
// ---------------------------------------------------------------------------

/**
 * Validate the eforge config file found from the given directory.
 * Loads the raw YAML, runs schema validation.
 */
export async function validateConfigFile(
  cwd?: string,
): Promise<{ configFound: boolean; valid: boolean; errors: string[] }> {
  const errors: string[] = [];

  const startDir = cwd ?? process.cwd();
  const configPath = await findConfigFile(startDir);
  if (!configPath) {
    return { configFound: false, valid: true, errors: [] }; // No config file is valid (defaults apply)
  }

  let raw: string;
  try {
    raw = await readFile(configPath, 'utf-8');
  } catch (err) {
    return { configFound: true, valid: false, errors: [`Failed to read config file: ${(err as Error).message}`] };
  }

  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch (err) {
    return { configFound: true, valid: false, errors: [`Invalid YAML: ${(err as Error).message}`] };
  }

  if (!data || typeof data !== 'object') {
    return { configFound: true, valid: true, errors: [] }; // Empty file is valid
  }

  // Schema validation — use configYamlSchema which rejects `backend:`
  const result = configYamlSchema.safeParse(data);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const path = issue.path.map(String).join('.');
      errors.push(`${path}: ${issue.message}`);
    }
  }

  return { configFound: true, valid: errors.length === 0, errors };
}
