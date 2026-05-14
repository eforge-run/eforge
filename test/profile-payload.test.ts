import { describe, it, expect } from 'vitest';
import { buildProfileCreatePayload } from '../packages/pi-eforge/extensions/eforge/profile-payload';

// ---------------------------------------------------------------------------
// buildProfileCreatePayload — tier-recipe shape
// ---------------------------------------------------------------------------

describe('buildProfileCreatePayload', () => {
  it('returns exactly name, scope, agents as top-level keys', () => {
    const payload = buildProfileCreatePayload({
      name: 'my-profile',
      scope: 'project',
      tiers: {
        planning:       { harness: 'claude-sdk', modelId: 'claude-opus-4-7',   effort: 'high' },
        implementation: { harness: 'claude-sdk', modelId: 'claude-sonnet-4-6', effort: 'medium' },
        review:         { harness: 'claude-sdk', modelId: 'claude-haiku-4-5',  effort: 'low' },
        evaluation:     { harness: 'claude-sdk', modelId: 'claude-haiku-4-5',  effort: 'low' },
      },
    });

    expect(Object.keys(payload).sort()).toEqual(['agents', 'name', 'scope']);
  });

  it('agents contains only tiers — no agentRuntimes, no defaultAgentRuntime, no agents.models', () => {
    const payload = buildProfileCreatePayload({
      name: 'clean',
      scope: 'project',
      tiers: {
        planning:       { harness: 'claude-sdk', modelId: 'model-a', effort: 'high' },
        implementation: { harness: 'claude-sdk', modelId: 'model-b', effort: 'medium' },
        review:         { harness: 'claude-sdk', modelId: 'model-c', effort: 'low' },
        evaluation:     { harness: 'claude-sdk', modelId: 'model-d', effort: 'low' },
      },
    });

    expect(Object.keys(payload.agents)).toEqual(['tiers']);
    expect((payload as Record<string, unknown>)['agentRuntimes']).toBeUndefined();
    expect((payload as Record<string, unknown>)['defaultAgentRuntime']).toBeUndefined();
    expect((payload.agents as Record<string, unknown>)['models']).toBeUndefined();
    expect((payload.agents as Record<string, unknown>)['agentRuntimes']).toBeUndefined();
    expect((payload.agents as Record<string, unknown>)['defaultAgentRuntime']).toBeUndefined();
  });

  it('emits all four built-in tiers', () => {
    const payload = buildProfileCreatePayload({
      name: 'four-tiers',
      scope: 'user',
      tiers: {
        planning:       { harness: 'claude-sdk', modelId: 'claude-opus-4-7',   effort: 'high' },
        implementation: { harness: 'claude-sdk', modelId: 'claude-sonnet-4-6', effort: 'medium' },
        review:         { harness: 'claude-sdk', modelId: 'claude-haiku-4-5',  effort: 'low' },
        evaluation:     { harness: 'claude-sdk', modelId: 'claude-haiku-4-5',  effort: 'low' },
      },
    });

    expect(Object.keys(payload.agents.tiers).sort()).toEqual(
      ['evaluation', 'implementation', 'planning', 'review'],
    );
  });

  it('each tier entry has harness, model, effort', () => {
    const payload = buildProfileCreatePayload({
      name: 'check-fields',
      scope: 'project',
      tiers: {
        planning:       { harness: 'claude-sdk', modelId: 'claude-opus-4-7',   effort: 'high' },
        implementation: { harness: 'claude-sdk', modelId: 'claude-sonnet-4-6', effort: 'medium' },
        review:         { harness: 'claude-sdk', modelId: 'claude-haiku-4-5',  effort: 'low' },
        evaluation:     { harness: 'claude-sdk', modelId: 'claude-haiku-4-5',  effort: 'low' },
      },
    });

    expect(payload.agents.tiers.planning).toEqual({ harness: 'claude-sdk', model: 'claude-opus-4-7', effort: 'high' });
    expect(payload.agents.tiers.implementation).toEqual({ harness: 'claude-sdk', model: 'claude-sonnet-4-6', effort: 'medium' });
    expect(payload.agents.tiers.review).toEqual({ harness: 'claude-sdk', model: 'claude-haiku-4-5', effort: 'low' });
    expect(payload.agents.tiers.evaluation).toEqual({ harness: 'claude-sdk', model: 'claude-haiku-4-5', effort: 'low' });
  });

  it('pi tier includes pi.provider', () => {
    const payload = buildProfileCreatePayload({
      name: 'pi-profile',
      scope: 'user',
      tiers: {
        planning:       { harness: 'pi', provider: 'anthropic', modelId: 'claude-opus-4-7',   effort: 'high' },
        implementation: { harness: 'pi', provider: 'anthropic', modelId: 'claude-sonnet-4-6', effort: 'medium' },
        review:         { harness: 'pi', provider: 'anthropic', modelId: 'claude-haiku-4-5',  effort: 'low' },
        evaluation:     { harness: 'pi', provider: 'anthropic', modelId: 'claude-haiku-4-5',  effort: 'low' },
      },
    });

    expect(payload.agents.tiers.planning).toEqual({
      harness: 'pi',
      pi: { provider: 'anthropic' },
      model: 'claude-opus-4-7',
      effort: 'high',
    });
    expect(payload.agents.tiers.implementation.pi?.provider).toBe('anthropic');
  });

  it('claude-sdk tier does not include pi field', () => {
    const payload = buildProfileCreatePayload({
      name: 'sdk-only',
      scope: 'project',
      tiers: {
        planning:       { harness: 'claude-sdk', modelId: 'model-a', effort: 'high' },
        implementation: { harness: 'claude-sdk', modelId: 'model-b', effort: 'medium' },
        review:         { harness: 'claude-sdk', modelId: 'model-c', effort: 'low' },
        evaluation:     { harness: 'claude-sdk', modelId: 'model-d', effort: 'low' },
      },
    });

    expect((payload.agents.tiers.planning as Record<string, unknown>)['pi']).toBeUndefined();
    expect((payload.agents.tiers.implementation as Record<string, unknown>)['pi']).toBeUndefined();
  });

  it('mixed harnesses across tiers are all preserved', () => {
    const payload = buildProfileCreatePayload({
      name: 'mixed',
      scope: 'project',
      tiers: {
        planning:       { harness: 'claude-sdk', modelId: 'claude-opus-4-7',   effort: 'high' },
        implementation: { harness: 'pi', provider: 'anthropic', modelId: 'claude-sonnet-4-6', effort: 'medium' },
        review:         { harness: 'pi', provider: 'openrouter', modelId: 'some-model',        effort: 'low' },
        evaluation:     { harness: 'claude-sdk', modelId: 'claude-haiku-4-5',  effort: 'low' },
      },
    });

    expect(payload.agents.tiers.planning.harness).toBe('claude-sdk');
    expect(payload.agents.tiers.implementation.harness).toBe('pi');
    expect(payload.agents.tiers.implementation.pi?.provider).toBe('anthropic');
    expect(payload.agents.tiers.review.harness).toBe('pi');
    expect(payload.agents.tiers.review.pi?.provider).toBe('openrouter');
    expect(payload.agents.tiers.evaluation.harness).toBe('claude-sdk');
  });

  it('name and scope are preserved in the payload', () => {
    const payload = buildProfileCreatePayload({
      name: 'my-profile',
      scope: 'user',
      tiers: {
        planning:       { harness: 'claude-sdk', modelId: 'model-a', effort: 'high' },
        implementation: { harness: 'claude-sdk', modelId: 'model-b', effort: 'medium' },
        review:         { harness: 'claude-sdk', modelId: 'model-c', effort: 'low' },
        evaluation:     { harness: 'claude-sdk', modelId: 'model-d', effort: 'low' },
      },
    });

    expect(payload.name).toBe('my-profile');
    expect(payload.scope).toBe('user');
  });

  it('does not emit effort/pi at top-level or agents level', () => {
    const payload = buildProfileCreatePayload({
      name: 'clean',
      scope: 'project',
      tiers: {
        planning:       { harness: 'claude-sdk', modelId: 'model-a', effort: 'high' },
        implementation: { harness: 'claude-sdk', modelId: 'model-b', effort: 'medium' },
        review:         { harness: 'claude-sdk', modelId: 'model-c', effort: 'low' },
        evaluation:     { harness: 'claude-sdk', modelId: 'model-d', effort: 'low' },
      },
    });

    const payloadAny = payload as Record<string, unknown>;
    expect(payloadAny['effort']).toBeUndefined();
    expect(payloadAny['pi']).toBeUndefined();
    expect(payloadAny['harness']).toBeUndefined();
    const agentsAny = payload.agents as Record<string, unknown>;
    expect(agentsAny['effort']).toBeUndefined();
    expect(agentsAny['pi']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildProfileCreatePayload — metadata pass-through
// ---------------------------------------------------------------------------

describe('metadata pass-through', () => {
  it('includes full metadata when all fields are provided', () => {
    const payload = buildProfileCreatePayload({
      name: 'meta-profile',
      scope: 'project',
      tiers: {
        planning:       { harness: 'claude-sdk', modelId: 'claude-opus-4-7',   effort: 'high' },
        implementation: { harness: 'claude-sdk', modelId: 'claude-sonnet-4-6', effort: 'medium' },
        review:         { harness: 'claude-sdk', modelId: 'claude-haiku-4-5',  effort: 'low' },
        evaluation:     { harness: 'claude-sdk', modelId: 'claude-haiku-4-5',  effort: 'low' },
      },
      metadata: { description: 'My profile', whenToUse: ['ci', 'review'], tags: ['fast', 'cheap'] },
    });

    expect(payload.metadata).toEqual({
      description: 'My profile',
      whenToUse: ['ci', 'review'],
      tags: ['fast', 'cheap'],
    });
    expect(Object.keys(payload).sort()).toEqual(['agents', 'metadata', 'name', 'scope']);
  });

  it('omits metadata key entirely when not provided', () => {
    const payload = buildProfileCreatePayload({
      name: 'no-meta',
      scope: 'project',
      tiers: {
        planning:       { harness: 'claude-sdk', modelId: 'model-a', effort: 'high' },
        implementation: { harness: 'claude-sdk', modelId: 'model-b', effort: 'medium' },
        review:         { harness: 'claude-sdk', modelId: 'model-c', effort: 'low' },
        evaluation:     { harness: 'claude-sdk', modelId: 'model-d', effort: 'low' },
      },
    });

    expect((payload as Record<string, unknown>)['metadata']).toBeUndefined();
    expect(Object.keys(payload).sort()).toEqual(['agents', 'name', 'scope']);
  });

  it('handles partial metadata (only description)', () => {
    const payload = buildProfileCreatePayload({
      name: 'partial-meta',
      scope: 'user',
      tiers: {
        planning:       { harness: 'claude-sdk', modelId: 'model-a', effort: 'high' },
        implementation: { harness: 'claude-sdk', modelId: 'model-b', effort: 'medium' },
        review:         { harness: 'claude-sdk', modelId: 'model-c', effort: 'low' },
        evaluation:     { harness: 'claude-sdk', modelId: 'model-d', effort: 'low' },
      },
      metadata: { description: 'Just a description' },
    });

    expect(payload.metadata).toEqual({ description: 'Just a description' });
    expect((payload.metadata as Record<string, unknown>)['whenToUse']).toBeUndefined();
    expect((payload.metadata as Record<string, unknown>)['tags']).toBeUndefined();
  });

  it('handles partial metadata (only tags)', () => {
    const payload = buildProfileCreatePayload({
      name: 'tags-only',
      scope: 'local',
      tiers: {
        planning:       { harness: 'claude-sdk', modelId: 'model-a', effort: 'high' },
        implementation: { harness: 'claude-sdk', modelId: 'model-b', effort: 'medium' },
        review:         { harness: 'claude-sdk', modelId: 'model-c', effort: 'low' },
        evaluation:     { harness: 'claude-sdk', modelId: 'model-d', effort: 'low' },
      },
      metadata: { tags: ['production', 'high-quality'] },
    });

    expect(payload.metadata).toEqual({ tags: ['production', 'high-quality'] });
    expect((payload.metadata as Record<string, unknown>)['description']).toBeUndefined();
    expect((payload.metadata as Record<string, unknown>)['whenToUse']).toBeUndefined();
  });

  it('metadata is preserved at top level (not nested inside agents)', () => {
    const payload = buildProfileCreatePayload({
      name: 'top-level-meta',
      scope: 'project',
      tiers: {
        planning:       { harness: 'claude-sdk', modelId: 'model-a', effort: 'high' },
        implementation: { harness: 'claude-sdk', modelId: 'model-b', effort: 'medium' },
        review:         { harness: 'claude-sdk', modelId: 'model-c', effort: 'low' },
        evaluation:     { harness: 'claude-sdk', modelId: 'model-d', effort: 'low' },
      },
      metadata: { description: 'top-level test' },
    });

    // Metadata is top-level, not inside agents
    expect(payload.metadata).toBeDefined();
    expect((payload.agents as Record<string, unknown>)['metadata']).toBeUndefined();
  });
});
