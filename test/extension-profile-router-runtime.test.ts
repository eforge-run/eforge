/**
 * Unit tests for executeProfileRouters and buildProfileRouterContext.
 *
 * Covers:
 * (a) Two routers, first returns null, second returns valid profile -> second wins.
 * (b) Router throws -> failed event emitted, next router consulted.
 * (c) Router never resolves -> timeout event emitted at configured timeout.
 * (d) Router returns missing profile name -> invalid-selection event emitted, next router consulted.
 * (e) selectBuildProfile preferred over resolve when both present.
 * (f) Deprecated resolve path still works when selectBuildProfile is absent.
 * (g) Router context includes availableProfiles, currentProfile, usage.profile returning dataSource='none' with a no-data provider.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeProfileRouters, buildProfileRouterContext } from '@eforge-build/engine/extensions/index';
import type { QueuedPrd } from '@eforge-build/engine/prd-queue';
import type { ProfileRouterRegistration } from '@eforge-build/engine/extensions/types';
import type { EforgeConfig } from '@eforge-build/engine/config';
import { DEFAULT_CONFIG } from '@eforge-build/engine/config';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'profile-router-test-'));
}

function setupProjectWithProfile(cwd: string, profileName: string): void {
  mkdirSync(join(cwd, 'eforge', 'profiles'), { recursive: true });
  writeFileSync(
    join(cwd, 'eforge', 'profiles', `${profileName}.yaml`),
    'agents:\n  tiers:\n    planning:\n      harness: claude-sdk\n      model: claude-haiku-4-5\n      effort: low\n',
    'utf-8',
  );
}

function setupEforgeConfig(cwd: string): void {
  mkdirSync(join(cwd, 'eforge'), { recursive: true });
  writeFileSync(join(cwd, 'eforge', 'config.yaml'), 'agents:\n  tiers: {}\n', 'utf-8');
}

function makePrd(overrides: Partial<QueuedPrd> = {}): QueuedPrd {
  return {
    id: 'test-prd',
    filePath: '/tmp/test-prd.md',
    frontmatter: { title: 'Test PRD' },
    content: '---\ntitle: Test PRD\n---\n\n# Test\n\nContent here.',
    lastCommitHash: '',
    lastCommitDate: '',
    ...overrides,
  };
}

function makeConfig(overrides: Partial<EforgeConfig['extensions']> = {}): EforgeConfig {
  return {
    ...DEFAULT_CONFIG,
    extensions: {
      ...DEFAULT_CONFIG.extensions,
      profileRouterTimeoutMs: 1000,
      ...overrides,
    },
  };
}

function makeRouterRegistration(
  name: string,
  spec: { selectBuildProfile?: (...args: unknown[]) => unknown; resolve?: (...args: unknown[]) => unknown },
  extensionName = 'test-ext',
  extensionPath = '/ext/test.ts',
): ProfileRouterRegistration {
  return {
    kind: 'profileRouter',
    extensionName,
    extensionPath,
    name,
    value: spec as ProfileRouterRegistration['value'],
  };
}

// ---------------------------------------------------------------------------
// (a) Two routers, first returns null, second returns valid profile
// ---------------------------------------------------------------------------

describe('executeProfileRouters', () => {
  it('(a) first-null, second-valid: second router wins', async () => {
    const cwd = makeTempDir();
    try {
      setupEforgeConfig(cwd);
      setupProjectWithProfile(cwd, 'profile-b');

      const { getConfigDir, getConventionalConfigDir } = await import('@eforge-build/engine/config');
      const configDir = (await getConfigDir(cwd)) ?? getConventionalConfigDir(cwd);

      const registry = {
        profileRouters: [
          makeRouterRegistration('router-a', {
            selectBuildProfile: async () => null,
          }),
          makeRouterRegistration('router-b', {
            selectBuildProfile: async () => ({ profile: 'profile-b', reason: 'second wins', confidence: 'high' as const }),
          }),
        ],
      };

      const result = await executeProfileRouters(registry, makePrd(), {
        configDir,
        cwd,
        config: makeConfig(),
        configProfileName: null,
      });

      expect(result.selection).not.toBeNull();
      expect(result.selection?.profile).toBe('profile-b');
      expect(result.selection?.routerName).toBe('router-b');
      expect(result.selection?.reason).toBe('second wins');
      expect(result.diagnostics).toHaveLength(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // (b) Router throws -> failed event emitted, next router consulted
  // ---------------------------------------------------------------------------

  it('(b) router throws: failed diagnostic emitted, next router consulted', async () => {
    const cwd = makeTempDir();
    try {
      setupEforgeConfig(cwd);
      setupProjectWithProfile(cwd, 'profile-b');

      const { getConfigDir, getConventionalConfigDir } = await import('@eforge-build/engine/config');
      const configDir = (await getConfigDir(cwd)) ?? getConventionalConfigDir(cwd);

      const registry = {
        profileRouters: [
          makeRouterRegistration('router-throws', {
            selectBuildProfile: async () => { throw new Error('boom'); },
          }),
          makeRouterRegistration('router-ok', {
            selectBuildProfile: async () => ({ profile: 'profile-b' }),
          }),
        ],
      };

      const result = await executeProfileRouters(registry, makePrd(), {
        configDir,
        cwd,
        config: makeConfig(),
        configProfileName: null,
      });

      expect(result.selection?.profile).toBe('profile-b');
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0].type).toBe('queue:profile:router-failed');
      const diag = result.diagnostics[0] as Extract<(typeof result.diagnostics)[0], { type: 'queue:profile:router-failed' }>;
      expect(diag.routerName).toBe('router-throws');
      expect(diag.message).toContain('boom');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // (c) Router never resolves -> timeout event emitted
  // ---------------------------------------------------------------------------

  it('(c) router timeout: timeout diagnostic emitted, next router consulted', async () => {
    const cwd = makeTempDir();
    try {
      setupEforgeConfig(cwd);
      setupProjectWithProfile(cwd, 'profile-b');

      const { getConfigDir, getConventionalConfigDir } = await import('@eforge-build/engine/config');
      const configDir = (await getConfigDir(cwd)) ?? getConventionalConfigDir(cwd);

      const registry = {
        profileRouters: [
          makeRouterRegistration('router-hangs', {
            selectBuildProfile: () => new Promise(() => { /* never resolves */ }),
          }),
          makeRouterRegistration('router-ok', {
            selectBuildProfile: async () => ({ profile: 'profile-b' }),
          }),
        ],
      };

      const result = await executeProfileRouters(registry, makePrd(), {
        configDir,
        cwd,
        // Use a very short timeout (50ms) so the test finishes quickly
        config: makeConfig({ profileRouterTimeoutMs: 50 }),
        configProfileName: null,
      });

      expect(result.selection?.profile).toBe('profile-b');
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0].type).toBe('queue:profile:router-timeout');
      const diag = result.diagnostics[0] as Extract<(typeof result.diagnostics)[0], { type: 'queue:profile:router-timeout' }>;
      expect(diag.routerName).toBe('router-hangs');
      expect(diag.timeoutMs).toBe(50);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 10_000);

  // ---------------------------------------------------------------------------
  // (d) Router returns missing profile -> invalid-selection emitted, next consulted
  // ---------------------------------------------------------------------------

  it('(d) invalid profile selection: invalid-selection diagnostic emitted, next router consulted', async () => {
    const cwd = makeTempDir();
    try {
      setupEforgeConfig(cwd);
      setupProjectWithProfile(cwd, 'profile-b');

      const { getConfigDir, getConventionalConfigDir } = await import('@eforge-build/engine/config');
      const configDir = (await getConfigDir(cwd)) ?? getConventionalConfigDir(cwd);

      const registry = {
        profileRouters: [
          makeRouterRegistration('router-bad', {
            selectBuildProfile: async () => ({ profile: 'nonexistent-profile' }),
          }),
          makeRouterRegistration('router-ok', {
            selectBuildProfile: async () => ({ profile: 'profile-b' }),
          }),
        ],
      };

      const result = await executeProfileRouters(registry, makePrd(), {
        configDir,
        cwd,
        config: makeConfig(),
        configProfileName: null,
      });

      expect(result.selection?.profile).toBe('profile-b');
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0].type).toBe('queue:profile:invalid-selection');
      const diag = result.diagnostics[0] as Extract<(typeof result.diagnostics)[0], { type: 'queue:profile:invalid-selection' }>;
      expect(diag.routerName).toBe('router-bad');
      expect(diag.requestedProfile).toBe('nonexistent-profile');
      expect(diag.reason).toBe('not-found');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // (e) selectBuildProfile preferred over resolve when both present
  // ---------------------------------------------------------------------------

  it('(e) selectBuildProfile preferred over deprecated resolve', async () => {
    const cwd = makeTempDir();
    try {
      setupEforgeConfig(cwd);
      setupProjectWithProfile(cwd, 'profile-canonical');
      setupProjectWithProfile(cwd, 'profile-deprecated');

      const { getConfigDir, getConventionalConfigDir } = await import('@eforge-build/engine/config');
      const configDir = (await getConfigDir(cwd)) ?? getConventionalConfigDir(cwd);

      const selectCalled = vi.fn().mockResolvedValue({ profile: 'profile-canonical' });
      const resolveCalled = vi.fn().mockResolvedValue({ profile: 'profile-deprecated' });

      const registry = {
        profileRouters: [
          makeRouterRegistration('router-both', {
            selectBuildProfile: selectCalled,
            resolve: resolveCalled,
          }),
        ],
      };

      const result = await executeProfileRouters(registry, makePrd(), {
        configDir,
        cwd,
        config: makeConfig(),
        configProfileName: null,
      });

      expect(result.selection?.profile).toBe('profile-canonical');
      expect(selectCalled).toHaveBeenCalledOnce();
      expect(resolveCalled).not.toHaveBeenCalled();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // (f) Deprecated resolve path works when selectBuildProfile is absent
  // ---------------------------------------------------------------------------

  it('(f) deprecated resolve path works when selectBuildProfile is absent', async () => {
    const cwd = makeTempDir();
    try {
      setupEforgeConfig(cwd);
      setupProjectWithProfile(cwd, 'profile-via-resolve');

      const { getConfigDir, getConventionalConfigDir } = await import('@eforge-build/engine/config');
      const configDir = (await getConfigDir(cwd)) ?? getConventionalConfigDir(cwd);

      const registry = {
        profileRouters: [
          makeRouterRegistration('router-resolve-only', {
            resolve: async () => ({ profile: 'profile-via-resolve' }),
          }),
        ],
      };

      const result = await executeProfileRouters(registry, makePrd(), {
        configDir,
        cwd,
        config: makeConfig(),
        configProfileName: null,
      });

      expect(result.selection?.profile).toBe('profile-via-resolve');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // (g) Context includes availableProfiles, currentProfile, usage.profile with no-data provider
  // ---------------------------------------------------------------------------

  it('(g) router context has availableProfiles, currentProfile, and usage.profile returning dataSource=none with no-data provider', async () => {
    const cwd = makeTempDir();
    try {
      setupEforgeConfig(cwd);
      setupProjectWithProfile(cwd, 'profile-c');

      const { getConfigDir, getConventionalConfigDir } = await import('@eforge-build/engine/config');
      const configDir = (await getConfigDir(cwd)) ?? getConventionalConfigDir(cwd);

      let capturedCtx: unknown = null;

      const registry = {
        profileRouters: [
          makeRouterRegistration('ctx-inspector', {
            selectBuildProfile: async (ctx: unknown) => {
              capturedCtx = ctx;
              return null;
            },
          }),
        ],
      };

      await executeProfileRouters(registry, makePrd(), {
        configDir,
        cwd,
        config: makeConfig(),
        configProfileName: 'my-config-profile',
        profileUsageProvider: null, // no-data provider
      });

      expect(capturedCtx).not.toBeNull();
      const ctx = capturedCtx as {
        availableProfiles: Array<{ name: string }>;
        currentProfile: string | null;
        baseProfile: string | null;
        usage: { profile: (name: string) => { dataSource: string } };
        prdId: string;
        prdTitle: string;
      };

      // currentProfile and baseProfile should reflect configProfileName
      expect(ctx.currentProfile).toBe('my-config-profile');
      expect(ctx.baseProfile).toBe('my-config-profile');

      // availableProfiles should include the project profile
      expect(ctx.availableProfiles.some((p) => p.name === 'profile-c')).toBe(true);

      // usage.profile returns { dataSource: 'none' } when no provider
      const usage = ctx.usage.profile('any-profile');
      expect(usage.dataSource).toBe('none');

      // prdId and prdTitle should come from the PRD
      expect(ctx.prdId).toBe('test-prd');
      expect(ctx.prdTitle).toBe('Test PRD');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // No routers registered -> null selection, empty diagnostics
  // ---------------------------------------------------------------------------

  it('returns null selection when no routers are registered', async () => {
    const cwd = makeTempDir();
    try {
      const { getConfigDir, getConventionalConfigDir } = await import('@eforge-build/engine/config');
      const configDir = (await getConfigDir(cwd)) ?? getConventionalConfigDir(cwd);

      const result = await executeProfileRouters(
        { profileRouters: [] },
        makePrd(),
        { configDir, cwd, config: makeConfig(), configProfileName: null },
      );

      expect(result.selection).toBeNull();
      expect(result.diagnostics).toHaveLength(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// buildProfileRouterContext tests
// ---------------------------------------------------------------------------

describe('buildProfileRouterContext', () => {
  it('caps prdBody at configured chars and sets prdContentSummary when over limit', () => {
    const longBody = 'x'.repeat(5000);
    const prd = makePrd({ content: `---\ntitle: Test PRD\n---\n\n${longBody}` });

    const ctx = buildProfileRouterContext(
      prd,
      {
        configProfileName: null,
        availableProfiles: [],
        cwd: '/tmp',
        prdBodyCapChars: 4096,
      },
      'test-ext',
      'test-router',
    );

    // Should be capped, so prdBody is absent and prdContentSummary is present
    expect(ctx.prdBody).toBeUndefined();
    expect(ctx.prdContentSummary).toBeDefined();
    expect((ctx.prdContentSummary ?? '').length).toBeLessThanOrEqual(600);
  });

  it('sets prdBody when content is within the cap', () => {
    const shortBody = 'Short content';
    const prd = makePrd({ content: `---\ntitle: Test PRD\n---\n\n${shortBody}` });

    const ctx = buildProfileRouterContext(
      prd,
      {
        configProfileName: null,
        availableProfiles: [],
        cwd: '/tmp',
        prdBodyCapChars: 4096,
      },
      'test-ext',
      'test-router',
    );

    expect(ctx.prdBody).toBe(shortBody);
    expect(ctx.prdContentSummary).toBeUndefined();
  });

  it('dependsOn comes from frontmatter.depends_on', () => {
    const prd = makePrd({
      frontmatter: { title: 'Test PRD', depends_on: ['upstream-1', 'upstream-2'] },
    });

    const ctx = buildProfileRouterContext(
      prd,
      { configProfileName: null, availableProfiles: [], cwd: '/tmp' },
      'test-ext',
      'test-router',
    );

    expect(ctx.dependsOn).toEqual(['upstream-1', 'upstream-2']);
  });
});
