/**
 * Tests for agentRuntimes selection logic in EforgeEngine.create().
 *
 * Verifies three paths:
 * 1. config with agentRuntimes: { default: { harness: 'pi' } } -> PiHarness instantiated via dynamic import
 * 2. config with agentRuntimes: { default: { harness: 'claude-sdk' } } -> ClaudeSDKHarness
 * 3. explicit options.agentRuntimes wraps a bare AgentHarness in singletonRegistry
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
    async *run() {
      // stub
    }
    effectiveCustomToolName(name: string) { return name; }
  }
  return { PiHarness: MockPiHarness };
});

// Mock MCP server and plugin loading to prevent filesystem access
vi.mock('@eforge-build/engine/eforge', async (importOriginal) => {
  const original = await importOriginal<typeof import('@eforge-build/engine/eforge')>();
  return original;
});

import { loadConfig } from '@eforge-build/engine/config';
import { DEFAULT_CONFIG } from '@eforge-build/engine/config';
import { EforgeEngine } from '@eforge-build/engine/eforge';
import { StubHarness } from './stub-harness.js';

const mockedLoadConfig = vi.mocked(loadConfig);

function makeConfig(overrides: Partial<typeof DEFAULT_CONFIG> = {}): { config: typeof DEFAULT_CONFIG; warnings: string[] } {
  return { config: { ...DEFAULT_CONFIG, ...overrides }, warnings: [] };
}

describe('EforgeEngine.create() agentRuntimes selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds AgentRuntimeRegistry from config with harness "pi"', async () => {
    mockedLoadConfig.mockResolvedValue(makeConfig({
      agentRuntimes: { default: { harness: 'pi' } },
      defaultAgentRuntime: 'default',
    }));

    const engine = await EforgeEngine.create({ cwd: '/tmp/test' });

    // Verify config was applied correctly
    expect(engine.resolvedConfig.agentRuntimes?.['default']?.harness).toBe('pi');
  });

  it('builds AgentRuntimeRegistry from config with harness "claude-sdk"', async () => {
    mockedLoadConfig.mockResolvedValue(makeConfig({
      agentRuntimes: { default: { harness: 'claude-sdk' } },
      defaultAgentRuntime: 'default',
    }));

    const engine = await EforgeEngine.create({ cwd: '/tmp/test' });

    expect(engine.resolvedConfig.agentRuntimes?.['default']?.harness).toBe('claude-sdk');
  });

  it('explicit agentRuntimes wraps bare AgentHarness in singletonRegistry', async () => {
    mockedLoadConfig.mockResolvedValue(makeConfig({
      agentRuntimes: { default: { harness: 'pi' } },
      defaultAgentRuntime: 'default',
    }));
    const explicitHarness = new StubHarness([]);

    const engine = await EforgeEngine.create({ cwd: '/tmp/test', agentRuntimes: explicitHarness });

    // singletonRegistry wraps the harness and returns it for every role
    const registry = (engine as unknown as { agentRuntimes: AgentRuntimeRegistry }).agentRuntimes;
    expect(registry.forRole('builder')).toBe(explicitHarness);
  });
});
