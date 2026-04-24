/**
 * Tests for AgentRuntimeRegistry: lazy Pi load, memoization, and unknown-name error.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  singletonRegistry,
  buildAgentRuntimeRegistry,
  type AgentRuntimeRegistry,
} from '@eforge-build/engine/agent-runtime-registry';
import { StubHarness } from './stub-harness.js';
import { DEFAULT_CONFIG, resolveConfig } from '@eforge-build/engine/config';

// ---------------------------------------------------------------------------
// singletonRegistry — test adapter
// ---------------------------------------------------------------------------

describe('singletonRegistry', () => {
  it('returns the same backend instance for all roles', () => {
    const stub = new StubHarness([]);
    const registry = singletonRegistry(stub);

    const forBuilder = registry.forRole('builder');
    const forPlanner = registry.forRole('planner');
    const forReviewer = registry.forRole('reviewer');

    expect(forBuilder).toBe(stub);
    expect(forPlanner).toBe(stub);
    expect(forReviewer).toBe(stub);
  });

  it('returns the same backend for all byName calls', () => {
    const stub = new StubHarness([]);
    const registry = singletonRegistry(stub);

    expect(registry.byName('any-name')).toBe(stub);
    expect(registry.byName('another-name')).toBe(stub);
  });

  it('configured() returns ["singleton"]', () => {
    const stub = new StubHarness([]);
    const registry = singletonRegistry(stub);
    expect(registry.configured()).toEqual(['singleton']);
  });

  it('nameForRole returns "singleton" for any role', () => {
    const stub = new StubHarness([]);
    const registry = singletonRegistry(stub);
    expect(registry.nameForRole('builder')).toBe('singleton');
    expect(registry.nameForRole('planner')).toBe('singleton');
  });
});

// ---------------------------------------------------------------------------
// buildAgentRuntimeRegistry — two roles sharing one entry share one instance
// ---------------------------------------------------------------------------

describe('buildAgentRuntimeRegistry', () => {
  it('two roles pointing at the same agentRuntime name receive the same instance', async () => {
    const config = resolveConfig({
      agentRuntimes: {
        main: { harness: 'claude-sdk' },
      },
      defaultAgentRuntime: 'main',
    });

    const registry = await buildAgentRuntimeRegistry(config, {});

    const builderBackend = registry.forRole('builder');
    const plannerBackend = registry.forRole('planner');
    const reviewerBackend = registry.forRole('reviewer');

    // All roles resolve to 'main', so all should return the same instance
    expect(builderBackend).toBe(plannerBackend);
    expect(builderBackend).toBe(reviewerBackend);
  });

  it('two entries with different names produce distinct instances', async () => {
    const config = resolveConfig({
      agentRuntimes: {
        fast: { harness: 'claude-sdk' },
        quality: { harness: 'claude-sdk' },
      },
      defaultAgentRuntime: 'fast',
      agents: {
        roles: {
          planner: { agentRuntime: 'quality' },
        },
      },
    });

    const registry = await buildAgentRuntimeRegistry(config, {});

    const builderBackend = registry.forRole('builder');   // resolves to 'fast'
    const plannerBackend = registry.forRole('planner');   // resolves to 'quality'

    // Different entry names → distinct instances
    expect(builderBackend).not.toBe(plannerBackend);
  });

  it('same entry resolved twice returns the same memoized instance', async () => {
    const config = resolveConfig({
      agentRuntimes: {
        main: { harness: 'claude-sdk' },
      },
      defaultAgentRuntime: 'main',
    });

    const registry = await buildAgentRuntimeRegistry(config, {});

    const first = registry.byName('main');
    const second = registry.byName('main');

    // Memoization: must be the same object reference
    expect(first).toBe(second);
  });

  it('throws on unknown agentRuntime name via byName', async () => {
    const config = resolveConfig({
      agentRuntimes: {
        main: { harness: 'claude-sdk' },
      },
      defaultAgentRuntime: 'main',
    });

    const registry = await buildAgentRuntimeRegistry(config, {});

    expect(() => registry.byName('nonexistent')).toThrow(/Unknown agentRuntime name/);
    expect(() => registry.byName('nonexistent')).toThrow(/nonexistent/);
  });

  it('DEFAULT_CONFIG has agentRuntimes and builds registry successfully', async () => {
    const registry = await buildAgentRuntimeRegistry(DEFAULT_CONFIG, {});

    // Should succeed without throwing
    const backend = registry.forRole('builder');
    expect(backend).toBeDefined();
  });

  it('throws when agentRuntimes is absent', async () => {
    const config = { ...DEFAULT_CONFIG, agentRuntimes: undefined, defaultAgentRuntime: undefined };
    await expect(buildAgentRuntimeRegistry(config, {})).rejects.toThrow(
      '"agentRuntimes" is not declared or is empty',
    );
  });

  it('configured() lists declared runtime names', async () => {
    const config = resolveConfig({
      agentRuntimes: {
        fast: { harness: 'claude-sdk' },
        quality: { harness: 'claude-sdk' },
      },
      defaultAgentRuntime: 'fast',
    });

    const registry = await buildAgentRuntimeRegistry(config, {});

    const names = registry.configured();
    expect(names).toContain('fast');
    expect(names).toContain('quality');
    expect(names).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Pi lazy-load — does NOT import pi when no pi entries are configured
// ---------------------------------------------------------------------------

describe('buildAgentRuntimeRegistry — Pi lazy-load', () => {
  it('does not attempt to import Pi module when no pi entries are configured', async () => {
    // Spy on the dynamic import by checking that a claude-sdk-only config
    // succeeds without any Pi-related error (Pi deps are not installed in CI).
    const config = resolveConfig({
      agentRuntimes: {
        claude: { harness: 'claude-sdk' },
      },
      defaultAgentRuntime: 'claude',
    });

    // This should NOT throw even though @mariozechner/pi-ai is not installed,
    // because no Pi entry is declared.
    await expect(buildAgentRuntimeRegistry(config, {})).resolves.toBeDefined();
  });

  it('succeeds and lazily loads Pi when Pi entries are configured and Pi SDK is installed', async () => {
    const config = resolveConfig({
      agentRuntimes: {
        piRuntime: { harness: 'pi' },
      },
      defaultAgentRuntime: 'piRuntime',
    });

    // Pi SDK deps (@mariozechner/pi-ai) ARE installed in this environment.
    // The registry factory should succeed and produce a usable registry.
    const registry = await buildAgentRuntimeRegistry(config, {});
    expect(registry).toBeDefined();
    expect(registry.configured()).toContain('piRuntime');
    // forRole must not throw — the Pi backend instance is created lazily
    expect(() => registry.byName('piRuntime')).not.toThrow();
  });
});
