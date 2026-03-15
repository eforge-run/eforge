import { readFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { availableParallelism, homedir } from 'node:os';
import { parse as parseYaml } from 'yaml';

export interface HookConfig {
  event: string;   // glob pattern on EforgeEvent.type (e.g. "build:*", "*")
  command: string; // shell command or script path
  timeout: number; // ms, default 5000
}

export interface PluginConfig {
  enabled: boolean;
  /** Plugin identifiers to include (e.g. "git@schaake-cc-marketplace"). If set, only these load. */
  include?: string[];
  /** Plugin identifiers to exclude from auto-discovery. */
  exclude?: string[];
  /** Additional local plugin directory paths (always appended). */
  paths?: string[];
}

export interface EforgeConfig {
  langfuse: { enabled: boolean; publicKey?: string; secretKey?: string; host: string };
  agents: { maxTurns: number; permissionMode: 'bypass' | 'default'; settingSources?: string[] };
  build: { parallelism: number; worktreeDir?: string; postMergeCommands?: string[]; maxValidationRetries: number; cleanupPlanFiles: boolean };
  plan: { outputDir: string };
  plugins: PluginConfig;
  hooks: readonly HookConfig[];
}

/** Deep-partial version of EforgeConfig used for parsing and merging. */
export type PartialEforgeConfig = {
  [K in keyof EforgeConfig]?: K extends 'hooks'
    ? HookConfig[]
    : EforgeConfig[K] extends object
      ? Partial<EforgeConfig[K]>
      : EforgeConfig[K];
};

export const DEFAULT_CONFIG: EforgeConfig = Object.freeze({
  langfuse: Object.freeze({ enabled: false, host: 'https://cloud.langfuse.com' }),
  agents: Object.freeze({ maxTurns: 30, permissionMode: 'bypass' as const, settingSources: ['project'] as string[] }),
  build: Object.freeze({ parallelism: availableParallelism(), worktreeDir: undefined, postMergeCommands: undefined, maxValidationRetries: 2, cleanupPlanFiles: true }),
  plan: Object.freeze({ outputDir: 'plans' }),
  plugins: Object.freeze({ enabled: true }),
  hooks: Object.freeze([]),
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
    hooks: Object.freeze(fileConfig.hooks ?? DEFAULT_CONFIG.hooks) as HookConfig[],
  });
}

/**
 * Parse and validate a raw YAML object into a partial EforgeConfig.
 * Returns only the fields that are present and valid — no premature defaults.
 */
function parseRawConfig(data: Record<string, unknown>): PartialEforgeConfig {
  const result: PartialEforgeConfig = {};

  if (data.langfuse && typeof data.langfuse === 'object') {
    const lf = data.langfuse as Record<string, unknown>;
    result.langfuse = {
      ...(typeof lf.publicKey === 'string' ? { publicKey: lf.publicKey } : {}),
      ...(typeof lf.secretKey === 'string' ? { secretKey: lf.secretKey } : {}),
      ...(typeof lf.host === 'string' ? { host: lf.host } : {}),
    };
  }

  if (data.agents && typeof data.agents === 'object') {
    const ag = data.agents as Record<string, unknown>;
    const VALID_SETTING_SOURCES = ['user', 'project', 'local'];
    const settingSources =
      Array.isArray(ag.settingSources)
        ? ag.settingSources.filter((s: unknown) => typeof s === 'string' && VALID_SETTING_SOURCES.includes(s)) as string[]
        : undefined;
    // Empty array after filtering means all entries were invalid — treat as absent so defaults apply
    const hasSettingSources = settingSources && settingSources.length > 0;
    result.agents = {
      ...(typeof ag.maxTurns === 'number' && ag.maxTurns > 0 ? { maxTurns: ag.maxTurns } : {}),
      ...(ag.permissionMode === 'bypass' || ag.permissionMode === 'default'
        ? { permissionMode: ag.permissionMode }
        : {}),
      ...(hasSettingSources ? { settingSources } : {}),
    };
  }

  if (data.build && typeof data.build === 'object') {
    const bd = data.build as Record<string, unknown>;
    const postMergeCommands =
      Array.isArray(bd.postMergeCommands) && bd.postMergeCommands.every((c: unknown) => typeof c === 'string')
        ? (bd.postMergeCommands as string[])
        : undefined;
    result.build = {
      ...(typeof bd.parallelism === 'number' && bd.parallelism > 0
        ? { parallelism: bd.parallelism }
        : {}),
      ...(typeof bd.worktreeDir === 'string' ? { worktreeDir: bd.worktreeDir } : {}),
      ...(postMergeCommands ? { postMergeCommands } : {}),
      ...(typeof bd.maxValidationRetries === 'number' && bd.maxValidationRetries >= 0
        ? { maxValidationRetries: bd.maxValidationRetries }
        : {}),
      ...(typeof bd.cleanupPlanFiles === 'boolean' ? { cleanupPlanFiles: bd.cleanupPlanFiles } : {}),
    };
  }

  if (data.plan && typeof data.plan === 'object') {
    const pl = data.plan as Record<string, unknown>;
    result.plan = {
      ...(typeof pl.outputDir === 'string' ? { outputDir: pl.outputDir } : {}),
    };
  }

  if (data.plugins && typeof data.plugins === 'object' && !Array.isArray(data.plugins)) {
    const pg = data.plugins as Record<string, unknown>;
    const include =
      Array.isArray(pg.include) && pg.include.every((s: unknown) => typeof s === 'string')
        ? (pg.include as string[])
        : undefined;
    const exclude =
      Array.isArray(pg.exclude) && pg.exclude.every((s: unknown) => typeof s === 'string')
        ? (pg.exclude as string[])
        : undefined;
    const paths =
      Array.isArray(pg.paths) && pg.paths.every((s: unknown) => typeof s === 'string')
        ? (pg.paths as string[])
        : undefined;
    result.plugins = {
      ...(typeof pg.enabled === 'boolean' ? { enabled: pg.enabled } : {}),
      ...(include ? { include } : {}),
      ...(exclude ? { exclude } : {}),
      ...(paths ? { paths } : {}),
    };
  }

  if (Array.isArray(data.hooks)) {
    const validHooks: HookConfig[] = [];
    for (const entry of data.hooks) {
      if (
        entry &&
        typeof entry === 'object' &&
        typeof (entry as Record<string, unknown>).event === 'string' &&
        typeof (entry as Record<string, unknown>).command === 'string'
      ) {
        const e = entry as Record<string, unknown>;
        const timeout = typeof e.timeout === 'number' && e.timeout > 0 ? e.timeout : 5000;
        validHooks.push({ event: e.event as string, command: e.command as string, timeout });
      }
    }
    result.hooks = validHooks;
  }

  return result;
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
