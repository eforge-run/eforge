import { readFile, readdir, rename, rm, unlink, writeFile, mkdir, access } from 'node:fs/promises';
import { resolve, dirname, basename, extname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod/v4';

import { sanitizeProfileName, parseRawConfigLegacy } from '@eforge-build/client';
import type { ReviewProfileConfig, BuildStageSpec } from '@eforge-build/client';
import type { AgentRole } from './events.js';

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
] as const;

const agentRoleSchema = z.enum(AGENT_ROLES);

/** Model classes group agents by workload type. */
export const MODEL_CLASSES = ['max', 'balanced', 'fast'] as const;
export type ModelClass = (typeof MODEL_CLASSES)[number];

export const modelClassSchema = z.enum(MODEL_CLASSES).describe('Model class for agent workload grouping');

const toolPresetConfigSchema = z.enum(['coding', 'none']);

// ---------------------------------------------------------------------------
// ModelRef — backend-aware model references
// ---------------------------------------------------------------------------

/** A model reference: id is always required, provider is required for Pi backend. */
export interface ModelRef {
  id: string;
  provider?: string;
}

export const modelRefSchema = z.object({
  id: z.string().describe('Model identifier (e.g. "claude-opus-4-7", "gpt-5.4")'),
  provider: z.string().optional().describe('Provider name (required for Pi backend, forbidden for Claude SDK)'),
}).describe('Model reference with optional provider');

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

export const backendSchema = z.enum(['claude-sdk', 'pi']).describe('Backend provider for agent execution');

export const piThinkingLevelSchema = z.enum(['off', 'low', 'medium', 'high', 'xhigh']).describe('Pi-native thinking level');

export const claudeSdkConfigSchema = z.object({
  disableSubagents: z.boolean().optional().describe('Disable the Task tool so agents cannot spawn subagents. Claude SDK backend only.'),
}).describe('Configuration specific to the Claude SDK backend');

export const piConfigSchema = z.object({
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

/** Base object schema without refinements — .partial() is derived from this. */
const eforgeConfigBaseSchema = z.object({
  backend: backendSchema,
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
    }).optional()).optional().describe('Per-agent role overrides'),
  }).optional(),
  build: z.object({
    worktreeDir: z.string().optional(),
    postMergeCommands: z.array(z.string()).optional(),
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
});

/** Exported schema with backend-conditional model ref validation. */
export const eforgeConfigSchema = eforgeConfigBaseSchema.superRefine((data, ctx) => {
  const backend = data.backend;
  if (!backend) return;

  /** Validate a single ModelRef against the backend. */
  function checkModelRef(ref: { id: string; provider?: string } | undefined, path: string) {
    if (!ref) return;
    if (backend === 'pi' && !ref.provider) {
      ctx.addIssue({
        code: 'custom',
        message: `Pi backend requires "provider" in model ref at ${path}. Got { id: "${ref.id}" }.`,
        path: path.split('.'),
      });
    }
    if (backend === 'claude-sdk' && ref.provider) {
      ctx.addIssue({
        code: 'custom',
        message: `Claude SDK backend does not accept "provider" in model ref at ${path}. Got { provider: "${ref.provider}", id: "${ref.id}" }.`,
        path: path.split('.'),
      });
    }
  }

  // Check agents.model
  checkModelRef(data.agents?.model, 'agents.model');

  // Check agents.models.*
  if (data.agents?.models) {
    for (const [cls, ref] of Object.entries(data.agents.models)) {
      if (ref) checkModelRef(ref, `agents.models.${cls}`);
    }
  }

  // Check agents.roles.*.model
  if (data.agents?.roles) {
    for (const [role, roleConfig] of Object.entries(data.agents.roles)) {
      if (roleConfig?.model) checkModelRef(roleConfig.model, `agents.roles.${role}.model`);
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

/** Resolved agent config for a specific role, combining SDK passthrough fields with maxTurns. */
export interface ResolvedAgentConfig {
  maxTurns?: number;
  model?: ModelRef;
  modelClass?: ModelClass;
  thinking?: import('./backend.js').ThinkingConfig;
  effort?: import('./backend.js').EffortLevel;
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
  effortOriginal?: import('./backend.js').EffortLevel;
  /** Provenance of the resolved effort value. */
  effortSource?: 'planner' | 'role-config' | 'global-config' | 'default';
  /** Provenance of the resolved thinking value. */
  thinkingSource?: 'planner' | 'role-config' | 'global-config' | 'default';
  /** True when thinking was coerced from 'enabled' to 'adaptive' for models that only support adaptive thinking. */
  thinkingCoerced?: boolean;
  /** The original thinking config before coercion was applied. */
  thinkingOriginal?: import('./backend.js').ThinkingConfig;
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
  backend?: 'claude-sdk' | 'pi';
  maxConcurrentBuilds: number;
  langfuse: { enabled: boolean; publicKey?: string; secretKey?: string; host: string };
  agents: {
    maxTurns: number;
    maxContinuations: number;
    permissionMode: 'bypass' | 'default';
    settingSources?: string[];
    bare: boolean;
    model?: ModelRef;
    thinking?: import('./backend.js').ThinkingConfig;
    effort?: import('./backend.js').EffortLevel;
    models?: Partial<Record<ModelClass, ModelRef>>;
    roles?: Record<string, Partial<ResolvedAgentConfig>>;
    /** Directory of .md files that shadow bundled prompts by name match. */
    promptDir?: string;
  };
  build: { worktreeDir?: string; postMergeCommands?: string[]; maxValidationRetries: number; cleanupPlanFiles: boolean };
  plan: { outputDir: string };
  plugins: PluginConfig;
  prdQueue: { dir: string; autoBuild: boolean; watchPollIntervalMs: number };
  daemon: { idleShutdownMs: number };
  monitor: { retentionCount: number };
  pi: PiConfig;
  claudeSdk: ClaudeSdkConfig;
  hooks: readonly HookConfig[];
}

/** Deep-partial version of EforgeConfig used for parsing and merging — derived from the zod schema. */
const partialEforgeConfigSchema = eforgeConfigBaseSchema.partial();
export type PartialEforgeConfig = z.output<typeof partialEforgeConfigSchema>;

/**
 * Schema for config.yaml validation — rejects `backend:` which now belongs in profile files.
 * Uses passthrough to detect the `backend` key and superRefine to produce a validation error.
 */
export const configYamlSchema = eforgeConfigBaseSchema.omit({ backend: true }).partial().passthrough().superRefine((data, ctx) => {
  if (data && typeof data === 'object' && 'backend' in (data as Record<string, unknown>)) {
    ctx.addIssue({
      code: 'custom',
      message: '"backend:" is no longer valid in config.yaml. Backend configuration now lives in named profiles under eforge/backends/. Run eforge init --migrate to extract it.',
      path: ['backend'],
    });
  }
});

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
  build: Object.freeze({ worktreeDir: undefined, postMergeCommands: undefined, maxValidationRetries: 2, cleanupPlanFiles: true }),
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
    backend: fileConfig.backend,
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
      promptDir: fileConfig.agents?.promptDir,
    }),
    build: Object.freeze({
      worktreeDir: fileConfig.build?.worktreeDir ?? DEFAULT_CONFIG.build.worktreeDir,
      postMergeCommands: fileConfig.build?.postMergeCommands ?? DEFAULT_CONFIG.build.postMergeCommands,
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
  });
}

/**
 * Error thrown when config.yaml contains `backend:` which must be migrated
 * to a named profile under eforge/backends/.
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
  // Config.yaml context: reject backend: field (hard break — must migrate)
  if (context === 'config' && data.backend !== undefined) {
    throw new ConfigMigrationError(
      '"backend:" is no longer valid in config.yaml. ' +
      'Backend configuration now lives in named profiles under eforge/backends/. ' +
      'Run eforge init --migrate to extract it.',
    );
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
  // Handle top-level scalar fields — backend: only allowed in profile context
  if (context === 'profile' && data.backend !== undefined) {
    const backendResult = backendSchema.safeParse(data.backend);
    if (backendResult.success) {
      (result as Record<string, unknown>).backend = backendResult.data;
    }
  }
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
  if (config.backend !== undefined) out.backend = config.backend;
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
  if (project.backend !== undefined || global.backend !== undefined) {
    result.backend = project.backend ?? global.backend;
  }
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
 * When an active backend profile is found (via `eforge/.active-backend`
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
export async function loadConfig(cwd?: string): Promise<{ config: EforgeConfig; warnings: string[] }> {
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

  // Resolve and merge active backend profile, if present
  let profileConfig: PartialEforgeConfig | null = null;
  if (configPath) {
    const configDir = dirname(configPath);
    try {
      const { name, warnings } = await resolveActiveProfileName(configDir, projectConfig, globalConfig);
      allWarnings.push(...warnings);
      if (name) {
        const result = await loadBackendProfile(configDir, name);
        if (result) {
          profileConfig = result.profile;
        }
      }
    } catch {
      // best-effort: profile resolution should not break config loading
    }
  }

  const baseMerged = mergePartialConfigs(globalConfig, projectConfig);
  const merged = profileConfig ? mergePartialConfigs(baseMerged, profileConfig) : baseMerged;
  return { config: resolveConfig(merged), warnings: allWarnings };
}

// ---------------------------------------------------------------------------
// Backend Profile Loader
// ---------------------------------------------------------------------------

/**
 * Source of the active backend profile resolution.
 *
 * - `local`: marker file `eforge/.active-backend` selected the profile (dev-local override)
 * - `user-local`: user-scope marker `~/.config/eforge/.active-backend` selected the profile
 * - `missing`: marker present, but the referenced profile file is missing
 *   (a one-shot stderr warning is logged; fallback to user-marker or none)
 * - `none`: no profile applied (no marker found)
 */
export type ActiveProfileSource = 'local' | 'user-local' | 'missing' | 'none';

/** Marker filename inside the eforge config directory. */
const ACTIVE_BACKEND_MARKER = '.active-backend';

/** Profile subdirectory inside the eforge config directory. */
const BACKENDS_SUBDIR = 'backends';

function profilePath(configDir: string, name: string): string {
  return resolve(configDir, BACKENDS_SUBDIR, `${name}.yaml`);
}

function backendsDir(configDir: string): string {
  return resolve(configDir, BACKENDS_SUBDIR);
}

function markerPath(configDir: string): string {
  return resolve(configDir, ACTIVE_BACKEND_MARKER);
}

/** Return the user-scope backends directory (~/.config/eforge/backends/). */
function userBackendsDir(): string {
  const base = process.env.XDG_CONFIG_HOME || resolve(homedir(), '.config');
  return resolve(base, 'eforge', BACKENDS_SUBDIR);
}

/** Return the path to a user-scope profile file. */
function userProfilePath(name: string): string {
  return resolve(userBackendsDir(), `${name}.yaml`);
}

/** Return the path to the user-scope active-backend marker file. */
function userMarkerPath(): string {
  const base = process.env.XDG_CONFIG_HOME || resolve(homedir(), '.config');
  return resolve(base, 'eforge', ACTIVE_BACKEND_MARKER);
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
 * Return the directory containing `eforge/config.yaml` from the given start
 * directory, or null when no config file is found.
 */
export async function getConfigDir(cwd?: string): Promise<string | null> {
  const startDir = cwd ?? process.cwd();
  const configPath = await findConfigFile(startDir);
  return configPath ? dirname(configPath) : null;
}

/**
 * Resolve the active backend profile name and how it was selected.
 *
 * Resolution precedence:
 * 1. Project marker `eforge/.active-backend` (dev-local) — wins when present and the
 *    referenced profile file exists in either project or user scope.
 * 2. User marker `~/.config/eforge/.active-backend` — user-level dev-local override.
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
      `[eforge] Active backend marker ${markerPath(configDir)} points at ` +
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
 * Load and parse a backend profile file from a specific path. Returns null
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
 * Load and parse a backend profile file. Looks up in project scope first
 * (`eforge/backends/`), then user scope (`~/.config/eforge/backends/`).
 * Returns null when the profile file does not exist in either scope.
 * Profile files use the same partial-config schema as `config.yaml`.
 */
export async function loadBackendProfile(
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
 * List all backend profile files from both project (`eforge/backends/`) and
 * user (`~/.config/eforge/backends/`) scopes. Each entry includes the profile
 * name, its declared `backend`, the absolute file path, the scope it belongs to,
 * and `shadowedBy: 'project'` when a user-scope entry is shadowed by a
 * project-scope entry with the same name. Unreadable or non-YAML files are
 * skipped silently.
 */
export async function listBackendProfiles(
  configDir: string,
): Promise<Array<{ name: string; backend: 'claude-sdk' | 'pi' | undefined; path: string; scope: 'project' | 'user'; shadowedBy?: 'project' }>> {
  type ProfileEntry = { name: string; backend: 'claude-sdk' | 'pi' | undefined; path: string; scope: 'project' | 'user'; shadowedBy?: 'project' };

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
      let backend: 'claude-sdk' | 'pi' | undefined;
      try {
        const raw = await readFile(path, 'utf-8');
        const data = parseYaml(raw);
        if (data && typeof data === 'object') {
          const parsed = backendSchema.safeParse((data as Record<string, unknown>).backend);
          if (parsed.success) {
            backend = parsed.data;
          }
        }
      } catch {
        // unreadable — still include the entry with backend=undefined
      }
      out.push({ name, backend, path, scope });
    }
    return out;
  }

  const projectEntries = await scanDir(backendsDir(configDir), 'project');
  const userEntries = await scanDir(userBackendsDir(), 'user');

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
 * Set the active backend profile by writing the marker file atomically.
 * Validates that the profile file exists (in at least one scope) and that
 * the merged result (global + project + profile) passes `eforgeConfigSchema`.
 *
 * When `opts.scope` is `'user'`, the user-scope marker
 * (`~/.config/eforge/.active-backend`) is written instead of the project marker.
 */
export async function setActiveBackend(
  configDir: string,
  name: string,
  opts?: { scope?: 'project' | 'user' },
): Promise<void> {
  const scope = opts?.scope ?? 'project';
  name = name.trim();
  if (name.length === 0) {
    throw new Error('Backend profile name must be a non-empty string');
  }

  // Validate profile exists in at least one scope
  if (!(await profileExistsInAnyScope(configDir, name))) {
    throw new Error(`Backend profile "${name}" not found in project or user scope`);
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

  const profileResult = await loadBackendProfile(configDir, name);
  if (!profileResult) {
    throw new Error(`Backend profile "${name}" could not be parsed`);
  }

  const baseMerged = mergePartialConfigs(globalConfig, projectConfig);
  const merged = mergePartialConfigs(baseMerged, profileResult.profile);

  const result = eforgeConfigSchema.safeParse(merged);
  if (!result.success) {
    throw new Error(
      `Backend profile "${name}" produces an invalid merged config: ` +
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
 * Create a backend profile file. Validates the partial-config shape and
 * the merged result (global + project + profile) before writing. Refuses
 * to overwrite an existing profile unless `overwrite: true` is supplied.
 *
 * When `scope` is `'user'`, writes to the user-scope backends directory
 * (`~/.config/eforge/backends/`) instead of the project directory.
 */
export async function createBackendProfile(
  configDir: string,
  input: {
    name: string;
    backend: 'claude-sdk' | 'pi';
    pi?: PartialEforgeConfig['pi'];
    agents?: PartialEforgeConfig['agents'];
    overwrite?: boolean;
    scope?: 'project' | 'user';
  },
): Promise<{ path: string }> {
  const { name, backend, pi, agents, overwrite, scope: inputScope } = input;
  const scope = inputScope ?? 'project';
  if (!name || typeof name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(
      `Invalid profile name "${name}": must contain only letters, digits, dot, underscore, or dash.`,
    );
  }

  const targetDir = scope === 'user' ? userBackendsDir() : backendsDir(configDir);
  const path = resolve(targetDir, `${name}.yaml`);
  if (await fileExists(path)) {
    if (!overwrite) {
      throw new Error(`Backend profile "${name}" already exists at ${path}. Pass overwrite: true to replace it.`);
    }
  }

  // Build the partial config
  const partial: PartialEforgeConfig = { backend };
  if (pi !== undefined) (partial as Record<string, unknown>).pi = pi;
  if (agents !== undefined) (partial as Record<string, unknown>).agents = agents;

  // Validate against the partial schema first
  const partialResult = partialEforgeConfigSchema.safeParse(partial);
  if (!partialResult.success) {
    throw new Error(
      `Backend profile "${name}" failed partial-config validation: ` +
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
      `Backend profile "${name}" produces an invalid merged config: ` +
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
          `Backend profile "${name}" failed round-trip validation after write: ` +
          z.prettifyError(verifyResult.error),
        );
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(`Backend profile "${name}"`)) {
      throw err;
    }
    // ignore verify-read errors
  }

  return { path };
}

// Re-export profile utilities from the shared client package
export { sanitizeProfileName, parseRawConfigLegacy } from '@eforge-build/client';

/**
 * Delete a backend profile file. Refuses to delete the currently active
 * profile unless `force: true` is supplied; in that case, the marker file
 * is also removed when it pointed at the deleted profile.
 *
 * When `scope` is omitted and the profile exists in both project and user
 * scopes, throws an error requesting explicit scope. When `scope` is specified,
 * deletes only from that scope.
 */
export async function deleteBackendProfile(
  configDir: string,
  name: string,
  force?: boolean,
  scope?: 'project' | 'user',
): Promise<void> {
  name = name.trim();
  if (name.length === 0) {
    throw new Error('Backend profile name must be a non-empty string');
  }

  const projectPath = profilePath(configDir, name);
  const userPath = userProfilePath(name);
  const existsInProject = await fileExists(projectPath);
  const existsInUser = await fileExists(userPath);

  if (scope === undefined) {
    // Infer scope — error if ambiguous
    if (existsInProject && existsInUser) {
      throw new Error(
        `Backend profile "${name}" exists in both project and user scope. ` +
        `Specify scope: 'project' or 'user' to disambiguate.`,
      );
    }
    if (existsInProject) {
      scope = 'project';
    } else if (existsInUser) {
      scope = 'user';
    } else {
      throw new Error(`Backend profile "${name}" not found in project or user scope`);
    }
  }

  const targetPath = scope === 'user' ? userPath : projectPath;
  if (!(await fileExists(targetPath))) {
    throw new Error(`Backend profile "${name}" not found in ${scope} scope at ${targetPath}`);
  }

  // Determine if this profile is currently active via either marker
  const projectMarkerName = await readMarkerName(markerPath(configDir));
  const userMarkerName = await readMarkerName(userMarkerPath());

  if ((projectMarkerName === name || userMarkerName === name) && !force) {
    throw new Error(
      `Backend profile "${name}" is currently active. ` +
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
