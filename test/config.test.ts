import { describe, it, expect, vi } from 'vitest';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { resolveConfig, DEFAULT_CONFIG, getUserConfigPath, mergePartialConfigs, loadConfig, findConfigFile, ConfigMigrationError, AGENT_ROLES, thinkingConfigSchema, effortLevelSchema, sdkPassthroughConfigSchema, eforgeConfigSchema, backendSchema, piConfigSchema, piThinkingLevelSchema, claudeSdkConfigSchema, modelClassSchema, MODEL_CLASSES, configYamlSchema, sanitizeProfileName, parseRawConfigLegacy } from '@eforge-build/engine/config';
import { pickSdkOptions } from '@eforge-build/engine/backend';
import type { PartialEforgeConfig, HookConfig } from '@eforge-build/engine/config';

describe('resolveConfig', () => {
  it('returns defaults for empty inputs', () => {
    const config = resolveConfig({}, {});
    expect(config.agents).toEqual(DEFAULT_CONFIG.agents);
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

  it('defaults agents.promptDir to undefined', () => {
    const config = resolveConfig({}, {});
    expect(config.agents.promptDir).toBeUndefined();
  });

  it('propagates per-role promptAppend through roles config', () => {
    const config = resolveConfig(
      {
        agents: {
          roles: {
            reviewer: { promptAppend: '## Extra\nCheck for XSS.' },
          },
        },
      },
      {},
    );
    expect(config.agents.roles?.reviewer?.promptAppend).toBe('## Extra\nCheck for XSS.');
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

  it('enables langfuse only when both keys present', () => {
    const config = resolveConfig(
      {},
      { LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk' },
    );
    expect(config.langfuse.enabled).toBe(true);
  });

  it('disables langfuse with only one key', () => {
    const config = resolveConfig({}, { LANGFUSE_PUBLIC_KEY: 'pk' });
    expect(config.langfuse.enabled).toBe(false);

    const config2 = resolveConfig({}, { LANGFUSE_SECRET_KEY: 'sk' });
    expect(config2.langfuse.enabled).toBe(false);
  });

  it('takes LANGFUSE_BASE_URL from env', () => {
    const config = resolveConfig(
      {},
      { LANGFUSE_BASE_URL: 'https://us.cloud.langfuse.com' },
    );
    expect(config.langfuse.host).toBe('https://us.cloud.langfuse.com');
  });

  it('postMergeCommands parsed from file config', () => {
    const config = resolveConfig(
      {
        build: {
          postMergeCommands: ['pnpm run type-check', 'pnpm test'],
        },
      },
      {},
    );
    expect(config.build.postMergeCommands).toEqual(['pnpm run type-check', 'pnpm test']);
  });

  it('postMergeCommands defaults to undefined when not set', () => {
    const config = resolveConfig({}, {});
    expect(config.build.postMergeCommands).toBeUndefined();
  });

  it('result is frozen', () => {
    const config = resolveConfig({}, {});
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.langfuse)).toBe(true);
    expect(Object.isFrozen(config.agents)).toBe(true);
    expect(Object.isFrozen(config.build)).toBe(true);
    expect(Object.isFrozen(config.plan)).toBe(true);
  });

  it('hooks defaults to empty array when not set', () => {
    const config = resolveConfig({}, {});
    expect(config.hooks).toEqual([]);
  });

  it('hooks propagated from file config', () => {
    const hooks = [
      { event: 'build:*', command: 'echo hello', timeout: 5000 },
      { event: '*', command: './notify.sh', timeout: 10000 },
    ];
    const config = resolveConfig({ hooks }, {});
    expect(config.hooks).toEqual(hooks);
  });

  it('hooks is frozen in resolved config', () => {
    const config = resolveConfig({}, {});
    expect(Object.isFrozen(config.hooks)).toBe(true);
  });

  it('bare defaults to false when no ANTHROPIC_API_KEY', () => {
    const config = resolveConfig({}, {});
    expect(config.agents.bare).toBe(false);
  });

  it('bare auto-enables when ANTHROPIC_API_KEY is set', () => {
    const config = resolveConfig({}, { ANTHROPIC_API_KEY: 'test-key' });
    expect(config.agents.bare).toBe(true);
  });

  it('explicit bare: false overrides ANTHROPIC_API_KEY env', () => {
    const config = resolveConfig(
      { agents: { bare: false } },
      { ANTHROPIC_API_KEY: 'test-key' },
    );
    expect(config.agents.bare).toBe(false);
  });

  it('explicit bare: true forces bare without ANTHROPIC_API_KEY', () => {
    const config = resolveConfig(
      { agents: { bare: true } },
      {},
    );
    expect(config.agents.bare).toBe(true);
  });

  it('claudeSdk.disableSubagents defaults to false', () => {
    const config = resolveConfig({}, {});
    expect(config.claudeSdk.disableSubagents).toBe(false);
  });

  it('claudeSdk.disableSubagents propagates from file config', () => {
    const config = resolveConfig({ claudeSdk: { disableSubagents: true } }, {});
    expect(config.claudeSdk.disableSubagents).toBe(true);
  });

  it('claudeSdk section is frozen in resolved config', () => {
    const config = resolveConfig({}, {});
    expect(Object.isFrozen(config.claudeSdk)).toBe(true);
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

  it('global-only fields survive when project is empty', () => {
    const global: PartialEforgeConfig = {
      agents: { maxTurns: 50 },
      plan: { outputDir: 'global-plans' },
    };
    const merged = mergePartialConfigs(global, {});
    expect(merged.agents?.maxTurns).toBe(50);
    expect(merged.plan?.outputDir).toBe('global-plans');
  });

  it('project fields override global scalars', () => {
    const global: PartialEforgeConfig = {
      agents: { maxTurns: 50, permissionMode: 'bypass' },
    };
    const project: PartialEforgeConfig = {
      agents: { maxTurns: 10 },
    };
    const merged = mergePartialConfigs(global, project);
    expect(merged.agents?.maxTurns).toBe(10);
    // project didn't set permissionMode, so global's survives via shallow merge
    expect(merged.agents?.permissionMode).toBe('bypass');
  });

  it('object sections merge shallowly (global host + project publicKey)', () => {
    const global: PartialEforgeConfig = {
      langfuse: { enabled: false, host: 'https://global.host' },
    };
    const project: PartialEforgeConfig = {
      langfuse: { enabled: false, publicKey: 'proj-pk' },
    };
    const merged = mergePartialConfigs(global, project);
    expect(merged.langfuse?.host).toBe('https://global.host');
    expect(merged.langfuse?.publicKey).toBe('proj-pk');
  });

  it('hooks concatenate (global first, then project)', () => {
    const globalHook: HookConfig = { event: '*', command: 'global.sh', timeout: 5000 };
    const projectHook: HookConfig = { event: 'build:*', command: 'project.sh', timeout: 3000 };
    const global: PartialEforgeConfig = { hooks: [globalHook] };
    const project: PartialEforgeConfig = { hooks: [projectHook] };
    const merged = mergePartialConfigs(global, project);
    expect(merged.hooks).toEqual([globalHook, projectHook]);
  });

  it('hooks from global only when project has none', () => {
    const globalHook: HookConfig = { event: '*', command: 'global.sh', timeout: 5000 };
    const merged = mergePartialConfigs({ hooks: [globalHook] }, {});
    expect(merged.hooks).toEqual([globalHook]);
  });

  it('hooks from project only when global has none', () => {
    const projectHook: HookConfig = { event: 'build:*', command: 'project.sh', timeout: 3000 };
    const merged = mergePartialConfigs({}, { hooks: [projectHook] });
    expect(merged.hooks).toEqual([projectHook]);
  });

  it('array fields inside objects replaced by project (postMergeCommands)', () => {
    const global: PartialEforgeConfig = {
      build: { postMergeCommands: ['global-cmd'] },
    };
    const project: PartialEforgeConfig = {
      build: { postMergeCommands: ['project-cmd'] },
    };
    const merged = mergePartialConfigs(global, project);
    expect(merged.build?.postMergeCommands).toEqual(['project-cmd']);
  });

  it('array fields inside objects replaced by project (plugins.include)', () => {
    const global: PartialEforgeConfig = {
      plugins: { enabled: true, include: ['a', 'b'] },
    };
    const project: PartialEforgeConfig = {
      plugins: { enabled: true, include: ['c'] },
    };
    const merged = mergePartialConfigs(global, project);
    expect(merged.plugins?.include).toEqual(['c']);
  });

  it('build sections merge shallowly', () => {
    const global: PartialEforgeConfig = {
      build: { cleanupPlanFiles: true },
    };
    const project: PartialEforgeConfig = {
      build: { maxValidationRetries: 5 },
    };
    const merged = mergePartialConfigs(global, project);
    expect(merged.build?.cleanupPlanFiles).toBe(true);
    expect(merged.build?.maxValidationRetries).toBe(5);
  });

  it('maxConcurrentBuilds merges as scalar (project wins)', () => {
    const global: PartialEforgeConfig = { maxConcurrentBuilds: 3 };
    const project: PartialEforgeConfig = { maxConcurrentBuilds: 5 };
    const merged = mergePartialConfigs(global, project);
    expect(merged.maxConcurrentBuilds).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// parseRawConfig validation warnings (zod-backed)
// ---------------------------------------------------------------------------

describe('parseRawConfig validation warnings', () => {
  // parseRawConfig is not exported, so we test it indirectly via loadConfig
  // which calls parseRawConfig on the YAML data. We use resolveConfig with
  // a PartialEforgeConfig that simulates what parseRawConfig would produce,
  // plus direct stderr spy tests to verify warning output.

  it('loadConfig with invalid maxTurns returns a warning containing "maxTurns"', async () => {
    // We test parseRawConfig indirectly via loadConfig, which calls it on the
    // YAML data. Warnings are returned in the { warnings } field — not logged.
    const { writeFile, mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const tmpDir = await mkdtemp(join(tmpdir(), 'eforge-config-warn-'));
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(tmpDir, 'eforge'), { recursive: true });
    const configPath = join(tmpDir, 'eforge', 'config.yaml');
    await writeFile(configPath, 'agents:\n  maxTurns: "not-a-number"\n', 'utf-8');

    try {
      const { warnings } = await loadConfig(tmpDir);
      const warningText = warnings.join('\n');
      expect(warningText).toContain('maxTurns');
    } finally {
      await rm(tmpDir, { recursive: true });
    }
  });

  it('loadConfig with invalid permissionMode returns a warning containing "permissionMode"', async () => {
    const { writeFile, mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const tmpDir = await mkdtemp(join(tmpdir(), 'eforge-config-warn-'));
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(tmpDir, 'eforge'), { recursive: true });
    const configPath = join(tmpDir, 'eforge', 'config.yaml');
    await writeFile(configPath, 'agents:\n  permissionMode: "skip"\n', 'utf-8');

    try {
      const { warnings } = await loadConfig(tmpDir);
      const warningText = warnings.join('\n');
      expect(warningText).toContain('permissionMode');
    } finally {
      await rm(tmpDir, { recursive: true });
    }
  });

  it('staleness-assessor is recognized as a valid agent role', () => {
    expect(AGENT_ROLES).toContain('staleness-assessor');
  });

  it('merge-conflict-resolver is recognized as a valid agent role', () => {
    expect(AGENT_ROLES).toContain('merge-conflict-resolver');
  });
});

// ---------------------------------------------------------------------------
// Backend-conditional model ref validation
// ---------------------------------------------------------------------------

describe('eforgeConfigSchema backend-conditional model ref validation', () => {
  it('rejects string model values in agents.model', () => {
    const result = eforgeConfigSchema.safeParse({
      backend: 'claude-sdk',
      agents: { model: 'claude-opus-4-6' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects string model values in agents.models.*', () => {
    const result = eforgeConfigSchema.safeParse({
      backend: 'claude-sdk',
      agents: { models: { max: 'claude-opus-4-6' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects string model values in agents.roles.*.model', () => {
    const result = eforgeConfigSchema.safeParse({
      backend: 'claude-sdk',
      agents: { roles: { builder: { model: 'claude-opus-4-6' } } },
    });
    expect(result.success).toBe(false);
  });

  it('accepts claude-sdk config where model refs are { id: "y" }', () => {
    const result = eforgeConfigSchema.safeParse({
      backend: 'claude-sdk',
      agents: {
        model: { id: 'claude-opus-4-6' },
        models: { max: { id: 'claude-opus-4-6' } },
        roles: { builder: { model: { id: 'claude-opus-4-6' } } },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects claude-sdk config where model ref has provider', () => {
    const result = eforgeConfigSchema.safeParse({
      backend: 'claude-sdk',
      agents: { model: { provider: 'anthropic', id: 'claude-opus-4-6' } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map(i => i.message).join('\n');
      expect(messages).toContain('Claude SDK backend does not accept "provider"');
    }
  });

  it('accepts pi config where model refs are { provider: "x", id: "y" }', () => {
    const result = eforgeConfigSchema.safeParse({
      backend: 'pi',
      agents: {
        model: { provider: 'openrouter', id: 'gpt-5.4' },
        models: { max: { provider: 'openrouter', id: 'gpt-5.4' } },
        roles: { builder: { model: { provider: 'openrouter', id: 'gpt-5.4' } } },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects pi config where model ref is { id: "x" } (missing provider)', () => {
    const result = eforgeConfigSchema.safeParse({
      backend: 'pi',
      agents: { model: { id: 'gpt-5.4' } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map(i => i.message).join('\n');
      expect(messages).toContain('Pi backend requires "provider"');
    }
  });

  it('rejects pi config where agents.models.* model ref is missing provider', () => {
    const result = eforgeConfigSchema.safeParse({
      backend: 'pi',
      agents: { models: { max: { id: 'gpt-5.4' } } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects pi config where agents.roles.*.model is missing provider', () => {
    const result = eforgeConfigSchema.safeParse({
      backend: 'pi',
      agents: { roles: { builder: { model: { id: 'gpt-5.4' } } } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects claude-sdk config where agents.models.* has provider', () => {
    const result = eforgeConfigSchema.safeParse({
      backend: 'claude-sdk',
      agents: { models: { max: { provider: 'anthropic', id: 'claude-opus-4-6' } } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects claude-sdk config where agents.roles.*.model has provider', () => {
    const result = eforgeConfigSchema.safeParse({
      backend: 'claude-sdk',
      agents: { roles: { builder: { model: { provider: 'anthropic', id: 'claude-opus-4-6' } } } },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// findConfigFile
// ---------------------------------------------------------------------------

describe('findConfigFile', () => {
  it('returns null when only legacy eforge.yaml exists (no eforge/config.yaml)', async () => {
    const { writeFile, mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const tmpDir = await mkdtemp(join(tmpdir(), 'eforge-config-find-'));
    await writeFile(join(tmpDir, 'eforge.yaml'), 'agents:\n  maxTurns: 10\n', 'utf-8');

    try {
      const result = await findConfigFile(tmpDir);
      // findConfigFile only searches for eforge/config.yaml — legacy eforge.yaml
      // is detected by loadConfig which surfaces a warning in its return value.
      expect(result).toBeNull();
    } finally {
      await rm(tmpDir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// loadConfig legacy eforge.yaml detection
// ---------------------------------------------------------------------------

describe('loadConfig legacy eforge.yaml detection', () => {
  it('throws ConfigMigrationError with the mv instruction when only legacy eforge.yaml exists', async () => {
    const { writeFile, mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const tmpDir = await mkdtemp(join(tmpdir(), 'eforge-legacy-error-'));
    await writeFile(join(tmpDir, 'eforge.yaml'), 'agents:\n  maxTurns: 10\n', 'utf-8');

    try {
      await expect(loadConfig(tmpDir)).rejects.toThrow(ConfigMigrationError);
      await expect(loadConfig(tmpDir)).rejects.toThrow('mv eforge.yaml eforge/config.yaml');
    } finally {
      await rm(tmpDir, { recursive: true });
    }
  });

  it('loads eforge/config.yaml successfully when present (no legacy detection needed)', async () => {
    const { writeFile, mkdir, mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const tmpDir = await mkdtemp(join(tmpdir(), 'eforge-no-legacy-'));
    await mkdir(join(tmpDir, 'eforge'), { recursive: true });
    await writeFile(join(tmpDir, 'eforge', 'config.yaml'), 'agents:\n  maxTurns: 10\n', 'utf-8');

    try {
      const { config, warnings } = await loadConfig(tmpDir);
      // Uses the eforge/config.yaml
      expect(config.agents.maxTurns).toBe(10);
      // No legacy warning because eforge/config.yaml was found
      const warningText = warnings.join('\n');
      expect(warningText).not.toContain('legacy config');
    } finally {
      await rm(tmpDir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// prdQueue config
// ---------------------------------------------------------------------------

describe('prdQueue config', () => {
  it('parses prdQueue section from config', () => {
    const config = resolveConfig(
      {
        prdQueue: {
          dir: 'custom/queue',
        },
      },
      {},
    );
    expect(config.prdQueue.dir).toBe('custom/queue');
  });

  it('applies defaults when prdQueue is omitted', () => {
    const config = resolveConfig({}, {});
    expect(config.prdQueue.dir).toBe(DEFAULT_CONFIG.prdQueue.dir);
  });

  it('merges prdQueue per-field (project overrides global)', () => {
    const global: PartialEforgeConfig = {
      prdQueue: {
        dir: 'global/queue',
      },
    };
    const project: PartialEforgeConfig = {
      prdQueue: {
        autoBuild: false,
      },
    };
    const merged = mergePartialConfigs(global, project);
    expect(merged.prdQueue?.autoBuild).toBe(false);
    // Global dir survives since project didn't override it
    expect(merged.prdQueue?.dir).toBe('global/queue');
  });
});

describe('maxConcurrentBuilds config', () => {
  it('defaults to 2', () => {
    const config = resolveConfig({}, {});
    expect(config.maxConcurrentBuilds).toBe(2);
  });

  it('accepts override from file config', () => {
    const config = resolveConfig({ maxConcurrentBuilds: 4 }, {});
    expect(config.maxConcurrentBuilds).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// SDK Passthrough Schemas
// ---------------------------------------------------------------------------

describe('thinkingConfigSchema', () => {
  it('accepts adaptive type', () => {
    const result = thinkingConfigSchema.safeParse({ type: 'adaptive' });
    expect(result.success).toBe(true);
  });

  it('accepts enabled type with budgetTokens', () => {
    const result = thinkingConfigSchema.safeParse({ type: 'enabled', budgetTokens: 5000 });
    expect(result.success).toBe(true);
  });

  it('accepts enabled type without budgetTokens', () => {
    const result = thinkingConfigSchema.safeParse({ type: 'enabled' });
    expect(result.success).toBe(true);
  });

  it('accepts disabled type', () => {
    const result = thinkingConfigSchema.safeParse({ type: 'disabled' });
    expect(result.success).toBe(true);
  });

  it('rejects invalid type', () => {
    const result = thinkingConfigSchema.safeParse({ type: 'invalid' });
    expect(result.success).toBe(false);
  });
});

describe('effortLevelSchema', () => {
  it('accepts low', () => {
    expect(effortLevelSchema.safeParse('low').success).toBe(true);
  });

  it('accepts medium', () => {
    expect(effortLevelSchema.safeParse('medium').success).toBe(true);
  });

  it('accepts high', () => {
    expect(effortLevelSchema.safeParse('high').success).toBe(true);
  });

  it('accepts xhigh', () => {
    expect(effortLevelSchema.safeParse('xhigh').success).toBe(true);
  });

  it('accepts max', () => {
    expect(effortLevelSchema.safeParse('max').success).toBe(true);
  });

  it('rejects extreme', () => {
    expect(effortLevelSchema.safeParse('extreme').success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// roles schema validation
// ---------------------------------------------------------------------------

describe('roles schema in eforgeConfigSchema', () => {
  it('accepts valid roles', () => {
    const config: PartialEforgeConfig = {
      agents: {
        roles: {
          builder: { effort: 'high' },
          formatter: { model: { id: 'claude-sonnet' }, maxTurns: 10 },
        },
      },
    };
    const resolved = resolveConfig(config, {});
    expect(resolved.agents.roles?.builder).toEqual({ effort: 'high' });
    expect(resolved.agents.roles?.formatter).toEqual({ model: { id: 'claude-sonnet' }, maxTurns: 10 });
  });

  it('rejects invalid role names via schema', async () => {
    const { eforgeConfigSchema } = await import('@eforge-build/engine/config');
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

// ---------------------------------------------------------------------------
// mergePartialConfigs with roles deep-merge
// ---------------------------------------------------------------------------

describe('mergePartialConfigs roles deep-merge', () => {
  it('per-role shallow merge: project role fields override global, global-only fields survive', () => {
    const global: PartialEforgeConfig = {
      agents: {
        roles: {
          builder: { model: { id: 'global-model' }, effort: 'high' },
          reviewer: { effort: 'low' },
        },
      },
    };
    const project: PartialEforgeConfig = {
      agents: {
        roles: {
          builder: { effort: 'low' },
        },
      },
    };
    const merged = mergePartialConfigs(global, project);
    // builder: project effort overrides global, global model survives
    expect(merged.agents?.roles?.builder).toEqual({ model: { id: 'global-model' }, effort: 'low' });
    // reviewer: only in global, survives
    expect(merged.agents?.roles?.reviewer).toEqual({ effort: 'low' });
  });

  it('project-only roles merge with empty global roles', () => {
    const global: PartialEforgeConfig = {
      agents: { maxTurns: 30 },
    };
    const project: PartialEforgeConfig = {
      agents: {
        roles: {
          formatter: { effort: 'low' },
        },
      },
    };
    const merged = mergePartialConfigs(global, project);
    expect(merged.agents?.roles?.formatter).toEqual({ effort: 'low' });
    expect(merged.agents?.maxTurns).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// resolveConfig with global SDK fields
// ---------------------------------------------------------------------------

describe('resolveConfig with global SDK fields', () => {
  it('passes through global model, thinking, effort', () => {
    const config = resolveConfig({
      agents: {
        model: { id: 'claude-opus' },
        thinking: { type: 'adaptive' },
        effort: 'high',
      },
    }, {});
    expect(config.agents.model).toEqual({ id: 'claude-opus' });
    expect(config.agents.thinking).toEqual({ type: 'adaptive' });
    expect(config.agents.effort).toBe('high');
  });

  it('SDK fields default to undefined when not configured', () => {
    const config = resolveConfig({}, {});
    expect(config.agents.model).toBeUndefined();
    expect(config.agents.thinking).toBeUndefined();
    expect(config.agents.effort).toBeUndefined();
    expect(config.agents.roles).toBeUndefined();
  });

  it('passes through roles from config', () => {
    const config = resolveConfig({
      agents: {
        roles: {
          builder: { effort: 'max', maxTurns: 100 },
        },
      },
    }, {});
    expect(config.agents.roles?.builder).toEqual({ effort: 'max', maxTurns: 100 });
  });
});

// ---------------------------------------------------------------------------
// pickSdkOptions
// ---------------------------------------------------------------------------

describe('pickSdkOptions', () => {
  it('strips undefined values from config', () => {
    const result = pickSdkOptions({ model: { id: 'x' }, thinking: undefined, effort: 'low' });
    expect(result).toEqual({ model: { id: 'x' }, effort: 'low' });
    expect('thinking' in result).toBe(false);
  });

  it('returns empty object when all values are undefined', () => {
    const result = pickSdkOptions({});
    expect(result).toEqual({});
  });

  it('passes through all defined fields', () => {
    const result = pickSdkOptions({
      model: { id: 'claude-opus' },
      thinking: { type: 'enabled', budgetTokens: 5000 },
      effort: 'high',
      maxBudgetUsd: 10,
      fallbackModel: 'claude-sonnet',
      allowedTools: ['read', 'write'],
      disallowedTools: ['bash'],
    });
    expect(result).toEqual({
      model: { id: 'claude-opus' },
      thinking: { type: 'enabled', budgetTokens: 5000 },
      effort: 'high',
      maxBudgetUsd: 10,
      fallbackModel: 'claude-sonnet',
      allowedTools: ['read', 'write'],
      disallowedTools: ['bash'],
    });
  });

  it('strips promptAppend from SDK options', () => {
    const result = pickSdkOptions({
      model: { id: 'claude-opus' },
      effort: 'high',
      promptAppend: '## Extra rules\nDo not use any type.',
    });
    expect(result).toEqual({ model: { id: 'claude-opus' }, effort: 'high' });
    expect('promptAppend' in result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sdkPassthroughConfigSchema
// ---------------------------------------------------------------------------

describe('sdkPassthroughConfigSchema', () => {
  it('accepts valid config with all fields', () => {
    const result = sdkPassthroughConfigSchema.safeParse({
      model: { id: 'claude-opus' },
      thinking: { type: 'enabled', budgetTokens: 5000 },
      effort: 'high',
    });
    expect(result.success).toBe(true);
  });

  it('accepts empty object (all fields optional)', () => {
    const result = sdkPassthroughConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('rejects invalid effort value', () => {
    const result = sdkPassthroughConfigSchema.safeParse({ effort: 'extreme' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid thinking type', () => {
    const result = sdkPassthroughConfigSchema.safeParse({ thinking: { type: 'invalid' } });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// backend and pi config
// ---------------------------------------------------------------------------

describe('backendSchema', () => {
  it('accepts claude-sdk', () => {
    expect(backendSchema.safeParse('claude-sdk').success).toBe(true);
  });

  it('accepts pi', () => {
    expect(backendSchema.safeParse('pi').success).toBe(true);
  });

  it('rejects invalid backend', () => {
    expect(backendSchema.safeParse('invalid').success).toBe(false);
  });
});

describe('eforgeConfigSchema backend and pi validation', () => {
  it('accepts { backend: "pi", pi: { provider: "openrouter", model: "anthropic/claude-sonnet-4" } }', () => {
    const result = eforgeConfigSchema.safeParse({
      backend: 'pi',
      pi: { provider: 'openrouter', model: 'anthropic/claude-sonnet-4' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts { backend: "claude-sdk" } without pi section', () => {
    const result = eforgeConfigSchema.safeParse({ backend: 'claude-sdk' });
    expect(result.success).toBe(true);
  });

  it('rejects empty config without backend', () => {
    const result = eforgeConfigSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects { backend: "invalid" }', () => {
    const result = eforgeConfigSchema.safeParse({ backend: 'invalid' });
    expect(result.success).toBe(false);
  });
});

describe('claudeSdkConfigSchema', () => {
  it('accepts { disableSubagents: true }', () => {
    const result = claudeSdkConfigSchema.safeParse({ disableSubagents: true });
    expect(result.success).toBe(true);
  });

  it('accepts empty object (all fields optional)', () => {
    const result = claudeSdkConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('rejects non-boolean disableSubagents', () => {
    const result = claudeSdkConfigSchema.safeParse({ disableSubagents: 'yes' });
    expect(result.success).toBe(false);
  });

  it('eforgeConfigSchema accepts claudeSdk block alongside backend: claude-sdk', () => {
    const result = eforgeConfigSchema.safeParse({
      backend: 'claude-sdk',
      claudeSdk: { disableSubagents: true },
    });
    expect(result.success).toBe(true);
  });
});

describe('mergePartialConfigs claudeSdk', () => {
  it('project claudeSdk wins over global', () => {
    const merged = mergePartialConfigs(
      { claudeSdk: { disableSubagents: false } },
      { claudeSdk: { disableSubagents: true } },
    );
    expect(merged.claudeSdk?.disableSubagents).toBe(true);
  });

  it('preserves global claudeSdk when project does not set it', () => {
    const merged = mergePartialConfigs(
      { claudeSdk: { disableSubagents: true } },
      {},
    );
    expect(merged.claudeSdk?.disableSubagents).toBe(true);
  });

  it('omits claudeSdk when neither side sets it', () => {
    const merged = mergePartialConfigs({}, {});
    expect(merged.claudeSdk).toBeUndefined();
  });
});

describe('piConfigSchema', () => {
  it('accepts full pi config', () => {
    const result = piConfigSchema.safeParse({
      apiKey: 'sk-test',
      thinkingLevel: 'high',
      extensions: { autoDiscover: true, include: ['ext1'], exclude: ['ext2'] },
      compaction: { enabled: true, threshold: 50_000 },
      retry: { maxRetries: 5, backoffMs: 2000 },
    });
    expect(result.success).toBe(true);
  });

  it('accepts empty pi config (all fields optional)', () => {
    const result = piConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('rejects invalid thinkingLevel', () => {
    const result = piConfigSchema.safeParse({ thinkingLevel: 'invalid' });
    expect(result.success).toBe(false);
  });
});

describe('piThinkingLevelSchema', () => {
  it('accepts off', () => {
    expect(piThinkingLevelSchema.safeParse('off').success).toBe(true);
  });

  it('accepts low', () => {
    expect(piThinkingLevelSchema.safeParse('low').success).toBe(true);
  });

  it('accepts medium', () => {
    expect(piThinkingLevelSchema.safeParse('medium').success).toBe(true);
  });

  it('accepts high', () => {
    expect(piThinkingLevelSchema.safeParse('high').success).toBe(true);
  });

  it('accepts xhigh', () => {
    expect(piThinkingLevelSchema.safeParse('xhigh').success).toBe(true);
  });

  it('rejects max (not a valid Pi thinking level)', () => {
    expect(piThinkingLevelSchema.safeParse('max').success).toBe(false);
  });

  it('rejects invalid values', () => {
    expect(piThinkingLevelSchema.safeParse('invalid').success).toBe(false);
  });
});

describe('resolveConfig backend and pi', () => {
  it('backend is undefined when config is empty', () => {
    const config = resolveConfig({}, {});
    expect(config.backend).toBeUndefined();
  });

  it('defaults pi section with sensible defaults', () => {
    const config = resolveConfig({}, {});
    expect(config.pi).toBeDefined();
    expect(config.pi.thinkingLevel).toBe('medium');
    expect(config.pi.extensions.autoDiscover).toBe(true);
    expect(config.pi.compaction.enabled).toBe(true);
  });

  it('preserves pi values from file config', () => {
    const config = resolveConfig(
      {
        backend: 'pi',
        pi: {
          apiKey: 'sk-test',
        },
      },
      {},
    );
    expect(config.backend).toBe('pi');
    expect(config.pi.apiKey).toBe('sk-test');
  });

  it('merges pi section with defaults for unset fields', () => {
    const config = resolveConfig(
      {
        backend: 'pi',
        pi: { apiKey: 'sk-test' },
      },
      {},
    );
    // Explicitly set values preserved
    expect(config.pi.apiKey).toBe('sk-test');
    // Defaults fill in unset values
    expect(config.pi.thinkingLevel).toBe('medium');
    expect(config.pi.extensions.autoDiscover).toBe(true);
    expect(config.pi.compaction.enabled).toBe(true);
    expect(config.pi.retry.maxRetries).toBe(3);
  });

  it('pi section is frozen in resolved config', () => {
    const config = resolveConfig({}, {});
    expect(Object.isFrozen(config.pi)).toBe(true);
  });
});

describe('DEFAULT_CONFIG.pi', () => {
  it('has sensible defaults', () => {
    expect(DEFAULT_CONFIG.pi.thinkingLevel).toBe('medium');
    expect(DEFAULT_CONFIG.pi.extensions.autoDiscover).toBe(true);
    expect(DEFAULT_CONFIG.pi.compaction.enabled).toBe(true);
    expect(DEFAULT_CONFIG.pi.compaction.threshold).toBe(100_000);
    expect(DEFAULT_CONFIG.pi.retry.maxRetries).toBe(3);
    expect(DEFAULT_CONFIG.pi.retry.backoffMs).toBe(1000);
  });

  it('has no backend in DEFAULT_CONFIG', () => {
    expect(DEFAULT_CONFIG.backend).toBeUndefined();
  });
});

describe('mergePartialConfigs backend and pi', () => {
  it('project backend overrides global', () => {
    const merged = mergePartialConfigs(
      { backend: 'claude-sdk' },
      { backend: 'pi' },
    );
    expect(merged.backend).toBe('pi');
  });

  it('pi section merges shallowly (global provider + project model)', () => {
    const global: PartialEforgeConfig = {
      pi: { provider: 'openrouter' },
    };
    const project: PartialEforgeConfig = {
      pi: { model: 'anthropic/claude-sonnet-4' },
    };
    const merged = mergePartialConfigs(global, project);
    expect(merged.pi?.provider).toBe('openrouter');
    expect(merged.pi?.model).toBe('anthropic/claude-sonnet-4');
  });
});

// ---------------------------------------------------------------------------
// Model Class Schema Validation
// ---------------------------------------------------------------------------

describe('modelClassSchema', () => {
  it('accepts max', () => {
    expect(modelClassSchema.safeParse('max').success).toBe(true);
  });

  it('accepts balanced', () => {
    expect(modelClassSchema.safeParse('balanced').success).toBe(true);
  });

  it('accepts fast', () => {
    expect(modelClassSchema.safeParse('fast').success).toBe(true);
  });

  it('rejects auto', () => {
    expect(modelClassSchema.safeParse('auto').success).toBe(false);
  });

  it('rejects invalid class name', () => {
    expect(modelClassSchema.safeParse('invalid').success).toBe(false);
  });
});

describe('agents.models schema validation', () => {
  it('accepts valid models map with known class names', () => {
    const result = eforgeConfigSchema.safeParse({
      backend: 'claude-sdk',
      agents: { models: { max: { id: 'some-model' } } },
    });
    expect(result.success).toBe(true);
  });

  it('accepts models map with multiple classes', () => {
    const result = eforgeConfigSchema.safeParse({
      backend: 'claude-sdk',
      agents: { models: { max: { id: 'model-a' }, balanced: { id: 'model-b' }, fast: { id: 'model-c' } } },
    });
    expect(result.success).toBe(true);
  });

  it('rejects models map with invalid class name', () => {
    const result = eforgeConfigSchema.safeParse({
      agents: { models: { 'invalid-class': 'model' } },
    });
    expect(result.success).toBe(false);
  });
});

describe('per-role modelClass schema validation', () => {
  it('accepts valid modelClass in per-role config', () => {
    const result = eforgeConfigSchema.safeParse({
      backend: 'claude-sdk',
      agents: {
        roles: {
          builder: { modelClass: 'max' },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts all valid modelClass values', () => {
    for (const cls of MODEL_CLASSES) {
      const result = eforgeConfigSchema.safeParse({
        backend: 'claude-sdk',
        agents: {
          roles: {
            builder: { modelClass: cls },
          },
        },
      });
      expect(result.success).toBe(true);
    }
  });

  it('rejects invalid modelClass in per-role config', () => {
    const result = eforgeConfigSchema.safeParse({
      agents: {
        roles: {
          builder: { modelClass: 'invalid' },
        },
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('DEFAULT_CONFIG.pi', () => {
  it('has no model field', () => {
    expect('model' in DEFAULT_CONFIG.pi).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// monitor config
// ---------------------------------------------------------------------------

describe('monitor config', () => {
  it('DEFAULT_CONFIG.monitor.retentionCount equals 20', () => {
    expect(DEFAULT_CONFIG.monitor.retentionCount).toBe(20);
  });

  it('monitor section is frozen in DEFAULT_CONFIG', () => {
    expect(Object.isFrozen(DEFAULT_CONFIG.monitor)).toBe(true);
  });

  it('eforgeConfigSchema accepts { monitor: { retentionCount: 20 } }', () => {
    const result = eforgeConfigSchema.safeParse({
      backend: 'claude-sdk',
      monitor: { retentionCount: 20 },
    });
    expect(result.success).toBe(true);
  });

  it('eforgeConfigSchema accepts monitor with no retentionCount (optional)', () => {
    const result = eforgeConfigSchema.safeParse({
      backend: 'claude-sdk',
      monitor: {},
    });
    expect(result.success).toBe(true);
  });

  it('eforgeConfigSchema rejects non-positive retentionCount', () => {
    const result = eforgeConfigSchema.safeParse({
      backend: 'claude-sdk',
      monitor: { retentionCount: 0 },
    });
    expect(result.success).toBe(false);
  });

  it('resolveConfig returns default monitor.retentionCount when not set', () => {
    const config = resolveConfig({}, {});
    expect(config.monitor.retentionCount).toBe(20);
  });

  it('resolveConfig preserves monitor.retentionCount from file config', () => {
    const config = resolveConfig({ monitor: { retentionCount: 50 } }, {});
    expect(config.monitor.retentionCount).toBe(50);
  });

  it('monitor section is frozen in resolved config', () => {
    const config = resolveConfig({}, {});
    expect(Object.isFrozen(config.monitor)).toBe(true);
  });
});

describe('mergePartialConfigs monitor', () => {
  it('project monitor overrides global monitor fields', () => {
    const global: PartialEforgeConfig = {
      monitor: { retentionCount: 10 },
    };
    const project: PartialEforgeConfig = {
      monitor: { retentionCount: 50 },
    };
    const merged = mergePartialConfigs(global, project);
    expect(merged.monitor?.retentionCount).toBe(50);
  });

  it('global monitor survives when project has no monitor', () => {
    const global: PartialEforgeConfig = {
      monitor: { retentionCount: 15 },
    };
    const merged = mergePartialConfigs(global, {});
    expect(merged.monitor?.retentionCount).toBe(15);
  });

  it('project monitor survives when global has no monitor', () => {
    const merged = mergePartialConfigs({}, { monitor: { retentionCount: 30 } });
    expect(merged.monitor?.retentionCount).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// configYamlSchema — rejects backend: in config.yaml
// ---------------------------------------------------------------------------

describe('configYamlSchema', () => {
  it('config.yaml with top-level backend: field is rejected with a validation error', () => {
    const result = configYamlSchema.safeParse({ backend: 'claude-sdk', agents: { maxTurns: 30 } });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i: { message: string }) => i.message).join('\n');
      expect(messages).toContain('backend');
    }
  });

  it('config.yaml without backend: field is accepted', () => {
    const result = configYamlSchema.safeParse({ agents: { maxTurns: 30 } });
    expect(result.success).toBe(true);
  });

  it('empty config.yaml is accepted', () => {
    const result = configYamlSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// sanitizeProfileName
// ---------------------------------------------------------------------------

describe('sanitizeProfileName', () => {
  it('claude-sdk + claude-opus-4.7 → claude-sdk-opus-4-7', () => {
    expect(sanitizeProfileName('claude-sdk', undefined, 'claude-opus-4.7')).toBe('claude-sdk-opus-4-7');
  });

  it('pi + anthropic + claude-opus-4.7 → pi-anthropic-opus-4-7', () => {
    expect(sanitizeProfileName('pi', 'anthropic', 'claude-opus-4.7')).toBe('pi-anthropic-opus-4-7');
  });

  it('pi + zai + glm-4.6 → pi-zai-glm-4-6', () => {
    expect(sanitizeProfileName('pi', 'zai', 'glm-4.6')).toBe('pi-zai-glm-4-6');
  });

  it('lowercases model ID', () => {
    expect(sanitizeProfileName('claude-sdk', undefined, 'Claude-Opus-4.7')).toBe('claude-sdk-opus-4-7');
  });

  it('collapses repeated dashes', () => {
    expect(sanitizeProfileName('pi', undefined, 'claude--test-4.7')).toBe('pi-test-4-7');
  });
});

// ---------------------------------------------------------------------------
// parseRawConfigLegacy
// ---------------------------------------------------------------------------

describe('parseRawConfigLegacy', () => {
  it('extracts backend and agents.models into profile, leaves build in remaining', () => {
    const data = {
      backend: 'claude-sdk',
      agents: { models: { max: { id: 'claude-opus-4.7' } } },
      build: { postMergeCommands: ['pnpm test'] },
    };
    const { profile, remaining } = parseRawConfigLegacy(data);
    expect(profile.backend).toBe('claude-sdk');
    expect(profile.agents).toEqual({ models: { max: { id: 'claude-opus-4.7' } } });
    expect(remaining).toEqual({ build: { postMergeCommands: ['pnpm test'] } });
    expect(remaining).not.toHaveProperty('backend');
    expect(remaining).not.toHaveProperty('pi');
    expect(remaining).not.toHaveProperty('agents');
  });

  it('extracts pi config into profile', () => {
    const data = {
      backend: 'pi',
      pi: { thinkingLevel: 'high' },
      agents: { model: { provider: 'anthropic', id: 'claude-opus-4.7' }, maxTurns: 50 },
    };
    const { profile, remaining } = parseRawConfigLegacy(data);
    expect(profile.backend).toBe('pi');
    expect(profile.pi).toEqual({ thinkingLevel: 'high' });
    expect(profile.agents).toEqual({ model: { provider: 'anthropic', id: 'claude-opus-4.7' } });
    // maxTurns stays in remaining since it's not a profile field
    expect(remaining.agents).toEqual({ maxTurns: 50 });
  });

  it('handles config with no backend-related fields', () => {
    const data = { build: { postMergeCommands: ['pnpm test'] } };
    const { profile, remaining } = parseRawConfigLegacy(data);
    expect(profile).toEqual({});
    expect(remaining).toEqual({ build: { postMergeCommands: ['pnpm test'] } });
  });

  it('extracts agents.effort and agents.thinking into profile', () => {
    const data = {
      backend: 'claude-sdk',
      agents: { effort: 'high', thinking: { type: 'adaptive' }, maxTurns: 30 },
    };
    const { profile, remaining } = parseRawConfigLegacy(data);
    expect(profile.agents).toEqual({ effort: 'high', thinking: { type: 'adaptive' } });
    expect(remaining.agents).toEqual({ maxTurns: 30 });
  });
});
