/**
 * Tests for AgentRuntimeRegistry: tier-driven harness lookup, lazy Pi load,
 * and (harness, provider) memoization.
 */

import { describe, it, expect } from 'vitest';
import {
  singletonRegistry,
  buildAgentRuntimeRegistry,
} from '@eforge-build/engine/agent-runtime-registry';
import { StubHarness } from './stub-harness.js';
import { DEFAULT_CONFIG, resolveConfig } from '@eforge-build/engine/config';

const FULL_TIERS_CLAUDE = {
  planning: { harness: 'claude-sdk' as const, model: 'claude-opus-4-7', effort: 'high' as const },
  implementation: { harness: 'claude-sdk' as const, model: 'claude-sonnet-4-6', effort: 'medium' as const },
  review: { harness: 'claude-sdk' as const, model: 'claude-opus-4-7', effort: 'high' as const },
  evaluation: { harness: 'claude-sdk' as const, model: 'claude-opus-4-7', effort: 'high' as const },
} as const;

// ---------------------------------------------------------------------------
// singletonRegistry — test adapter
// ---------------------------------------------------------------------------

describe('singletonRegistry', () => {
  it('returns the same backend instance for all roles', () => {
    const stub = new StubHarness([]);
    const registry = singletonRegistry(stub);

    expect(registry.forRole('builder')).toBe(stub);
    expect(registry.forRole('planner')).toBe(stub);
    expect(registry.forRole('reviewer')).toBe(stub);
  });
});

// ---------------------------------------------------------------------------
// buildAgentRuntimeRegistry — tier-driven dispatch
// ---------------------------------------------------------------------------

describe('buildAgentRuntimeRegistry', () => {
  it('roles in tiers sharing harness+provider get the same instance', async () => {
    const config = resolveConfig({
      agents: { tiers: FULL_TIERS_CLAUDE },
    });

    const registry = await buildAgentRuntimeRegistry(config, {});

    const builder = registry.forRole('builder');
    const planner = registry.forRole('planner');
    const reviewer = registry.forRole('reviewer');

    // All claude-sdk: same memoized instance
    expect(builder).toBe(planner);
    expect(builder).toBe(reviewer);
  });

  it('tiers with different harnesses produce distinct instances', async () => {
    const config = resolveConfig({
      agents: {
        tiers: {
          ...FULL_TIERS_CLAUDE,
          implementation: { harness: 'pi' as const, pi: { provider: 'openrouter' }, model: 'qwen-coder', effort: 'medium' as const },
        },
      },
    });

    const registry = await buildAgentRuntimeRegistry(config, {});

    const builder = registry.forRole('builder');   // pi
    const planner = registry.forRole('planner');   // claude-sdk

    expect(builder).not.toBe(planner);
  });

  it('two pi tiers with same provider share the same instance', async () => {
    const config = resolveConfig({
      agents: {
        tiers: {
          planning: { harness: 'pi' as const, pi: { provider: 'anthropic' }, model: 'claude-opus-4-7', effort: 'high' as const },
          implementation: { harness: 'pi' as const, pi: { provider: 'anthropic' }, model: 'claude-sonnet-4-6', effort: 'medium' as const },
          review: { harness: 'pi' as const, pi: { provider: 'anthropic' }, model: 'claude-opus-4-7', effort: 'high' as const },
          evaluation: { harness: 'pi' as const, pi: { provider: 'anthropic' }, model: 'claude-opus-4-7', effort: 'high' as const },
        },
      },
    });

    const registry = await buildAgentRuntimeRegistry(config, {});

    const planner = registry.forRole('planner');
    const builder = registry.forRole('builder');
    expect(planner).toBe(builder);
  });

  it('two pi tiers with different providers produce distinct instances', async () => {
    const config = resolveConfig({
      agents: {
        tiers: {
          planning: { harness: 'pi' as const, pi: { provider: 'anthropic' }, model: 'claude-opus-4-7', effort: 'high' as const },
          implementation: { harness: 'pi' as const, pi: { provider: 'openrouter' }, model: 'qwen-coder', effort: 'medium' as const },
          review: { harness: 'pi' as const, pi: { provider: 'anthropic' }, model: 'claude-opus-4-7', effort: 'high' as const },
          evaluation: { harness: 'pi' as const, pi: { provider: 'anthropic' }, model: 'claude-opus-4-7', effort: 'high' as const },
        },
      },
    });

    const registry = await buildAgentRuntimeRegistry(config, {});

    const planner = registry.forRole('planner'); // pi/anthropic
    const builder = registry.forRole('builder'); // pi/openrouter
    expect(planner).not.toBe(builder);
  });

  it('DEFAULT_CONFIG has tiers and builds registry successfully', async () => {
    const registry = await buildAgentRuntimeRegistry(DEFAULT_CONFIG, {});
    const harness = registry.forRole('builder');
    expect(harness).toBeDefined();
  });

  it('throws when tiers is empty', async () => {
    const config = { ...DEFAULT_CONFIG, agents: { ...DEFAULT_CONFIG.agents, tiers: {} } };
    await expect(buildAgentRuntimeRegistry(config, {})).rejects.toThrow(/agents.tiers/);
  });
});

// ---------------------------------------------------------------------------
// Pi lazy-load
// ---------------------------------------------------------------------------

describe('buildAgentRuntimeRegistry — Pi lazy-load', () => {
  it('does not import Pi when no pi tier is configured', async () => {
    const config = resolveConfig({ agents: { tiers: FULL_TIERS_CLAUDE } });
    await expect(buildAgentRuntimeRegistry(config, {})).resolves.toBeDefined();
  });

  it('lazily loads Pi when pi tiers exist', async () => {
    const config = resolveConfig({
      agents: {
        tiers: {
          planning: { harness: 'pi' as const, pi: { provider: 'anthropic' }, model: 'claude-opus-4-7', effort: 'high' as const },
          implementation: { harness: 'pi' as const, pi: { provider: 'anthropic' }, model: 'claude-sonnet-4-6', effort: 'medium' as const },
          review: { harness: 'pi' as const, pi: { provider: 'anthropic' }, model: 'claude-opus-4-7', effort: 'high' as const },
          evaluation: { harness: 'pi' as const, pi: { provider: 'anthropic' }, model: 'claude-opus-4-7', effort: 'high' as const },
        },
      },
    });

    const registry = await buildAgentRuntimeRegistry(config, {});
    expect(registry).toBeDefined();
    expect(() => registry.forRole('planner')).not.toThrow();
  });
});
