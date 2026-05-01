import { describe, it, expect } from 'vitest';
import { resolveAgentConfig } from '@eforge-build/engine/pipeline';
import { resolveConfig, DEFAULT_CONFIG } from '@eforge-build/engine/config';

// ---------------------------------------------------------------------------
// resolveAgentConfig — tier recipes drive harness, model, effort
// ---------------------------------------------------------------------------

describe('resolveAgentConfig with tier recipes', () => {
  it('throws when role tier has no recipe', () => {
    const config = resolveConfig({
      agents: {
        tiers: {
          planning: { harness: 'claude-sdk' as const, model: 'claude-opus-4-7', effort: 'high' as const },
        },
      },
    });
    // builder is in the implementation tier, but only planning is configured
    expect(() => resolveAgentConfig('builder', config)).toThrow(/no tier recipe is configured/);
  });

  it('DEFAULT_CONFIG resolves every role to claude-sdk via tier recipes', () => {
    const roles = ['planner', 'builder', 'reviewer', 'evaluator', 'review-fixer'] as const;
    for (const role of roles) {
      const result = resolveAgentConfig(role, DEFAULT_CONFIG);
      expect(result.harness).toBe('claude-sdk');
      expect(result.harnessSource).toBe('tier');
    }
  });

  it('routes role to its tier recipe', () => {
    const config = resolveConfig({
      agents: {
        tiers: {
          planning: { harness: 'claude-sdk' as const, model: 'claude-opus-4-7', effort: 'high' as const },
          implementation: { harness: 'pi' as const, pi: { provider: 'openrouter' }, model: 'qwen-coder', effort: 'medium' as const },
          review: { harness: 'claude-sdk' as const, model: 'claude-opus-4-7', effort: 'high' as const },
          evaluation: { harness: 'claude-sdk' as const, model: 'claude-opus-4-7', effort: 'high' as const },
        },
      },
    });
    const builder = resolveAgentConfig('builder', config);
    expect(builder.harness).toBe('pi');
    expect(builder.model.id).toBe('qwen-coder');
    expect(builder.model.provider).toBe('openrouter');

    const planner = resolveAgentConfig('planner', config);
    expect(planner.harness).toBe('claude-sdk');
    expect(planner.model.id).toBe('claude-opus-4-7');
    expect(planner.model.provider).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Provider splice for pi tier
// ---------------------------------------------------------------------------

describe('resolveAgentConfig provider splice', () => {
  it('pi tier splices pi.provider into model.provider', () => {
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
    const result = resolveAgentConfig('builder', config);
    expect(result.harness).toBe('pi');
    expect(result.model.id).toBe('claude-sonnet-4-6');
    expect(result.model.provider).toBe('anthropic');
  });

  it('claude-sdk tier produces model.provider === undefined', () => {
    const config = resolveConfig({
      agents: {
        tiers: {
          planning: { harness: 'claude-sdk' as const, model: 'claude-opus-4-7', effort: 'high' as const },
          implementation: { harness: 'claude-sdk' as const, model: 'claude-sonnet-4-6', effort: 'medium' as const },
          review: { harness: 'claude-sdk' as const, model: 'claude-opus-4-7', effort: 'high' as const },
          evaluation: { harness: 'claude-sdk' as const, model: 'claude-opus-4-7', effort: 'high' as const },
        },
      },
    });
    const result = resolveAgentConfig('builder', config);
    expect(result.harness).toBe('claude-sdk');
    expect(result.model.provider).toBeUndefined();
    expect(result.model.id).toBe('claude-sonnet-4-6');
  });
});
