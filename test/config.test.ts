import { describe, it, expect } from 'vitest';
import { resolveConfig, DEFAULT_CONFIG } from '../src/engine/config.js';

describe('resolveConfig', () => {
  it('returns defaults for empty inputs', () => {
    const config = resolveConfig({}, {});
    expect(config.agents).toEqual(DEFAULT_CONFIG.agents);
    expect(config.build.parallelism).toBe(DEFAULT_CONFIG.build.parallelism);
    expect(config.plan).toEqual(DEFAULT_CONFIG.plan);
    expect(config.langfuse.enabled).toBe(false);
  });

  it('propagates file config values', () => {
    const config = resolveConfig(
      {
        agents: { maxTurns: 50, permissionMode: 'default' },
        plan: { outputDir: 'custom-plans' },
      },
      {},
    );
    expect(config.agents.maxTurns).toBe(50);
    expect(config.agents.permissionMode).toBe('default');
    expect(config.plan.outputDir).toBe('custom-plans');
  });

  it('env overrides file for langfuse keys', () => {
    const config = resolveConfig(
      { langfuse: { enabled: false, publicKey: 'file-pk', secretKey: 'file-sk', host: 'https://file.host' } },
      { LANGFUSE_PUBLIC_KEY: 'env-pk', LANGFUSE_SECRET_KEY: 'env-sk' },
    );
    expect(config.langfuse.publicKey).toBe('env-pk');
    expect(config.langfuse.secretKey).toBe('env-sk');
    expect(config.langfuse.enabled).toBe(true);
  });

  it('enables langfuse only when both keys present', () => {
    const config = resolveConfig(
      {},
      { LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk' },
    );
    expect(config.langfuse.enabled).toBe(true);
  });

  it('disables langfuse with only one key', () => {
    const config = resolveConfig({}, { LANGFUSE_PUBLIC_KEY: 'pk' });
    expect(config.langfuse.enabled).toBe(false);

    const config2 = resolveConfig({}, { LANGFUSE_SECRET_KEY: 'sk' });
    expect(config2.langfuse.enabled).toBe(false);
  });

  it('takes LANGFUSE_BASE_URL from env', () => {
    const config = resolveConfig(
      {},
      { LANGFUSE_BASE_URL: 'https://us.cloud.langfuse.com' },
    );
    expect(config.langfuse.host).toBe('https://us.cloud.langfuse.com');
  });

  it('postMergeCommands parsed from file config', () => {
    const config = resolveConfig(
      {
        build: {
          parallelism: 4,
          postMergeCommands: ['pnpm run type-check', 'pnpm test'],
        },
      },
      {},
    );
    expect(config.build.postMergeCommands).toEqual(['pnpm run type-check', 'pnpm test']);
  });

  it('postMergeCommands defaults to undefined when not set', () => {
    const config = resolveConfig({}, {});
    expect(config.build.postMergeCommands).toBeUndefined();
  });

  it('result is frozen', () => {
    const config = resolveConfig({}, {});
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.langfuse)).toBe(true);
    expect(Object.isFrozen(config.agents)).toBe(true);
    expect(Object.isFrozen(config.build)).toBe(true);
    expect(Object.isFrozen(config.plan)).toBe(true);
  });
});
