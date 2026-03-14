import { readFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { availableParallelism } from 'node:os';
import { parse as parseYaml } from 'yaml';

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
  build: { parallelism: number; worktreeDir?: string; postMergeCommands?: string[]; maxValidationRetries: number };
  plan: { outputDir: string };
  plugins: PluginConfig;
}

export const DEFAULT_CONFIG: EforgeConfig = Object.freeze({
  langfuse: Object.freeze({ enabled: false, host: 'https://cloud.langfuse.com' }),
  agents: Object.freeze({ maxTurns: 30, permissionMode: 'bypass' as const, settingSources: ['project'] as string[] }),
  build: Object.freeze({ parallelism: availableParallelism(), worktreeDir: undefined, postMergeCommands: undefined, maxValidationRetries: 2 }),
  plan: Object.freeze({ outputDir: 'plans' }),
  plugins: Object.freeze({ enabled: true }),
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
  fileConfig: Partial<EforgeConfig>,
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
  });
}

/**
 * Parse and validate a raw YAML object into a partial EforgeConfig.
 * Returns only the fields that are present and valid.
 */
function parseRawConfig(data: Record<string, unknown>): Partial<EforgeConfig> {
  const result: Partial<EforgeConfig> = {};

  if (data.langfuse && typeof data.langfuse === 'object') {
    const lf = data.langfuse as Record<string, unknown>;
    result.langfuse = {
      enabled: false, // resolved later by resolveConfig
      publicKey: typeof lf.publicKey === 'string' ? lf.publicKey : undefined,
      secretKey: typeof lf.secretKey === 'string' ? lf.secretKey : undefined,
      host: typeof lf.host === 'string' ? lf.host : DEFAULT_CONFIG.langfuse.host,
    };
  }

  if (data.agents && typeof data.agents === 'object') {
    const ag = data.agents as Record<string, unknown>;
    const VALID_SETTING_SOURCES = ['user', 'project', 'local'];
    const settingSources =
      Array.isArray(ag.settingSources)
        ? ag.settingSources.filter((s: unknown) => typeof s === 'string' && VALID_SETTING_SOURCES.includes(s)) as string[]
        : undefined;
    result.agents = {
      maxTurns: typeof ag.maxTurns === 'number' && ag.maxTurns > 0 ? ag.maxTurns : DEFAULT_CONFIG.agents.maxTurns,
      permissionMode:
        ag.permissionMode === 'bypass' || ag.permissionMode === 'default'
          ? ag.permissionMode
          : DEFAULT_CONFIG.agents.permissionMode,
      settingSources,
    };
  }

  if (data.build && typeof data.build === 'object') {
    const bd = data.build as Record<string, unknown>;
    const postMergeCommands =
      Array.isArray(bd.postMergeCommands) && bd.postMergeCommands.every((c: unknown) => typeof c === 'string')
        ? (bd.postMergeCommands as string[])
        : undefined;
    result.build = {
      parallelism:
        typeof bd.parallelism === 'number' && bd.parallelism > 0
          ? bd.parallelism
          : DEFAULT_CONFIG.build.parallelism,
      worktreeDir: typeof bd.worktreeDir === 'string' ? bd.worktreeDir : undefined,
      postMergeCommands,
      maxValidationRetries:
        typeof bd.maxValidationRetries === 'number' && bd.maxValidationRetries >= 0
          ? bd.maxValidationRetries
          : DEFAULT_CONFIG.build.maxValidationRetries,
    };
  }

  if (data.plan && typeof data.plan === 'object') {
    const pl = data.plan as Record<string, unknown>;
    result.plan = {
      outputDir: typeof pl.outputDir === 'string' ? pl.outputDir : DEFAULT_CONFIG.plan.outputDir,
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
      enabled: typeof pg.enabled === 'boolean' ? pg.enabled : DEFAULT_CONFIG.plugins.enabled,
      include,
      exclude,
      paths,
    };
  }

  return result;
}

/**
 * Load eforge.yaml config from the given directory (searching upward).
 * Returns DEFAULT_CONFIG when no eforge.yaml exists.
 * Logs a warning and returns defaults on malformed YAML.
 */
export async function loadConfig(cwd?: string): Promise<EforgeConfig> {
  const startDir = cwd ?? process.cwd();
  const configPath = await findConfigFile(startDir);

  if (!configPath) {
    return resolveConfig({});
  }

  try {
    const raw = await readFile(configPath, 'utf-8');
    const data = parseYaml(raw);

    if (!data || typeof data !== 'object') {
      return resolveConfig({});
    }

    const fileConfig = parseRawConfig(data as Record<string, unknown>);
    return resolveConfig(fileConfig);
  } catch {
    return resolveConfig({});
  }
}
