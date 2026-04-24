import { describe, it, expect } from 'vitest';
import { resolveAgentConfig, resolveAgentRuntimeForRole } from '@eforge-build/engine/pipeline';
import { resolveConfig, DEFAULT_CONFIG } from '@eforge-build/engine/config';

// ---------------------------------------------------------------------------
// resolveAgentRuntimeForRole — precedence, dangling refs, legacy fallback
// ---------------------------------------------------------------------------

describe('resolveAgentRuntimeForRole', () => {
  describe('throws when agentRuntimes is absent or empty', () => {
    it('throws when agentRuntimes is absent', () => {
      const config = { ...DEFAULT_CONFIG, agentRuntimes: undefined, defaultAgentRuntime: undefined };
      expect(() => resolveAgentRuntimeForRole('builder', config)).toThrow(
        '"agentRuntimes" is not declared in config',
      );
    });

    it('throws when agentRuntimes is empty object', () => {
      const config = { ...DEFAULT_CONFIG, agentRuntimes: {}, defaultAgentRuntime: undefined };
      expect(() => resolveAgentRuntimeForRole('builder', config)).toThrow(
        '"agentRuntimes" is not declared in config',
      );
    });

    it('DEFAULT_CONFIG has agentRuntimes and resolves to claude-sdk', () => {
      const result = resolveAgentRuntimeForRole('builder', DEFAULT_CONFIG);
      expect(result).toEqual({ agentRuntimeName: 'claude-sdk', harness: 'claude-sdk' });
    });
  });

  describe('new path (agentRuntimes declared)', () => {
    const configWithRuntimes = resolveConfig(
      {
        agentRuntimes: {
          opus: { harness: 'claude-sdk' },
          'pi-openrouter': { harness: 'pi', pi: { apiKey: 'test' } },
        },
        defaultAgentRuntime: 'opus',
      },
      {},
    );

    it('resolves to defaultAgentRuntime when role has no override', () => {
      const result = resolveAgentRuntimeForRole('planner', configWithRuntimes);
      expect(result).toEqual({ agentRuntimeName: 'opus', harness: 'claude-sdk' });
    });

    it('resolves to role-level agentRuntime over default', () => {
      const config = resolveConfig(
        {
          agentRuntimes: {
            opus: { harness: 'claude-sdk' },
            'pi-openrouter': { harness: 'pi', pi: { apiKey: 'test' } },
          },
          defaultAgentRuntime: 'opus',
          agents: {
            roles: {
              builder: { agentRuntime: 'pi-openrouter' },
            },
          },
        },
        {},
      );
      const builderResult = resolveAgentRuntimeForRole('builder', config);
      expect(builderResult).toEqual({ agentRuntimeName: 'pi-openrouter', harness: 'pi' });
      const plannerResult = resolveAgentRuntimeForRole('planner', config);
      expect(plannerResult).toEqual({ agentRuntimeName: 'opus', harness: 'claude-sdk' });
    });

    it('throws when no defaultAgentRuntime and role has no override', () => {
      const config = {
        ...DEFAULT_CONFIG,
        agentRuntimes: { opus: { harness: 'claude-sdk' as const } },
        defaultAgentRuntime: undefined,
      };
      expect(() => resolveAgentRuntimeForRole('planner', config)).toThrow(
        'could not resolve an agentRuntime',
      );
    });

    it('throws when role agentRuntime references non-existent entry', () => {
      const config = {
        ...DEFAULT_CONFIG,
        agentRuntimes: { opus: { harness: 'claude-sdk' as const } },
        defaultAgentRuntime: 'opus',
        agents: {
          ...DEFAULT_CONFIG.agents,
          roles: {
            builder: { agentRuntime: 'ghost', agentRuntimeName: 'claude-sdk', harness: 'claude-sdk' as const },
          },
        },
      };
      expect(() => resolveAgentRuntimeForRole('builder', config)).toThrow(
        '"ghost" which is not declared in agentRuntimes',
      );
    });
  });
});

// ---------------------------------------------------------------------------
// resolveAgentConfig — new fields agentRuntimeName and harness
// ---------------------------------------------------------------------------

describe('resolveAgentConfig new fields', () => {
  it('populates agentRuntimeName and harness from DEFAULT_CONFIG agentRuntimes', () => {
    const result = resolveAgentConfig('builder', DEFAULT_CONFIG);
    expect(result.agentRuntimeName).toBe('claude-sdk');
    expect(result.harness).toBe('claude-sdk');
  });

  it('populates agentRuntimeName and harness from agentRuntimes map', () => {
    const config = resolveConfig(
      {
        agentRuntimes: {
          opus: { harness: 'claude-sdk' },
          'pi-openrouter': { harness: 'pi', pi: { apiKey: 'test' } },
        },
        defaultAgentRuntime: 'opus',
        agents: {
          roles: {
            builder: { agentRuntime: 'pi-openrouter', model: { id: 'qwen-coder', provider: 'openrouter' } },
          },
        },
      },
      {},
    );
    const builder = resolveAgentConfig('builder', config);
    expect(builder.agentRuntimeName).toBe('pi-openrouter');
    expect(builder.harness).toBe('pi');

    const planner = resolveAgentConfig('planner', config);
    expect(planner.agentRuntimeName).toBe('opus');
    expect(planner.harness).toBe('claude-sdk');
  });

  it('DEFAULT_CONFIG resolves every role to claude-sdk harness via agentRuntimes default', () => {
    const roles = [
      'planner', 'builder', 'reviewer', 'evaluator', 'review-fixer',
    ] as const;
    for (const role of roles) {
      const result = resolveAgentConfig(role, DEFAULT_CONFIG);
      expect(result.agentRuntimeName).toBe('claude-sdk');
      expect(result.harness).toBe('claude-sdk');
    }
  });
});

// ---------------------------------------------------------------------------
// Per-role provider-ness validation at resolve time
// ---------------------------------------------------------------------------

describe('resolveAgentConfig provider-ness validation', () => {
  it('throws at resolve time when harness is pi but agents.model lacks provider', () => {
    const config = resolveConfig(
      {
        agentRuntimes: { mypi: { harness: 'pi', pi: { apiKey: 'key' } } },
        defaultAgentRuntime: 'mypi',
        agents: { model: { id: 'claude-opus-4-7' } },
      },
      {},
    );
    expect(() => resolveAgentConfig('planner', config)).toThrow(
      /harness "pi".*missing "provider"/,
    );
    // Error message names the role, agentRuntimeName, and provenance
    expect(() => resolveAgentConfig('planner', config)).toThrow(/"planner"/);
    expect(() => resolveAgentConfig('planner', config)).toThrow(/"mypi"/);
    expect(() => resolveAgentConfig('planner', config)).toThrow(/agents\.model/);
  });

  it('throws at resolve time when harness is pi but per-role model lacks provider', () => {
    const config = resolveConfig(
      {
        agentRuntimes: { mypi: { harness: 'pi', pi: { apiKey: 'key' } } },
        defaultAgentRuntime: 'mypi',
        agents: {
          roles: {
            builder: {
              model: { id: 'claude-sonnet-4-6' },
              agentRuntime: 'mypi',
            },
          },
        },
      },
      {},
    );
    expect(() => resolveAgentConfig('builder', config)).toThrow(
      /harness "pi".*missing "provider"/,
    );
    expect(() => resolveAgentConfig('builder', config)).toThrow(/agents\.roles\.builder\.model/);
  });

  it('throws when harness is claude-sdk but model has a provider', () => {
    const config = resolveConfig(
      {
        agentRuntimes: { myclaudesdk: { harness: 'claude-sdk' } },
        defaultAgentRuntime: 'myclaudesdk',
        agents: {
          roles: {
            reviewer: {
              model: { id: 'claude-opus-4-7', provider: 'anthropic' },
            },
          },
        },
      },
      {},
    );
    expect(() => resolveAgentConfig('reviewer', config)).toThrow(
      /harness "claude-sdk".*forbidden "provider"/,
    );
    expect(() => resolveAgentConfig('reviewer', config)).toThrow(/agents\.roles\.reviewer\.model/);
  });

  it('does not throw when pi harness has model with provider', () => {
    const config = resolveConfig(
      {
        agentRuntimes: { mypi: { harness: 'pi', pi: { apiKey: 'key' } } },
        defaultAgentRuntime: 'mypi',
        agents: {
          models: {
            max: { id: 'qwen-coder', provider: 'openrouter' },
            balanced: { id: 'gpt-4o', provider: 'openai' },
            fast: { id: 'gpt-4o-mini', provider: 'openai' },
          },
        },
      },
      {},
    );
    const result = resolveAgentConfig('planner', config);
    expect(result.harness).toBe('pi');
    expect(result.model).toEqual({ id: 'qwen-coder', provider: 'openrouter' });
  });
});
