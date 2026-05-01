import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  resolveConfig,
  DEFAULT_CONFIG,
  getUserConfigPath,
  mergePartialConfigs,
  loadConfig,
  findConfigFile,
  ConfigMigrationError,
  AGENT_ROLES,
  thinkingConfigSchema,
  effortLevelSchema,
  sdkPassthroughConfigSchema,
  eforgeConfigSchema,
  piConfigSchema,
  piThinkingLevelSchema,
  claudeSdkConfigSchema,
  configYamlSchema,
  sanitizeProfileName,
  parseRawConfigLegacy,
  tierConfigSchema,
} from '@eforge-build/engine/config';
import { pickSdkOptions } from '@eforge-build/engine/harness';
import type { PartialEforgeConfig, HookConfig } from '@eforge-build/engine/config';

describe('resolveConfig', () => {
  it('returns defaults for empty inputs', () => {
    const config = resolveConfig({}, {});
    expect(config.agents.maxTurns).toBe(DEFAULT_CONFIG.agents.maxTurns);
    expect(config.maxConcurrentBuilds).toBe(DEFAULT_CONFIG.maxConcurrentBuilds);
    expect(config.plan).toEqual(DEFAULT_CONFIG.plan);
    expect(config.langfuse.enabled).toBe(false);
  });

  it('propagates file config values', () => {
    const config = resolveConfig(
      {
        agents: { maxTurns: 40, permissionMode: 'default' },
        plan: { outputDir: 'custom-plans' },
      },
      {},
    );
    expect(config.agents.maxTurns).toBe(40);
    expect(config.agents.permissionMode).toBe('default');
    expect(config.plan.outputDir).toBe('custom-plans');
  });

  it('propagates agents.promptDir', () => {
    const config = resolveConfig(
      { agents: { promptDir: 'eforge/prompts' } },
      {},
    );
    expect(config.agents.promptDir).toBe('eforge/prompts');
  });

  it('env overrides file for langfuse keys', () => {
    const config = resolveConfig(
      { langfuse: { enabled: false, publicKey: 'file-pk', secretKey: 'file-sk', host: 'https://file.host' } },
      { LANGFUSE_PUBLIC_KEY: 'env-pk', LANGFUSE_SECRET_KEY: 'env-sk' },
    );
    expect(config.langfuse.publicKey).toBe('env-pk');
    expect(config.langfuse.secretKey).toBe('env-sk');
    expect(config.langfuse.enabled).toBe(true);
  });

  it('hooks defaults to empty array when not set', () => {
    const config = resolveConfig({}, {});
    expect(config.hooks).toEqual([]);
  });

  it('postMergeCommands parsed from file config', () => {
    const config = resolveConfig(
      { build: { postMergeCommands: ['pnpm test'] } },
      {},
    );
    expect(config.build.postMergeCommands).toEqual(['pnpm test']);
  });

  it('result is frozen', () => {
    const config = resolveConfig({}, {});
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.agents)).toBe(true);
  });
});

describe('getUserConfigPath', () => {
  it('returns ~/.config/eforge/config.yaml by default', () => {
    const path = getUserConfigPath({});
    expect(path).toBe(resolve(homedir(), '.config', 'eforge', 'config.yaml'));
  });

  it('respects XDG_CONFIG_HOME override', () => {
    const path = getUserConfigPath({ XDG_CONFIG_HOME: '/tmp/xdg-config' });
    expect(path).toBe(resolve('/tmp/xdg-config', 'eforge', 'config.yaml'));
  });
});

describe('mergePartialConfigs', () => {
  it('empty + empty → empty', () => {
    const merged = mergePartialConfigs({}, {});
    expect(merged).toEqual({});
  });

  it('project fields override global scalars', () => {
    const global: PartialEforgeConfig = { agents: { maxTurns: 50, permissionMode: 'bypass' } };
    const project: PartialEforgeConfig = { agents: { maxTurns: 10 } };
    const merged = mergePartialConfigs(global, project);
    expect(merged.agents?.maxTurns).toBe(10);
    expect(merged.agents?.permissionMode).toBe('bypass');
  });

  it('hooks concatenate (global first, then project)', () => {
    const globalHook: HookConfig = { event: '*', command: 'global.sh', timeout: 5000 };
    const projectHook: HookConfig = { event: 'build:*', command: 'project.sh', timeout: 3000 };
    const merged = mergePartialConfigs({ hooks: [globalHook] }, { hooks: [projectHook] });
    expect(merged.hooks).toEqual([globalHook, projectHook]);
  });

  it('agents.tiers shallow-merge per tier', () => {
    const global: PartialEforgeConfig = {
      agents: {
        tiers: {
          planning: { harness: 'claude-sdk' as const, model: 'claude-opus-4-7', effort: 'high' as const },
        },
      },
    };
    const project: PartialEforgeConfig = {
      agents: {
        tiers: {
          implementation: { harness: 'claude-sdk' as const, model: 'claude-sonnet-4-6', effort: 'medium' as const },
        },
      },
    };
    const merged = mergePartialConfigs(global, project);
    expect(merged.agents?.tiers?.planning?.model).toBe('claude-opus-4-7');
    expect(merged.agents?.tiers?.implementation?.model).toBe('claude-sonnet-4-6');
  });

  it('agents.roles deep-merge: per-role shallow merge', () => {
    const global: PartialEforgeConfig = {
      agents: {
        roles: {
          builder: { effort: 'high' },
          reviewer: { effort: 'low' },
        },
      },
    };
    const project: PartialEforgeConfig = {
      agents: {
        roles: {
          builder: { maxTurns: 100 },
        },
      },
    };
    const merged = mergePartialConfigs(global, project);
    expect(merged.agents?.roles?.builder?.effort).toBe('high');
    expect(merged.agents?.roles?.builder?.maxTurns).toBe(100);
    expect(merged.agents?.roles?.reviewer?.effort).toBe('low');
  });
});

describe('parseRawConfig strict validation', () => {
  it('staleness-assessor is recognized as a valid agent role', () => {
    expect(AGENT_ROLES).toContain('staleness-assessor');
  });

  it('merge-conflict-resolver is recognized as a valid agent role', () => {
    expect(AGENT_ROLES).toContain('merge-conflict-resolver');
  });
});

describe('eforgeConfigSchema', () => {
  it('accepts a valid config with tier recipes', () => {
    const result = eforgeConfigSchema.safeParse({
      agents: {
        tiers: {
          planning: { harness: 'claude-sdk', model: 'claude-opus-4-7', effort: 'high' },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects monitor.retentionCount < 1', () => {
    const result = eforgeConfigSchema.safeParse({ monitor: { retentionCount: 0 } });
    expect(result.success).toBe(false);
  });
});

describe('findConfigFile', () => {
  it('returns null when only legacy eforge.yaml exists', async () => {
    const { writeFile, mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const tmpDir = await mkdtemp(join(tmpdir(), 'eforge-config-find-'));
    await writeFile(join(tmpDir, 'eforge.yaml'), 'agents:\n  maxTurns: 10\n', 'utf-8');

    try {
      const result = await findConfigFile(tmpDir);
      expect(result).toBeNull();
    } finally {
      await rm(tmpDir, { recursive: true });
    }
  });
});

describe('loadConfig legacy eforge.yaml detection', () => {
  it('throws ConfigMigrationError when only legacy eforge.yaml exists', async () => {
    const { writeFile, mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const tmpDir = await mkdtemp(join(tmpdir(), 'eforge-legacy-error-'));
    await writeFile(join(tmpDir, 'eforge.yaml'), 'agents:\n  maxTurns: 10\n', 'utf-8');

    try {
      await expect(loadConfig(tmpDir)).rejects.toThrow(ConfigMigrationError);
    } finally {
      await rm(tmpDir, { recursive: true });
    }
  });

  it('loads eforge/config.yaml successfully when present', async () => {
    const { writeFile, mkdir, mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const tmpDir = await mkdtemp(join(tmpdir(), 'eforge-no-legacy-'));
    await mkdir(join(tmpDir, 'eforge'), { recursive: true });
    await writeFile(join(tmpDir, 'eforge', 'config.yaml'), 'agents:\n  maxTurns: 10\n', 'utf-8');

    try {
      const { config } = await loadConfig(tmpDir);
      expect(config.agents.maxTurns).toBe(10);
    } finally {
      await rm(tmpDir, { recursive: true });
    }
  });
});

describe('thinkingConfigSchema', () => {
  it('accepts adaptive type', () => {
    expect(thinkingConfigSchema.safeParse({ type: 'adaptive' }).success).toBe(true);
  });

  it('rejects invalid type', () => {
    expect(thinkingConfigSchema.safeParse({ type: 'invalid' }).success).toBe(false);
  });
});

describe('effortLevelSchema', () => {
  it('accepts low/medium/high/xhigh/max', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(effortLevelSchema.safeParse(level).success).toBe(true);
    }
  });

  it('rejects extreme', () => {
    expect(effortLevelSchema.safeParse('extreme').success).toBe(false);
  });
});

describe('roles schema', () => {
  it('accepts valid roles', () => {
    const config = resolveConfig({
      agents: {
        roles: {
          builder: { effort: 'high' },
        },
      },
    });
    expect(config.agents.roles?.builder?.effort).toBe('high');
  });

  it('rejects invalid role names via schema', () => {
    const result = eforgeConfigSchema.safeParse({
      agents: {
        roles: {
          'not-a-role': { effort: 'high' },
        },
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('pickSdkOptions', () => {
  it('strips undefined values', () => {
    const result = pickSdkOptions({ model: { id: 'x' }, thinking: undefined, effort: 'low' });
    expect(result).toEqual({ model: { id: 'x' }, effort: 'low' });
  });

  it('strips promptAppend from SDK options', () => {
    const result = pickSdkOptions({ effort: 'high', promptAppend: '## Extra' });
    expect(result).toEqual({ effort: 'high' });
  });
});

describe('sdkPassthroughConfigSchema', () => {
  it('accepts valid config with all fields', () => {
    const result = sdkPassthroughConfigSchema.safeParse({
      model: { id: 'x' },
      thinking: { type: 'enabled', budgetTokens: 5000 },
      effort: 'high',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid effort value', () => {
    expect(sdkPassthroughConfigSchema.safeParse({ effort: 'extreme' }).success).toBe(false);
  });
});

describe('configYamlSchema rejects legacy fields', () => {
  it('rejects backend:', () => {
    const result = configYamlSchema.safeParse({ backend: 'claude-sdk' });
    expect(result.success).toBe(false);
  });

  it('rejects pi:', () => {
    const result = configYamlSchema.safeParse({ pi: { thinkingLevel: 'high' } });
    expect(result.success).toBe(false);
  });

  it('rejects claudeSdk:', () => {
    const result = configYamlSchema.safeParse({ claudeSdk: { disableSubagents: false } });
    expect(result.success).toBe(false);
  });

  it('rejects agentRuntimes:', () => {
    const result = configYamlSchema.safeParse({ agentRuntimes: { main: { harness: 'claude-sdk' } } });
    expect(result.success).toBe(false);
  });

  it('accepts agents.tiers config', () => {
    const result = configYamlSchema.safeParse({
      agents: {
        tiers: {
          planning: { harness: 'claude-sdk', model: 'claude-opus-4-7', effort: 'high' },
        },
      },
    });
    expect(result.success).toBe(true);
  });
});

describe('claudeSdkConfigSchema', () => {
  it('accepts { disableSubagents: true }', () => {
    expect(claudeSdkConfigSchema.safeParse({ disableSubagents: true }).success).toBe(true);
  });

  it('accepts empty object', () => {
    expect(claudeSdkConfigSchema.safeParse({}).success).toBe(true);
  });

  it('rejects non-boolean disableSubagents', () => {
    expect(claudeSdkConfigSchema.safeParse({ disableSubagents: 'yes' }).success).toBe(false);
  });
});

describe('piConfigSchema', () => {
  it('accepts full pi config', () => {
    const result = piConfigSchema.safeParse({
      apiKey: 'sk-test',
      thinkingLevel: 'high',
      extensions: { autoDiscover: true },
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid thinkingLevel', () => {
    expect(piConfigSchema.safeParse({ thinkingLevel: 'invalid' }).success).toBe(false);
  });
});

describe('piThinkingLevelSchema', () => {
  it('accepts off/low/medium/high/xhigh', () => {
    for (const level of ['off', 'low', 'medium', 'high', 'xhigh']) {
      expect(piThinkingLevelSchema.safeParse(level).success).toBe(true);
    }
  });

  it('rejects max', () => {
    expect(piThinkingLevelSchema.safeParse('max').success).toBe(false);
  });
});

describe('tierConfigSchema accepts tier recipes', () => {
  it('accepts a claude-sdk tier', () => {
    const result = tierConfigSchema.safeParse({
      harness: 'claude-sdk',
      model: 'claude-opus-4-7',
      effort: 'high',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a pi tier with provider', () => {
    const result = tierConfigSchema.safeParse({
      harness: 'pi',
      pi: { provider: 'openrouter' },
      model: 'qwen-coder',
      effort: 'medium',
    });
    expect(result.success).toBe(true);
  });
});

describe('DEFAULT_CONFIG', () => {
  it('has tier recipes for every tier', () => {
    expect(DEFAULT_CONFIG.agents.tiers?.planning).toBeDefined();
    expect(DEFAULT_CONFIG.agents.tiers?.implementation).toBeDefined();
    expect(DEFAULT_CONFIG.agents.tiers?.review).toBeDefined();
    expect(DEFAULT_CONFIG.agents.tiers?.evaluation).toBeDefined();
  });

  it('planning tier defaults to claude-opus-4-7 + high effort', () => {
    const p = DEFAULT_CONFIG.agents.tiers?.planning;
    expect(p?.harness).toBe('claude-sdk');
    expect(p?.model).toBe('claude-opus-4-7');
    expect(p?.effort).toBe('high');
  });

  it('implementation tier defaults to claude-sonnet-4-6 + medium effort', () => {
    const i = DEFAULT_CONFIG.agents.tiers?.implementation;
    expect(i?.harness).toBe('claude-sdk');
    expect(i?.model).toBe('claude-sonnet-4-6');
    expect(i?.effort).toBe('medium');
  });
});

describe('monitor config', () => {
  it('DEFAULT_CONFIG.monitor.retentionCount equals 20', () => {
    expect(DEFAULT_CONFIG.monitor.retentionCount).toBe(20);
  });

  it('resolveConfig preserves monitor.retentionCount', () => {
    const config = resolveConfig({ monitor: { retentionCount: 50 } }, {});
    expect(config.monitor.retentionCount).toBe(50);
  });
});

describe('mergePartialConfigs chained-twice', () => {
  it('local wins over project wins over user for scalar at leaf', () => {
    const user: PartialEforgeConfig = { agents: { maxTurns: 10 } };
    const project: PartialEforgeConfig = { agents: { maxTurns: 20 } };
    const local: PartialEforgeConfig = { agents: { maxTurns: 99 } };
    const merged = mergePartialConfigs(mergePartialConfigs(user, project), local);
    expect(merged.agents?.maxTurns).toBe(99);
  });

  it('array replacement at leaf', () => {
    const user: PartialEforgeConfig = { build: { postMergeCommands: ['user-cmd'] } };
    const project: PartialEforgeConfig = { build: { postMergeCommands: ['project-cmd'] } };
    const local: PartialEforgeConfig = { build: { postMergeCommands: ['local-cmd'] } };
    const merged = mergePartialConfigs(mergePartialConfigs(user, project), local);
    expect(merged.build?.postMergeCommands).toEqual(['local-cmd']);
  });
});

describe('sanitizeProfileName', () => {
  it('claude-sdk + claude-opus-4.7 → claude-sdk-opus-4-7', () => {
    expect(sanitizeProfileName('claude-sdk', undefined, 'claude-opus-4.7')).toBe('claude-sdk-opus-4-7');
  });
});

describe('parseRawConfigLegacy', () => {
  it('extracts backend and agents.models into profile', () => {
    const data = {
      backend: 'claude-sdk' as const,
      agents: { models: { max: { id: 'claude-opus-4.7' } } },
      build: { postMergeCommands: ['pnpm test'] },
    };
    const { profile, remaining } = parseRawConfigLegacy(data);
    expect(profile.backend).toBe('claude-sdk');
    expect(remaining).toEqual({ build: { postMergeCommands: ['pnpm test'] } });
  });
});
