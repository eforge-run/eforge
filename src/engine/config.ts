import { readFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { availableParallelism, homedir } from 'node:os';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod/v4';

import type { AgentRole } from './events.js';

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
  'test-writer', 'tester', 'prd-validator', 'dependency-detector',
] as const;

const agentRoleSchema = z.enum(AGENT_ROLES);

/** Model classes group agents by workload type. */
export const MODEL_CLASSES = ['max', 'balanced', 'fast', 'auto'] as const;
export type ModelClass = (typeof MODEL_CLASSES)[number];

export const modelClassSchema = z.enum(MODEL_CLASSES).describe('Model class for agent workload grouping');

const toolPresetConfigSchema = z.enum(['coding', 'none']);

// ---------------------------------------------------------------------------
// SDK Passthrough Config Schemas
// ---------------------------------------------------------------------------

export const thinkingConfigSchema = z.union([
  z.object({ type: z.literal('adaptive') }),
  z.object({ type: z.literal('enabled'), budgetTokens: z.number().int().positive().optional() }),
  z.object({ type: z.literal('disabled') }),
]).describe('Controls Claude\'s thinking/reasoning behavior');

export const effortLevelSchema = z.enum(['low', 'medium', 'high', 'max']).describe('Effort level for controlling thinking depth');

export const sdkPassthroughConfigSchema = z.object({
  model: z.string().optional().describe('Model override'),
  thinking: thinkingConfigSchema.optional().describe('Thinking/reasoning behavior'),
  effort: effortLevelSchema.optional().describe('Effort level'),
  maxBudgetUsd: z.number().positive().optional().describe('Maximum budget in USD'),
  fallbackModel: z.string().optional().describe('Fallback model if primary is unavailable'),
  allowedTools: z.array(z.string()).optional().describe('Whitelist of allowed tool names'),
  disallowedTools: z.array(z.string()).optional().describe('Blacklist of disallowed tool names'),
});

const agentProfileConfigSchema = z.object({
  maxTurns: z.number().int().positive().optional().describe('Maximum conversation turns for this agent'),
  prompt: z.string().optional().describe('Custom prompt override for this agent'),
  tools: toolPresetConfigSchema.optional().describe('Tool preset: "coding" for full tools or "none" for read-only'),
  model: z.string().optional().describe('Model override for this agent'),
  thinking: thinkingConfigSchema.optional().describe('Thinking/reasoning behavior'),
  effort: effortLevelSchema.optional().describe('Effort level'),
  maxBudgetUsd: z.number().positive().optional().describe('Maximum budget in USD'),
  fallbackModel: z.string().optional().describe('Fallback model if primary is unavailable'),
  allowedTools: z.array(z.string()).optional().describe('Whitelist of allowed tool names'),
  disallowedTools: z.array(z.string()).optional().describe('Blacklist of disallowed tool names'),
  modelClass: modelClassSchema.optional().describe('Override the model class for this agent profile'),
  roles: z.record(agentRoleSchema, sdkPassthroughConfigSchema.extend({
    maxTurns: z.number().int().positive().optional(),
    modelClass: modelClassSchema.optional().describe('Override the model class for this role'),
  })).optional().describe('Per-agent role overrides for SDK passthrough fields'),
});

const STRATEGIES = ['auto', 'single', 'parallel'] as const;
const STRICTNESS = ['strict', 'standard', 'lenient'] as const;
const AUTO_ACCEPT = ['suggestion', 'warning'] as const;

export const reviewProfileConfigSchema = z.object({
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

const partialProfileConfigSchema = z.object({
  description: z.string().optional(),
  extends: z.string().optional(),
  compile: z.array(z.string()).optional(),
});

export const resolvedProfileConfigSchema = z.object({
  description: z.string().min(1).describe('Human-readable description of what this profile is for'),
  extends: z.string().optional().describe('Name of the base profile this profile extends'),
  compile: z.array(z.string()).nonempty().describe('Ordered list of compile stage names to run'),
});

// ---------------------------------------------------------------------------
// Schema-derived YAML documentation for profile generation prompts
// ---------------------------------------------------------------------------

let _profileSchemaYamlCache: string | undefined;

/**
 * Convert the resolved profile config schema to a YAML string documenting
 * all fields and their descriptions. Uses z.toJSONSchema() and strips
 * internal keys ($schema, ~standard). Module-level cached since the schema
 * is static.
 */
export function getProfileSchemaYaml(): string {
  if (_profileSchemaYamlCache !== undefined) return _profileSchemaYamlCache;

  const jsonSchema = z.toJSONSchema(resolvedProfileConfigSchema);

  // Strip internal keys that aren't useful for prompt documentation
  function stripInternalKeys(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key === '$schema' || key === '~standard') continue;
      if (Array.isArray(value)) {
        result[key] = value.map((item) =>
          item && typeof item === 'object' && !Array.isArray(item)
            ? stripInternalKeys(item as Record<string, unknown>)
            : item,
        );
      } else if (value && typeof value === 'object') {
        result[key] = stripInternalKeys(value as Record<string, unknown>);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  const cleaned = stripInternalKeys(jsonSchema as Record<string, unknown>);
  _profileSchemaYamlCache = stringifyYaml(cleaned);
  return _profileSchemaYamlCache;
}

// ---------------------------------------------------------------------------
// Compile-only profile schema YAML (excludes build/review/agents)
// ---------------------------------------------------------------------------

let _compileOnlyProfileSchemaYamlCache: string | undefined;

/**
 * Convert a compile-only subset of the resolved profile config schema to YAML.
 * Excludes build, review, and agents fields - those are per-plan concerns
 * handled by module planners, not the top-level planner.
 */
export function getCompileOnlyProfileSchemaYaml(): string {
  if (_compileOnlyProfileSchemaYamlCache !== undefined) return _compileOnlyProfileSchemaYamlCache;

  const compileOnlySchema = z.object({
    description: resolvedProfileConfigSchema.shape.description,
    extends: resolvedProfileConfigSchema.shape.extends,
    compile: resolvedProfileConfigSchema.shape.compile,
  });

  const jsonSchema = z.toJSONSchema(compileOnlySchema);

  function stripInternalKeys(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key === '$schema' || key === '~standard') continue;
      if (Array.isArray(value)) {
        result[key] = value.map((item) =>
          item && typeof item === 'object' && !Array.isArray(item)
            ? stripInternalKeys(item as Record<string, unknown>)
            : item,
        );
      } else if (value && typeof value === 'object') {
        result[key] = stripInternalKeys(value as Record<string, unknown>);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  const cleaned = stripInternalKeys(jsonSchema as Record<string, unknown>);
  _compileOnlyProfileSchemaYamlCache = stringifyYaml(cleaned);
  return _compileOnlyProfileSchemaYamlCache;
}

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

export const piThinkingLevelSchema = z.enum(['off', 'medium', 'high']).describe('Pi-native thinking level');

export const piConfigSchema = z.object({
  provider: z.string().optional().describe('Pi AI provider (e.g. "openrouter", "anthropic")'),
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

export const eforgeConfigSchema = z.object({
  backend: backendSchema,
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
    model: z.string().optional().describe('Global model override for all agents'),
    thinking: thinkingConfigSchema.optional().describe('Global thinking config for all agents'),
    effort: effortLevelSchema.optional().describe('Global effort level for all agents'),
    models: z.record(modelClassSchema, z.string().optional()).optional().describe('Map model class names to model strings'),
    roles: z.record(agentRoleSchema, sdkPassthroughConfigSchema.extend({
      maxTurns: z.number().int().positive().optional(),
      modelClass: modelClassSchema.optional().describe('Override the model class for this role'),
    }).optional()).optional().describe('Per-agent role overrides'),
  }).optional(),
  build: z.object({
    parallelism: z.number().int().positive().optional(),
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
    autoRevise: z.boolean().optional(),
    autoBuild: z.boolean().optional(),
    watchPollIntervalMs: z.number().int().positive().optional(),
    parallelism: z.number().int().positive().optional(),
  }).optional(),
  daemon: z.object({
    idleShutdownMs: z.number().int().nonnegative().optional(),
  }).optional(),
  monitor: z.object({
    retentionCount: z.number().int().positive().optional(),
  }).optional(),
  pi: piConfigSchema.optional(),
  hooks: z.array(hookConfigSchema).optional(),
  profiles: z.record(z.string(), partialProfileConfigSchema).optional(),
});

// ---------------------------------------------------------------------------
// Derived TypeScript types — from schemas, not hand-written
// ---------------------------------------------------------------------------

export type ToolPresetConfig = z.output<typeof toolPresetConfigSchema>;
export type AgentProfileConfig = z.output<typeof agentProfileConfigSchema>;
export type ReviewProfileConfig = z.output<typeof reviewProfileConfigSchema>;
export type PartialProfileConfig = z.output<typeof partialProfileConfigSchema>;
export type ResolvedProfileConfig = z.output<typeof resolvedProfileConfigSchema>;
/** A single build stage name or an array of names to run in parallel. */
export type BuildStageSpec = string | string[];
/** Alias kept for barrel re-export convenience. */
export type ProfileConfig = ResolvedProfileConfig;
export type HookConfig = z.output<typeof hookConfigSchema>;
export type PluginConfig = z.output<typeof pluginConfigSchema>;

/** Resolved agent config for a specific role, combining SDK passthrough fields with maxTurns. */
export interface ResolvedAgentConfig {
  maxTurns?: number;
  model?: string;
  modelClass?: ModelClass;
  thinking?: import('./backend.js').ThinkingConfig;
  effort?: import('./backend.js').EffortLevel;
  maxBudgetUsd?: number;
  fallbackModel?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
}

export interface PiConfig {
  provider?: string;
  apiKey?: string;
  thinkingLevel: 'off' | 'medium' | 'high';
  extensions: { autoDiscover: boolean; include?: string[]; exclude?: string[]; paths?: string[] };
  compaction: { enabled: boolean; threshold: number };
  retry: { maxRetries: number; backoffMs: number };
}

export interface EforgeConfig {
  backend?: 'claude-sdk' | 'pi';
  langfuse: { enabled: boolean; publicKey?: string; secretKey?: string; host: string };
  agents: {
    maxTurns: number;
    maxContinuations: number;
    permissionMode: 'bypass' | 'default';
    settingSources?: string[];
    bare: boolean;
    model?: string;
    thinking?: import('./backend.js').ThinkingConfig;
    effort?: import('./backend.js').EffortLevel;
    models?: Partial<Record<ModelClass, string>>;
    roles?: Record<string, Partial<ResolvedAgentConfig>>;
  };
  build: { parallelism: number; worktreeDir?: string; postMergeCommands?: string[]; maxValidationRetries: number; cleanupPlanFiles: boolean };
  plan: { outputDir: string };
  plugins: PluginConfig;
  prdQueue: { dir: string; autoRevise: boolean; autoBuild: boolean; watchPollIntervalMs: number; parallelism: number };
  daemon: { idleShutdownMs: number };
  monitor: { retentionCount: number };
  pi: PiConfig;
  hooks: readonly HookConfig[];
  profiles: Record<string, ResolvedProfileConfig>;
}

/** Deep-partial version of EforgeConfig used for parsing and merging — derived from the zod schema. */
const partialEforgeConfigSchema = eforgeConfigSchema.partial();
export type PartialEforgeConfig = z.output<typeof partialEforgeConfigSchema>;

export const DEFAULT_REVIEW: ReviewProfileConfig = Object.freeze({
  strategy: 'auto' as const,
  perspectives: Object.freeze(['code']) as unknown as string[],
  maxRounds: 1,
  evaluatorStrictness: 'standard' as const,
});

/** Default build stages for errands (no doc-update). */
export const DEFAULT_BUILD: BuildStageSpec[] = Object.freeze([
  'implement', 'review-cycle',
]) as unknown as BuildStageSpec[];

/** Default build stages with parallel doc-update (for excursion/expedition). */
export const DEFAULT_BUILD_WITH_DOCS: BuildStageSpec[] = Object.freeze([
  Object.freeze(['implement', 'doc-update']), 'review-cycle',
]) as unknown as BuildStageSpec[];

/** Default build stages with test cycle (build-then-test). */
export const DEFAULT_BUILD_WITH_TESTS: BuildStageSpec[] = Object.freeze([
  'implement', 'test-cycle', 'review-cycle',
]) as unknown as BuildStageSpec[];

/** Default build stages for TDD workflow. */
export const DEFAULT_BUILD_TDD: BuildStageSpec[] = Object.freeze([
  'test-write', 'implement', 'test-cycle',
]) as unknown as BuildStageSpec[];

export const BUILTIN_PROFILES: Record<string, ResolvedProfileConfig> = Object.freeze({
  errand: Object.freeze({
    description: 'Small, self-contained changes. Single file or a few lines. Low risk, no architectural impact.',
    compile: Object.freeze(['prd-passthrough']) as unknown as string[],
  }),
  excursion: Object.freeze({
    description: 'Multi-file feature work or refactors. Use when the full scope can be planned in a single planner session - all plans enumerated, all file changes listed, and cross-plan dependencies resolved. Covers tightly coupled changes (type cascades, interface refactors, rename-and-update-all-callers) and any work where one planning pass is sufficient.',
    compile: Object.freeze(['planner', 'plan-review-cycle']) as unknown as string[],
  }),
  expedition: Object.freeze({
    description: 'Large work where planning scope requires delegated module planning with architecture and cohesion review. Use when the total scope exceeds what a single planner session can produce with quality - 4+ subsystems each needing dedicated codebase exploration, shared files requiring coordinated edits, or planning that would need to be deferred across modules.',
    compile: Object.freeze(['planner', 'architecture-review-cycle', 'module-planning', 'cohesion-review-cycle', 'compile-expedition']) as unknown as string[],
  }),
});

export const DEFAULT_CONFIG: EforgeConfig = Object.freeze({
  langfuse: Object.freeze({ enabled: false, host: 'https://cloud.langfuse.com' }),
  agents: Object.freeze({ maxTurns: 30, maxContinuations: 3, permissionMode: 'bypass' as const, settingSources: ['project'] as string[], bare: false }),
  build: Object.freeze({ parallelism: availableParallelism(), worktreeDir: undefined, postMergeCommands: undefined, maxValidationRetries: 2, cleanupPlanFiles: true }),
  plan: Object.freeze({ outputDir: 'eforge/plans' }),
  plugins: Object.freeze({ enabled: true }),
  prdQueue: Object.freeze({ dir: 'eforge/queue', autoRevise: true, autoBuild: true, watchPollIntervalMs: 5000, parallelism: 1 }),
  daemon: Object.freeze({ idleShutdownMs: 7_200_000 }),
  monitor: Object.freeze({ retentionCount: 20 }),
  pi: Object.freeze({
    thinkingLevel: 'medium' as const,
    extensions: Object.freeze({ autoDiscover: true }),
    compaction: Object.freeze({ enabled: true, threshold: 100_000 }),
    retry: Object.freeze({ maxRetries: 3, backoffMs: 1000 }),
  }),
  hooks: Object.freeze([]),
  profiles: BUILTIN_PROFILES,
});

/**
 * Walk up the directory tree looking for eforge/config.yaml.
 * If not found, checks for legacy eforge.yaml at startDir only and logs a
 * migration warning to stderr.
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

  // Check for legacy eforge.yaml at startDir only
  const legacyCandidate = resolve(startDir, 'eforge.yaml');
  try {
    await access(legacyCandidate);
    console.error(
      `[eforge] Found legacy config at ${legacyCandidate}. ` +
      `Please move it to eforge/config.yaml. ` +
      `Run: mkdir -p eforge && mv eforge.yaml eforge/config.yaml`,
    );
  } catch {
    // no legacy config either
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
    }),
    build: Object.freeze({
      parallelism: fileConfig.build?.parallelism ?? DEFAULT_CONFIG.build.parallelism,
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
      autoRevise: fileConfig.prdQueue?.autoRevise ?? DEFAULT_CONFIG.prdQueue.autoRevise,
      autoBuild: fileConfig.prdQueue?.autoBuild ?? DEFAULT_CONFIG.prdQueue.autoBuild,
      watchPollIntervalMs: fileConfig.prdQueue?.watchPollIntervalMs ?? DEFAULT_CONFIG.prdQueue.watchPollIntervalMs,
      parallelism: fileConfig.prdQueue?.parallelism ?? DEFAULT_CONFIG.prdQueue.parallelism,
    }),
    daemon: Object.freeze({
      idleShutdownMs: fileConfig.daemon?.idleShutdownMs ?? DEFAULT_CONFIG.daemon.idleShutdownMs,
    }),
    monitor: Object.freeze({
      retentionCount: fileConfig.monitor?.retentionCount ?? DEFAULT_CONFIG.monitor.retentionCount,
    }),
    pi: Object.freeze({
      provider: fileConfig.pi?.provider,
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
    hooks: Object.freeze(fileConfig.hooks ?? DEFAULT_CONFIG.hooks) as HookConfig[],
    profiles: Object.freeze(
      resolveProfileExtensions(fileConfig.profiles ?? {}, BUILTIN_PROFILES),
    ),
  });
}

/**
 * Parse and validate a raw YAML object into a partial EforgeConfig.
 * Uses zod schema for validation — invalid fields are dropped and
 * a warning is logged to stderr so users get feedback on typos.
 */
function parseRawConfig(data: Record<string, unknown>): PartialEforgeConfig {
  const result = partialEforgeConfigSchema.safeParse(data);
  if (result.success) {
    return stripUndefinedSections(result.data);
  }
  // Log validation errors so users know about typos/invalid values
  console.error('eforge config warning: some fields were invalid and will be ignored:\n' + z.prettifyError(result.error));
  // Parse again with passthrough to salvage valid fields —
  // safeParse is all-or-nothing per property, so re-parse each section independently
  return parseRawConfigFallback(data);
}

/**
 * Fallback parser: parse each top-level section independently so that
 * one bad section doesn't nuke the rest. Mirrors the schema structure.
 */
function parseRawConfigFallback(data: Record<string, unknown>): PartialEforgeConfig {
  const result: PartialEforgeConfig = {};
  // Handle top-level scalar fields
  if (data.backend !== undefined) {
    const backendResult = backendSchema.safeParse(data.backend);
    if (backendResult.success) {
      (result as Record<string, unknown>).backend = backendResult.data;
    }
  }
  const sections = ['langfuse', 'agents', 'build', 'plan', 'plugins', 'prdQueue', 'daemon', 'pi', 'hooks', 'profiles'] as const;
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
  if (config.langfuse !== undefined) out.langfuse = config.langfuse;
  if (config.agents !== undefined) out.agents = config.agents;
  if (config.build !== undefined) out.build = config.build;
  if (config.plan !== undefined) out.plan = config.plan;
  if (config.plugins !== undefined) out.plugins = config.plugins;
  if (config.prdQueue !== undefined) out.prdQueue = config.prdQueue;
  if (config.daemon !== undefined) out.daemon = config.daemon;
  if (config.pi !== undefined) out.pi = config.pi;
  if (config.hooks !== undefined) out.hooks = config.hooks;
  if (config.profiles !== undefined) out.profiles = config.profiles;
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

  // hooks: concatenate (global first, then project)
  if (global.hooks || project.hooks) {
    result.hooks = [...(global.hooks ?? []), ...(project.hooks ?? [])];
  }

  // profiles: merge by name
  if (global.profiles || project.profiles) {
    const merged: Record<string, PartialProfileConfig> = {};
    const allNames = new Set([
      ...Object.keys(global.profiles ?? {}),
      ...Object.keys(project.profiles ?? {}),
    ]);
    for (const name of allNames) {
      const g = global.profiles?.[name];
      const p = project.profiles?.[name];
      if (g && p) {
        // Shallow merge per profile: description, compile, extends
        merged[name] = { ...g, ...p };
      } else {
        merged[name] = (p ?? g)!;
      }
    }
    result.profiles = merged;
  }

  return result;
}

/**
 * Load the user-level (global) config file.
 * Returns an empty partial on any failure (missing file, bad YAML, etc.).
 */
async function loadUserConfig(
  env: Record<string, string | undefined> = process.env,
): Promise<PartialEforgeConfig> {
  const configPath = getUserConfigPath(env);
  try {
    const raw = await readFile(configPath, 'utf-8');
    const data = parseYaml(raw);
    if (!data || typeof data !== 'object') {
      return {};
    }
    return parseRawConfig(data as Record<string, unknown>);
  } catch {
    return {};
  }
}

/**
 * Load eforge.yaml config from the given directory (searching upward),
 * merged with user-level global config (~/.config/eforge/config.yaml).
 * Returns DEFAULT_CONFIG when no config files exist.
 */
export async function loadConfig(cwd?: string): Promise<EforgeConfig> {
  const globalConfig = await loadUserConfig();

  const startDir = cwd ?? process.cwd();
  const configPath = await findConfigFile(startDir);

  let projectConfig: PartialEforgeConfig = {};
  if (configPath) {
    try {
      const raw = await readFile(configPath, 'utf-8');
      const data = parseYaml(raw);
      if (data && typeof data === 'object') {
        projectConfig = parseRawConfig(data as Record<string, unknown>);
      }
    } catch {
      // malformed YAML — treat as empty
    }
  }

  const merged = mergePartialConfigs(globalConfig, projectConfig);
  return resolveConfig(merged);
}

/**
 * Resolve profile extensions by walking `extends` chains, detecting cycles,
 * and shallow-merging inherited fields. Returns fully-resolved profiles
 * with all required fields present.
 */
export function resolveProfileExtensions(
  partials: Record<string, PartialProfileConfig>,
  builtins: Record<string, ResolvedProfileConfig> = BUILTIN_PROFILES,
): Record<string, ResolvedProfileConfig> {
  const resolved = new Map<string, ResolvedProfileConfig>();
  const resolving = new Set<string>(); // cycle detection

  function resolve(name: string): ResolvedProfileConfig {
    const cached = resolved.get(name);
    if (cached) return cached;

    // If it's a built-in with no user override, return as-is
    const partial = partials[name];
    if (!partial) {
      const builtin = builtins[name];
      if (builtin) return builtin;
      throw new Error(`Profile "${name}" not found`);
    }

    if (resolving.has(name)) {
      throw new Error(`Circular profile extension detected: ${name}`);
    }
    resolving.add(name);

    // Get base - either the extends target or the built-in of the same name or excursion fallback
    let base: ResolvedProfileConfig;
    if (partial.extends) {
      base = resolve(partial.extends);
    } else if (builtins[name]) {
      base = builtins[name];
    } else {
      base = builtins['excursion']; // fallback for custom profiles with no extends
    }

    // Determine the extends value for the resolved config
    const extendsValue = partial.extends
      ? partial.extends
      : builtins[name]
        ? undefined // built-in override inherits from itself, no extends
        : 'excursion'; // custom profile with no explicit extends fell through to excursion fallback

    const result: ResolvedProfileConfig = {
      description: partial.description ?? base.description,
      ...(extendsValue ? { extends: extendsValue } : {}),
      compile: partial.compile ?? base.compile,
    };

    resolving.delete(name);
    resolved.set(name, result);
    return result;
  }

  // Resolve all profiles (builtins + user-defined)
  const allNames = new Set([...Object.keys(builtins), ...Object.keys(partials)]);
  const out: Record<string, ResolvedProfileConfig> = {};
  for (const name of allNames) {
    out[name] = resolve(name);
  }
  return out;
}

/**
 * Parse a standalone profiles YAML file into partial profile configs.
 * The file is expected to have a `profiles` top-level key matching the
 * same structure as in eforge.yaml.
 */
export async function parseProfilesFile(
  filePath: string,
): Promise<Record<string, PartialProfileConfig>> {
  const raw = await readFile(filePath, 'utf-8');
  const data = parseYaml(raw);
  if (!data || typeof data !== 'object') return {};
  const parsed = parseRawConfig(data as Record<string, unknown>);
  return parsed.profiles ?? {};
}

// ---------------------------------------------------------------------------
// Profile Validation
// ---------------------------------------------------------------------------

/**
 * Validate a ResolvedProfileConfig has valid stage names, required fields,
 * and allowed enum values. When stage registries are provided, validates
 * that all stage names exist in the registries.
 *
 * Uses zod schema for structural/enum validation, then applies runtime
 * stage-name checks (registries aren't known at schema-definition time).
 */
export function validateProfileConfig(
  config: ResolvedProfileConfig,
  compileStageNames?: Set<string>,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Schema-based validation for structure + enums
  const result = resolvedProfileConfigSchema.safeParse(config);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const path = issue.path.map(String).join('.');
      if (path === 'description') {
        errors.push('description is required and must be a non-empty string');
      } else if (path === 'compile') {
        errors.push('compile must be a non-empty array of stage names');
      } else {
        errors.push(`${path}: ${issue.message}`);
      }
    }
  }

  // Runtime stage-name validation against registries
  if (compileStageNames) {
    for (const name of config.compile) {
      if (!compileStageNames.has(name)) {
        errors.push(`unknown compile stage: "${name}"`);
      }
    }
  }

  // Deduplicate errors (schema may produce multiple issues for the same field)
  const uniqueErrors = [...new Set(errors)];
  return { valid: uniqueErrors.length === 0, errors: uniqueErrors };
}

/**
 * Resolve a generated profile block into a full ResolvedProfileConfig.
 * Supports two modes:
 * - Full config: `{ config: { ... } }` — returns config as-is
 * - Extends: `{ extends: "base-name", overrides: { ... } }` — merges overrides onto base
 */
export function resolveGeneratedProfile(
  generated: import('./agents/common.js').GeneratedProfileBlock,
  availableProfiles: Record<string, ResolvedProfileConfig>,
): ResolvedProfileConfig {
  // Full config mode - use as-is
  if (generated.config) return generated.config;

  // Extends mode - merge overrides onto base
  const baseName = generated.extends ?? 'excursion';
  const base = availableProfiles[baseName];
  if (!base) {
    throw new Error(`Generated profile extends unknown base: "${baseName}"`);
  }

  const overrides = generated.overrides ?? {};
  return {
    extends: baseName,
    description: overrides.description ?? base.description,
    compile: overrides.compile ?? base.compile,
  };
}

// ---------------------------------------------------------------------------
// Config File Validation
// ---------------------------------------------------------------------------

/**
 * Validate the eforge config file found from the given directory.
 * Loads the raw YAML, runs schema validation, then validates each resolved
 * profile against the stage registries from pipeline.ts.
 */
export async function validateConfigFile(
  cwd?: string,
): Promise<{ valid: boolean; errors: string[] }> {
  const { getCompileStageNames } = await import('./pipeline.js');
  const errors: string[] = [];

  const startDir = cwd ?? process.cwd();
  const configPath = await findConfigFile(startDir);
  if (!configPath) {
    return { valid: true, errors: [] }; // No config file is valid (defaults apply)
  }

  let raw: string;
  try {
    raw = await readFile(configPath, 'utf-8');
  } catch (err) {
    return { valid: false, errors: [`Failed to read config file: ${(err as Error).message}`] };
  }

  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch (err) {
    return { valid: false, errors: [`Invalid YAML: ${(err as Error).message}`] };
  }

  if (!data || typeof data !== 'object') {
    return { valid: true, errors: [] }; // Empty file is valid
  }

  // Schema validation
  const result = eforgeConfigSchema.safeParse(data);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const path = issue.path.map(String).join('.');
      errors.push(`${path}: ${issue.message}`);
    }
  }

  // Profile validation against stage registries
  const parsed: PartialEforgeConfig = result.success ? result.data : {};
  if (parsed.profiles) {
    const compileStageNames = getCompileStageNames();

    try {
      const resolved = resolveProfileExtensions(parsed.profiles, BUILTIN_PROFILES);
      for (const [name, profile] of Object.entries(resolved)) {
        const profileResult = validateProfileConfig(profile, compileStageNames);
        for (const err of profileResult.errors) {
          errors.push(`profile "${name}": ${err}`);
        }
      }
    } catch (err) {
      errors.push(`Profile resolution failed: ${(err as Error).message}`);
    }
  }

  return { valid: errors.length === 0, errors };
}
