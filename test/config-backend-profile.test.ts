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
  type PartialEforgeConfig,
} from '@eforge-build/engine/config';

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

  beforeEach(async () => {
    ({ projectDir, configDir } = await makeProject({ configYaml: 'backend: claude-sdk\n' }));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it('returns source=none when no marker and no matching team profile', async () => {
    const result = await resolveActiveProfileName(configDir, {});
    expect(result).toEqual({ name: null, source: 'none' });
  });

  it('marker present overrides config.yaml backend', async () => {
    // Create a team profile for claude-sdk
    await mkdir(join(configDir, 'backends'), { recursive: true });
    await writeFile(join(configDir, 'backends', 'claude-sdk.yaml'), 'backend: claude-sdk\n', 'utf-8');
    await writeFile(join(configDir, 'backends', 'pi-prod.yaml'), 'backend: pi\n', 'utf-8');
    // Write marker pointing at pi-prod
    await writeFile(join(configDir, '.active-backend'), 'pi-prod\n', 'utf-8');

    const result = await resolveActiveProfileName(configDir, { backend: 'claude-sdk' });
    expect(result).toEqual({ name: 'pi-prod', source: 'local' });
  });

  it('marker absent + config.yaml backend: pi + backends/pi.yaml → profile applied with source=team', async () => {
    await mkdir(join(configDir, 'backends'), { recursive: true });
    await writeFile(join(configDir, 'backends', 'pi.yaml'), 'backend: pi\n', 'utf-8');

    const result = await resolveActiveProfileName(configDir, { backend: 'pi' });
    expect(result).toEqual({ name: 'pi', source: 'team' });
  });

  it('unknown profile name in marker logs warning and falls back', async () => {
    await mkdir(join(configDir, 'backends'), { recursive: true });
    await writeFile(join(configDir, 'backends', 'claude-sdk.yaml'), 'backend: claude-sdk\n', 'utf-8');
    await writeFile(join(configDir, '.active-backend'), 'nonexistent\n', 'utf-8');

    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await resolveActiveProfileName(configDir, { backend: 'claude-sdk' });
      // Falls back to team default; source is 'missing' to signal stale marker
      expect(result.name).toBe('claude-sdk');
      expect(result.source).toBe('missing');
      const warnings = stderrSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(warnings).toContain('nonexistent');
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('unknown profile name in marker with no team fallback returns name=null source=missing', async () => {
    await writeFile(join(configDir, '.active-backend'), 'nonexistent\n', 'utf-8');

    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await resolveActiveProfileName(configDir, {});
      expect(result).toEqual({ name: null, source: 'missing' });
    } finally {
      stderrSpy.mockRestore();
    }
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

  it('parses a valid profile file', async () => {
    await mkdir(join(configDir, 'backends'), { recursive: true });
    await writeFile(
      join(configDir, 'backends', 'pi.yaml'),
      'backend: pi\npi:\n  thinkingLevel: high\n',
      'utf-8',
    );
    const result = await loadBackendProfile(configDir, 'pi');
    expect(result).not.toBeNull();
    expect(result?.backend).toBe('pi');
    expect(result?.pi?.thinkingLevel).toBe('high');
  });
});

describe('listBackendProfiles', () => {
  let projectDir: string;
  let configDir: string;

  beforeEach(async () => {
    ({ projectDir, configDir } = await makeProject());
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it('returns [] when no backends directory exists', async () => {
    const result = await listBackendProfiles(configDir);
    expect(result).toEqual([]);
  });

  it('returns entries for each .yaml file with parsed backend', async () => {
    await mkdir(join(configDir, 'backends'), { recursive: true });
    await writeFile(join(configDir, 'backends', 'pi-prod.yaml'), 'backend: pi\n', 'utf-8');
    await writeFile(join(configDir, 'backends', 'claude.yaml'), 'backend: claude-sdk\n', 'utf-8');
    await writeFile(join(configDir, 'backends', 'README.md'), '# skip me', 'utf-8');

    const result = await listBackendProfiles(configDir);
    expect(result.length).toBe(2);
    const byName = new Map(result.map((r) => [r.name, r]));
    expect(byName.get('pi-prod')?.backend).toBe('pi');
    expect(byName.get('claude')?.backend).toBe('claude-sdk');
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

  it('rejects a pi profile whose agents.model lacks provider', async () => {
    await expect(
      createBackendProfile(configDir, {
        name: 'bad-pi',
        backend: 'pi',
        agents: { model: { id: 'gpt-5.4' } } as PartialEforgeConfig['agents'],
      }),
    ).rejects.toThrow(/Pi backend requires "provider"/);
  });

  it('creates a valid pi profile with provider-qualified model', async () => {
    const result = await createBackendProfile(configDir, {
      name: 'pi-prod',
      backend: 'pi',
      agents: { model: { provider: 'openrouter', id: 'anthropic/claude-sonnet-4' } } as PartialEforgeConfig['agents'],
    });
    expect(await fileExists(result.path)).toBe(true);
    const written = await readFile(result.path, 'utf-8');
    expect(written).toContain('backend: pi');
    expect(written).toContain('openrouter');
  });

  it('refuses overwrite without overwrite: true', async () => {
    await createBackendProfile(configDir, { name: 'pi', backend: 'claude-sdk' });
    await expect(
      createBackendProfile(configDir, { name: 'pi', backend: 'claude-sdk' }),
    ).rejects.toThrow(/already exists/);
  });

  it('with overwrite: true replaces the file', async () => {
    await createBackendProfile(configDir, { name: 'pi', backend: 'claude-sdk' });
    const again = await createBackendProfile(configDir, {
      name: 'pi',
      backend: 'pi',
      overwrite: true,
    });
    const content = await readFile(again.path, 'utf-8');
    expect(content).toContain('backend: pi');
    expect(content).not.toContain('claude-sdk');
  });

  it('rejects invalid profile names', async () => {
    await expect(
      createBackendProfile(configDir, { name: 'has spaces', backend: 'claude-sdk' }),
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

  afterEach(async () => {
    if (projectDir) {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('no backends/ dir: resolved config matches baseline (no change)', async () => {
    ({ projectDir, configDir } = await makeProject({
      configYaml: 'backend: claude-sdk\nagents:\n  maxTurns: 25\n',
    }));
    const cfg = await loadConfig(projectDir);
    expect(cfg.backend).toBe('claude-sdk');
    expect(cfg.agents.maxTurns).toBe(25);
  });

  it('profile merges on top of project config when active', async () => {
    ({ projectDir, configDir } = await makeProject({
      configYaml: 'backend: pi\nagents:\n  maxTurns: 20\n',
    }));
    await mkdir(join(configDir, 'backends'), { recursive: true });
    await writeFile(
      join(configDir, 'backends', 'pi.yaml'),
      'backend: pi\nagents:\n  maxTurns: 40\n',
      'utf-8',
    );
    const cfg = await loadConfig(projectDir);
    expect(cfg.agents.maxTurns).toBe(40);
  });

  it('marker overrides team default', async () => {
    ({ projectDir, configDir } = await makeProject({
      configYaml: 'backend: pi\n',
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

    const cfg = await loadConfig(projectDir);
    expect(cfg.backend).toBe('claude-sdk');
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
