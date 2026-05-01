/**
 * Tests for tier-driven harness selection in EforgeEngine.create().
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentRuntimeRegistry } from '@eforge-build/engine/agent-runtime-registry';

// Mock config loading to return controlled config
vi.mock('@eforge-build/engine/config', async (importOriginal) => {
  const original = await importOriginal<typeof import('@eforge-build/engine/config')>();
  return {
    ...original,
    loadConfig: vi.fn(),
  };
});

// Mock PiHarness dynamic import to avoid requiring actual Pi SDK
vi.mock('@eforge-build/engine/harnesses/pi', () => {
  class MockPiHarness {
    readonly _isPiHarness = true;
    constructor(public options: unknown) {}
    async *run() {}
    effectiveCustomToolName(name: string) { return name; }
  }
  return { PiHarness: MockPiHarness };
});

import { loadConfig, DEFAULT_CONFIG } from '@eforge-build/engine/config';
import { EforgeEngine } from '@eforge-build/engine/eforge';
import { StubHarness } from './stub-harness.js';

const mockedLoadConfig = vi.mocked(loadConfig);

function makeConfig(overrides: Partial<typeof DEFAULT_CONFIG> = {}): { config: typeof DEFAULT_CONFIG; warnings: string[]; profile: { name: null; source: 'none'; scope: null; config: null } } {
  return {
    config: { ...DEFAULT_CONFIG, ...overrides },
    warnings: [],
    profile: { name: null, source: 'none', scope: null, config: null },
  };
}

describe('EforgeEngine.create() tier-driven harness selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds AgentRuntimeRegistry from config with pi tiers', async () => {
    mockedLoadConfig.mockResolvedValue(makeConfig({
      agents: {
        ...DEFAULT_CONFIG.agents,
        tiers: {
          planning: { harness: 'pi' as const, pi: { provider: 'anthropic' }, model: 'claude-opus-4-7', effort: 'high' as const },
          implementation: { harness: 'pi' as const, pi: { provider: 'anthropic' }, model: 'claude-sonnet-4-6', effort: 'medium' as const },
          review: { harness: 'pi' as const, pi: { provider: 'anthropic' }, model: 'claude-opus-4-7', effort: 'high' as const },
          evaluation: { harness: 'pi' as const, pi: { provider: 'anthropic' }, model: 'claude-opus-4-7', effort: 'high' as const },
        },
      },
    }));

    const engine = await EforgeEngine.create({ cwd: '/tmp/test' });
    expect(engine.resolvedConfig.agents.tiers?.planning?.harness).toBe('pi');
  });

  it('builds AgentRuntimeRegistry from config with claude-sdk tiers', async () => {
    mockedLoadConfig.mockResolvedValue(makeConfig());
    const engine = await EforgeEngine.create({ cwd: '/tmp/test' });
    expect(engine.resolvedConfig.agents.tiers?.planning?.harness).toBe('claude-sdk');
  });

  it('explicit agentRuntimes wraps bare AgentHarness in singletonRegistry', async () => {
    mockedLoadConfig.mockResolvedValue(makeConfig());
    const explicitHarness = new StubHarness([]);

    const engine = await EforgeEngine.create({ cwd: '/tmp/test', agentRuntimes: explicitHarness });

    const registry = (engine as unknown as { agentRuntimes: AgentRuntimeRegistry }).agentRuntimes;
    expect(registry.forRole('builder')).toBe(explicitHarness);
  });
});
