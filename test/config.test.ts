import { describe, it, expect, vi } from 'vitest';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { resolveConfig, DEFAULT_CONFIG, getUserConfigPath, mergePartialConfigs, loadConfig, AGENT_ROLES } from '../src/engine/config.js';
import type { PartialEforgeConfig, HookConfig } from '../src/engine/config.js';

describe('resolveConfig', () => {
  it('returns defaults for empty inputs', () => {
    const config = resolveConfig({}, {});
    expect(config.agents).toEqual(DEFAULT_CONFIG.agents);
    expect(config.build.parallelism).toBe(DEFAULT_CONFIG.build.parallelism);
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
          parallelism: 4,
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
      build: { parallelism: 8 },
    };
    const project: PartialEforgeConfig = {
      build: { maxValidationRetries: 5 },
    };
    const merged = mergePartialConfigs(global, project);
    expect(merged.build?.parallelism).toBe(8);
    expect(merged.build?.maxValidationRetries).toBe(5);
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

  it('parseRawConfig with invalid maxTurns logs a warning containing "maxTurns"', async () => {
    // We need to test parseRawConfig indirectly. The simplest way is to
    // write a temp config file and load it, but we can also test via the
    // config module internals. Since parseRawConfig is private, we test
    // that the schema validation produces warnings by importing loadConfig
    // with a temp file.
    const { writeFile, mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const tmpDir = await mkdtemp(join(tmpdir(), 'eforge-config-warn-'));
    const configPath = join(tmpDir, 'eforge.yaml');
    await writeFile(configPath, 'agents:\n  maxTurns: "not-a-number"\n', 'utf-8');

    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await loadConfig(tmpDir);
      const warnings = stderrSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(warnings).toContain('maxTurns');
    } finally {
      stderrSpy.mockRestore();
      await rm(tmpDir, { recursive: true });
    }
  });

  it('parseRawConfig with invalid permissionMode logs a warning containing "permissionMode"', async () => {
    const { writeFile, mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const tmpDir = await mkdtemp(join(tmpdir(), 'eforge-config-warn-'));
    const configPath = join(tmpDir, 'eforge.yaml');
    await writeFile(configPath, 'agents:\n  permissionMode: "skip"\n', 'utf-8');

    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await loadConfig(tmpDir);
      const warnings = stderrSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(warnings).toContain('permissionMode');
    } finally {
      stderrSpy.mockRestore();
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
// prdQueue config
// ---------------------------------------------------------------------------

describe('prdQueue config', () => {
  it('parses prdQueue section from config', () => {
    const config = resolveConfig(
      {
        prdQueue: {
          dir: 'custom/queue',
          autoRevise: true,
        },
      },
      {},
    );
    expect(config.prdQueue.dir).toBe('custom/queue');
    expect(config.prdQueue.autoRevise).toBe(true);
  });

  it('applies defaults when prdQueue is omitted', () => {
    const config = resolveConfig({}, {});
    expect(config.prdQueue.dir).toBe(DEFAULT_CONFIG.prdQueue.dir);
    expect(config.prdQueue.autoRevise).toBe(DEFAULT_CONFIG.prdQueue.autoRevise);
  });

  it('merges prdQueue per-field (project overrides global)', () => {
    const global: PartialEforgeConfig = {
      prdQueue: {
        dir: 'global/queue',
      },
    };
    const project: PartialEforgeConfig = {
      prdQueue: {
        autoRevise: true,
      },
    };
    const merged = mergePartialConfigs(global, project);
    expect(merged.prdQueue?.autoRevise).toBe(true);
    // Global dir survives since project didn't override it
    expect(merged.prdQueue?.dir).toBe('global/queue');
  });
});
