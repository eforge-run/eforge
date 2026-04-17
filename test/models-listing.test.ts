import { describe, it, expect } from 'vitest';
import { listProviders, listModels } from '@eforge-build/engine/models';

describe('listProviders', () => {
  it('returns [] for claude-sdk (provider implicit)', async () => {
    const providers = await listProviders('claude-sdk');
    expect(providers).toEqual([]);
  });

  it('returns a non-empty array for pi, including anthropic', async () => {
    const providers = await listProviders('pi');
    expect(Array.isArray(providers)).toBe(true);
    expect(providers.length).toBeGreaterThan(0);
    expect(providers).toContain('anthropic');
  });
});

describe('listModels', () => {
  it('returns Anthropic models for claude-sdk without the provider field', async () => {
    const models = await listModels('claude-sdk');
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      expect(typeof m.id).toBe('string');
      // Provider is omitted for claude-sdk results
      expect(m.provider).toBeUndefined();
    }
  });

  it('returns at least one entry for pi + anthropic with { id, provider }', async () => {
    const models = await listModels('pi', 'anthropic');
    expect(models.length).toBeGreaterThan(0);
    const first = models[0];
    expect(typeof first.id).toBe('string');
    expect(first.provider).toBe('anthropic');
  });

  it('without a provider filter returns models across providers for pi', async () => {
    const models = await listModels('pi');
    expect(models.length).toBeGreaterThan(0);
    const providers = new Set(models.map((m) => m.provider).filter(Boolean));
    expect(providers.size).toBeGreaterThan(0);
  });
});
