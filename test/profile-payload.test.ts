import { describe, it, expect } from 'vitest';
import { buildProfileCreatePayload, runtimeName } from '../packages/pi-eforge/extensions/eforge/profile-payload';

// ---------------------------------------------------------------------------
// runtimeName
// ---------------------------------------------------------------------------

describe('runtimeName', () => {
  it('returns "claude-sdk" for claude-sdk harness regardless of provider', () => {
    expect(runtimeName('claude-sdk')).toBe('claude-sdk');
    expect(runtimeName('claude-sdk', undefined)).toBe('claude-sdk');
  });

  it('returns "pi-<provider>" for pi harness', () => {
    expect(runtimeName('pi', 'anthropic')).toBe('pi-anthropic');
    expect(runtimeName('pi', 'openrouter')).toBe('pi-openrouter');
    expect(runtimeName('pi', 'zai')).toBe('pi-zai');
  });
});

// ---------------------------------------------------------------------------
// buildProfileCreatePayload
// ---------------------------------------------------------------------------

describe('buildProfileCreatePayload', () => {
  it('all three classes share one claude-sdk runtime', () => {
    const payload = buildProfileCreatePayload({
      name: 'my-profile',
      scope: 'project',
      max: { harness: 'claude-sdk', modelId: 'claude-opus-4-7' },
      balanced: { harness: 'claude-sdk', modelId: 'claude-sonnet-4-6' },
      fast: { harness: 'claude-sdk', modelId: 'claude-haiku-4-5' },
    });

    expect(Object.keys(payload.agentRuntimes)).toHaveLength(1);
    expect(payload.agentRuntimes['claude-sdk']).toEqual({ harness: 'claude-sdk' });
    expect(payload.defaultAgentRuntime).toBe('claude-sdk');
    expect(payload.agents.models.max).toEqual({ id: 'claude-opus-4-7' });
    expect(payload.agents.models.balanced).toEqual({ id: 'claude-sonnet-4-6' });
    expect(payload.agents.models.fast).toEqual({ id: 'claude-haiku-4-5' });
    // no tier override when all share the same runtime
    expect(payload.agents.tiers).toBeUndefined();
  });

  it('all three classes share one Pi runtime', () => {
    const payload = buildProfileCreatePayload({
      name: 'pi-profile',
      scope: 'user',
      max: { harness: 'pi', provider: 'anthropic', modelId: 'claude-opus-4-7' },
      balanced: { harness: 'pi', provider: 'anthropic', modelId: 'claude-sonnet-4-6' },
      fast: { harness: 'pi', provider: 'anthropic', modelId: 'claude-haiku-4-5' },
    });

    expect(Object.keys(payload.agentRuntimes)).toHaveLength(1);
    expect(payload.agentRuntimes['pi-anthropic']).toEqual({ harness: 'pi', pi: { provider: 'anthropic' } });
    expect(payload.defaultAgentRuntime).toBe('pi-anthropic');
    expect(payload.agents.tiers).toBeUndefined();
  });

  it('balanced differs from max — emits implementation tier override', () => {
    const payload = buildProfileCreatePayload({
      name: 'mixed-profile',
      scope: 'project',
      max: { harness: 'claude-sdk', modelId: 'claude-opus-4-7' },
      balanced: { harness: 'pi', provider: 'anthropic', modelId: 'claude-sonnet-4-6' },
      fast: { harness: 'pi', provider: 'anthropic', modelId: 'claude-haiku-4-5' },
    });

    expect(Object.keys(payload.agentRuntimes)).toHaveLength(2);
    expect(payload.agentRuntimes['claude-sdk']).toEqual({ harness: 'claude-sdk' });
    expect(payload.agentRuntimes['pi-anthropic']).toEqual({ harness: 'pi', pi: { provider: 'anthropic' } });
    expect(payload.defaultAgentRuntime).toBe('claude-sdk');
    expect(payload.agents.tiers).toEqual({ implementation: { agentRuntime: 'pi-anthropic' } });
  });

  it('fast differs from balanced and max — no tier override for fast', () => {
    const payload = buildProfileCreatePayload({
      name: 'tri-profile',
      scope: 'project',
      max: { harness: 'claude-sdk', modelId: 'opus' },
      balanced: { harness: 'pi', provider: 'anthropic', modelId: 'sonnet' },
      fast: { harness: 'pi', provider: 'openrouter', modelId: 'haiku' },
    });

    expect(Object.keys(payload.agentRuntimes)).toHaveLength(3);
    expect(payload.agentRuntimes['claude-sdk']).toBeDefined();
    expect(payload.agentRuntimes['pi-anthropic']).toBeDefined();
    expect(payload.agentRuntimes['pi-openrouter']).toBeDefined();
    // implementation tier override for balanced (different from max)
    expect(payload.agents.tiers).toEqual({ implementation: { agentRuntime: 'pi-anthropic' } });
    // fast is in agentRuntimes but never gets a tier override
    expect((payload.agents.tiers as Record<string, unknown>)?.fast).toBeUndefined();
  });

  it('all three classes on different runtimes — only implementation tier override', () => {
    const payload = buildProfileCreatePayload({
      name: 'all-different',
      scope: 'project',
      max: { harness: 'claude-sdk', modelId: 'model-a' },
      balanced: { harness: 'pi', provider: 'anthropic', modelId: 'model-b' },
      fast: { harness: 'pi', provider: 'zai', modelId: 'model-c' },
    });

    expect(Object.keys(payload.agentRuntimes)).toHaveLength(3);
    // only implementation tier override — no max/balanced/fast tier keys
    expect(payload.agents.tiers).toEqual({ implementation: { agentRuntime: 'pi-anthropic' } });
    const tiersAny = payload.agents.tiers as Record<string, unknown>;
    expect(tiersAny['max']).toBeUndefined();
    expect(tiersAny['balanced']).toBeUndefined();
    expect(tiersAny['fast']).toBeUndefined();
  });

  it('claude-sdk + pi mix — provider on agentRuntimes entry, not on model refs', () => {
    const payload = buildProfileCreatePayload({
      name: 'mixed',
      scope: 'project',
      max: { harness: 'pi', provider: 'anthropic', modelId: 'claude-opus-4-7' },
      balanced: { harness: 'claude-sdk', modelId: 'claude-sonnet-4-6' },
      fast: { harness: 'claude-sdk', modelId: 'claude-haiku-4-5' },
    });

    // Provider goes on agentRuntimes entry, not on model refs
    expect(payload.agentRuntimes['pi-anthropic']?.pi?.provider).toBe('anthropic');
    expect(payload.agentRuntimes['claude-sdk']).toEqual({ harness: 'claude-sdk' });
    expect((payload.agents.models.max as Record<string, unknown>).provider).toBeUndefined();
    expect((payload.agents.models.balanced as Record<string, unknown>).provider).toBeUndefined();
    expect((payload.agents.models.fast as Record<string, unknown>).provider).toBeUndefined();
    // max runtime is pi-anthropic, balanced is claude-sdk -> implementation tier override
    expect(payload.agents.tiers).toEqual({ implementation: { agentRuntime: 'claude-sdk' } });
    expect(payload.defaultAgentRuntime).toBe('pi-anthropic');
  });

  it('does not emit agents.effort or pi.thinkingLevel', () => {
    const payload = buildProfileCreatePayload({
      name: 'clean',
      scope: 'project',
      max: { harness: 'claude-sdk', modelId: 'model-a' },
      balanced: { harness: 'claude-sdk', modelId: 'model-b' },
      fast: { harness: 'claude-sdk', modelId: 'model-c' },
    });

    const payloadAny = payload as Record<string, unknown>;
    // no top-level effort or pi
    expect(payloadAny['effort']).toBeUndefined();
    expect(payloadAny['pi']).toBeUndefined();
    const agentsAny = payload.agents as Record<string, unknown>;
    // no agents.effort or agents.thinkingLevel
    expect(agentsAny['effort']).toBeUndefined();
    expect(agentsAny['thinkingLevel']).toBeUndefined();
  });

  it('de-duplicates runtimes when balanced and fast share a runtime different from max', () => {
    const payload = buildProfileCreatePayload({
      name: 'dedup',
      scope: 'project',
      max: { harness: 'claude-sdk', modelId: 'model-a' },
      balanced: { harness: 'pi', provider: 'anthropic', modelId: 'model-b' },
      fast: { harness: 'pi', provider: 'anthropic', modelId: 'model-c' },
    });

    // pi-anthropic appears once even though both balanced and fast use it
    expect(Object.keys(payload.agentRuntimes)).toHaveLength(2);
    expect(Object.keys(payload.agentRuntimes).sort()).toEqual(['claude-sdk', 'pi-anthropic']);
  });

  it('defaultAgentRuntime is always the max runtime name', () => {
    const payload = buildProfileCreatePayload({
      name: 'default-check',
      scope: 'project',
      max: { harness: 'pi', provider: 'openrouter', modelId: 'model-a' },
      balanced: { harness: 'claude-sdk', modelId: 'model-b' },
      fast: { harness: 'claude-sdk', modelId: 'model-c' },
    });

    expect(payload.defaultAgentRuntime).toBe('pi-openrouter');
  });

  it('name and scope are preserved in the payload', () => {
    const payload = buildProfileCreatePayload({
      name: 'my-profile',
      scope: 'user',
      max: { harness: 'claude-sdk', modelId: 'model-a' },
      balanced: { harness: 'claude-sdk', modelId: 'model-b' },
      fast: { harness: 'claude-sdk', modelId: 'model-c' },
    });

    expect(payload.name).toBe('my-profile');
    expect(payload.scope).toBe('user');
  });
});
