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
import {
  resolveNamedSet,
  resolveLayeredSingletons,
  getScopeDirectory,
  userEforgeConfigDir,
} from '@eforge-build/scopes';
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
  'staleness-assessor', 'formatter', 'doc-author', 'doc-syncer',
  'test-writer', 'tester', 'prd-validator', 'dependency-detector', 'pipeline-composer',
  'gap-closer',
  'recovery-analyst',
] as const;

const agentRoleSchema = z.enum(AGENT_ROLES);

/** Agent tiers group agent roles by workload type for batch configuration. */
export const AGENT_TIERS = ['planning', 'implementation', 'review', 'evaluation'] as const;
export type AgentTier = (typeof AGENT_TIERS)[number];
export const agentTierSchema = z.enum(AGENT_TIERS).describe('Agent tier for grouping roles by workload type');

const toolPresetConfigSchema = z.enum(['coding', 'none']);

// ---------------------------------------------------------------------------
// ModelRef — model references
// ---------------------------------------------------------------------------

/** A model reference: id is always required. Resolver-only `provider` is spliced
 * in for Pi harness from `agents.tiers.<tier>.pi.provider`. Do not set `provider`
 * on config model refs. */
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
      message: '"provider" must not be set on model refs. Set provider on the tier\'s pi.provider instead.',
      path: ['provider'],
    });
  }
}).describe('Model reference (provider must not be set here; use tier pi.provider)');

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

/** Harness kind for a tier recipe. */
export const harnessTypeSchema = z.enum(['claude-sdk', 'pi']).describe('Harness kind for the tier recipe');
/** Backwards-compatible alias. */
export const harnessSchema = harnessTypeSchema;

export const piThinkingLevelSchema = z.enum(['off', 'low', 'medium', 'high', 'xhigh']).describe('Pi-native thinking level');

export const claudeSdkConfigSchema = z.object({
  disableSubagents: z.boolean().optional().describe('Disable the Task tool so agents cannot spawn subagents. Claude SDK harness only.'),
}).describe('Configuration specific to the Claude SDK harness');

export const piConfigSchema = z.object({
  provider: z.string().optional().describe('Pi provider name (required when used in a pi tier)'),
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
}).describe('Configuration for the Pi coding agent harness');

/**
 * A self-contained tier recipe: harness + harness-specific config + model + effort.
 *
 * Each tier owns the entire decision: which harness to run, which model to use,
 * what effort/thinking behavior, and any tool/budget tuning. Tiers cross-reference
 * nothing — there is no shared model class table, no separate runtime registry.
 */
export const tierConfigSchema = z.object({
  harness: harnessTypeSchema.describe('Which harness to run for roles in this tier'),
  pi: piConfigSchema.optional().describe('Pi-specific configuration (only when harness === "pi")'),
  claudeSdk: claudeSdkConfigSchema.optional().describe('Claude SDK-specific configuration (only when harness === "claude-sdk")'),
  model: z.string().describe('Model identifier for this tier (provider is taken from pi.provider for pi)'),
  effort: effortLevelSchema.describe('Effort level for roles in this tier'),
  thinking: z.boolean().optional().describe('When true, request thinking; coerced to adaptive for adaptive-only models'),
  fallbackModel: z.string().optional().describe('Fallback model id when primary is unavailable'),
  maxTurns: z.number().int().positive().optional().describe('Default maxTurns for roles in this tier'),
  allowedTools: z.array(z.string()).optional().describe('Whitelist of allowed tool names'),
  disallowedTools: z.array(z.string()).optional().describe('Blacklist of disallowed tool names'),
  promptAppend: z.string().optional().describe('Text appended to every agent prompt in this tier after variable substitution'),
}).superRefine((data, ctx) => {
  if (data.harness === 'pi' && data.claudeSdk !== undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'Tier with harness "pi" cannot include "claudeSdk" configuration.',
    });
  }
  if (data.harness === 'claude-sdk' && data.pi !== undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'Tier with harness "claude-sdk" cannot include "pi" configuration.',
    });
  }
  if (data.harness === 'pi' && (!data.pi?.provider || data.pi.provider.trim() === '')) {
    ctx.addIssue({
      code: 'custom',
      message: 'Tier with harness "pi" requires non-empty "pi.provider".',
      path: ['pi', 'provider'],
    });
  }
}).describe('A self-contained tier recipe (harness + model + effort + tuning)');

/**
 * Per-role override block. Roles select a tier and may further tune per-role
 * fields without redeclaring the harness/model/etc. (those flow from the tier).
 */
const roleOverrideSchema = z.object({
  tier: agentTierSchema.optional().describe('Override the tier assignment for this role'),
  effort: effortLevelSchema.optional().describe('Override effort for this role'),
  thinking: z.boolean().optional().describe('Override thinking for this role'),
  maxTurns: z.number().int().positive().optional().describe('Override maxTurns for this role'),
  allowedTools: z.array(z.string()).optional().describe('Override allowedTools for this role'),
  disallowedTools: z.array(z.string()).optional().describe('Override disallowedTools for this role'),
  promptAppend: z.string().optional().describe('Text appended to this role\'s prompt after variable substitution'),
  shards: z.array(shardScopeSchema).optional().describe('Parallel implementation shards (builder role only)'),
});

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
    promptDir: z.string().optional().describe('Directory of .md files that shadow bundled prompts by name match'),
    tiers: z.record(z.string(), tierConfigSchema).optional().describe('Tier recipes — every tier referenced by any role must be declared'),
    roles: z.record(agentRoleSchema, roleOverrideSchema.optional()).optional().describe('Per-agent role overrides'),
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
  hooks: z.array(hookConfigSchema).optional(),
});

/** Exported schema. Cross-field validation is performed in tierConfigSchema. */
export const eforgeConfigSchema = eforgeConfigBaseSchema;

// ---------------------------------------------------------------------------
// Derived TypeScript types — from schemas, not hand-written
// ---------------------------------------------------------------------------

export type ToolPresetConfig = z.output<typeof toolPresetConfigSchema>;
// `ReviewProfileConfig` and `BuildStageSpec` are owned by `@eforge-build/client`
// and re-exported at the top of this file.
export type HookConfig = z.output<typeof hookConfigSchema>;
export type PluginConfig = z.output<typeof pluginConfigSchema>;
export type TierConfig = z.output<typeof tierConfigSchema>;

/**
 * Resolved agent config for a specific role, combining tier recipe + role/plan
 * overrides. Provenance for each tunable field is `tier | role | plan`.
 */
export interface ResolvedAgentConfig {
  /** Harness kind resolved from the tier recipe. */
  harness: 'claude-sdk' | 'pi';
  /** Source of harness — always `'tier'` since harness flows from the tier. */
  harnessSource: 'tier';
  /** Resolved tier name. */
  tier: AgentTier;
  /** Provenance of the tier value. */
  tierSource: 'tier' | 'role' | 'plan';
  /** Resolved model ref. Provider is spliced from tier.pi.provider for pi harness. */
  model: ModelRef;
  /** Resolved effort level. */
  effort: import('./harness.js').EffortLevel;
  /** Provenance of the resolved effort value. */
  effortSource: 'tier' | 'role' | 'plan';
  /** Resolved thinking config (when set). */
  thinking?: import('./harness.js').ThinkingConfig;
  /** Provenance of the resolved thinking value. */
  thinkingSource: 'tier' | 'role' | 'plan';
  /** Resolved maxTurns value. */
  maxTurns?: number;
  /** Resolved fallback model id. */
  fallbackModel?: string;
  /** Resolved allowed tools list. */
  allowedTools?: string[];
  /** Resolved disallowed tools list. */
  disallowedTools?: string[];
  /** Text appended to the agent prompt after variable substitution. */
  promptAppend?: string;
  /** True when the resolved effort was clamped to the model's maximum supported level. */
  effortClamped?: boolean;
  /** The original effort level before clamping was applied. */
  effortOriginal?: import('./harness.js').EffortLevel;
  /** True when thinking was coerced from 'enabled' to 'adaptive' for models that only support adaptive thinking. */
  thinkingCoerced?: boolean;
  /** The original thinking config before coercion was applied. */
  thinkingOriginal?: import('./harness.js').ThinkingConfig;
  /** Parallel implementation shards for the builder role. When present, the implement stage fans out. */
  shards?: ShardScope[];
}

export interface PiConfig {
  /** Optional explicit API key override. */
  apiKey?: string;
  /** Optional provider override. */
  provider?: string;
  thinkingLevel: 'off' | 'low' | 'medium' | 'high' | 'xhigh';
  extensions: { autoDiscover: boolean; include?: string[]; exclude?: string[]; paths?: string[] };
  compaction: { enabled: boolean; threshold: number };
  retry: { maxRetries: number; backoffMs: number };
}

/** Resolved Claude SDK harness config. */
export interface ClaudeSdkConfig {
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
    promptDir?: string;
    tiers: Partial<Record<AgentTier, TierConfig>>;
    roles?: Partial<Record<AgentRole, z.output<typeof roleOverrideSchema>>>;
  };
  build: { worktreeDir?: string; postMergeCommands?: string[]; postMergeCommandTimeoutMs?: number; maxValidationRetries: number; cleanupPlanFiles: boolean };
  plan: { outputDir: string };
  plugins: PluginConfig;
  prdQueue: { dir: string; autoBuild: boolean; watchPollIntervalMs: number };
  daemon: { idleShutdownMs: number };
  monitor: { retentionCount: number };
  hooks: readonly HookConfig[];
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

// For configYamlSchema: build a passthrough agents schema so that unknown
// nested keys like `agents.models` survive inner-object parsing and are
// detectable in the superRefine legacy-detection step. Without passthrough,
// Zod strips unknown keys from the agents sub-object before superRefine runs.
const _configYamlAgentsSchema = (
  eforgeConfigBaseSchema.shape.agents as z.ZodOptional<z.ZodObject<any>>
).unwrap().passthrough().optional();

/**
 * Schema for config.yaml validation. Unknown top-level keys are rejected,
 * legacy keys (`backend:`, `pi:`, `claudeSdk:`, `agentRuntimes:`,
 * `defaultAgentRuntime:`, `agents.models`) get a migration hint.
 *
 * Implemented via .passthrough() + superRefine rather than .strict() so the
 * legacy migration hint always wins over the generic message and ordering is
 * fully under our control.
 */
export const configYamlSchema = eforgeConfigBaseSchema.partial()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  .extend({ agents: _configYamlAgentsSchema as any })
  .passthrough()
  .superRefine((data, ctx) => {
  if (!data || typeof data !== 'object') return;
  const obj = data as Record<string, unknown>;
  const legacyTopLevel = new Set(['backend', 'pi', 'claudeSdk', 'agentRuntimes', 'defaultAgentRuntime']);
  for (const key of Object.keys(obj)) {
    if (legacyTopLevel.has(key)) {
      ctx.addIssue({
        code: 'custom',
        message: `"${key}:" is no longer valid in config.yaml. Each tier under agents.tiers is now a self-contained recipe with harness + model + effort. See docs/config-migration.md for before/after examples.`,
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
  // agents.models is also legacy now — tier recipes carry the model directly.
  const agents = obj.agents;
  if (agents && typeof agents === 'object' && 'models' in (agents as Record<string, unknown>)) {
    ctx.addIssue({
      code: 'custom',
      message: '"agents.models" is no longer supported. Each tier under agents.tiers carries its own model. See docs/config-migration.md for before/after examples.',
      path: ['agents', 'models'],
    });
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

const DEFAULT_TIER_RECIPES: Partial<Record<AgentTier, TierConfig>> = Object.freeze({
  planning: Object.freeze({
    harness: 'claude-sdk' as const,
    model: 'claude-opus-4-7',
    effort: 'high' as const,
  }),
  implementation: Object.freeze({
    harness: 'claude-sdk' as const,
    model: 'claude-sonnet-4-6',
    effort: 'medium' as const,
  }),
  review: Object.freeze({
    harness: 'claude-sdk' as const,
    model: 'claude-opus-4-7',
    effort: 'high' as const,
  }),
  evaluation: Object.freeze({
    harness: 'claude-sdk' as const,
    model: 'claude-opus-4-7',
    effort: 'high' as const,
  }),
}) as Partial<Record<AgentTier, TierConfig>>;

export const DEFAULT_CONFIG: EforgeConfig = Object.freeze({
  maxConcurrentBuilds: 2,
  langfuse: Object.freeze({ enabled: false, host: 'https://cloud.langfuse.com' }),
  agents: Object.freeze({
    maxTurns: 30,
    maxContinuations: 3,
    permissionMode: 'bypass' as const,
    settingSources: ['project'] as string[],
    bare: false,
    tiers: DEFAULT_TIER_RECIPES,
  }),
  build: Object.freeze({ worktreeDir: undefined, postMergeCommands: undefined, postMergeCommandTimeoutMs: 300_000, maxValidationRetries: 2, cleanupPlanFiles: true }),
  plan: Object.freeze({ outputDir: 'eforge/plans' }),
  plugins: Object.freeze({ enabled: true }),
  prdQueue: Object.freeze({ dir: 'eforge/queue', autoBuild: true, watchPollIntervalMs: 5000 }),
  daemon: Object.freeze({ idleShutdownMs: 7_200_000 }),
  monitor: Object.freeze({ retentionCount: 20 }),
  hooks: Object.freeze([]),
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

  const tiers = (fileConfig.agents?.tiers as Partial<Record<AgentTier, TierConfig>> | undefined) ?? DEFAULT_CONFIG.agents.tiers;

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
      promptDir: fileConfig.agents?.promptDir,
      tiers,
      roles: fileConfig.agents?.roles as EforgeConfig['agents']['roles'] | undefined,
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
    hooks: Object.freeze(fileConfig.hooks ?? DEFAULT_CONFIG.hooks) as HookConfig[],
  });
}

/**
 * Error thrown when config.yaml contains a legacy field that must be migrated.
 */
export class ConfigMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigMigrationError';
  }
}

/**
 * Error thrown when config.yaml or a profile YAML fails schema validation.
 * Strict-by-design: invalid fields are NOT silently dropped — the user gets
 * a clear error so the typo or schema mismatch surfaces immediately.
 */
export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

/**
 * Parse and validate a raw YAML object into a partial EforgeConfig.
 * Strict: any schema validation failure throws `ConfigValidationError`.
 * No silent dropping of invalid fields.
 *
 * @param context  `'config'` (default) for config.yaml parsing — rejects legacy fields.
 *                 `'profile'` for profile file parsing.
 */
export function parseRawConfig(data: Record<string, unknown>, context: 'config' | 'profile' = 'config'): PartialEforgeConfig {
  // Reject legacy top-level fields with a migration pointer (in both contexts).
  const offending: string[] = [];
  if (data.backend !== undefined) offending.push('backend');
  if (data.pi !== undefined) offending.push('pi');
  if (data.claudeSdk !== undefined) offending.push('claudeSdk');
  if (data.agentRuntimes !== undefined) offending.push('agentRuntimes');
  if (data.defaultAgentRuntime !== undefined) offending.push('defaultAgentRuntime');

  if (offending.length > 0) {
    const fieldList = offending.map((f) => `"${f}:"`).join(', ');
    throw new ConfigMigrationError(
      `Legacy field(s) ${fieldList} are no longer valid. ` +
      `Each tier under agents.tiers is now a self-contained recipe (harness + model + effort + tuning). ` +
      `Example:\n\n` +
      `  agents:\n` +
      `    tiers:\n` +
      `      planning:\n` +
      `        harness: claude-sdk\n` +
      `        model: claude-opus-4-7\n` +
      `        effort: high\n\n` +
      `Offending field(s): ${offending.join(', ')}. ` +
      `See docs/config-migration.md for before/after examples.`,
    );
  }

  // Reject legacy agents.models nested field with a migration pointer.
  const agentsField = data.agents as Record<string, unknown> | undefined;
  if (agentsField && typeof agentsField === 'object' && 'models' in agentsField) {
    throw new ConfigMigrationError(
      `"agents.models" is no longer supported. Each tier under agents.tiers carries its own model. ` +
      `Move per-class model ids onto the corresponding tier(s). ` +
      `See docs/config-migration.md for before/after examples.`,
    );
  }

  const result = partialEforgeConfigSchema.safeParse(data);
  if (!result.success) {
    const label = context === 'profile' ? 'profile' : 'config';
    throw new ConfigValidationError(
      `Invalid ${label}: ` + z.prettifyError(result.error),
    );
  }
  return stripUndefinedSections(result.data);
}

/**
 * Remove top-level keys that are undefined so that mergePartialConfigs
 * treats absent sections correctly. Driven by the base schema's shape,
 * so any future top-level config field is preserved automatically.
 */
function stripUndefinedSections(config: PartialEforgeConfig): PartialEforgeConfig {
  const out: Record<string, unknown> = {};
  const src = config as Record<string, unknown>;
  for (const key of Object.keys(eforgeConfigBaseSchema.shape)) {
    if (src[key] !== undefined) out[key] = src[key];
  }
  return out as PartialEforgeConfig;
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
    const mergedAgents: Record<string, unknown> = { ...global.agents, ...project.agents };

    // Deep-merge tiers: per-tier shallow merge so a project override of a single
    // field doesn't drop the rest of the tier from global.
    const globalTiers = global.agents?.tiers as Record<string, Record<string, unknown>> | undefined;
    const projectTiers = project.agents?.tiers as Record<string, Record<string, unknown>> | undefined;
    if (globalTiers || projectTiers) {
      const mergedTiers: Record<string, Record<string, unknown>> = {};
      const allTierNames = new Set([
        ...Object.keys(globalTiers ?? {}),
        ...Object.keys(projectTiers ?? {}),
      ]);
      for (const tierName of allTierNames) {
        const g = globalTiers?.[tierName];
        const p = projectTiers?.[tierName];
        if (g && p) {
          mergedTiers[tierName] = { ...g, ...p };
        } else {
          mergedTiers[tierName] = (p ?? g)!;
        }
      }
      mergedAgents.tiers = mergedTiers;
    }

    // Deep-merge roles: per-role shallow merge.
    const globalRoles = global.agents?.roles as Record<string, Record<string, unknown>> | undefined;
    const projectRoles = project.agents?.roles as Record<string, Record<string, unknown>> | undefined;
    if (globalRoles || projectRoles) {
      const mergedRoles: Record<string, Record<string, unknown>> = {};
      const allRoleNames = new Set([
        ...Object.keys(globalRoles ?? {}),
        ...Object.keys(projectRoles ?? {}),
      ]);
      for (const roleName of allRoleNames) {
        const g = globalRoles?.[roleName];
        const p = projectRoles?.[roleName];
        if (g && p) {
          mergedRoles[roleName] = { ...g, ...p };
        } else {
          mergedRoles[roleName] = (p ?? g)!;
        }
      }
      mergedAgents.roles = mergedRoles;
    }

    result.agents = mergedAgents as PartialEforgeConfig['agents'];
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

  // hooks: concatenate (global first, then project)
  if (global.hooks || project.hooks) {
    result.hooks = [...(global.hooks ?? []), ...(project.hooks ?? [])];
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
  let raw: string;
  try {
    raw = await readFile(configPath, 'utf-8');
  } catch (err) {
    // Missing user-level global config is fine — most users don't have one.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return {};
    throw err;
  }
  const data = parseYaml(raw);
  if (!data || typeof data !== 'object') return {};
  return parseRawConfig(data as Record<string, unknown>);
}

/**
 * Read and parse `eforge/config.yaml` from a config directory.
 * Returns `{}` when the file does not exist (ENOENT).
 * Propagates `ConfigMigrationError` and `ConfigValidationError` so callers
 * surface clear errors instead of silently falling back to an empty baseline.
 */
async function readProjectConfigOrEmpty(configDir: string): Promise<PartialEforgeConfig> {
  const cfgPath = resolve(configDir, 'config.yaml');
  let raw: string;
  try {
    raw = await readFile(cfgPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return {};
    throw err;
  }
  const data = parseYaml(raw);
  if (!data || typeof data !== 'object') return {};
  return parseRawConfig(data as Record<string, unknown>);
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
 * the start directory and no `eforge/config.yaml` is found.
 */
export async function loadConfig(cwd?: string): Promise<{ config: EforgeConfig; warnings: string[]; profile: { name: string | null; source: ActiveProfileSource; scope: 'local' | 'project' | 'user' | null; config: PartialEforgeConfig | null } }> {
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

  // Establish configDir and projectRoot early (needed for resolveLayeredSingletons)
  const projectRoot = configPath ? dirname(dirname(configPath)) : startDir;
  const configDir = configPath ? dirname(configPath) : projectRoot;

  // Auto-migrate eforge/backends/ -> eforge/profiles/ on first load after upgrade
  if (configPath) {
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

  // Load all config.yaml layers via resolveLayeredSingletons (user → project-team → project-local)
  let globalConfig: PartialEforgeConfig = {};
  let projectConfig: PartialEforgeConfig = {};
  let localConfig: PartialEforgeConfig = {};
  const configYamlLayers = await resolveLayeredSingletons('config.yaml', { cwd: projectRoot, configDir });
  for (const { scope, path } of configYamlLayers) {
    const raw = await readFile(path, 'utf-8');
    const data = parseYaml(raw);
    if (data && typeof data === 'object') {
      const partial = parseRawConfig(data as Record<string, unknown>);
      if (scope === 'user') globalConfig = partial;
      else if (scope === 'project-team') projectConfig = partial;
      else localConfig = partial;
    }
  }

  let profileConfig: PartialEforgeConfig | null = null;
  let resolvedProfileName: string | null = null;
  let resolvedProfileSource: ActiveProfileSource = 'none';
  let resolvedProfileScope: 'local' | 'project' | 'user' | null = null;
  {
    const { name, source, warnings } = await resolveActiveProfileName(configDir, projectConfig, globalConfig, projectRoot);
    allWarnings.push(...warnings);
    resolvedProfileName = name;
    resolvedProfileSource = source;
    if (name) {
      const result = await loadProfile(configDir, name, projectRoot);
      if (result) {
        profileConfig = result.profile;
        resolvedProfileScope = result.scope;
      }
    }
  }

  // Merge sequence: user → project → local (three-tier deep merge)
  const baseMerged = mergePartialConfigs(mergePartialConfigs(globalConfig, projectConfig), localConfig);
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
 */
export type ActiveProfileSource = 'local' | 'project' | 'user-local' | 'missing' | 'none';

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

// ---------------------------------------------------------------------------
// Project-local tier paths (.eforge/ inside project root — gitignored)
// ---------------------------------------------------------------------------

/** Return the project-local scope root directory (<cwd>/.eforge/). */
function localScopeDir(cwd: string): string {
  return getScopeDirectory('project-local', { cwd, configDir: '' });
}

/** Return the project-local profiles directory (<cwd>/.eforge/profiles/). */
function localProfilesDir(cwd: string): string {
  return resolve(localScopeDir(cwd), PROFILES_SUBDIR);
}

/** Return the path to a project-local profile file. */
function localProfilePath(cwd: string, name: string): string {
  return resolve(localScopeDir(cwd), PROFILES_SUBDIR, `${name}.yaml`);
}

/** Return the path to the project-local active-profile marker file. */
function localMarkerPath(cwd: string): string {
  return resolve(localScopeDir(cwd), ACTIVE_PROFILE_MARKER);
}

/** Check whether a profile file exists in local, project, or user scope. */
async function profileExistsInAnyScope(configDir: string, name: string, cwd?: string): Promise<boolean> {
  const effectiveCwd = cwd ?? dirname(configDir);
  if (await fileExists(localProfilePath(effectiveCwd, name))) return true;
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
    process.stderr.write(
      '[eforge] Both eforge/backends/ and eforge/profiles/ exist. ' +
      'Migration skipped; please resolve manually and remove eforge/backends/.\n',
    );
    return;
  }

  const projectRoot = dirname(configDir);
  let migrated = false;
  try {
    await execFileAsync('git', ['-C', projectRoot, 'mv', 'eforge/backends', 'eforge/profiles']);
    migrated = true;
  } catch {
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
 * Auto-migrate user-scope `~/.config/eforge/backends/` -> `~/.config/eforge/profiles/`.
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
    process.stderr.write(
      '[eforge] Both ~/.config/eforge/backends/ and ~/.config/eforge/profiles/ exist. ' +
      'Migration skipped; please resolve manually and remove ~/.config/eforge/backends/.\n',
    );
    return;
  }

  try {
    await rename(oldDir, newDir);
  } catch {
    process.stderr.write('[eforge] Failed to migrate ~/.config/eforge/backends/ to ~/.config/eforge/profiles/.\n');
    return;
  }

  process.stderr.write('[eforge] Migrated ~/.config/eforge/backends/ -> ~/.config/eforge/profiles/\n');

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
 */
export async function resolveActiveProfileName(
  configDir: string,
  projectConfig: PartialEforgeConfig,
  userConfig?: PartialEforgeConfig,
  cwd?: string,
): Promise<{ name: string | null; source: ActiveProfileSource; warnings: string[] }> {
  const warnings: string[] = [];
  const effectiveCwd = cwd ?? dirname(configDir);

  // Step 0: Local marker
  const localMarkerName = await readMarkerName(localMarkerPath(effectiveCwd));
  if (localMarkerName !== null) {
    if (await profileExistsInAnyScope(configDir, localMarkerName, effectiveCwd)) {
      return { name: localMarkerName, source: 'local', warnings };
    }
    warnings.push(
      `[eforge] Active profile marker ${localMarkerPath(effectiveCwd)} points at ` +
      `"${localMarkerName}" but no profile file exists in any scope. ` +
      `Falling back to next available source.`,
    );
  }

  // Step 1: Project marker
  const projectMarkerName = await readMarkerName(markerPath(configDir));

  if (projectMarkerName !== null) {
    if (await profileExistsInAnyScope(configDir, projectMarkerName, effectiveCwd)) {
      return { name: projectMarkerName, source: 'project', warnings };
    }
    warnings.push(
      `[eforge] Active profile marker ${markerPath(configDir)} points at ` +
      `"${projectMarkerName}" but no profile file exists in any scope. ` +
      `Falling back to next available source.`,
    );
    const userMarker = await readMarkerName(userMarkerPath());
    if (userMarker && await profileExistsInAnyScope(configDir, userMarker, effectiveCwd)) {
      return { name: userMarker, source: 'user-local', warnings };
    }
    return { name: null, source: 'missing', warnings };
  }

  // Step 2: User marker
  const userMarker = await readMarkerName(userMarkerPath());
  if (userMarker && await profileExistsInAnyScope(configDir, userMarker, effectiveCwd)) {
    return { name: userMarker, source: 'user-local', warnings };
  }

  // Step 3: None
  return { name: null, source: 'none', warnings };
}

/**
 * Load and parse an agent runtime profile file from a specific path. Returns null
 * when the file does not exist. Throws if the file exists but is invalid
 * (malformed YAML or schema validation failure).
 */
async function loadProfileFromPath(path: string): Promise<PartialEforgeConfig | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw err;
  }
  const data = parseYaml(raw);
  if (!data || typeof data !== 'object') return {};
  return parseRawConfig(data as Record<string, unknown>, 'profile');
}

/**
 * Load and parse a profile file. Looks up local / project / user scope.
 */
export async function loadProfile(
  configDir: string,
  name: string,
  cwd?: string,
): Promise<{ profile: PartialEforgeConfig; scope: 'local' | 'project' | 'user' } | null> {
  const effectiveCwd = cwd ?? dirname(configDir);
  const profiles = await resolveNamedSet('profiles', { cwd: effectiveCwd, configDir, extension: 'yaml' });
  const artifact = profiles.get(name);
  if (!artifact) return null;
  const profile = await loadProfileFromPath(artifact.path);
  if (profile === null) return null;
  const scope = artifact.scope === 'project-local' ? 'local'
    : artifact.scope === 'project-team' ? 'project'
    : 'user';
  return { profile, scope };
}

/** Shared entry type returned by scanProfilesDir. */
type ScannedProfileEntry = { name: string; harness: 'claude-sdk' | 'pi' | undefined; path: string; scope: 'local' | 'project' | 'user' };

/**
 * Scan a profiles directory and return an entry for each `.yaml` file.
 *
 * Harness inference: walks the parsed yaml's tier recipes (when present)
 * and returns the most common harness; otherwise falls back to undefined.
 * Legacy profiles using `backend:` are still recognized for harness inference.
 */
async function scanProfilesDir(dir: string, scope: 'local' | 'project' | 'user'): Promise<ScannedProfileEntry[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const out: ScannedProfileEntry[] = [];
  for (const entry of entries.sort()) {
    if (extname(entry) !== '.yaml') continue;
    const name = basename(entry, '.yaml');
    const path = resolve(dir, entry);
    let harness: 'claude-sdk' | 'pi' | undefined;
    try {
      const raw = await readFile(path, 'utf-8');
      const data = parseYaml(raw);
      if (data && typeof data === 'object') {
        const raw_data = data as Record<string, unknown>;
        // Prefer the new shape: agents.tiers.<tier>.harness
        const agents = raw_data.agents as Record<string, unknown> | undefined;
        const tiers = agents?.tiers as Record<string, unknown> | undefined;
        if (tiers) {
          for (const tierData of Object.values(tiers)) {
            if (tierData && typeof tierData === 'object') {
              const h = (tierData as Record<string, unknown>).harness;
              const parsed = harnessTypeSchema.safeParse(h);
              if (parsed.success) { harness = parsed.data; break; }
            }
          }
        }
        // Legacy fallback: backend:
        if (harness === undefined) {
          const harnessVal = raw_data.harness ?? raw_data.backend;
          const parsed = harnessTypeSchema.safeParse(harnessVal);
          if (parsed.success) harness = parsed.data;
        }
      }
    } catch {
      // unreadable — still include the entry with harness=undefined
    }
    out.push({ name, harness, path, scope });
  }
  return out;
}

/**
 * List all profile files from local / project / user scopes.
 */
export async function listProfiles(
  configDir: string,
  cwd?: string,
): Promise<Array<{ name: string; harness: 'claude-sdk' | 'pi' | undefined; path: string; scope: 'local' | 'project' | 'user'; shadowedBy?: 'local' | 'project' }>> {
  type ProfileEntry = { name: string; harness: 'claude-sdk' | 'pi' | undefined; path: string; scope: 'local' | 'project' | 'user'; shadowedBy?: 'local' | 'project' };
  const effectiveCwd = cwd ?? dirname(configDir);

  const scopeOpts = { cwd: effectiveCwd, configDir };
  const localEntries = await scanProfilesDir(resolve(getScopeDirectory('project-local', scopeOpts), PROFILES_SUBDIR), 'local') as ProfileEntry[];
  const projectEntries = await scanProfilesDir(resolve(getScopeDirectory('project-team', scopeOpts), PROFILES_SUBDIR), 'project') as ProfileEntry[];
  const userEntries = await scanProfilesDir(resolve(getScopeDirectory('user', scopeOpts), PROFILES_SUBDIR), 'user') as ProfileEntry[];

  const localNames = new Set(localEntries.map((e) => e.name));
  const projectNames = new Set(projectEntries.map((e) => e.name));

  for (const entry of projectEntries) {
    if (localNames.has(entry.name)) {
      entry.shadowedBy = 'local';
    }
  }
  for (const entry of userEntries) {
    if (localNames.has(entry.name)) {
      entry.shadowedBy = 'local';
    } else if (projectNames.has(entry.name)) {
      entry.shadowedBy = 'project';
    }
  }

  return [...localEntries, ...projectEntries, ...userEntries];
}

/**
 * List all profile files from only the user scope.
 */
export async function listUserProfiles(): Promise<Array<{ name: string; harness: 'claude-sdk' | 'pi' | undefined; path: string; scope: 'user' }>> {
  const entries = await scanProfilesDir(userProfilesDir(), 'user');
  return entries as Array<{ name: string; harness: 'claude-sdk' | 'pi' | undefined; path: string; scope: 'user' }>;
}

/**
 * Resolve the active profile from the user-scope marker only.
 */
export async function resolveUserActiveProfile(): Promise<{ name: string | null; source: 'user-local' | 'none'; warnings: string[] }> {
  const warnings: string[] = [];
  const markerName = await readMarkerName(userMarkerPath());
  if (markerName !== null) {
    if (await fileExists(userProfilePath(markerName))) {
      return { name: markerName, source: 'user-local', warnings };
    }
    warnings.push(
      `[eforge] Active profile marker ${userMarkerPath()} points at ` +
      `"${markerName}" but no profile file exists in user scope. ` +
      `Falling back to next available source.`,
    );
    return { name: null, source: 'none', warnings };
  }
  return { name: null, source: 'none', warnings };
}

/**
 * Load a user-scope profile by name from `~/.config/eforge/profiles/`.
 */
export async function loadUserProfile(name: string): Promise<{ profile: PartialEforgeConfig; scope: 'user' } | null> {
  const result = await loadProfileFromPath(userProfilePath(name));
  if (result !== null) {
    return { profile: result, scope: 'user' };
  }
  return null;
}

/**
 * Set the active profile by writing the marker file atomically.
 */
export async function setActiveProfile(
  configDir: string,
  name: string,
  opts?: { scope?: 'local' | 'project' | 'user' },
  cwd?: string,
): Promise<void> {
  const scope = opts?.scope ?? 'project';
  const effectiveCwd = cwd ?? dirname(configDir);
  name = name.trim();
  if (name.length === 0) {
    throw new Error('Profile name must be a non-empty string');
  }

  if (!(await profileExistsInAnyScope(configDir, name, effectiveCwd))) {
    throw new Error(`Profile "${name}" not found in local, project, or user scope`);
  }

  // Validate that the merged result passes the schema. Strict.
  const globalConfig = await loadUserConfig();
  const projectConfig = await readProjectConfigOrEmpty(configDir);

  const profileResult = await loadProfile(configDir, name, effectiveCwd);
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

  const target = scope === 'user' ? userMarkerPath()
    : scope === 'local' ? localMarkerPath(effectiveCwd)
    : markerPath(configDir);
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, `${name}\n`, 'utf-8');
  await rename(tmp, target);
}

/**
 * Input for `createAgentRuntimeProfile`.
 *
 * The new shape carries `agents.tiers` recipes directly. Callers that still
 * pass the legacy single-runtime shape should be updated to the new tier shape.
 */
export type CreateProfileInput = {
  name: string;
  agents?: PartialEforgeConfig['agents'];
  overwrite?: boolean;
  scope?: 'local' | 'project' | 'user';
};

/**
 * Create an agent runtime profile file. Validates the partial-config shape and
 * the merged result before writing.
 */
export async function createAgentRuntimeProfile(
  configDir: string,
  input: CreateProfileInput,
  cwd?: string,
): Promise<{ path: string }> {
  const { name, agents, overwrite, scope: inputScope } = input;
  const scope = inputScope ?? 'project';
  const effectiveCwd = cwd ?? dirname(configDir);
  if (!name || typeof name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(
      `Invalid profile name "${name}": must contain only letters, digits, dot, underscore, or dash.`,
    );
  }

  const targetDir = scope === 'user' ? userProfilesDir()
    : scope === 'local' ? localProfilesDir(effectiveCwd)
    : profilesDir(configDir);
  const path = resolve(targetDir, `${name}.yaml`);
  if (await fileExists(path)) {
    if (!overwrite) {
      throw new Error(`Profile "${name}" already exists at ${path}. Pass overwrite: true to replace it.`);
    }
  }

  const partial: PartialEforgeConfig = {};
  if (agents !== undefined) partial.agents = agents as PartialEforgeConfig['agents'];

  // Validate against the partial schema first
  const partialResult = partialEforgeConfigSchema.safeParse(partial);
  if (!partialResult.success) {
    throw new Error(
      `Profile "${name}" failed partial-config validation: ` +
      z.prettifyError(partialResult.error),
    );
  }

  // Validate against the merged schema (global + project + profile).
  const globalConfig = await loadUserConfig();
  const projectConfig = await readProjectConfigOrEmpty(configDir);

  const baseMerged = mergePartialConfigs(globalConfig, projectConfig);
  const merged = mergePartialConfigs(baseMerged, partialResult.data);
  const mergedResult = eforgeConfigSchema.safeParse(merged);
  if (!mergedResult.success) {
    throw new Error(
      `Profile "${name}" produces an invalid merged config: ` +
      z.prettifyError(mergedResult.error),
    );
  }

  const yamlOut = stringifyYaml(stripUndefinedSections(partialResult.data));

  await mkdir(targetDir, { recursive: true });
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
 * Spec passed to `deriveProfileName` describing the tier recipes for which a
 * deterministic profile name should be computed.
 */
export interface DeriveProfileNameSpec {
  agents?: {
    tiers?: Partial<Record<AgentTier, { harness?: 'claude-sdk' | 'pi'; pi?: { provider?: string }; model?: string }>>;
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
 * Derive a deterministic profile name from a multi-tier spec.
 *
 * Rules:
 * - All tiers share the same model id → `<sanitized-model-id>`.
 * - Tiers share the same harness (and provider) but mixed model ids → `<harness>` or `<harness>-<provider>`.
 * - Tiers use multiple harnesses → `mixed-<planning-harness>` (or planning-harness-provider).
 */
export function deriveProfileName(spec: DeriveProfileNameSpec): string {
  const tiers = spec.agents?.tiers ?? {};
  const tierEntries = Object.values(tiers).filter((t): t is NonNullable<typeof t> => !!t);

  if (tierEntries.length === 0) {
    return 'default';
  }

  const harnesses = new Set(tierEntries.map((t) => t.harness ?? 'claude-sdk'));
  const modelIds = new Set(tierEntries.map((t) => t.model).filter((m): m is string => !!m));

  // Multiple harnesses → mixed
  if (harnesses.size > 1) {
    const planningTier = tiers.planning ?? tierEntries[0];
    const harness = planningTier?.harness ?? 'claude-sdk';
    const provider = planningTier?.pi?.provider;
    const parts = ['mixed', harness];
    if (provider) parts.push(provider);
    return parts.join('-').replace(/-{2,}/g, '-');
  }

  // Single harness, all models match
  if (modelIds.size === 1) {
    return sanitizeFragment([...modelIds][0]);
  }

  // Single harness, mixed models — use harness + optional provider
  const harness = [...harnesses][0];
  const planningTier = tiers.planning ?? tierEntries[0];
  const provider = planningTier?.pi?.provider;
  const parts: string[] = [harness];
  if (provider) parts.push(provider);
  return parts.join('-').replace(/-{2,}/g, '-');
}

/**
 * Delete an agent runtime profile file.
 */
export async function deleteAgentRuntimeProfile(
  configDir: string,
  name: string,
  force?: boolean,
  scope?: 'local' | 'project' | 'user',
  cwd?: string,
): Promise<void> {
  name = name.trim();
  if (name.length === 0) {
    throw new Error('Profile name must be a non-empty string');
  }
  const effectiveCwd = cwd ?? dirname(configDir);

  const localPath = localProfilePath(effectiveCwd, name);
  const projectPath = profilePath(configDir, name);
  const userPath = userProfilePath(name);
  const existsInLocal = await fileExists(localPath);
  const existsInProject = await fileExists(projectPath);
  const existsInUser = await fileExists(userPath);

  if (scope === undefined) {
    const existingScopes = (
      [existsInLocal && 'local', existsInProject && 'project', existsInUser && 'user'] as const
    ).filter(Boolean) as Array<'local' | 'project' | 'user'>;

    if (existingScopes.length > 1) {
      throw new Error(
        `Profile "${name}" exists in multiple scopes (${existingScopes.join(', ')}). ` +
        `Specify scope: ${existingScopes.map((s) => `'${s}'`).join(' or ')} to disambiguate.`,
      );
    }
    if (existsInLocal) {
      scope = 'local';
    } else if (existsInProject) {
      scope = 'project';
    } else if (existsInUser) {
      scope = 'user';
    } else {
      throw new Error(`Profile "${name}" not found in local, project, or user scope`);
    }
  }

  const targetPath = scope === 'user' ? userPath
    : scope === 'local' ? localPath
    : projectPath;
  if (!(await fileExists(targetPath))) {
    throw new Error(`Profile "${name}" not found in ${scope} scope at ${targetPath}`);
  }

  const localMarkerName = await readMarkerName(localMarkerPath(effectiveCwd));
  const projectMarkerName = await readMarkerName(markerPath(configDir));
  const userMarkerName = await readMarkerName(userMarkerPath());

  if ((localMarkerName === name || projectMarkerName === name || userMarkerName === name) && !force) {
    throw new Error(
      `Profile "${name}" is currently active. ` +
      `Pass force: true to delete it.`,
    );
  }

  await rm(targetPath);

  if (force) {
    if (localMarkerName === name) {
      try {
        await unlink(localMarkerPath(effectiveCwd));
      } catch {
        // marker already gone
      }
    }
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
 */
export async function validateConfigFile(
  cwd?: string,
): Promise<{ configFound: boolean; valid: boolean; errors: string[] }> {
  const errors: string[] = [];

  const startDir = cwd ?? process.cwd();
  const configPath = await findConfigFile(startDir);
  if (!configPath) {
    return { configFound: false, valid: true, errors: [] };
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
    return { configFound: true, valid: true, errors: [] };
  }

  const result = configYamlSchema.safeParse(data);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const path = issue.path.map(String).join('.');
      errors.push(`${path}: ${issue.message}`);
    }
  }

  return { configFound: true, valid: errors.length === 0, errors };
}
