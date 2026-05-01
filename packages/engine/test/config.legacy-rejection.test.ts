/**
 * Tests that configYamlSchema rejects legacy top-level fields with migration
 * pointers and that any other unrecognized top-level key is rejected.
 */
import { describe, it, expect } from 'vitest';
import { configYamlSchema } from '@eforge-build/engine/config';

describe('configYamlSchema legacy field rejection', () => {
  it('rejects scalar backend: with migration pointer', () => {
    const result = configYamlSchema.safeParse({ backend: 'claude-sdk' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join('\n');
      expect(messages).toMatch(/agents\.tiers/);
    }
  });

  it('rejects top-level pi: with migration pointer', () => {
    const result = configYamlSchema.safeParse({ pi: { thinkingLevel: 'high' } });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join('\n');
      expect(messages).toMatch(/agents\.tiers/);
    }
  });

  it('rejects top-level claudeSdk:', () => {
    const result = configYamlSchema.safeParse({ claudeSdk: { disableSubagents: true } });
    expect(result.success).toBe(false);
  });

  it('rejects top-level agentRuntimes:', () => {
    const result = configYamlSchema.safeParse({ agentRuntimes: { main: { harness: 'claude-sdk' } } });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join('\n');
      expect(messages).toMatch(/agents\.tiers/);
    }
  });

  it('rejects top-level defaultAgentRuntime:', () => {
    const result = configYamlSchema.safeParse({ defaultAgentRuntime: 'main' });
    expect(result.success).toBe(false);
  });

  it('rejects agents.models nested field', () => {
    const result = configYamlSchema.safeParse({
      agents: { models: { max: { id: 'claude-opus-4-7' } } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join('\n');
      expect(messages).toMatch(/agents\.models.*no longer supported/);
    }
  });

  it('accepts a valid agents.tiers config', () => {
    const result = configYamlSchema.safeParse({
      agents: {
        tiers: {
          planning: { harness: 'claude-sdk', model: 'claude-opus-4-7', effort: 'high' },
        },
      },
    });
    expect(result.success).toBe(true);
  });
});

describe('configYamlSchema unknown-key rejection', () => {
  it('rejects an unrecognized top-level key', () => {
    const result = configYamlSchema.safeParse({
      profiles: { docs: { extends: 'errand' } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join('.') === 'profiles');
      expect(issue).toBeDefined();
      expect(issue!.message).toMatch(/Unrecognized key "profiles"/);
    }
  });

  it('rejects a misspelled top-level key', () => {
    const result = configYamlSchema.safeParse({ agent: { maxTurns: 30 } });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join('.') === 'agent');
      expect(issue).toBeDefined();
      expect(issue!.message).toMatch(/Unrecognized key "agent"/);
    }
  });

  it('accepts a config containing only known top-level keys', () => {
    const result = configYamlSchema.safeParse({
      maxConcurrentBuilds: 2,
      build: { postMergeCommands: ['pnpm install'] },
      agents: { maxTurns: 30 },
      prdQueue: { dir: 'eforge/queue' },
    });
    expect(result.success).toBe(true);
  });
});
