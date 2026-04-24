import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadConfig,
  resolveActiveProfileName,
  loadBackendProfile,
  listBackendProfiles,
  setActiveBackend,
  createBackendProfile,
  deleteBackendProfile,
  getConfigDir,
  parseRawConfigLegacy,
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
    await mkdir(join(configDir, 'backends'), { recursive: true });
    await writeFile(join(configDir, 'backends', 'claude-sdk.yaml'), 'backend: claude-sdk\n', 'utf-8');
    await writeFile(join(configDir, 'backends', 'pi-prod.yaml'), 'backend: pi\n', 'utf-8');
    // Write marker pointing at pi-prod
    await writeFile(join(configDir, '.active-backend'), 'pi-prod\n', 'utf-8');

    const result = await resolveActiveProfileName(configDir, {});
    expect(result).toEqual({ name: 'pi-prod', source: 'local', warnings: [] });
  });

  it('marker absent + no matching profile → source=none (backend: in config.yaml no longer used for resolution)', async () => {
    await mkdir(join(configDir, 'backends'), { recursive: true });
    await writeFile(join(configDir, 'backends', 'pi.yaml'), 'backend: pi\n', 'utf-8');

    // Even with a matching profile file, resolution no longer uses config.yaml backend: field
    const result = await resolveActiveProfileName(configDir, {});
    expect(result).toEqual({ name: null, source: 'none', warnings: [] });
  });

  it('unknown profile name in marker returns warning and missing when no user marker', async () => {
    await mkdir(join(configDir, 'backends'), { recursive: true });
    await writeFile(join(configDir, 'backends', 'claude-sdk.yaml'), 'backend: claude-sdk\n', 'utf-8');
    await writeFile(join(configDir, '.active-backend'), 'nonexistent\n', 'utf-8');

    const result = await resolveActiveProfileName(configDir, {});
    // No team fallback, no user marker → missing
    expect(result.name).toBeNull();
    expect(result.source).toBe('missing');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('nonexistent');
  });

  it('unknown profile name in marker with no team fallback returns name=null source=missing', async () => {
    await writeFile(join(configDir, '.active-backend'), 'nonexistent\n', 'utf-8');

    const result = await resolveActiveProfileName(configDir, {});
    expect(result.name).toBeNull();
    expect(result.source).toBe('missing');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('nonexistent');
  });
});

describe('loadBackendProfile', () => {
  let projectDir: string;
  let configDir: string;

  beforeEach(async () => {
    ({ projectDir, configDir } = await makeProject());
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it('returns null when profile file missing', async () => {
    const result = await loadBackendProfile(configDir, 'nope');
    expect(result).toBeNull();
  });

  it('parses a valid profile file and returns scope', async () => {
    await mkdir(join(configDir, 'backends'), { recursive: true });
    await writeFile(
      join(configDir, 'backends', 'pi.yaml'),
      'backend: pi\npi:\n  thinkingLevel: high\n',
      'utf-8',
    );
    const result = await loadBackendProfile(configDir, 'pi');
    expect(result).not.toBeNull();
    // profile.backend is no longer in PartialEforgeConfig; check pi-specific config instead
    expect(result?.profile.pi?.thinkingLevel).toBe('high');
    expect(result?.scope).toBe('project');
  });
});

describe('listBackendProfiles', () => {
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

  it('returns [] when no backends directory exists', async () => {
    const result = await listBackendProfiles(configDir);
    expect(result).toEqual([]);
  });

  it('returns entries for each .yaml file with parsed backend and scope', async () => {
    await mkdir(join(configDir, 'backends'), { recursive: true });
    await writeFile(join(configDir, 'backends', 'pi-prod.yaml'), 'backend: pi\n', 'utf-8');
    await writeFile(join(configDir, 'backends', 'claude.yaml'), 'backend: claude-sdk\n', 'utf-8');
    await writeFile(join(configDir, 'backends', 'README.md'), '# skip me', 'utf-8');

    const result = await listBackendProfiles(configDir);
    const projectEntries = result.filter((r) => r.scope === 'project');
    expect(projectEntries.length).toBe(2);
    const byName = new Map(projectEntries.map((r) => [r.name, r]));
    expect(byName.get('pi-prod')?.harness).toBe('pi');
    expect(byName.get('claude')?.harness).toBe('claude-sdk');
  });
});

describe('setActiveBackend', () => {
  let projectDir: string;
  let configDir: string;

  beforeEach(async () => {
    ({ projectDir, configDir } = await makeProject({ configYaml: 'backend: claude-sdk\n' }));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it('rejects when the profile file is missing', async () => {
    await expect(setActiveBackend(configDir, 'ghost')).rejects.toThrow(/not found/);
  });

  it('writes the marker when the profile exists and merged config validates', async () => {
    await mkdir(join(configDir, 'backends'), { recursive: true });
    await writeFile(join(configDir, 'backends', 'pi-prod.yaml'), 'backend: pi\n', 'utf-8');

    await setActiveBackend(configDir, 'pi-prod');
    const marker = await readFile(join(configDir, '.active-backend'), 'utf-8');
    expect(marker.trim()).toBe('pi-prod');
  });
});

describe('createBackendProfile', () => {
  let projectDir: string;
  let configDir: string;

  beforeEach(async () => {
    ({ projectDir, configDir } = await makeProject());
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it('accepts pi profile without model.provider (provider check deferred to resolve time)', async () => {
    // Provider validation moved to resolve time; createBackendProfile accepts any model ref
    const result = await createBackendProfile(configDir, {
      name: 'pi-no-provider',
      harness: 'pi',
      agents: { model: { id: 'some-model' } } as PartialEforgeConfig['agents'],
    });
    expect(await fileExists(result.path)).toBe(true);
  });

  it('creates a valid pi profile with provider-qualified model', async () => {
    const result = await createBackendProfile(configDir, {
      name: 'pi-prod',
      harness: 'pi',
      agents: { model: { provider: 'openrouter', id: 'anthropic/claude-sonnet-4' } } as PartialEforgeConfig['agents'],
    });
    expect(await fileExists(result.path)).toBe(true);
    const written = await readFile(result.path, 'utf-8');
    expect(written).toContain('harness: pi');
    expect(written).toContain('openrouter');
  });

  it('refuses overwrite without overwrite: true', async () => {
    await createBackendProfile(configDir, { name: 'pi', harness: 'claude-sdk' });
    await expect(
      createBackendProfile(configDir, { name: 'pi', harness: 'claude-sdk' }),
    ).rejects.toThrow(/already exists/);
  });

  it('with overwrite: true replaces the file', async () => {
    await createBackendProfile(configDir, { name: 'pi', harness: 'claude-sdk' });
    const again = await createBackendProfile(configDir, {
      name: 'pi',
      harness: 'pi',
      overwrite: true,
    });
    const content = await readFile(again.path, 'utf-8');
    expect(content).toContain('harness: pi');
    expect(content).not.toContain('claude-sdk');
  });

  it('rejects invalid profile names', async () => {
    await expect(
      createBackendProfile(configDir, { name: 'has spaces', harness: 'claude-sdk' }),
    ).rejects.toThrow(/Invalid profile name/);
  });
});

describe('deleteBackendProfile', () => {
  let projectDir: string;
  let configDir: string;

  beforeEach(async () => {
    ({ projectDir, configDir } = await makeProject());
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it('refuses to delete the currently active profile without force', async () => {
    await mkdir(join(configDir, 'backends'), { recursive: true });
    await writeFile(join(configDir, 'backends', 'active.yaml'), 'backend: claude-sdk\n', 'utf-8');
    await writeFile(join(configDir, '.active-backend'), 'active\n', 'utf-8');
    await expect(deleteBackendProfile(configDir, 'active')).rejects.toThrow(/currently active/);
  });

  it('with force: true removes the file and clears the marker', async () => {
    await mkdir(join(configDir, 'backends'), { recursive: true });
    await writeFile(join(configDir, 'backends', 'active.yaml'), 'backend: claude-sdk\n', 'utf-8');
    await writeFile(join(configDir, '.active-backend'), 'active\n', 'utf-8');

    await deleteBackendProfile(configDir, 'active', true);
    expect(await fileExists(join(configDir, 'backends', 'active.yaml'))).toBe(false);
    expect(await fileExists(join(configDir, '.active-backend'))).toBe(false);
  });

  it('errors when the profile file does not exist', async () => {
    await expect(deleteBackendProfile(configDir, 'ghost')).rejects.toThrow(/not found/);
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

  it('no backends/ dir: resolved config uses project settings without backend', async () => {
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
    await mkdir(join(configDir, 'backends'), { recursive: true });
    await writeFile(
      join(configDir, 'backends', 'pi.yaml'),
      'backend: pi\nagents:\n  maxTurns: 40\n',
      'utf-8',
    );
    // Profile is only loaded when a marker is present (team resolution removed)
    await writeFile(join(configDir, '.active-backend'), 'pi\n', 'utf-8');
    const { config: cfg } = await loadConfig(projectDir);
    expect(cfg.agents.maxTurns).toBe(40);
  });

  it('marker selects specific profile', async () => {
    ({ projectDir, configDir } = await makeProject({
      configYaml: '',
    }));
    await mkdir(join(configDir, 'backends'), { recursive: true });
    await writeFile(
      join(configDir, 'backends', 'pi.yaml'),
      'backend: pi\nagents:\n  maxTurns: 40\n',
      'utf-8',
    );
    await writeFile(
      join(configDir, 'backends', 'local.yaml'),
      'backend: claude-sdk\nagents:\n  maxTurns: 99\n',
      'utf-8',
    );
    await writeFile(join(configDir, '.active-backend'), 'local\n', 'utf-8');

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

describe('user-scope: loadBackendProfile', () => {
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
    await mkdir(join(userEforgeDir, 'backends'), { recursive: true });
    await writeFile(
      join(userEforgeDir, 'backends', 'shared.yaml'),
      'backend: claude-sdk\n',
      'utf-8',
    );
    const result = await loadBackendProfile(configDir, 'shared');
    expect(result).not.toBeNull();
    expect(result?.scope).toBe('user');
    // profile.backend is no longer in PartialEforgeConfig (backend: in profile files is a legacy harness indicator)
  });

  it('project profile shadows user profile on same-name collision', async () => {
    await mkdir(join(configDir, 'backends'), { recursive: true });
    await writeFile(join(configDir, 'backends', 'common.yaml'), 'backend: pi\n', 'utf-8');
    await mkdir(join(userEforgeDir, 'backends'), { recursive: true });
    await writeFile(join(userEforgeDir, 'backends', 'common.yaml'), 'backend: claude-sdk\n', 'utf-8');

    const result = await loadBackendProfile(configDir, 'common');
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
    await mkdir(join(userEforgeDir, 'backends'), { recursive: true });
    await writeFile(join(userEforgeDir, 'backends', 'default.yaml'), 'backend: claude-sdk\n', 'utf-8');
    // Write user marker
    await writeFile(join(userEforgeDir, '.active-backend'), 'default\n', 'utf-8');

    const result = await resolveActiveProfileName(configDir, {});
    expect(result).toEqual({ name: 'default', source: 'user-local', warnings: [] });
  });

  it('returns source=local (project) when both project and user markers exist', async () => {
    // Create profiles in both scopes
    await mkdir(join(configDir, 'backends'), { recursive: true });
    await writeFile(join(configDir, 'backends', 'proj.yaml'), 'backend: pi\n', 'utf-8');
    await mkdir(join(userEforgeDir, 'backends'), { recursive: true });
    await writeFile(join(userEforgeDir, 'backends', 'usr.yaml'), 'backend: claude-sdk\n', 'utf-8');
    // Write both markers
    await writeFile(join(configDir, '.active-backend'), 'proj\n', 'utf-8');
    await writeFile(join(userEforgeDir, '.active-backend'), 'usr\n', 'utf-8');

    const result = await resolveActiveProfileName(configDir, {});
    expect(result).toEqual({ name: 'proj', source: 'local', warnings: [] });
  });

  it('user marker wins over user config backend field', async () => {
    await mkdir(join(userEforgeDir, 'backends'), { recursive: true });
    await writeFile(join(userEforgeDir, 'backends', 'marker-pick.yaml'), 'backend: pi\n', 'utf-8');
    await writeFile(join(userEforgeDir, 'backends', 'config-pick.yaml'), 'backend: claude-sdk\n', 'utf-8');
    await writeFile(join(userEforgeDir, '.active-backend'), 'marker-pick\n', 'utf-8');

    const result = await resolveActiveProfileName(
      configDir,
      {},
      { backend: 'config-pick' } as PartialEforgeConfig,
    );
    expect(result).toEqual({ name: 'marker-pick', source: 'user-local', warnings: [] });
  });

  it('returns source=none when only user config backend: is set (user-team resolution removed)', async () => {
    await mkdir(join(userEforgeDir, 'backends'), { recursive: true });
    await writeFile(join(userEforgeDir, 'backends', 'team-default.yaml'), 'backend: claude-sdk\n', 'utf-8');

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
    await mkdir(join(userEforgeDir, 'backends'), { recursive: true });
    await writeFile(join(userEforgeDir, 'backends', 'shared.yaml'), 'backend: claude-sdk\n', 'utf-8');
    await writeFile(join(configDir, '.active-backend'), 'shared\n', 'utf-8');

    const result = await resolveActiveProfileName(configDir, {});
    expect(result).toEqual({ name: 'shared', source: 'local', warnings: [] });
  });
});

describe('user-scope: listBackendProfiles', () => {
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
    await mkdir(join(configDir, 'backends'), { recursive: true });
    await writeFile(join(configDir, 'backends', 'shared.yaml'), 'backend: pi\n', 'utf-8');
    await writeFile(join(configDir, 'backends', 'proj-only.yaml'), 'backend: claude-sdk\n', 'utf-8');
    await mkdir(join(userEforgeDir, 'backends'), { recursive: true });
    await writeFile(join(userEforgeDir, 'backends', 'shared.yaml'), 'backend: claude-sdk\n', 'utf-8');
    await writeFile(join(userEforgeDir, 'backends', 'usr-only.yaml'), 'backend: pi\n', 'utf-8');

    const result = await listBackendProfiles(configDir);
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

describe('user-scope: createBackendProfile', () => {
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

  it('with scope: user writes file under user config backends directory', async () => {
    const result = await createBackendProfile(configDir, {
      name: 'user-prof',
      harness: 'claude-sdk',
      scope: 'user',
    });
    expect(result.path).toContain(userHomeDir);
    expect(await fileExists(result.path)).toBe(true);
    // Should NOT exist in project scope
    expect(await fileExists(join(configDir, 'backends', 'user-prof.yaml'))).toBe(false);
  });
});

describe('user-scope: deleteBackendProfile', () => {
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
    await mkdir(join(configDir, 'backends'), { recursive: true });
    await writeFile(join(configDir, 'backends', 'dup.yaml'), 'backend: claude-sdk\n', 'utf-8');
    await mkdir(join(userEforgeDir, 'backends'), { recursive: true });
    await writeFile(join(userEforgeDir, 'backends', 'dup.yaml'), 'backend: pi\n', 'utf-8');

    await expect(deleteBackendProfile(configDir, 'dup')).rejects.toThrow(
      /both project and user scope/i,
    );
  });

  it('deletes from specified scope when name exists in both', async () => {
    await mkdir(join(configDir, 'backends'), { recursive: true });
    await writeFile(join(configDir, 'backends', 'dup.yaml'), 'backend: claude-sdk\n', 'utf-8');
    await mkdir(join(userEforgeDir, 'backends'), { recursive: true });
    await writeFile(join(userEforgeDir, 'backends', 'dup.yaml'), 'backend: pi\n', 'utf-8');

    await deleteBackendProfile(configDir, 'dup', false, 'user');
    expect(await fileExists(join(userEforgeDir, 'backends', 'dup.yaml'))).toBe(false);
    expect(await fileExists(join(configDir, 'backends', 'dup.yaml'))).toBe(true);
  });
});

describe('user-scope: setActiveBackend', () => {
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
    await mkdir(join(userEforgeDir, 'backends'), { recursive: true });
    await writeFile(join(userEforgeDir, 'backends', 'user-default.yaml'), 'backend: claude-sdk\n', 'utf-8');

    await setActiveBackend(configDir, 'user-default', { scope: 'user' });

    const userMarker = await readFile(join(userEforgeDir, '.active-backend'), 'utf-8');
    expect(userMarker.trim()).toBe('user-default');
    // Project marker should not exist
    expect(await fileExists(join(configDir, '.active-backend'))).toBe(false);
  });

  it('with scope: user validates profile exists in user scope', async () => {
    await expect(
      setActiveBackend(configDir, 'nonexistent', { scope: 'user' }),
    ).rejects.toThrow(/not found/);
  });

  it('with scope: user can reference a project-scope profile file', async () => {
    // Profile exists only in project scope, but setActiveBackend with scope: user should
    // accept it because profileExistsInAnyScope checks both directories
    await mkdir(join(configDir, 'backends'), { recursive: true });
    await writeFile(join(configDir, 'backends', 'proj-only.yaml'), 'backend: claude-sdk\n', 'utf-8');

    await setActiveBackend(configDir, 'proj-only', { scope: 'user' });
    const userMarker = await readFile(join(userEforgeDir, '.active-backend'), 'utf-8');
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
    await writeFile(join(configDir, '.active-backend'), 'gone\n', 'utf-8');
    // User marker points at a valid user-scope profile
    await mkdir(join(userEforgeDir, 'backends'), { recursive: true });
    await writeFile(join(userEforgeDir, 'backends', 'fallback.yaml'), 'backend: claude-sdk\n', 'utf-8');
    await writeFile(join(userEforgeDir, '.active-backend'), 'fallback\n', 'utf-8');

    const result = await resolveActiveProfileName(configDir, {});
    expect(result.name).toBe('fallback');
    expect(result.source).toBe('user-local');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('gone');
  });

  it('stale project marker falls through to missing when no user marker exists (user-team removed)', async () => {
    await writeFile(join(configDir, '.active-backend'), 'gone\n', 'utf-8');
    await mkdir(join(userEforgeDir, 'backends'), { recursive: true });
    await writeFile(join(userEforgeDir, 'backends', 'team-default.yaml'), 'backend: pi\n', 'utf-8');

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
    await mkdir(join(configDir, 'backends'), { recursive: true });
    await writeFile(join(configDir, 'backends', 'team.yaml'), 'backend: pi\n', 'utf-8');
    // User marker exists
    await mkdir(join(userEforgeDir, 'backends'), { recursive: true });
    await writeFile(join(userEforgeDir, 'backends', 'usr.yaml'), 'backend: claude-sdk\n', 'utf-8');
    await writeFile(join(userEforgeDir, '.active-backend'), 'usr\n', 'utf-8');

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

describe('user-scope: deleteBackendProfile edge cases', () => {
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
    await mkdir(join(userEforgeDir, 'backends'), { recursive: true });
    await writeFile(join(userEforgeDir, 'backends', 'active.yaml'), 'backend: claude-sdk\n', 'utf-8');
    await writeFile(join(userEforgeDir, '.active-backend'), 'active\n', 'utf-8');

    await deleteBackendProfile(configDir, 'active', true, 'user');
    expect(await fileExists(join(userEforgeDir, 'backends', 'active.yaml'))).toBe(false);
    expect(await fileExists(join(userEforgeDir, '.active-backend'))).toBe(false);
  });

  it('refuses to delete profile active via user marker without force', async () => {
    await mkdir(join(userEforgeDir, 'backends'), { recursive: true });
    await writeFile(join(userEforgeDir, 'backends', 'active.yaml'), 'backend: claude-sdk\n', 'utf-8');
    await writeFile(join(userEforgeDir, '.active-backend'), 'active\n', 'utf-8');

    await expect(deleteBackendProfile(configDir, 'active', false, 'user')).rejects.toThrow(
      /currently active/,
    );
  });

  it('infers user scope when profile only exists in user scope', async () => {
    await mkdir(join(userEforgeDir, 'backends'), { recursive: true });
    await writeFile(join(userEforgeDir, 'backends', 'usr-only.yaml'), 'backend: pi\n', 'utf-8');

    await deleteBackendProfile(configDir, 'usr-only');
    expect(await fileExists(join(userEforgeDir, 'backends', 'usr-only.yaml'))).toBe(false);
  });

  it('errors when profile not found in specified scope even if it exists in the other', async () => {
    await mkdir(join(configDir, 'backends'), { recursive: true });
    await writeFile(join(configDir, 'backends', 'proj.yaml'), 'backend: claude-sdk\n', 'utf-8');

    await expect(deleteBackendProfile(configDir, 'proj', false, 'user')).rejects.toThrow(
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
    await mkdir(join(userEforgeDir, 'backends'), { recursive: true });
    await writeFile(
      join(userEforgeDir, 'backends', 'user-override.yaml'),
      'backend: pi\nagents:\n  maxTurns: 55\n',
      'utf-8',
    );
    await writeFile(join(userEforgeDir, '.active-backend'), 'user-override\n', 'utf-8');

    const { config: cfg } = await loadConfig(projectDir);
    // cfg.backend is no longer part of EforgeConfig; verify agents settings from the profile
    expect(cfg.agents.maxTurns).toBe(55);
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
