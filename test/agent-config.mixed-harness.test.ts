import { describe, it, expect } from 'vitest';
import { resolveAgentConfig } from '@eforge-build/engine/pipeline';
import { resolveConfig } from '@eforge-build/engine/config';

// ---------------------------------------------------------------------------
// Mixed-harness config: different tiers use different harnesses (and providers)
// ---------------------------------------------------------------------------

describe('resolveAgentConfig mixed-harness tiers', () => {
  const mixedConfig = resolveConfig({
    agents: {
      tiers: {
        planning: { harness: 'pi' as const, pi: { provider: 'anthropic' }, model: 'claude-opus-4-7', effort: 'high' as const },
        implementation: { harness: 'pi' as const, pi: { provider: 'mlx-lm' }, model: 'qwen-coder', effort: 'medium' as const },
        review: { harness: 'pi' as const, pi: { provider: 'anthropic' }, model: 'claude-opus-4-7', effort: 'high' as const },
        evaluation: { harness: 'pi' as const, pi: { provider: 'anthropic' }, model: 'claude-opus-4-7', effort: 'high' as const },
      },
    },
  });

  it('planner (planning tier) resolves to pi/anthropic', () => {
    const result = resolveAgentConfig('planner', mixedConfig);
    expect(result.harness).toBe('pi');
    expect(result.model.provider).toBe('anthropic');
    expect(result.model.id).toBe('claude-opus-4-7');
  });

  it('builder (implementation tier) resolves to pi/mlx-lm', () => {
    const result = resolveAgentConfig('builder', mixedConfig);
    expect(result.harness).toBe('pi');
    expect(result.model.provider).toBe('mlx-lm');
    expect(result.model.id).toBe('qwen-coder');
  });

  it('reviewer (review tier) resolves to pi/anthropic', () => {
    const result = resolveAgentConfig('reviewer', mixedConfig);
    expect(result.harness).toBe('pi');
    expect(result.model.provider).toBe('anthropic');
  });

  it('cross-harness mix: planning=claude-sdk, implementation=pi', () => {
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
    const planner = resolveAgentConfig('planner', config);
    const builder = resolveAgentConfig('builder', config);
    expect(planner.harness).toBe('claude-sdk');
    expect(planner.model.provider).toBeUndefined();
    expect(builder.harness).toBe('pi');
    expect(builder.model.provider).toBe('openrouter');
  });
});
