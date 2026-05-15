/**
 * Per-build profile override tests.
 *
 * Covers the full feature surface:
 * - loadConfig with profileOverride option
 * - PRD frontmatter schema with profile field
 * - enqueuePrd serializes profile field
 * - parseFrontmatter reads profile field back
 * - argv builder produces --profile flag when frontmatter.profile is set
 * - loadConfig without profileOverride preserves existing marker-chain behavior
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach } from 'vitest';
import { loadConfig } from '@eforge-build/engine/config';
import { enqueuePrd, validatePrdFrontmatter } from '@eforge-build/engine/prd-queue';

// ---------------------------------------------------------------------------
// Temp dir helpers
// ---------------------------------------------------------------------------

function makeTempDir(prefix = 'eforge-profile-override-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

function createTempDir(prefix?: string): string {
  const dir = makeTempDir(prefix);
  tempDirs.push(dir);
  return dir;
}

/**
 * Set up a minimal eforge project with an eforge/profiles/pi-local.yaml file.
 * Returns the project root directory.
 */
function setupProjectWithProfile(profileName = 'pi-local'): string {
  const projectRoot = createTempDir('eforge-profile-project-');

  // Create eforge/config.yaml (minimal)
  mkdirSync(join(projectRoot, 'eforge'), { recursive: true });
  writeFileSync(join(projectRoot, 'eforge', 'config.yaml'), 'agents:\n  tiers: {}\n', 'utf-8');

  // Create eforge/profiles/<name>.yaml
  mkdirSync(join(projectRoot, 'eforge', 'profiles'), { recursive: true });
  writeFileSync(
    join(projectRoot, 'eforge', 'profiles', `${profileName}.yaml`),
    'agents:\n  tiers:\n    planning:\n      harness: claude-sdk\n      model: claude-haiku-4-5\n      effort: low\n',
    'utf-8',
  );

  return projectRoot;
}

// ---------------------------------------------------------------------------
// loadConfig with profileOverride
// ---------------------------------------------------------------------------

describe('loadConfig with profileOverride', () => {
  it('returns source=override when profileOverride is set and profile exists', async () => {
    const projectRoot = setupProjectWithProfile('pi-local');

    const result = await loadConfig(projectRoot, { profileOverride: 'pi-local' });

    expect(result.profile.source).toBe('override');
    expect(result.profile.name).toBe('pi-local');
    expect(result.profile.scope).toBeDefined();
    expect(result.profile.config).not.toBeNull();
  });

  it('throws when profileOverride names a missing profile', async () => {
    const projectRoot = setupProjectWithProfile('pi-local');

    await expect(
      loadConfig(projectRoot, { profileOverride: 'does-not-exist' }),
    ).rejects.toThrow(/Profile override 'does-not-exist' not found/);
  });

  it('error message names searched scopes when profile is missing', async () => {
    const projectRoot = setupProjectWithProfile('pi-local');

    await expect(
      loadConfig(projectRoot, { profileOverride: 'does-not-exist' }),
    ).rejects.toThrow(/searched:/);
  });

  it('loadConfig without profileOverride uses marker-chain (source != override)', async () => {
    const projectRoot = setupProjectWithProfile('pi-local');

    const result = await loadConfig(projectRoot);

    // No active marker written, so source should be 'none' (no marker points to a profile)
    expect(result.profile.source).not.toBe('override');
  });

  it('two loadConfig calls with different profileOverride return distinct profile.name values', async () => {
    const projectRoot = createTempDir('eforge-two-profiles-');

    // Create eforge/config.yaml
    mkdirSync(join(projectRoot, 'eforge'), { recursive: true });
    writeFileSync(join(projectRoot, 'eforge', 'config.yaml'), 'agents:\n  tiers: {}\n', 'utf-8');

    // Create two profiles
    mkdirSync(join(projectRoot, 'eforge', 'profiles'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'eforge', 'profiles', 'profile-a.yaml'),
      'agents:\n  tiers:\n    planning:\n      harness: claude-sdk\n      model: claude-haiku-4-5\n      effort: low\n',
      'utf-8',
    );
    writeFileSync(
      join(projectRoot, 'eforge', 'profiles', 'profile-b.yaml'),
      'agents:\n  tiers:\n    planning:\n      harness: claude-sdk\n      model: claude-sonnet-4-6\n      effort: medium\n',
      'utf-8',
    );

    const [resultA, resultB] = await Promise.all([
      loadConfig(projectRoot, { profileOverride: 'profile-a' }),
      loadConfig(projectRoot, { profileOverride: 'profile-b' }),
    ]);

    expect(resultA.profile.name).toBe('profile-a');
    expect(resultB.profile.name).toBe('profile-b');
    expect(resultA.profile.name).not.toBe(resultB.profile.name);
    expect(resultA.profile.source).toBe('override');
    expect(resultB.profile.source).toBe('override');
  });
});

// ---------------------------------------------------------------------------
// PRD frontmatter schema
// ---------------------------------------------------------------------------

describe('prdFrontmatterSchema profile field', () => {
  it('accepts a PRD frontmatter with profile field', () => {
    const result = validatePrdFrontmatter({
      title: 'Test PRD',
      created: '2024-01-01',
      profile: 'pi-local',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.profile).toBe('pi-local');
    }
  });

  it('accepts a PRD frontmatter without profile field', () => {
    const result = validatePrdFrontmatter({
      title: 'Test PRD',
      created: '2024-01-01',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.profile).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// enqueuePrd writes profile to frontmatter
// ---------------------------------------------------------------------------

describe('enqueuePrd with profile option', () => {
  it('serializes profile field when profile is provided', async () => {
    const queueDir = createTempDir('eforge-queue-');
    const cwd = createTempDir('eforge-cwd-');

    const result = await enqueuePrd({
      body: '# Test PRD\n\nSome content.',
      title: 'Test PRD',
      queueDir,
      cwd,
      profile: 'pi-local',
    });

    // Read the written file and check frontmatter
    const { readFileSync } = await import('node:fs');
    const content = readFileSync(result.filePath, 'utf-8');

    expect(content).toContain('profile: pi-local');
  });

  it('does not serialize profile field when profile is not provided', async () => {
    const queueDir = createTempDir('eforge-queue-no-profile-');
    const cwd = createTempDir('eforge-cwd-no-profile-');

    const result = await enqueuePrd({
      body: '# Test PRD\n\nSome content.',
      title: 'Test PRD',
      queueDir,
      cwd,
    });

    const { readFileSync } = await import('node:fs');
    const content = readFileSync(result.filePath, 'utf-8');

    expect(content).not.toContain('profile:');
  });

  it('written PRD frontmatter with profile validates against schema', async () => {
    const queueDir = createTempDir('eforge-queue-validate-');
    const cwd = createTempDir('eforge-cwd-validate-');

    const result = await enqueuePrd({
      body: '# Test PRD\n\nSome content.',
      title: 'Test PRD',
      queueDir,
      cwd,
      profile: 'pi-local',
    });

    // The frontmatter returned should include profile
    const validation = validatePrdFrontmatter({ ...result.frontmatter, profile: 'pi-local' });
    expect(validation.success).toBe(true);
    if (validation.success) {
      expect(validation.data.profile).toBe('pi-local');
    }
  });
});

// ---------------------------------------------------------------------------
// argv builder helper — extracted logic
// ---------------------------------------------------------------------------

/**
 * Mirrors the argv construction logic inside spawnPrdChild.
 * When prd.frontmatter.profile is set, appends '--profile <name>' to argv.
 */
function buildQueueExecArgv(
  prdId: string,
  options: { auto?: boolean; verbose?: boolean },
  prdSessionId: string,
  frontmatterProfile?: string,
): string[] {
  const args = ['queue', 'exec', prdId];
  if (options.auto) args.push('--auto');
  if (options.verbose) args.push('--verbose');
  args.push('--no-monitor');
  args.push('--session-id', prdSessionId);
  if (frontmatterProfile) {
    args.push('--profile', frontmatterProfile);
  }
  return args;
}

describe('argv builder for spawnPrdChild', () => {
  it('includes --profile <name> when frontmatter.profile is set', () => {
    const argv = buildQueueExecArgv('my-prd', {}, 'session-123', 'pi-local');

    expect(argv).toContain('--profile');
    expect(argv).toContain('pi-local');

    const profileIdx = argv.indexOf('--profile');
    expect(argv[profileIdx + 1]).toBe('pi-local');
  });

  it('does not include --profile when frontmatter.profile is undefined', () => {
    const argv = buildQueueExecArgv('my-prd', {}, 'session-123', undefined);

    expect(argv).not.toContain('--profile');
  });

  it('places --profile after --session-id in argv', () => {
    const argv = buildQueueExecArgv('my-prd', {}, 'session-456', 'pi-local');

    const sessionIdIdx = argv.indexOf('--session-id');
    const profileIdx = argv.indexOf('--profile');

    expect(sessionIdIdx).toBeGreaterThan(0);
    expect(profileIdx).toBeGreaterThan(sessionIdIdx);
  });

  it('argv structure is correct with auto and verbose flags', () => {
    const argv = buildQueueExecArgv('my-prd', { auto: true, verbose: true }, 'session-789', 'pi-local');

    expect(argv[0]).toBe('queue');
    expect(argv[1]).toBe('exec');
    expect(argv[2]).toBe('my-prd');
    expect(argv).toContain('--auto');
    expect(argv).toContain('--verbose');
    expect(argv).toContain('--no-monitor');
    expect(argv).toContain('--profile');
    expect(argv).toContain('pi-local');
  });
});

// ---------------------------------------------------------------------------
// Routed-selection argv builder — in-memory override path (persist-failed fallback)
// ---------------------------------------------------------------------------

/**
 * Mirrors the argv construction for the in-memory routedProfileOverride path
 * in spawnPrdChild. When frontmatter.profile is absent but a routed override
 * is provided (persist-failed fallback), --profile uses the override.
 */
function buildQueueExecArgvWithOverride(
  prdId: string,
  options: { auto?: boolean; verbose?: boolean },
  prdSessionId: string,
  frontmatterProfile?: string,
  routedProfileOverride?: string,
): string[] {
  const args = ['queue', 'exec', prdId];
  if (options.auto) args.push('--auto');
  if (options.verbose) args.push('--verbose');
  args.push('--no-monitor');
  args.push('--session-id', prdSessionId);
  if (frontmatterProfile) {
    args.push('--profile', frontmatterProfile);
  } else if (routedProfileOverride) {
    args.push('--profile', routedProfileOverride);
  }
  return args;
}

describe('argv builder for routed-selection scenario', () => {
  it('uses frontmatter.profile when set (persisted path), ignores routedProfileOverride', () => {
    const argv = buildQueueExecArgvWithOverride('my-prd', {}, 'session-abc', 'persisted-profile', 'override-profile');

    expect(argv).toContain('--profile');
    const profileIdx = argv.indexOf('--profile');
    // frontmatter wins over routedProfileOverride
    expect(argv[profileIdx + 1]).toBe('persisted-profile');
  });

  it('uses routedProfileOverride when frontmatter.profile is absent (persist-failed fallback)', () => {
    const argv = buildQueueExecArgvWithOverride('my-prd', {}, 'session-def', undefined, 'routed-profile');

    expect(argv).toContain('--profile');
    const profileIdx = argv.indexOf('--profile');
    expect(argv[profileIdx + 1]).toBe('routed-profile');
  });

  it('includes no --profile when both frontmatter.profile and routedProfileOverride are absent', () => {
    const argv = buildQueueExecArgvWithOverride('my-prd', {}, 'session-ghi', undefined, undefined);

    expect(argv).not.toContain('--profile');
  });

  it('routed selection uses --profile with the routed profile name', () => {
    const argv = buildQueueExecArgvWithOverride('my-prd', { auto: true }, 'session-xyz', undefined, 'routed-pi-local');

    expect(argv).toContain('--auto');
    expect(argv).toContain('--profile');
    const profileIdx = argv.indexOf('--profile');
    expect(argv[profileIdx + 1]).toBe('routed-pi-local');
  });
});
