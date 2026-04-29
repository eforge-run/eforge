import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  eforgeConfigSchema,
  agentRuntimeEntrySchema,
  configYamlSchema,
  parseRawConfig,
  loadConfig,
  ConfigValidationError,
} from '@eforge-build/engine/config';

// ---------------------------------------------------------------------------
// agentRuntimeEntrySchema — cross-kind sub-block rejection
// ---------------------------------------------------------------------------

describe('agentRuntimeEntrySchema', () => {
  it('accepts harness claude-sdk without sub-blocks', () => {
    const result = agentRuntimeEntrySchema.safeParse({ harness: 'claude-sdk' });
    expect(result.success).toBe(true);
  });

  it('accepts harness pi with required pi.provider', () => {
    const result = agentRuntimeEntrySchema.safeParse({ harness: 'pi', pi: { provider: 'openrouter' } });
    expect(result.success).toBe(true);
  });

  it('accepts harness claude-sdk with claudeSdk config', () => {
    const result = agentRuntimeEntrySchema.safeParse({
      harness: 'claude-sdk',
      claudeSdk: { disableSubagents: true },
    });
    expect(result.success).toBe(true);
  });

  it('accepts harness pi with pi config including required provider', () => {
    const result = agentRuntimeEntrySchema.safeParse({
      harness: 'pi',
      pi: { provider: 'openrouter', apiKey: 'test-key', thinkingLevel: 'medium' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects harness pi with claudeSdk sub-block (cross-kind conflict)', () => {
    const result = agentRuntimeEntrySchema.safeParse({
      harness: 'pi',
      claudeSdk: { disableSubagents: true },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join('\n');
      expect(messages).toMatch(/harness "pi".*cannot include "claudeSdk"/);
    }
  });

  it('rejects harness claude-sdk with pi sub-block (cross-kind conflict)', () => {
    const result = agentRuntimeEntrySchema.safeParse({
      harness: 'claude-sdk',
      pi: { apiKey: 'test' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join('\n');
      expect(messages).toMatch(/harness "claude-sdk".*cannot include "pi"/);
    }
  });

  it('rejects unknown harness value', () => {
    const result = agentRuntimeEntrySchema.safeParse({ harness: 'unknown-backend' });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// eforgeConfigSchema — agentRuntimes cross-field refinements
// ---------------------------------------------------------------------------

describe('eforgeConfigSchema agentRuntimes cross-field validation', () => {
  const validBase = {
    agents: { maxTurns: 30 },
  };

  it('accepts config with no agentRuntimes', () => {
    const result = eforgeConfigSchema.safeParse(validBase);
    expect(result.success).toBe(true);
  });

  it('accepts config with agentRuntimes and defaultAgentRuntime', () => {
    const result = eforgeConfigSchema.safeParse({
      ...validBase,
      agentRuntimes: {
        opus: { harness: 'claude-sdk' },
        mypi: { harness: 'pi', pi: { provider: 'openrouter' } },
      },
      defaultAgentRuntime: 'opus',
    });
    expect(result.success).toBe(true);
  });

  it('rejects config with agentRuntimes but no defaultAgentRuntime', () => {
    const result = eforgeConfigSchema.safeParse({
      ...validBase,
      agentRuntimes: { opus: { harness: 'claude-sdk' } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join('\n');
      expect(messages).toMatch(/"defaultAgentRuntime" is required/);
    }
  });

  it('rejects config where defaultAgentRuntime references a non-existent entry', () => {
    const result = eforgeConfigSchema.safeParse({
      ...validBase,
      agentRuntimes: { opus: { harness: 'claude-sdk' } },
      defaultAgentRuntime: 'missing-runtime',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join('\n');
      expect(messages).toMatch(/"missing-runtime"/);
      expect(messages).toMatch(/not declared in "agentRuntimes"/);
    }
  });

  it('rejects config where agents.roles.*.agentRuntime references a non-existent entry', () => {
    const result = eforgeConfigSchema.safeParse({
      ...validBase,
      agentRuntimes: { opus: { harness: 'claude-sdk' } },
      defaultAgentRuntime: 'opus',
      agents: {
        maxTurns: 30,
        roles: {
          builder: { agentRuntime: 'ghost' },
        },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join('\n');
      expect(messages).toMatch(/agents\.roles\.builder\.agentRuntime/);
      expect(messages).toMatch(/"ghost"/);
      expect(messages).toMatch(/not declared in "agentRuntimes"/);
    }
  });

  it('accepts config where agents.roles.*.agentRuntime references a declared entry', () => {
    const result = eforgeConfigSchema.safeParse({
      ...validBase,
      agentRuntimes: {
        opus: { harness: 'claude-sdk' },
        mypi: { harness: 'pi', pi: { provider: 'openrouter' } },
      },
      defaultAgentRuntime: 'opus',
      agents: {
        maxTurns: 30,
        roles: {
          builder: { agentRuntime: 'mypi' },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects config with pi harness + claudeSdk sub-block in agentRuntimes entry', () => {
    const result = eforgeConfigSchema.safeParse({
      ...validBase,
      agentRuntimes: {
        bad: { harness: 'pi', claudeSdk: { disableSubagents: false } },
      },
      defaultAgentRuntime: 'bad',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join('\n');
      expect(messages).toMatch(/harness "pi".*cannot include "claudeSdk"/);
    }
  });

  // Legacy backend scalar rejection is covered by packages/engine/test/config.legacy-rejection.test.ts
});

// ---------------------------------------------------------------------------
// agents.tiers — keyed by AgentTier, NOT by modelClass.
// Regression: prior schema accepted modelClass keys (max/balanced/fast),
// but the runtime indexes config.agents.tiers[tier] where tier is one of
// planning/implementation/review/evaluation. Schema and runtime now agree.
// ---------------------------------------------------------------------------

describe('agents.tiers schema (AgentTier-keyed)', () => {
  it('accepts all four AgentTier names', () => {
    const config = parseRawConfig({
      agents: {
        tiers: {
          planning: { effort: 'xhigh', modelClass: 'max' },
          implementation: { effort: 'medium', modelClass: 'balanced' },
          review: { effort: 'xhigh', modelClass: 'max' },
          evaluation: { effort: 'high', modelClass: 'max' },
        },
      },
    }, 'profile');
    expect(config.agents?.tiers?.planning?.effort).toBe('xhigh');
    expect(config.agents?.tiers?.implementation?.modelClass).toBe('balanced');
    expect(config.agents?.tiers?.review?.effort).toBe('xhigh');
    expect(config.agents?.tiers?.evaluation?.effort).toBe('high');
  });

  it('rejects modelClass keys (max/balanced/fast) — those belong on agents.models, not agents.tiers', () => {
    expect(() => parseRawConfig({
      agents: { tiers: { fast: { agentRuntime: 'main' } } },
    }, 'profile')).toThrow(/Unrecognized key.*fast/);
  });
});

// ---------------------------------------------------------------------------
// parseRawConfig — strict, no silent dropping of valid sibling fields
// when one section fails validation.
// Regression: the old fallback parser had a hardcoded section allowlist
// missing agentRuntimes/defaultAgentRuntime, which silently disappeared
// from a profile any time another section failed to validate.
// ---------------------------------------------------------------------------

describe('parseRawConfig strict fail-fast', () => {
  it('throws ConfigValidationError when any field fails validation — never silently drops valid siblings', () => {
    expect(() => parseRawConfig({
      agentRuntimes: { main: { harness: 'claude-sdk' } },
      defaultAgentRuntime: 'main',
      agents: { permissionMode: 'totally-bogus' },
    }, 'profile')).toThrow(ConfigValidationError);
  });

  it('error message names the offending path', () => {
    try {
      parseRawConfig({
        agentRuntimes: { main: { harness: 'claude-sdk' } },
        defaultAgentRuntime: 'main',
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
// loadConfig — user-scope profile is picked up when project has config.yaml
// but no project-level profiles directory. This is the regression scenario
// the user hit: project config without agentRuntimes, profile under
// ~/.config/eforge/profiles/, marker at ~/.config/eforge/.active-profile.
// ---------------------------------------------------------------------------

describe('loadConfig user-scope profile resolution', () => {
  it('merges user-scope profile (with AgentTier-keyed tiers) into config when project has only build commands', async () => {
    const xdg = await mkdtemp(join(tmpdir(), 'eforge-xdg-'));
    const projectDir = await mkdtemp(join(tmpdir(), 'eforge-proj-'));
    const prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdg;
    try {
      // Project config has no agentRuntimes — depends entirely on the profile.
      await mkdir(join(projectDir, 'eforge'), { recursive: true });
      await writeFile(
        join(projectDir, 'eforge', 'config.yaml'),
        'build:\n  postMergeCommands:\n    - echo ok\n',
        'utf-8',
      );

      // User-scope profile lives under XDG_CONFIG_HOME/eforge/profiles/.
      await mkdir(join(xdg, 'eforge', 'profiles'), { recursive: true });
      await writeFile(
        join(xdg, 'eforge', 'profiles', 'p1.yaml'),
        [
          'agentRuntimes:',
          '  main:',
          '    harness: claude-sdk',
          'defaultAgentRuntime: main',
          'agents:',
          '  tiers:',
          '    planning:',
          '      effort: xhigh',
          '      modelClass: max',
          '',
        ].join('\n'),
        'utf-8',
      );
      await writeFile(join(xdg, 'eforge', '.active-profile'), 'p1\n', 'utf-8');

      const result = await loadConfig(projectDir);
      expect(result.profile.name).toBe('p1');
      expect(result.profile.scope).toBe('user');
      expect(result.profile.config?.agentRuntimes?.main?.harness).toBe('claude-sdk');
      expect(result.profile.config?.defaultAgentRuntime).toBe('main');
      // The merged config inherits the profile's agentRuntimes.
      expect(result.config.agentRuntimes?.main?.harness).toBe('claude-sdk');
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdg;
      await rm(xdg, { recursive: true });
      await rm(projectDir, { recursive: true });
    }
  });
});
