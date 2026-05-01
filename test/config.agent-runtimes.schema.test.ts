import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  eforgeConfigSchema,
  tierConfigSchema,
  configYamlSchema,
  parseRawConfig,
  loadConfig,
  ConfigValidationError,
  ConfigMigrationError,
} from '@eforge-build/engine/config';

// ---------------------------------------------------------------------------
// tierConfigSchema — self-contained recipe with cross-field validation
// ---------------------------------------------------------------------------

describe('tierConfigSchema', () => {
  it('accepts a claude-sdk tier recipe', () => {
    const result = tierConfigSchema.safeParse({
      harness: 'claude-sdk',
      model: 'claude-opus-4-7',
      effort: 'high',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a pi tier recipe with required pi.provider', () => {
    const result = tierConfigSchema.safeParse({
      harness: 'pi',
      pi: { provider: 'openrouter' },
      model: 'qwen-coder',
      effort: 'medium',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a claude-sdk tier with claudeSdk config', () => {
    const result = tierConfigSchema.safeParse({
      harness: 'claude-sdk',
      claudeSdk: { disableSubagents: true },
      model: 'claude-opus-4-7',
      effort: 'high',
    });
    expect(result.success).toBe(true);
  });

  it('rejects pi tier with claudeSdk sub-block', () => {
    const result = tierConfigSchema.safeParse({
      harness: 'pi',
      claudeSdk: { disableSubagents: true },
      model: 'qwen-coder',
      effort: 'medium',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join('\n');
      expect(messages).toMatch(/harness "pi".*cannot include "claudeSdk"/);
    }
  });

  it('rejects claude-sdk tier with pi sub-block', () => {
    const result = tierConfigSchema.safeParse({
      harness: 'claude-sdk',
      pi: { provider: 'foo' },
      model: 'claude-opus-4-7',
      effort: 'high',
    });
    expect(result.success).toBe(false);
  });

  it('rejects pi tier missing pi.provider', () => {
    const result = tierConfigSchema.safeParse({
      harness: 'pi',
      model: 'qwen-coder',
      effort: 'medium',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join('\n');
      expect(messages).toMatch(/non-empty "pi.provider"/);
    }
  });

  it('rejects pi tier with empty pi.provider', () => {
    const result = tierConfigSchema.safeParse({
      harness: 'pi',
      pi: { provider: '' },
      model: 'qwen-coder',
      effort: 'medium',
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown harness value', () => {
    const result = tierConfigSchema.safeParse({
      harness: 'unknown',
      model: 'foo',
      effort: 'high',
    });
    expect(result.success).toBe(false);
  });

  it('rejects tier missing required model', () => {
    const result = tierConfigSchema.safeParse({
      harness: 'claude-sdk',
      effort: 'high',
    });
    expect(result.success).toBe(false);
  });

  it('rejects tier missing required effort', () => {
    const result = tierConfigSchema.safeParse({
      harness: 'claude-sdk',
      model: 'claude-opus-4-7',
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// eforgeConfigSchema — accepts agents.tiers
// ---------------------------------------------------------------------------

describe('eforgeConfigSchema with agents.tiers', () => {
  it('accepts config with valid tier recipes', () => {
    const result = eforgeConfigSchema.safeParse({
      agents: {
        tiers: {
          planning: { harness: 'claude-sdk', model: 'claude-opus-4-7', effort: 'high' },
          implementation: { harness: 'pi', pi: { provider: 'openrouter' }, model: 'qwen-coder', effort: 'medium' },
        },
      },
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// agents.tiers — keyed by AgentTier
// ---------------------------------------------------------------------------

describe('agents.tiers schema (AgentTier-keyed)', () => {
  it('accepts all four AgentTier names', () => {
    const config = parseRawConfig({
      agents: {
        tiers: {
          planning: { harness: 'claude-sdk', model: 'claude-opus-4-7', effort: 'xhigh' },
          implementation: { harness: 'claude-sdk', model: 'claude-sonnet-4-6', effort: 'medium' },
          review: { harness: 'claude-sdk', model: 'claude-opus-4-7', effort: 'high' },
          evaluation: { harness: 'claude-sdk', model: 'claude-opus-4-7', effort: 'high' },
        },
      },
    }, 'profile');
    expect(config.agents?.tiers?.planning?.effort).toBe('xhigh');
    expect(config.agents?.tiers?.implementation?.model).toBe('claude-sonnet-4-6');
  });

  it('accepts arbitrary tier names (including former model-class names like fast)', () => {
    // The schema now accepts arbitrary tier names — users can declare custom tiers.
    // Former model-class names (max, balanced, fast) are valid arbitrary tier keys.
    const config = parseRawConfig({
      agents: { tiers: { fast: { harness: 'claude-sdk', model: 'x', effort: 'high' } } },
    }, 'profile');
    expect(config.agents?.tiers?.['fast']?.model).toBe('x');
  });
});

// ---------------------------------------------------------------------------
// parseRawConfig — strict, no silent dropping
// ---------------------------------------------------------------------------

describe('parseRawConfig strict fail-fast', () => {
  it('throws ConfigValidationError when any field fails validation', () => {
    expect(() => parseRawConfig({
      agents: { permissionMode: 'totally-bogus' },
    }, 'profile')).toThrow(ConfigValidationError);
  });

  it('error message names the offending path', () => {
    try {
      parseRawConfig({
        agents: { permissionMode: 'totally-bogus' },
      }, 'profile');
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      expect((err as Error).message).toContain('permissionMode');
    }
  });
});

// ---------------------------------------------------------------------------
// Legacy field rejection — agentRuntimes/defaultAgentRuntime/agents.models gone
// ---------------------------------------------------------------------------

describe('parseRawConfig rejects legacy fields', () => {
  it('rejects top-level agentRuntimes with migration pointer', () => {
    expect(() => parseRawConfig({
      agentRuntimes: { main: { harness: 'claude-sdk' } },
    })).toThrow(ConfigMigrationError);
  });

  it('rejects defaultAgentRuntime', () => {
    expect(() => parseRawConfig({
      defaultAgentRuntime: 'main',
    })).toThrow(ConfigMigrationError);
  });

  it('rejects backend at top level', () => {
    expect(() => parseRawConfig({
      backend: 'claude-sdk',
    })).toThrow(ConfigMigrationError);
  });

  it('rejects agents.models with migration pointer', () => {
    expect(() => parseRawConfig({
      agents: { models: { max: { id: 'x' } } },
    }, 'profile')).toThrow(ConfigMigrationError);
  });
});

// ---------------------------------------------------------------------------
// loadConfig — user-scope profile is picked up when project has config.yaml
// ---------------------------------------------------------------------------

describe('loadConfig user-scope profile resolution', () => {
  it('merges user-scope profile (with tier recipes) into config', async () => {
    const xdg = await mkdtemp(join(tmpdir(), 'eforge-xdg-'));
    const projectDir = await mkdtemp(join(tmpdir(), 'eforge-proj-'));
    const prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdg;
    try {
      await mkdir(join(projectDir, 'eforge'), { recursive: true });
      await writeFile(
        join(projectDir, 'eforge', 'config.yaml'),
        'build:\n  postMergeCommands:\n    - echo ok\n',
        'utf-8',
      );

      await mkdir(join(xdg, 'eforge', 'profiles'), { recursive: true });
      await writeFile(
        join(xdg, 'eforge', 'profiles', 'p1.yaml'),
        [
          'agents:',
          '  tiers:',
          '    planning:',
          '      harness: claude-sdk',
          '      model: claude-opus-4-7',
          '      effort: xhigh',
          '',
        ].join('\n'),
        'utf-8',
      );
      await writeFile(join(xdg, 'eforge', '.active-profile'), 'p1\n', 'utf-8');

      const result = await loadConfig(projectDir);
      expect(result.profile.name).toBe('p1');
      expect(result.profile.scope).toBe('user');
      expect(result.profile.config?.agents?.tiers?.planning?.harness).toBe('claude-sdk');
      expect(result.profile.config?.agents?.tiers?.planning?.effort).toBe('xhigh');
      expect(result.config.agents.tiers?.planning?.harness).toBe('claude-sdk');
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdg;
      await rm(xdg, { recursive: true });
      await rm(projectDir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// configYamlSchema — recognized keys
// ---------------------------------------------------------------------------

describe('configYamlSchema recognized keys', () => {
  it('accepts agents.tiers in config.yaml', () => {
    const result = configYamlSchema.safeParse({
      agents: {
        tiers: {
          planning: { harness: 'claude-sdk', model: 'claude-opus-4-7', effort: 'high' },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects legacy agentRuntimes at top level', () => {
    const result = configYamlSchema.safeParse({
      agentRuntimes: { main: { harness: 'claude-sdk' } },
    });
    expect(result.success).toBe(false);
  });
});
