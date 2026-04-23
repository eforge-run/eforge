/**
 * Tests for backend selection logic in EforgeEngine.create().
 *
 * Verifies three paths:
 * 1. config.backend: 'pi' -> PiBackend instantiated via dynamic import
 * 2. default config (claude-sdk) -> ClaudeSDKBackend
 * 3. explicit options.backend overrides config.backend
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config loading to return controlled config
vi.mock('@eforge-build/engine/config', async (importOriginal) => {
  const original = await importOriginal<typeof import('@eforge-build/engine/config')>();
  return {
    ...original,
    loadConfig: vi.fn(),
  };
});

// Mock PiBackend dynamic import to avoid requiring actual Pi SDK
vi.mock('@eforge-build/engine/backends/pi', () => {
  class MockPiBackend {
    readonly _isPiBackend = true;
    constructor(public options: unknown) {}
    async *run() {
      // stub
    }
  }
  return { PiBackend: MockPiBackend };
});

// Mock MCP server and plugin loading to prevent filesystem access
vi.mock('@eforge-build/engine/eforge', async (importOriginal) => {
  const original = await importOriginal<typeof import('@eforge-build/engine/eforge')>();
  return original;
});

import { loadConfig } from '@eforge-build/engine/config';
import { DEFAULT_CONFIG } from '@eforge-build/engine/config';
import { EforgeEngine } from '@eforge-build/engine/eforge';
import { ClaudeSDKBackend } from '@eforge-build/engine/backends/claude-sdk';
import { StubBackend } from './stub-backend.js';

const mockedLoadConfig = vi.mocked(loadConfig);

function makeConfig(overrides: Partial<typeof DEFAULT_CONFIG> = {}): { config: typeof DEFAULT_CONFIG; warnings: string[] } {
  return { config: { ...DEFAULT_CONFIG, ...overrides }, warnings: [] };
}

describe('EforgeEngine.create() backend selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('instantiates PiBackend when config.backend is "pi"', async () => {
    mockedLoadConfig.mockResolvedValue(makeConfig({ backend: 'pi' }));

    const engine = await EforgeEngine.create({ cwd: '/tmp/test' });

    // Access private backend via resolvedConfig check - the engine was created with PiBackend
    // We verify by checking the backend field through the engine's internals
    const backend = (engine as unknown as { backend: unknown }).backend;
    expect(backend).toHaveProperty('_isPiBackend', true);
  });

  it('uses ClaudeSDKBackend when config.backend is "claude-sdk" (default)', async () => {
    mockedLoadConfig.mockResolvedValue(makeConfig({ backend: 'claude-sdk' }));

    const engine = await EforgeEngine.create({ cwd: '/tmp/test' });

    const backend = (engine as unknown as { backend: unknown }).backend;
    expect(backend).toBeInstanceOf(ClaudeSDKBackend);
  });

  it('explicit options.backend overrides config.backend', async () => {
    mockedLoadConfig.mockResolvedValue(makeConfig({ backend: 'pi' }));
    const explicitBackend = new StubBackend([]);

    const engine = await EforgeEngine.create({ cwd: '/tmp/test', backend: explicitBackend });

    const backend = (engine as unknown as { backend: unknown }).backend;
    expect(backend).toBe(explicitBackend);
  });
});
