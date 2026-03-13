import { readFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { cpus } from 'node:os';
import { parse as parseYaml } from 'yaml';

export interface ForgeConfig {
  langfuse: { enabled: boolean; publicKey?: string; secretKey?: string; host: string };
  agents: { maxTurns: number; permissionMode: 'bypass' | 'default' };
  build: { parallelism: number; worktreeDir?: string };
  plan: { outputDir: string };
}

export const DEFAULT_CONFIG: ForgeConfig = Object.freeze({
  langfuse: Object.freeze({ enabled: false, host: 'https://cloud.langfuse.com' }),
  agents: Object.freeze({ maxTurns: 30, permissionMode: 'bypass' as const }),
  build: Object.freeze({ parallelism: cpus().length, worktreeDir: undefined }),
  plan: Object.freeze({ outputDir: 'plans' }),
});

/**
 * Walk up the directory tree looking for forge.yaml.
 * Returns the absolute path if found, null otherwise.
 */
export async function findConfigFile(startDir: string): Promise<string | null> {
  let dir = resolve(startDir);

  while (true) {
    const candidate = resolve(dir, 'forge.yaml');
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
  fileConfig: Partial<ForgeConfig>,
  env: Record<string, string | undefined> = process.env,
): ForgeConfig {
  const langfusePublicKey = env.LANGFUSE_PUBLIC_KEY ?? fileConfig.langfuse?.publicKey;
  const langfuseSecretKey = env.LANGFUSE_SECRET_KEY ?? fileConfig.langfuse?.secretKey;
  const langfuseHost = env.LANGFUSE_HOST ?? fileConfig.langfuse?.host ?? DEFAULT_CONFIG.langfuse.host;
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
    }),
    build: Object.freeze({
      parallelism: fileConfig.build?.parallelism ?? DEFAULT_CONFIG.build.parallelism,
      worktreeDir: fileConfig.build?.worktreeDir ?? DEFAULT_CONFIG.build.worktreeDir,
    }),
    plan: Object.freeze({
      outputDir: fileConfig.plan?.outputDir ?? DEFAULT_CONFIG.plan.outputDir,
    }),
  });
}

/**
 * Parse and validate a raw YAML object into a partial ForgeConfig.
 * Returns only the fields that are present and valid.
 */
function parseRawConfig(data: Record<string, unknown>): Partial<ForgeConfig> {
  const result: Partial<ForgeConfig> = {};

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
    result.agents = {
      maxTurns: typeof ag.maxTurns === 'number' && ag.maxTurns > 0 ? ag.maxTurns : DEFAULT_CONFIG.agents.maxTurns,
      permissionMode:
        ag.permissionMode === 'bypass' || ag.permissionMode === 'default'
          ? ag.permissionMode
          : DEFAULT_CONFIG.agents.permissionMode,
    };
  }

  if (data.build && typeof data.build === 'object') {
    const bd = data.build as Record<string, unknown>;
    result.build = {
      parallelism:
        typeof bd.parallelism === 'number' && bd.parallelism > 0
          ? bd.parallelism
          : DEFAULT_CONFIG.build.parallelism,
      worktreeDir: typeof bd.worktreeDir === 'string' ? bd.worktreeDir : undefined,
    };
  }

  if (data.plan && typeof data.plan === 'object') {
    const pl = data.plan as Record<string, unknown>;
    result.plan = {
      outputDir: typeof pl.outputDir === 'string' ? pl.outputDir : DEFAULT_CONFIG.plan.outputDir,
    };
  }

  return result;
}

/**
 * Load forge.yaml config from the given directory (searching upward).
 * Returns DEFAULT_CONFIG when no forge.yaml exists.
 * Logs a warning and returns defaults on malformed YAML.
 */
export async function loadConfig(cwd?: string): Promise<ForgeConfig> {
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
