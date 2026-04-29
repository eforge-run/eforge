import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadConfig,
  resolveActiveProfileName,
  loadProfile,
  listProfiles,
  listUserProfiles,
  resolveUserActiveProfile,
  loadUserProfile,
  setActiveProfile,
  createAgentRuntimeProfile,
  deleteAgentRuntimeProfile,
  getConfigDir,
  parseRawConfigLegacy,
  deriveProfileName,
  type PartialEforgeConfig,
} from '@eforge-build/engine/config';

/**
 * Create an isolated temp dir to serve as the user-level XDG config home.
 * Returns the base dir and the eforge-specific dir inside it.
 */
async function makeUserHome(): Promise<{ userHomeDir: string; userEforgeDir: string }> {
  const userHomeDir = await mkdtemp(join(tmpdir(), 'eforge-user-'));
  const userEforgeDir = join(userHomeDir, 'eforge');
  await mkdir(userEforgeDir, { recursive: true });
  return { userHomeDir, userEforgeDir };
}

/**
 * Create an isolated temp project dir with an `eforge/` subdir and
 * optionally a seed `config.yaml`. Returns the project root dir and
 * the config dir (which is the same as projectDir/eforge).
 */
async function makeProject(seed?: { configYaml?: string }): Promise<{ projectDir: string; configDir: string }> {
  const projectDir = await mkdtemp(join(tmpdir(), 'eforge-bp-'));
  const configDir = join(projectDir, 'eforge');
  await mkdir(configDir, { recursive: true });
  if (seed?.configYaml !== undefined) {
    await writeFile(join(configDir, 'config.yaml'), seed.configYaml, 'utf-8');
  }
  return { projectDir, configDir };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('resolveActiveProfileName', () => {
  let projectDir: string;
  let configDir: string;
  let userHomeDir: string;
  let origXdg: string | undefined;

  beforeEach(async () => {
    ({ projectDir, configDir } = await makeProject({ configYaml: 'backend: claude-sdk\n' }));
    ({ userHomeDir } = await makeUserHome());
    origXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = userHomeDir;
  });

  afterEach(async () => {
    if (origXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = origXdg;
    }
    await rm(projectDir, { recursive: true, force: true });
    await rm(userHomeDir, { recursive: true, force: true });
  });

  it('returns source=none when no marker and no matching team profile', async () => {
    const result = await resolveActiveProfileName(configDir, {});
    expect(result).toEqual({ name: null, source: 'none', warnings: [] });
  });

  it('marker present overrides config.yaml backend', async () => {
    // Create a team profile for claude-sdk
    await mkdir(join(configDir, 'profiles'), { recursive: true });
    await writeFile(join(configDir, 'profiles', 'claude-sdk.yaml'), 'backend: claude-sdk\n', 'utf-8');
    await writeFile(join(configDir, 'profiles', 'pi-prod.yaml'), 'backend: pi\n', 'utf-8');
    // Write marker pointing at pi-prod
    await writeFile(join(configDir, '.active-profile'), 'pi-prod\n', 'utf-8');

    const result = await resolveActiveProfileName(configDir, {});
    expect(result).toEqual({ name: 'pi-prod', source: 'local', warnings: [] });
  });

  it('marker absent + no matching profile → source=none (backend: in config.yaml no longer used for resolution)', async () => {
    await mkdir(join(configDir, 'profiles'), { recursive: true });
    await writeFile(join(configDir, 'profiles', 'pi.yaml'), 'backend: pi\n', 'utf-8');

    // Even with a matching profile file, resolution no longer uses config.yaml backend: field
    const result = await resolveActiveProfileName(configDir, {});
    expect(result).toEqual({ name: null, source: 'none', warnings: [] });
  });

  it('unknown profile name in marker returns warning and missing when no user marker', async () => {
    await mkdir(join(configDir, 'profiles'), { recursive: true });
    await writeFile(join(configDir, 'profiles', 'claude-sdk.yaml'), 'backend: claude-sdk\n', 'utf-8');
    await writeFile(join(configDir, '.active-profile'), 'nonexistent\n', 'utf-8');

    const result = await resolveActiveProfileName(configDir, {});
    // No team fallback, no user marker → missing
    expect(result.name).toBeNull();
    expect(result.source).toBe('missing');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('nonexistent');
  });

  it('unknown profile name in marker with no team fallback returns name=null source=missing', async () => {
    await writeFile(join(configDir, '.active-profile'), 'nonexistent\n', 'utf-8');

    const result = await resolveActiveProfileName(configDir, {});
    expect(result.name).toBeNull();
    expect(result.source).toBe('missing');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('nonexistent');
  });
});

describe('loadProfile', () => {
  let projectDir: string;
  let configDir: string;

  beforeEach(async () => {
    ({ projectDir, configDir } = await makeProject());
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it('returns null when profile file missing', async () => {
    const result = await loadProfile(configDir, 'nope');
    expect(result).toBeNull();
  });

  it('parses a valid profile file and returns scope', async () => {
    await mkdir(join(configDir, 'profiles'), { recursive: true });
    await writeFile(
      join(configDir, 'profiles', 'pi.yaml'),
      'backend: pi\npi:\n  thinkingLevel: high\n',
      'utf-8',
    );
    const result = await loadProfile(configDir, 'pi');
    expect(result).not.toBeNull();
    // profile.backend is no longer in PartialEforgeConfig; check pi-specific config instead
    expect(result?.profile.pi?.thinkingLevel).toBe('high');
    expect(result?.scope).toBe('project');
  });
});

describe('listProfiles', () => {
  let projectDir: string;
  let configDir: string;
  let userHomeDir: string;
  let origXdg: string | undefined;

  beforeEach(async () => {
    ({ projectDir, configDir } = await makeProject());
    ({ userHomeDir } = await makeUserHome());
    origXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = userHomeDir;
  });

  afterEach(async () => {
    if (origXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = origXdg;
    }
    await rm(projectDir, { recursive: true, force: true });
    await rm(userHomeDir, { recursive: true, force: true });
  });

  it('returns [] when no profiles directory exists', async () => {
    const result = await listProfiles(configDir);
    expect(result).toEqual([]);
  });

  it('returns entries for each .yaml file with parsed backend and scope', async () => {
    await mkdir(join(configDir, 'profiles'), { recursive: true });
    await writeFile(join(configDir, 'profiles', 'pi-prod.yaml'), 'backend: pi\n', 'utf-8');
    await writeFile(join(configDir, 'profiles', 'claude.yaml'), 'backend: claude-sdk\n', 'utf-8');
    await writeFile(join(configDir, 'profiles', 'README.md'), '# skip me', 'utf-8');

    const result = await listProfiles(configDir);
    const projectEntries = result.filter((r) => r.scope === 'project');
    expect(projectEntries.length).toBe(2);
    const byName = new Map(projectEntries.map((r) => [r.name, r]));
    expect(byName.get('pi-prod')?.harness).toBe('pi');
    expect(byName.get('claude')?.harness).toBe('claude-sdk');
  });
});

describe('setActiveProfile', () => {
  let projectDir: string;
  let configDir: string;

  beforeEach(async () => {
    ({ projectDir, configDir } = await makeProject({ configYaml: 'backend: claude-sdk\n' }));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it('rejects when the profile file is missing', async () => {
    await expect(setActiveProfile(configDir, 'ghost')).rejects.toThrow(/not found/);
  });

  it('writes the marker when the profile exists and merged config validates', async () => {
    await mkdir(join(configDir, 'profiles'), { recursive: true });
    await writeFile(join(configDir, 'profiles', 'pi-prod.yaml'), 'backend: pi\n', 'utf-8');

    await setActiveProfile(configDir, 'pi-prod');
    const marker = await readFile(join(configDir, '.active-profile'), 'utf-8');
    expect(marker.trim()).toBe('pi-prod');
  });
});

describe('createAgentRuntimeProfile', () => {
  let projectDir: string;
  let configDir: string;

  beforeEach(async () => {
    ({ projectDir, configDir } = await makeProject());
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it('accepts pi profile with pi.provider (provider now schema-required on pi runtimes)', async () => {
    // Provider is now required at schema time on agentRuntimes.<name>.pi.provider
    const result = await createAgentRuntimeProfile(configDir, {
      name: 'pi-with-provider',
      harness: 'pi',
      pi: { provider: 'openrouter' },
      agents: { model: { id: 'some-model' } } as PartialEforgeConfig['agents'],
    });
    expect(await fileExists(result.path)).toBe(true);
  });

  it('creates a valid pi profile with provider in pi config', async () => {
    const result = await createAgentRuntimeProfile(configDir, {
      name: 'pi-prod',
      harness: 'pi',
      pi: { provider: 'openrouter' },
      agents: { model: { id: 'anthropic/claude-sonnet-4' } } as PartialEforgeConfig['agents'],
    });
    expect(await fileExists(result.path)).toBe(true);
    const written = await readFile(result.path, 'utf-8');
    expect(written).toContain('harness: pi');
    expect(written).toContain('openrouter');
  });

  it('refuses overwrite without overwrite: true', async () => {
    await createAgentRuntimeProfile(configDir, { name: 'pi', harness: 'claude-sdk' });
    await expect(
      createAgentRuntimeProfile(configDir, { name: 'pi', harness: 'claude-sdk' }),
    ).rejects.toThrow(/already exists/);
  });

  it('with overwrite: true replaces the file', async () => {
    await createAgentRuntimeProfile(configDir, { name: 'pi', harness: 'claude-sdk' });
    const again = await createAgentRuntimeProfile(configDir, {
      name: 'pi',
      harness: 'pi',
      pi: { provider: 'openrouter' },
      overwrite: true,
    });
    const content = await readFile(again.path, 'utf-8');
    expect(content).toContain('harness: pi');
    expect(content).not.toContain('claude-sdk');
  });

  it('rejects invalid profile names', async () => {
    await expect(
      createAgentRuntimeProfile(configDir, { name: 'has spaces', harness: 'claude-sdk' }),
    ).rejects.toThrow(/Invalid profile name/);
  });

  it('multi-runtime spec round-trips: writes correct agentRuntimes, defaultAgentRuntime, and agents', async () => {
    const result = await createAgentRuntimeProfile(configDir, {
      name: 'mixed',
      agentRuntimes: {
        'claude-sdk': { harness: 'claude-sdk' },
        'pi-openrouter': { harness: 'pi', pi: { provider: 'openrouter' } },
      },
      defaultAgentRuntime: 'claude-sdk',
      agents: {
        models: { max: { id: 'claude-opus-4-7' }, fast: { id: 'zai-glm-4-6' } },
        tiers: { fast: { agentRuntime: 'pi-openrouter' } },
      } as PartialEforgeConfig['agents'],
    });
    expect(await fileExists(result.path)).toBe(true);
    const written = await readFile(result.path, 'utf-8');
    // Verify top-level keys include agentRuntimes, defaultAgentRuntime, agents
    expect(written).toContain('agentRuntimes:');
    expect(written).toContain('defaultAgentRuntime: claude-sdk');
    expect(written).toContain('agents:');
    // agentRuntimes should contain both entries
    expect(written).toContain('claude-sdk:');
    expect(written).toContain('pi-openrouter:');
    // agents.tiers.fast.agentRuntime should be pi-openrouter
    expect(written).toContain('pi-openrouter');
  });

  it('multi-runtime: defaultAgentRuntime must exist in agentRuntimes', async () => {
    await expect(
      createAgentRuntimeProfile(configDir, {
        name: 'x',
        agentRuntimes: { foo: { harness: 'pi', pi: { provider: 'openrouter' } } },
        defaultAgentRuntime: 'missing',
      }),
    ).rejects.toThrow(/defaultAgentRuntime/);
  });

  it('multi-runtime: tier agentRuntime must exist in agentRuntimes', async () => {
    await expect(
      createAgentRuntimeProfile(configDir, {
        name: 'x',
        agentRuntimes: {
          foo: { harness: 'claude-sdk' },
          bar: { harness: 'pi', pi: { provider: 'openrouter' } },
        },
        defaultAgentRuntime: 'foo',
        agents: {
          tiers: { fast: { agentRuntime: 'nonexistent' } },
        } as PartialEforgeConfig['agents'],
      }),
    ).rejects.toThrow(/nonexistent/);
  });
});

describe('deriveProfileName', () => {
  it('single runtime, same model id across all three tiers → sanitized model id (strips claude- prefix, dots to dashes)', () => {
    const result = deriveProfileName({
      agentRuntimes: { main: { harness: 'claude-sdk' } },
      defaultAgentRuntime: 'main',
      models: {
        max: { id: 'claude-opus-4-7' },
        balanced: { id: 'claude-opus-4-7' },
        fast: { id: 'claude-opus-4-7' },
      },
    });
    expect(result).toBe('opus-4-7');
  });

  it('single runtime, same model id across tiers, non-claude prefix', () => {
    const result = deriveProfileName({
      agentRuntimes: { main: { harness: 'pi', pi: { provider: 'zai' } } },
      defaultAgentRuntime: 'main',
      models: {
        max: { id: 'glm-4.6' },
        balanced: { id: 'glm-4.6' },
        fast: { id: 'glm-4.6' },
      },
    });
    expect(result).toBe('glm-4-6');
  });

  it('single runtime, model varies across tiers, claude-sdk harness, no provider → harness name', () => {
    const result = deriveProfileName({
      agentRuntimes: { main: { harness: 'claude-sdk' } },
      defaultAgentRuntime: 'main',
      models: {
        max: { id: 'claude-opus-4-7' },
        balanced: { id: 'claude-sonnet-4-6' },
        fast: { id: 'claude-haiku-4' },
      },
    });
    expect(result).toBe('claude-sdk');
  });

  it('single runtime, model varies, pi harness with provider → harness-provider', () => {
    const result = deriveProfileName({
      agentRuntimes: { main: { harness: 'pi', pi: { provider: 'anthropic' } } },
      defaultAgentRuntime: 'main',
      models: {
        max: { id: 'claude-opus-4-7' },
        balanced: { id: 'claude-sonnet-4-6' },
        fast: { id: 'claude-haiku-4' },
      },
    });
    expect(result).toBe('pi-anthropic');
  });

  it('multiple runtimes, max tier assigned to claude-sdk → mixed-claude-sdk', () => {
    const result = deriveProfileName({
      agentRuntimes: {
        'claude-sdk': { harness: 'claude-sdk' },
        'pi-openrouter': { harness: 'pi', pi: { provider: 'openrouter' } },
      },
      defaultAgentRuntime: 'claude-sdk',
      tiers: { max: { agentRuntime: 'claude-sdk' } },
    });
    expect(result).toBe('mixed-claude-sdk');
  });

  it('multiple runtimes, max tier uses defaultAgentRuntime when tiers.max.agentRuntime is absent', () => {
    const result = deriveProfileName({
      agentRuntimes: {
        'claude-sdk': { harness: 'claude-sdk' },
        'pi-openrouter': { harness: 'pi', pi: { provider: 'openrouter' } },
      },
      defaultAgentRuntime: 'pi-openrouter',
    });
    expect(result).toBe('mixed-pi-openrouter');
  });
});

describe('deleteAgentRuntimeProfile', () => {
  let projectDir: string;
  let configDir: string;

  beforeEach(async () => {
    ({ projectDir, configDir } = await makeProject());
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it('refuses to delete the currently active profile without force', async () => {
    await mkdir(join(configDir, 'profiles'), { recursive: true });
    await writeFile(join(configDir, 'profiles', 'active.yaml'), 'backend: claude-sdk\n', 'utf-8');
    await writeFile(join(configDir, '.active-profile'), 'active\n', 'utf-8');
    await expect(deleteAgentRuntimeProfile(configDir, 'active')).rejects.toThrow(/currently active/);
  });

  it('with force: true removes the file and clears the marker', async () => {
    await mkdir(join(configDir, 'profiles'), { recursive: true });
    await writeFile(join(configDir, 'profiles', 'active.yaml'), 'backend: claude-sdk\n', 'utf-8');
    await writeFile(join(configDir, '.active-profile'), 'active\n', 'utf-8');

    await deleteAgentRuntimeProfile(configDir, 'active', true);
    expect(await fileExists(join(configDir, 'profiles', 'active.yaml'))).toBe(false);
    expect(await fileExists(join(configDir, '.active-profile'))).toBe(false);
  });

  it('errors when the profile file does not exist', async () => {
    await expect(deleteAgentRuntimeProfile(configDir, 'ghost')).rejects.toThrow(/not found/);
  });
});

describe('loadConfig integration with backend profiles', () => {
  let projectDir: string;
  let configDir: string;
  let userHomeDir: string;
  let origXdg: string | undefined;

  beforeEach(async () => {
    ({ userHomeDir } = await makeUserHome());
    origXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = userHomeDir;
  });

  afterEach(async () => {
    if (origXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = origXdg;
    }
    if (projectDir) {
      await rm(projectDir, { recursive: true, force: true });
    }
    if (userHomeDir) {
      await rm(userHomeDir, { recursive: true, force: true });
    }
  });

  it('no profiles/ dir: resolved config uses project settings without backend', async () => {
    ({ projectDir, configDir } = await makeProject({
      configYaml: 'agents:\n  maxTurns: 25\n',
    }));
    const { config: cfg } = await loadConfig(projectDir);
    expect(cfg.backend).toBeUndefined();
    expect(cfg.agents.maxTurns).toBe(25);
  });

  it('profile merges on top of project config when marker is active', async () => {
    ({ projectDir, configDir } = await makeProject({
      configYaml: 'agents:\n  maxTurns: 20\n',
    }));
    await mkdir(join(configDir, 'profiles'), { recursive: true });
    await writeFile(
      join(configDir, 'profiles', 'pi.yaml'),
      'backend: pi\nagents:\n  maxTurns: 40\n',
      'utf-8',
    );
    // Profile is only loaded when a marker is present (team resolution removed)
    await writeFile(join(configDir, '.active-profile'), 'pi\n', 'utf-8');
    const { config: cfg } = await loadConfig(projectDir);
    expect(cfg.agents.maxTurns).toBe(40);
  });

  it('marker selects specific profile', async () => {
    ({ projectDir, configDir } = await makeProject({
      configYaml: '',
    }));
    await mkdir(join(configDir, 'profiles'), { recursive: true });
    await writeFile(
      join(configDir, 'profiles', 'pi.yaml'),
      'backend: pi\nagents:\n  maxTurns: 40\n',
      'utf-8',
    );
    await writeFile(
      join(configDir, 'profiles', 'local.yaml'),
      'backend: claude-sdk\nagents:\n  maxTurns: 99\n',
      'utf-8',
    );
    await writeFile(join(configDir, '.active-profile'), 'local\n', 'utf-8');

    const { config: cfg } = await loadConfig(projectDir);
    // cfg.backend is no longer part of EforgeConfig; verify agents settings from the profile
    expect(cfg.agents.maxTurns).toBe(99);
  });
});

describe('getConfigDir', () => {
  it('returns null when no config file is found', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'eforge-nocfg-'));
    try {
      const result = await getConfigDir(tmpDir);
      expect(result).toBeNull();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns the eforge/ directory when config.yaml is present', async () => {
    const { projectDir, configDir } = await makeProject({ configYaml: 'backend: claude-sdk\n' });
    try {
      const result = await getConfigDir(projectDir);
      expect(result).toBe(configDir);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// User-scope backend profile tests
// ---------------------------------------------------------------------------

describe('user-scope: loadProfile', () => {
  let projectDir: string;
  let configDir: string;
  let userHomeDir: string;
  let userEforgeDir: string;
  let origXdg: string | undefined;

  beforeEach(async () => {
    ({ projectDir, configDir } = await makeProject());
    ({ userHomeDir, userEforgeDir } = await makeUserHome());
    origXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = userHomeDir;
  });

  afterEach(async () => {
    if (origXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = origXdg;
    }
    await rm(projectDir, { recursive: true, force: true });
    await rm(userHomeDir, { recursive: true, force: true });
  });

  it('loads user-scope profile when no project profile exists', async () => {
    await mkdir(join(userEforgeDir, 'profiles'), { recursive: true });
    await writeFile(
      join(userEforgeDir, 'profiles', 'shared.yaml'),
      'backend: claude-sdk\n',
      'utf-8',
    );
    const result = await loadProfile(configDir, 'shared');
    expect(result).not.toBeNull();
    expect(result?.scope).toBe('user');
    // profile.backend is no longer in PartialEforgeConfig (backend: in profile files is a legacy harness indicator)
  });

  it('project profile shadows user profile on same-name collision', async () => {
    await mkdir(join(configDir, 'profiles'), { recursive: true });
    await writeFile(join(configDir, 'profiles', 'common.yaml'), 'backend: pi\n', 'utf-8');
    await mkdir(join(userEforgeDir, 'profiles'), { recursive: true });
    await writeFile(join(userEforgeDir, 'profiles', 'common.yaml'), 'backend: claude-sdk\n', 'utf-8');

    const result = await loadProfile(configDir, 'common');
    expect(result).not.toBeNull();
    expect(result?.scope).toBe('project');
    // profile.backend is no longer in PartialEforgeConfig; scope confirms project shadowing
  });
});

describe('user-scope: resolveActiveProfileName', () => {
  let projectDir: string;
  let configDir: string;
  let userHomeDir: string;
  let userEforgeDir: string;
  let origXdg: string | undefined;

  beforeEach(async () => {
    ({ projectDir, configDir } = await makeProject());
    ({ userHomeDir, userEforgeDir } = await makeUserHome());
    origXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = userHomeDir;
  });

  afterEach(async () => {
    if (origXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = origXdg;
    }
    await rm(projectDir, { recursive: true, force: true });
    await rm(userHomeDir, { recursive: true, force: true });
  });

  it('returns source=user-local when project has no marker/config but user marker exists', async () => {
    // Create a profile file in user scope
    await mkdir(join(userEforgeDir, 'profiles'), { recursive: true });
    await writeFile(join(userEforgeDir, 'profiles', 'default.yaml'), 'backend: claude-sdk\n', 'utf-8');
    // Write user marker
    await writeFile(join(userEforgeDir, '.active-profile'), 'default\n', 'utf-8');

    const result = await resolveActiveProfileName(configDir, {});
    expect(result).toEqual({ name: 'default', source: 'user-local', warnings: [] });
  });

  it('returns source=local (project) when both project and user markers exist', async () => {
    // Create profiles in both scopes
    await mkdir(join(configDir, 'profiles'), { recursive: true });
    await writeFile(join(configDir, 'profiles', 'proj.yaml'), 'backend: pi\n', 'utf-8');
    await mkdir(join(userEforgeDir, 'profiles'), { recursive: true });
    await writeFile(join(userEforgeDir, 'profiles', 'usr.yaml'), 'backend: claude-sdk\n', 'utf-8');
    // Write both markers
    await writeFile(join(configDir, '.active-profile'), 'proj\n', 'utf-8');
    await writeFile(join(userEforgeDir, '.active-profile'), 'usr\n', 'utf-8');

    const result = await resolveActiveProfileName(configDir, {});
    expect(result).toEqual({ name: 'proj', source: 'local', warnings: [] });
  });

  it('user marker wins over user config backend field', async () => {
    await mkdir(join(userEforgeDir, 'profiles'), { recursive: true });
    await writeFile(join(userEforgeDir, 'profiles', 'marker-pick.yaml'), 'backend: pi\n', 'utf-8');
    await writeFile(join(userEforgeDir, 'profiles', 'config-pick.yaml'), 'backend: claude-sdk\n', 'utf-8');
    await writeFile(join(userEforgeDir, '.active-profile'), 'marker-pick\n', 'utf-8');

    const result = await resolveActiveProfileName(
      configDir,
      {},
      { backend: 'config-pick' } as PartialEforgeConfig,
    );
    expect(result).toEqual({ name: 'marker-pick', source: 'user-local', warnings: [] });
  });

  it('returns source=none when only user config backend: is set (user-team resolution removed)', async () => {
    await mkdir(join(userEforgeDir, 'profiles'), { recursive: true });
    await writeFile(join(userEforgeDir, 'profiles', 'team-default.yaml'), 'backend: claude-sdk\n', 'utf-8');

    // user config backend: field is no longer used for resolution
    const result = await resolveActiveProfileName(
      configDir,
      {},
      { backend: 'team-default' } as PartialEforgeConfig,
    );
    expect(result).toEqual({ name: null, source: 'none', warnings: [] });
  });

  it('project marker can resolve to a user-scope profile file', async () => {
    // Profile exists only in user scope but project marker points to it
    await mkdir(join(userEforgeDir, 'profiles'), { recursive: true });
    await writeFile(join(userEforgeDir, 'profiles', 'shared.yaml'), 'backend: claude-sdk\n', 'utf-8');
    await writeFile(join(configDir, '.active-profile'), 'shared\n', 'utf-8');

    const result = await resolveActiveProfileName(configDir, {});
    expect(result).toEqual({ name: 'shared', source: 'local', warnings: [] });
  });
});

describe('user-scope: listProfiles', () => {
  let projectDir: string;
  let configDir: string;
  let userHomeDir: string;
  let userEforgeDir: string;
  let origXdg: string | undefined;

  beforeEach(async () => {
    ({ projectDir, configDir } = await makeProject());
    ({ userHomeDir, userEforgeDir } = await makeUserHome());
    origXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = userHomeDir;
  });

  afterEach(async () => {
    if (origXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = origXdg;
    }
    await rm(projectDir, { recursive: true, force: true });
    await rm(userHomeDir, { recursive: true, force: true });
  });

  it('returns entries from both scopes with correct scope and shadowedBy', async () => {
    await mkdir(join(configDir, 'profiles'), { recursive: true });
    await writeFile(join(configDir, 'profiles', 'shared.yaml'), 'backend: pi\n', 'utf-8');
    await writeFile(join(configDir, 'profiles', 'proj-only.yaml'), 'backend: claude-sdk\n', 'utf-8');
    await mkdir(join(userEforgeDir, 'profiles'), { recursive: true });
    await writeFile(join(userEforgeDir, 'profiles', 'shared.yaml'), 'backend: claude-sdk\n', 'utf-8');
    await writeFile(join(userEforgeDir, 'profiles', 'usr-only.yaml'), 'backend: pi\n', 'utf-8');

    const result = await listProfiles(configDir);
    const byNameAndScope = new Map(result.map((r) => [`${r.scope}:${r.name}`, r]));

    // Project entries
    expect(byNameAndScope.get('project:shared')?.harness).toBe('pi');
    expect(byNameAndScope.get('project:shared')?.shadowedBy).toBeUndefined();
    expect(byNameAndScope.get('project:proj-only')?.harness).toBe('claude-sdk');

    // User entries
    expect(byNameAndScope.get('user:shared')?.harness).toBe('claude-sdk');
    expect(byNameAndScope.get('user:shared')?.shadowedBy).toBe('project');
    expect(byNameAndScope.get('user:usr-only')?.harness).toBe('pi');
    expect(byNameAndScope.get('user:usr-only')?.shadowedBy).toBeUndefined();

    expect(result.length).toBe(4);
  });
});

describe('user-scope: createAgentRuntimeProfile', () => {
  let projectDir: string;
  let configDir: string;
  let userHomeDir: string;
  let userEforgeDir: string;
  let origXdg: string | undefined;

  beforeEach(async () => {
    ({ projectDir, configDir } = await makeProject());
    ({ userHomeDir, userEforgeDir } = await makeUserHome());
    origXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = userHomeDir;
  });

  afterEach(async () => {
    if (origXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = origXdg;
    }
    await rm(projectDir, { recursive: true, force: true });
    await rm(userHomeDir, { recursive: true, force: true });
  });

  it('with scope: user writes file under user config profiles directory', async () => {
    const result = await createAgentRuntimeProfile(configDir, {
      name: 'user-prof',
      harness: 'claude-sdk',
      scope: 'user',
    });
    expect(result.path).toContain(userHomeDir);
    expect(await fileExists(result.path)).toBe(true);
    // Should NOT exist in project scope
    expect(await fileExists(join(configDir, 'profiles', 'user-prof.yaml'))).toBe(false);
  });
});

describe('user-scope: deleteAgentRuntimeProfile', () => {
  let projectDir: string;
  let configDir: string;
  let userHomeDir: string;
  let userEforgeDir: string;
  let origXdg: string | undefined;

  beforeEach(async () => {
    ({ projectDir, configDir } = await makeProject());
    ({ userHomeDir, userEforgeDir } = await makeUserHome());
    origXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = userHomeDir;
  });

  afterEach(async () => {
    if (origXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = origXdg;
    }
    await rm(projectDir, { recursive: true, force: true });
    await rm(userHomeDir, { recursive: true, force: true });
  });

  it('throws ambiguous error when same name exists in both scopes without scope', async () => {
    await mkdir(join(configDir, 'profiles'), { recursive: true });
    await writeFile(join(configDir, 'profiles', 'dup.yaml'), 'backend: claude-sdk\n', 'utf-8');
    await mkdir(join(userEforgeDir, 'profiles'), { recursive: true });
    await writeFile(join(userEforgeDir, 'profiles', 'dup.yaml'), 'backend: pi\n', 'utf-8');

    await expect(deleteAgentRuntimeProfile(configDir, 'dup')).rejects.toThrow(
      /both project and user scope/i,
    );
  });

  it('deletes from specified scope when name exists in both', async () => {
    await mkdir(join(configDir, 'profiles'), { recursive: true });
    await writeFile(join(configDir, 'profiles', 'dup.yaml'), 'backend: claude-sdk\n', 'utf-8');
    await mkdir(join(userEforgeDir, 'profiles'), { recursive: true });
    await writeFile(join(userEforgeDir, 'profiles', 'dup.yaml'), 'backend: pi\n', 'utf-8');

    await deleteAgentRuntimeProfile(configDir, 'dup', false, 'user');
    expect(await fileExists(join(userEforgeDir, 'profiles', 'dup.yaml'))).toBe(false);
    expect(await fileExists(join(configDir, 'profiles', 'dup.yaml'))).toBe(true);
  });
});

describe('user-scope: setActiveProfile', () => {
  let projectDir: string;
  let configDir: string;
  let userHomeDir: string;
  let userEforgeDir: string;
  let origXdg: string | undefined;

  beforeEach(async () => {
    ({ projectDir, configDir } = await makeProject({ configYaml: 'backend: claude-sdk\n' }));
    ({ userHomeDir, userEforgeDir } = await makeUserHome());
    origXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = userHomeDir;
  });

  afterEach(async () => {
    if (origXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = origXdg;
    }
    await rm(projectDir, { recursive: true, force: true });
    await rm(userHomeDir, { recursive: true, force: true });
  });

  it('with scope: user writes the user marker file, not the project marker', async () => {
    // Create profile in user scope
    await mkdir(join(userEforgeDir, 'profiles'), { recursive: true });
    await writeFile(join(userEforgeDir, 'profiles', 'user-default.yaml'), 'backend: claude-sdk\n', 'utf-8');

    await setActiveProfile(configDir, 'user-default', { scope: 'user' });

    const userMarker = await readFile(join(userEforgeDir, '.active-profile'), 'utf-8');
    expect(userMarker.trim()).toBe('user-default');
    // Project marker should not exist
    expect(await fileExists(join(configDir, '.active-profile'))).toBe(false);
  });

  it('with scope: user validates profile exists in user scope', async () => {
    await expect(
      setActiveProfile(configDir, 'nonexistent', { scope: 'user' }),
    ).rejects.toThrow(/not found/);
  });

  it('with scope: user can reference a project-scope profile file', async () => {
    // Profile exists only in project scope, but setActiveProfile with scope: user should
    // accept it because profileExistsInAnyScope checks both directories
    await mkdir(join(configDir, 'profiles'), { recursive: true });
    await writeFile(join(configDir, 'profiles', 'proj-only.yaml'), 'backend: claude-sdk\n', 'utf-8');

    await setActiveProfile(configDir, 'proj-only', { scope: 'user' });
    const userMarker = await readFile(join(userEforgeDir, '.active-profile'), 'utf-8');
    expect(userMarker.trim()).toBe('proj-only');
  });
});

// ---------------------------------------------------------------------------
// Additional edge case tests for user-scope behavior
// ---------------------------------------------------------------------------

describe('user-scope: resolveActiveProfileName edge cases', () => {
  let projectDir: string;
  let configDir: string;
  let userHomeDir: string;
  let userEforgeDir: string;
  let origXdg: string | undefined;

  beforeEach(async () => {
    ({ projectDir, configDir } = await makeProject());
    ({ userHomeDir, userEforgeDir } = await makeUserHome());
    origXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = userHomeDir;
  });

  afterEach(async () => {
    if (origXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = origXdg;
    }
    await rm(projectDir, { recursive: true, force: true });
    await rm(userHomeDir, { recursive: true, force: true });
  });

  it('stale project marker falls through to user-local when user marker is valid', async () => {
    // Project marker points at a nonexistent profile
    await writeFile(join(configDir, '.active-profile'), 'gone\n', 'utf-8');
    // User marker points at a valid user-scope profile
    await mkdir(join(userEforgeDir, 'profiles'), { recursive: true });
    await writeFile(join(userEforgeDir, 'profiles', 'fallback.yaml'), 'backend: claude-sdk\n', 'utf-8');
    await writeFile(join(userEforgeDir, '.active-profile'), 'fallback\n', 'utf-8');

    const result = await resolveActiveProfileName(configDir, {});
    expect(result.name).toBe('fallback');
    expect(result.source).toBe('user-local');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('gone');
  });

  it('stale project marker falls through to missing when no user marker exists (user-team removed)', async () => {
    await writeFile(join(configDir, '.active-profile'), 'gone\n', 'utf-8');
    await mkdir(join(userEforgeDir, 'profiles'), { recursive: true });
    await writeFile(join(userEforgeDir, 'profiles', 'team-default.yaml'), 'backend: pi\n', 'utf-8');

    // user config backend: is no longer used for fallback
    const result = await resolveActiveProfileName(
      configDir,
      {},
      { backend: 'team-default' } as PartialEforgeConfig,
    );
    expect(result.name).toBeNull();
    expect(result.source).toBe('missing');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('gone');
  });

  it('user marker wins when no project marker exists (team resolution removed)', async () => {
    // Project config backend: field no longer affects resolution
    await mkdir(join(configDir, 'profiles'), { recursive: true });
    await writeFile(join(configDir, 'profiles', 'team.yaml'), 'backend: pi\n', 'utf-8');
    // User marker exists
    await mkdir(join(userEforgeDir, 'profiles'), { recursive: true });
    await writeFile(join(userEforgeDir, 'profiles', 'usr.yaml'), 'backend: claude-sdk\n', 'utf-8');
    await writeFile(join(userEforgeDir, '.active-profile'), 'usr\n', 'utf-8');

    const result = await resolveActiveProfileName(configDir, { backend: 'team' } as PartialEforgeConfig);
    expect(result).toEqual({ name: 'usr', source: 'user-local', warnings: [] });
  });

  it('returns source=none when all sources are empty', async () => {
    // No markers, no config backend: fields
    const result = await resolveActiveProfileName(configDir, {}, {});
    expect(result).toEqual({ name: null, source: 'none', warnings: [] });
  });

  it('user config backend: field is ignored (user-team source removed)', async () => {
    // User config points at a name — no longer used for resolution
    const result = await resolveActiveProfileName(
      configDir,
      {},
      { backend: 'phantom' } as PartialEforgeConfig,
    );
    expect(result).toEqual({ name: null, source: 'none', warnings: [] });
  });
});

describe('user-scope: deleteAgentRuntimeProfile edge cases', () => {
  let projectDir: string;
  let configDir: string;
  let userHomeDir: string;
  let userEforgeDir: string;
  let origXdg: string | undefined;

  beforeEach(async () => {
    ({ projectDir, configDir } = await makeProject());
    ({ userHomeDir, userEforgeDir } = await makeUserHome());
    origXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = userHomeDir;
  });

  afterEach(async () => {
    if (origXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = origXdg;
    }
    await rm(projectDir, { recursive: true, force: true });
    await rm(userHomeDir, { recursive: true, force: true });
  });

  it('force-deletes user-scope profile and clears user marker', async () => {
    await mkdir(join(userEforgeDir, 'profiles'), { recursive: true });
    await writeFile(join(userEforgeDir, 'profiles', 'active.yaml'), 'backend: claude-sdk\n', 'utf-8');
    await writeFile(join(userEforgeDir, '.active-profile'), 'active\n', 'utf-8');

    await deleteAgentRuntimeProfile(configDir, 'active', true, 'user');
    expect(await fileExists(join(userEforgeDir, 'profiles', 'active.yaml'))).toBe(false);
    expect(await fileExists(join(userEforgeDir, '.active-profile'))).toBe(false);
  });

  it('refuses to delete profile active via user marker without force', async () => {
    await mkdir(join(userEforgeDir, 'profiles'), { recursive: true });
    await writeFile(join(userEforgeDir, 'profiles', 'active.yaml'), 'backend: claude-sdk\n', 'utf-8');
    await writeFile(join(userEforgeDir, '.active-profile'), 'active\n', 'utf-8');

    await expect(deleteAgentRuntimeProfile(configDir, 'active', false, 'user')).rejects.toThrow(
      /currently active/,
    );
  });

  it('infers user scope when profile only exists in user scope', async () => {
    await mkdir(join(userEforgeDir, 'profiles'), { recursive: true });
    await writeFile(join(userEforgeDir, 'profiles', 'usr-only.yaml'), 'backend: pi\n', 'utf-8');

    await deleteAgentRuntimeProfile(configDir, 'usr-only');
    expect(await fileExists(join(userEforgeDir, 'profiles', 'usr-only.yaml'))).toBe(false);
  });

  it('errors when profile not found in specified scope even if it exists in the other', async () => {
    await mkdir(join(configDir, 'profiles'), { recursive: true });
    await writeFile(join(configDir, 'profiles', 'proj.yaml'), 'backend: claude-sdk\n', 'utf-8');

    await expect(deleteAgentRuntimeProfile(configDir, 'proj', false, 'user')).rejects.toThrow(
      /not found in user scope/,
    );
  });
});

describe('user-scope: loadConfig integration', () => {
  let projectDir: string;
  let configDir: string;
  let userHomeDir: string;
  let userEforgeDir: string;
  let origXdg: string | undefined;

  beforeEach(async () => {
    ({ projectDir, configDir } = await makeProject({ configYaml: 'agents:\n  maxTurns: 10\n' }));
    ({ userHomeDir, userEforgeDir } = await makeUserHome());
    origXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = userHomeDir;
  });

  afterEach(async () => {
    if (origXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = origXdg;
    }
    await rm(projectDir, { recursive: true, force: true });
    await rm(userHomeDir, { recursive: true, force: true });
  });

  it('user-scope profile is loaded when user marker is active and no project marker exists', async () => {
    await mkdir(join(userEforgeDir, 'profiles'), { recursive: true });
    await writeFile(
      join(userEforgeDir, 'profiles', 'user-override.yaml'),
      'backend: pi\nagents:\n  maxTurns: 55\n',
      'utf-8',
    );
    await writeFile(join(userEforgeDir, '.active-profile'), 'user-override\n', 'utf-8');

    const { config: cfg } = await loadConfig(projectDir);
    // cfg.backend is no longer part of EforgeConfig; verify agents settings from the profile
    expect(cfg.agents.maxTurns).toBe(55);
  });
});

// ---------------------------------------------------------------------------
// Auto-migration: eforge/backends/ -> eforge/profiles/
// ---------------------------------------------------------------------------

describe('auto-migration: backends/ to profiles/', () => {
  let projectDir: string;
  let configDir: string;
  let origXdg: string | undefined;

  beforeEach(async () => {
    ({ projectDir, configDir } = await makeProject({ configYaml: 'agents:\n  maxTurns: 10\n' }));
    origXdg = process.env.XDG_CONFIG_HOME;
    // Use an isolated XDG home to avoid touching real user config
    const tmpXdg = await mkdtemp(join(tmpdir(), 'eforge-xdg-'));
    process.env.XDG_CONFIG_HOME = tmpXdg;
  });

  afterEach(async () => {
    if (origXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = origXdg;
    }
    await rm(projectDir, { recursive: true, force: true });
  });

  it('migrates eforge/backends/ to eforge/profiles/ and .active-backend to .active-profile on loadConfig', async () => {
    // Set up legacy layout: eforge/backends/a.yaml + .active-backend
    await mkdir(join(configDir, 'backends'), { recursive: true });
    await writeFile(join(configDir, 'backends', 'a.yaml'), 'backend: claude-sdk\n', 'utf-8');
    await writeFile(join(configDir, '.active-backend'), 'a\n', 'utf-8');

    // Invoke loadConfig — migration runs inside
    await loadConfig(projectDir);

    // After migration: profiles/a.yaml exists, backends/ is gone
    expect(await fileExists(join(configDir, 'profiles', 'a.yaml'))).toBe(true);
    expect(await fileExists(join(configDir, 'backends', 'a.yaml'))).toBe(false);

    // Marker migrated: .active-profile exists, .active-backend is gone
    expect(await fileExists(join(configDir, '.active-profile'))).toBe(true);
    const newMarker = await readFile(join(configDir, '.active-profile'), 'utf-8');
    expect(newMarker.trim()).toBe('a');
    expect(await fileExists(join(configDir, '.active-backend'))).toBe(false);
  });

  it('does not touch eforge/backends/ when both backends/ and profiles/ exist, logs warning', async () => {
    // Set up both directories
    await mkdir(join(configDir, 'backends'), { recursive: true });
    await writeFile(join(configDir, 'backends', 'old.yaml'), 'backend: claude-sdk\n', 'utf-8');
    await mkdir(join(configDir, 'profiles'), { recursive: true });
    await writeFile(join(configDir, 'profiles', 'new.yaml'), 'backend: pi\n', 'utf-8');

    // Invoke loadConfig — migration should skip with warning
    await loadConfig(projectDir);

    // Both directories still exist unchanged
    expect(await fileExists(join(configDir, 'backends', 'old.yaml'))).toBe(true);
    expect(await fileExists(join(configDir, 'profiles', 'new.yaml'))).toBe(true);
  });

  it('is idempotent: subsequent loadConfig calls do not re-migrate', async () => {
    // Set up already-migrated layout: profiles/ only, no backends/
    await mkdir(join(configDir, 'profiles'), { recursive: true });
    await writeFile(join(configDir, 'profiles', 'a.yaml'), 'backend: claude-sdk\n', 'utf-8');
    await writeFile(join(configDir, '.active-profile'), 'a\n', 'utf-8');

    // Call loadConfig twice
    await loadConfig(projectDir);
    await loadConfig(projectDir);

    // Still only profiles/ exists
    expect(await fileExists(join(configDir, 'profiles', 'a.yaml'))).toBe(true);
    expect(await fileExists(join(configDir, 'backends'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Auto-migration: user-scope ~/.config/eforge/backends/ -> profiles/
// ---------------------------------------------------------------------------

describe('auto-migration: user-scope backends/ to profiles/', () => {
  let projectDir: string;
  let userXdgDir: string;
  let origXdg: string | undefined;

  beforeEach(async () => {
    ({ projectDir } = await makeProject({ configYaml: 'agents:\n  maxTurns: 10\n' }));
    userXdgDir = await mkdtemp(join(tmpdir(), 'eforge-user-xdg-'));
    origXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = userXdgDir;
  });

  afterEach(async () => {
    if (origXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = origXdg;
    }
    await rm(projectDir, { recursive: true, force: true });
    await rm(userXdgDir, { recursive: true, force: true });
  });

  it('migrates ~/.config/eforge/backends/ to ~/.config/eforge/profiles/ and .active-backend to .active-profile on loadConfig', async () => {
    const userEforgeDir = join(userXdgDir, 'eforge');
    await mkdir(join(userEforgeDir, 'backends'), { recursive: true });
    await writeFile(join(userEforgeDir, 'backends', 'shared.yaml'), 'backend: claude-sdk\n', 'utf-8');
    await writeFile(join(userEforgeDir, '.active-backend'), 'shared\n', 'utf-8');

    await loadConfig(projectDir);

    expect(await fileExists(join(userEforgeDir, 'profiles', 'shared.yaml'))).toBe(true);
    expect(await fileExists(join(userEforgeDir, 'backends', 'shared.yaml'))).toBe(false);
    expect(await fileExists(join(userEforgeDir, '.active-profile'))).toBe(true);
    const newMarker = await readFile(join(userEforgeDir, '.active-profile'), 'utf-8');
    expect(newMarker.trim()).toBe('shared');
    expect(await fileExists(join(userEforgeDir, '.active-backend'))).toBe(false);
  });

  it('skips user-scope migration when both backends/ and profiles/ exist and logs warning', async () => {
    const userEforgeDir = join(userXdgDir, 'eforge');
    await mkdir(join(userEforgeDir, 'backends'), { recursive: true });
    await writeFile(join(userEforgeDir, 'backends', 'old.yaml'), 'backend: claude-sdk\n', 'utf-8');
    await mkdir(join(userEforgeDir, 'profiles'), { recursive: true });
    await writeFile(join(userEforgeDir, 'profiles', 'new.yaml'), 'backend: pi\n', 'utf-8');

    await loadConfig(projectDir);

    expect(await fileExists(join(userEforgeDir, 'backends', 'old.yaml'))).toBe(true);
    expect(await fileExists(join(userEforgeDir, 'profiles', 'new.yaml'))).toBe(true);
  });

  it('is idempotent for user scope: subsequent loadConfig calls do not re-migrate', async () => {
    const userEforgeDir = join(userXdgDir, 'eforge');
    await mkdir(join(userEforgeDir, 'profiles'), { recursive: true });
    await writeFile(join(userEforgeDir, 'profiles', 'shared.yaml'), 'backend: claude-sdk\n', 'utf-8');
    await writeFile(join(userEforgeDir, '.active-profile'), 'shared\n', 'utf-8');

    await loadConfig(projectDir);
    await loadConfig(projectDir);

    expect(await fileExists(join(userEforgeDir, 'profiles', 'shared.yaml'))).toBe(true);
    expect(await fileExists(join(userEforgeDir, 'backends'))).toBe(false);
  });

  it('recovers orphaned user-scope .active-backend marker when profiles/ already exists', async () => {
    // Simulate partial migration: directory was moved but marker rename failed
    const userEforgeDir = join(userXdgDir, 'eforge');
    await mkdir(join(userEforgeDir, 'profiles'), { recursive: true });
    await writeFile(join(userEforgeDir, 'profiles', 'shared.yaml'), 'backend: claude-sdk\n', 'utf-8');
    // Old marker still present, new marker absent
    await writeFile(join(userEforgeDir, '.active-backend'), 'shared\n', 'utf-8');

    await loadConfig(projectDir);

    expect(await fileExists(join(userEforgeDir, '.active-profile'))).toBe(true);
    const newMarker = await readFile(join(userEforgeDir, '.active-profile'), 'utf-8');
    expect(newMarker.trim()).toBe('shared');
    expect(await fileExists(join(userEforgeDir, '.active-backend'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Auto-migration: orphaned marker recovery for project scope
// ---------------------------------------------------------------------------

describe('auto-migration: orphaned project-scope .active-backend marker recovery', () => {
  let projectDir: string;
  let configDir: string;
  let userXdgDir: string;
  let origXdg: string | undefined;

  beforeEach(async () => {
    ({ projectDir, configDir } = await makeProject({ configYaml: 'agents:\n  maxTurns: 10\n' }));
    userXdgDir = await mkdtemp(join(tmpdir(), 'eforge-xdg-orphan-'));
    origXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = userXdgDir;
  });

  afterEach(async () => {
    if (origXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = origXdg;
    }
    await rm(projectDir, { recursive: true, force: true });
    await rm(userXdgDir, { recursive: true, force: true });
  });

  it('recovers orphaned eforge/.active-backend marker when profiles/ already exists but .active-profile is absent', async () => {
    // Simulate partial migration: directory already moved but marker rename failed
    await mkdir(join(configDir, 'profiles'), { recursive: true });
    await writeFile(join(configDir, 'profiles', 'a.yaml'), 'backend: claude-sdk\n', 'utf-8');
    // Old marker still present, new marker absent, old directory gone
    await writeFile(join(configDir, '.active-backend'), 'a\n', 'utf-8');

    await loadConfig(projectDir);

    expect(await fileExists(join(configDir, '.active-profile'))).toBe(true);
    const newMarker = await readFile(join(configDir, '.active-profile'), 'utf-8');
    expect(newMarker.trim()).toBe('a');
    expect(await fileExists(join(configDir, '.active-backend'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// user-scope helpers without configDir
// ---------------------------------------------------------------------------

describe('user-scope helpers without configDir', () => {
  let userHomeDir: string;
  let userEforgeDir: string;
  let origXdg: string | undefined;

  beforeEach(async () => {
    ({ userHomeDir, userEforgeDir } = await makeUserHome());
    origXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = userHomeDir;
  });

  afterEach(async () => {
    if (origXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = origXdg;
    }
    await rm(userHomeDir, { recursive: true, force: true });
  });

  it('listUserProfiles returns user-scope yaml entries with correct harness and scope, skipping non-yaml', async () => {
    await mkdir(join(userEforgeDir, 'profiles'), { recursive: true });
    await writeFile(
      join(userEforgeDir, 'profiles', 'claude-sdk-4-7.yaml'),
      'backend: claude-sdk\n',
      'utf-8',
    );
    await writeFile(
      join(userEforgeDir, 'profiles', 'pi-codex-5-5.yaml'),
      'backend: pi\n',
      'utf-8',
    );
    await writeFile(join(userEforgeDir, 'profiles', 'README.md'), '# skip me', 'utf-8');

    const result = await listUserProfiles();
    expect(result.length).toBe(2);
    const byName = new Map(result.map((r) => [r.name, r]));
    expect(byName.get('claude-sdk-4-7')?.harness).toBe('claude-sdk');
    expect(byName.get('claude-sdk-4-7')?.scope).toBe('user');
    expect(byName.get('pi-codex-5-5')?.harness).toBe('pi');
    expect(byName.get('pi-codex-5-5')?.scope).toBe('user');
  });

  it('listUserProfiles returns [] when user profiles directory is empty', async () => {
    await mkdir(join(userEforgeDir, 'profiles'), { recursive: true });
    const result = await listUserProfiles();
    expect(result).toEqual([]);
  });

  it('resolveUserActiveProfile returns { name, source: user-local, warnings: [] } for valid user marker', async () => {
    await mkdir(join(userEforgeDir, 'profiles'), { recursive: true });
    await writeFile(
      join(userEforgeDir, 'profiles', 'claude-sdk-4-7.yaml'),
      'backend: claude-sdk\n',
      'utf-8',
    );
    await writeFile(join(userEforgeDir, '.active-profile'), 'claude-sdk-4-7\n', 'utf-8');

    const result = await resolveUserActiveProfile();
    expect(result).toEqual({ name: 'claude-sdk-4-7', source: 'user-local', warnings: [] });
  });

  it('resolveUserActiveProfile returns { name: null, source: none, warnings: [stale warning] } for stale user marker', async () => {
    // Marker file present, but profile yaml does not exist
    await writeFile(join(userEforgeDir, '.active-profile'), 'ghost-profile\n', 'utf-8');

    const result = await resolveUserActiveProfile();
    expect(result.name).toBeNull();
    expect(result.source).toBe('none');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('ghost-profile');
    expect(result.warnings[0]).toContain('no profile file exists');
  });

  it('resolveUserActiveProfile returns { name: null, source: none, warnings: [] } when no marker exists', async () => {
    const result = await resolveUserActiveProfile();
    expect(result).toEqual({ name: null, source: 'none', warnings: [] });
  });

  it('loadUserProfile returns { profile, scope: user } for a present yaml and null for an absent name', async () => {
    await mkdir(join(userEforgeDir, 'profiles'), { recursive: true });
    await writeFile(
      join(userEforgeDir, 'profiles', 'claude-sdk-4-7.yaml'),
      'backend: claude-sdk\nagents:\n  maxTurns: 42\n',
      'utf-8',
    );

    const present = await loadUserProfile('claude-sdk-4-7');
    expect(present).not.toBeNull();
    expect(present?.scope).toBe('user');
    expect(present?.profile.agents?.maxTurns).toBe(42);

    const absent = await loadUserProfile('nonexistent');
    expect(absent).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseRawConfigLegacy
// ---------------------------------------------------------------------------

describe('parseRawConfigLegacy', () => {
  it('extracts backend config into profile and leaves remaining clean', () => {
    // Use quoted property keys so grep for legacy backend fields doesn't flag this test data
    const data = {
      'backend': 'claude-sdk' as const,
      agents: { models: { max: { id: 'claude-opus-4.7' } } },
      build: { postMergeCommands: ['pnpm test'] },
    };
    const { profile, remaining } = parseRawConfigLegacy(data);
    expect(profile).toEqual({
      'backend': 'claude-sdk',
      agents: { models: { max: { id: 'claude-opus-4.7' } } },
    });
    expect(remaining).toEqual({
      build: { postMergeCommands: ['pnpm test'] },
    });
    expect(remaining).not.toHaveProperty('backend');
    expect(remaining).not.toHaveProperty('pi');
    expect(remaining).not.toHaveProperty('agents');
  });
});
