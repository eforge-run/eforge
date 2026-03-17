import { readFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { availableParallelism, homedir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod/v4';

import type { AgentRole } from './events.js';

// ---------------------------------------------------------------------------
// Zod Schemas — single source of truth for config types
// ---------------------------------------------------------------------------

/** Agent roles matching the AgentRole union in events.ts. */
const AGENT_ROLES = [
  'planner', 'builder', 'reviewer', 'evaluator', 'module-planner',
  'plan-reviewer', 'plan-evaluator', 'cohesion-reviewer', 'cohesion-evaluator',
  'validation-fixer', 'assessor', 'review-fixer', 'merge-conflict-resolver',
  'staleness-assessor', 'formatter', 'doc-updater',
] as const;

const agentRoleSchema = z.enum(AGENT_ROLES);

const toolPresetConfigSchema = z.enum(['coding', 'none']);

const agentProfileConfigSchema = z.object({
  maxTurns: z.number().int().positive().optional(),
  prompt: z.string().optional(),
  tools: toolPresetConfigSchema.optional(),
  model: z.string().optional(),
});

const STRATEGIES = ['auto', 'single', 'parallel'] as const;
const STRICTNESS = ['strict', 'standard', 'lenient'] as const;
const AUTO_ACCEPT = ['suggestion', 'warning'] as const;

const reviewProfileConfigSchema = z.object({
  strategy: z.enum(STRATEGIES),
  perspectives: z.array(z.string()).nonempty(),
  maxRounds: z.number().int().positive(),
  autoAcceptBelow: z.enum(AUTO_ACCEPT).optional(),
  evaluatorStrictness: z.enum(STRICTNESS),
});

/** A build stage spec: either a single stage name or an array of stage names to run in parallel. */
const buildStageSpecSchema = z.union([z.string(), z.array(z.string())]);

const partialProfileConfigSchema = z.object({
  description: z.string().optional(),
  extends: z.string().optional(),
  compile: z.array(z.string()).optional(),
  build: z.array(buildStageSpecSchema).optional(),
  agents: z.partialRecord(agentRoleSchema, agentProfileConfigSchema).optional(),
  review: reviewProfileConfigSchema.partial().optional(),
});

const resolvedProfileConfigSchema = z.object({
  description: z.string().min(1),
  compile: z.array(z.string()).nonempty(),
  build: z.array(buildStageSpecSchema).nonempty(),
  agents: z.partialRecord(agentRoleSchema, agentProfileConfigSchema),
  review: reviewProfileConfigSchema,
});

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

const eforgeConfigSchema = z.object({
  langfuse: z.object({
    enabled: z.boolean().optional(),
    publicKey: z.string().optional(),
    secretKey: z.string().optional(),
    host: z.string().optional(),
  }).optional(),
  agents: z.object({
    maxTurns: z.number().int().positive().optional(),
    permissionMode: z.enum(['bypass', 'default']).optional(),
    settingSources: z.array(z.enum(SETTING_SOURCES)).nonempty().optional(),
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
  }).optional(),
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

export interface EforgeConfig {
  langfuse: { enabled: boolean; publicKey?: string; secretKey?: string; host: string };
  agents: { maxTurns: number; permissionMode: 'bypass' | 'default'; settingSources?: string[] };
  build: { parallelism: number; worktreeDir?: string; postMergeCommands?: string[]; maxValidationRetries: number; cleanupPlanFiles: boolean };
  plan: { outputDir: string };
  plugins: PluginConfig;
  prdQueue: { dir: string; autoRevise: boolean };
  hooks: readonly HookConfig[];
  profiles: Record<string, ResolvedProfileConfig>;
}

/** Deep-partial version of EforgeConfig used for parsing and merging — derived from the zod schema. */
export type PartialEforgeConfig = z.output<typeof eforgeConfigSchema>;

const DEFAULT_REVIEW: ReviewProfileConfig = Object.freeze({
  strategy: 'auto' as const,
  perspectives: Object.freeze(['code']) as unknown as string[],
  maxRounds: 1,
  evaluatorStrictness: 'standard' as const,
});

const DEFAULT_BUILD_STAGES = Object.freeze([
  Object.freeze(['implement', 'doc-update']), 'review', 'review-fix', 'evaluate',
]) as unknown as BuildStageSpec[];

export const BUILTIN_PROFILES: Record<string, ResolvedProfileConfig> = Object.freeze({
  errand: Object.freeze({
    description: 'Small, self-contained changes. Single file or a few lines. Low risk, no architectural impact.',
    compile: Object.freeze(['planner', 'plan-review-cycle']) as unknown as string[],
    build: DEFAULT_BUILD_STAGES,
    agents: Object.freeze({}),
    review: DEFAULT_REVIEW,
  }),
  excursion: Object.freeze({
    description: 'Multi-file feature work or refactors that need planning and review but fit in a single plan. Use for medium-complexity tasks with cross-file changes.',
    compile: Object.freeze(['planner', 'plan-review-cycle']) as unknown as string[],
    build: DEFAULT_BUILD_STAGES,
    agents: Object.freeze({}),
    review: DEFAULT_REVIEW,
  }),
  expedition: Object.freeze({
    description: 'Large cross-cutting work spanning multiple modules. Needs architecture planning, module decomposition, and parallel execution.',
    compile: Object.freeze(['planner', 'module-planning', 'cohesion-review-cycle', 'compile-expedition']) as unknown as string[],
    build: DEFAULT_BUILD_STAGES,
    agents: Object.freeze({}),
    review: DEFAULT_REVIEW,
  }),
});

export const DEFAULT_CONFIG: EforgeConfig = Object.freeze({
  langfuse: Object.freeze({ enabled: false, host: 'https://cloud.langfuse.com' }),
  agents: Object.freeze({ maxTurns: 30, permissionMode: 'bypass' as const, settingSources: ['project'] as string[] }),
  build: Object.freeze({ parallelism: availableParallelism(), worktreeDir: undefined, postMergeCommands: undefined, maxValidationRetries: 2, cleanupPlanFiles: true }),
  plan: Object.freeze({ outputDir: 'plans' }),
  plugins: Object.freeze({ enabled: true }),
  prdQueue: Object.freeze({ dir: 'docs/prd-queue', autoRevise: false }),
  hooks: Object.freeze([]),
  profiles: BUILTIN_PROFILES,
});

/**
 * Walk up the directory tree looking for eforge.yaml.
 * Returns the absolute path if found, null otherwise.
 */
export async function findConfigFile(startDir: string): Promise<string | null> {
  let dir = resolve(startDir);

  while (true) {
    const candidate = resolve(dir, 'eforge.yaml');
    try {
      await access(candidate);
      return candidate;
    } catch {
      // not found, move up
    }

    const parent = dirname(dir);
    if (parent === dir) {
      return null; // reached filesystem root
    }
    dir = parent;
  }
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
    langfuse: Object.freeze({
      enabled: langfuseEnabled,
      publicKey: langfusePublicKey,
      secretKey: langfuseSecretKey,
      host: langfuseHost,
    }),
    agents: Object.freeze({
      maxTurns: fileConfig.agents?.maxTurns ?? DEFAULT_CONFIG.agents.maxTurns,
      permissionMode: fileConfig.agents?.permissionMode ?? DEFAULT_CONFIG.agents.permissionMode,
      settingSources: fileConfig.agents?.settingSources ?? DEFAULT_CONFIG.agents.settingSources,
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
  const result = eforgeConfigSchema.safeParse(data);
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
  const sections = ['langfuse', 'agents', 'build', 'plan', 'plugins', 'prdQueue', 'hooks', 'profiles'] as const;
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
  if (config.langfuse !== undefined) out.langfuse = config.langfuse;
  if (config.agents !== undefined) out.agents = config.agents;
  if (config.build !== undefined) out.build = config.build;
  if (config.plan !== undefined) out.plan = config.plan;
  if (config.plugins !== undefined) out.plugins = config.plugins;
  if (config.prdQueue !== undefined) out.prdQueue = config.prdQueue;
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

  // Object sections: shallow merge
  if (global.langfuse || project.langfuse) {
    result.langfuse = { ...global.langfuse, ...project.langfuse };
  }
  if (global.agents || project.agents) {
    result.agents = { ...global.agents, ...project.agents };
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
        // Shallow merge per profile, with agents merged per-agent
        const mergedAgents: Partial<Record<AgentRole, AgentProfileConfig>> = {
          ...g.agents,
        };
        if (p.agents) {
          for (const [role, config] of Object.entries(p.agents)) {
            const base = mergedAgents[role as AgentRole];
            mergedAgents[role as AgentRole] = base ? { ...base, ...config } : config;
          }
        }
        merged[name] = {
          ...g,
          ...p,
          agents: Object.keys(mergedAgents).length > 0 ? mergedAgents : undefined,
          review: g.review || p.review ? { ...g.review, ...p.review } : undefined,
        };
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

    // Shallow merge per-agent
    const mergedAgents: Partial<Record<AgentRole, AgentProfileConfig>> = { ...base.agents };
    if (partial.agents) {
      for (const [role, agentConfig] of Object.entries(partial.agents)) {
        const baseAgent = mergedAgents[role as AgentRole];
        mergedAgents[role as AgentRole] = baseAgent
          ? { ...baseAgent, ...agentConfig }
          : agentConfig;
      }
    }

    // Shallow merge review
    const mergedReview: ReviewProfileConfig = {
      ...base.review,
      ...(partial.review ?? {}),
    } as ReviewProfileConfig;

    const result: ResolvedProfileConfig = {
      description: partial.description ?? base.description,
      compile: partial.compile ?? base.compile,
      build: partial.build ?? base.build,
      agents: mergedAgents,
      review: mergedReview,
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
  buildStageNames?: Set<string>,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Schema-based validation for structure + enums
  const result = resolvedProfileConfigSchema.safeParse(config);
  if (!result.success) {
    // Walk zod issues and produce human-readable error strings
    // matching the existing format for backward compatibility
    for (const issue of result.error.issues) {
      const path = issue.path.map(String).join('.');
      if (path === 'description') {
        errors.push('description is required and must be a non-empty string');
      } else if (path === 'compile') {
        errors.push('compile must be a non-empty array of stage names');
      } else if (path === 'build') {
        errors.push('build must be a non-empty array of stage names');
      } else if (path === 'review') {
        errors.push('review config is required');
      } else if (path === 'review.strategy') {
        errors.push(`invalid review strategy: "${(config.review as Record<string, unknown>)?.strategy ?? ''}"`);
      } else if (path === 'review.evaluatorStrictness') {
        errors.push(`invalid evaluator strictness: "${(config.review as Record<string, unknown>)?.evaluatorStrictness ?? ''}"`);
      } else if (path === 'review.maxRounds') {
        errors.push('review.maxRounds must be a positive integer');
      } else if (path === 'review.perspectives') {
        errors.push('review.perspectives must be a non-empty array');
      } else if (path === 'review.autoAcceptBelow') {
        errors.push(`invalid autoAcceptBelow: "${(config.review as Record<string, unknown>)?.autoAcceptBelow ?? ''}"`);
      } else {
        errors.push(`${path}: ${issue.message}`);
      }
    }
  }

  // Check for unknown agent roles (partialRecord allows unknown keys at runtime,
  // so we validate manually)
  if (config.agents) {
    const validRoles = new Set<string>(AGENT_ROLES);
    for (const role of Object.keys(config.agents)) {
      if (!validRoles.has(role)) {
        errors.push(`unknown agent role: "${role}"`);
      }
    }
  }

  // Check review missing entirely
  if (!config.review && !errors.some((e) => e.includes('review'))) {
    errors.push('review config is required');
  }

  // Runtime stage-name validation against registries
  if (compileStageNames) {
    for (const name of config.compile) {
      if (!compileStageNames.has(name)) {
        errors.push(`unknown compile stage: "${name}"`);
      }
    }
  }
  if (buildStageNames) {
    const flatBuildStages = config.build.flatMap((spec) => Array.isArray(spec) ? spec : [spec]);
    for (const name of flatBuildStages) {
      if (!buildStageNames.has(name)) {
        errors.push(`unknown build stage: "${name}"`);
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
    description: overrides.description ?? base.description,
    compile: overrides.compile ?? base.compile,
    build: overrides.build ?? base.build,
    agents: { ...base.agents, ...(overrides.agents as Partial<Record<AgentRole, AgentProfileConfig>> ?? {}) },
    review: { ...base.review, ...(overrides.review ?? {}) } as ReviewProfileConfig,
  };
}
