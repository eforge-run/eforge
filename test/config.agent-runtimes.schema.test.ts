import { describe, it, expect } from 'vitest';
import { eforgeConfigSchema, agentRuntimeEntrySchema, configYamlSchema } from '@eforge-build/engine/config';

// ---------------------------------------------------------------------------
// agentRuntimeEntrySchema — cross-kind sub-block rejection
// ---------------------------------------------------------------------------

describe('agentRuntimeEntrySchema', () => {
  it('accepts harness claude-sdk without sub-blocks', () => {
    const result = agentRuntimeEntrySchema.safeParse({ harness: 'claude-sdk' });
    expect(result.success).toBe(true);
  });

  it('accepts harness pi without sub-blocks', () => {
    const result = agentRuntimeEntrySchema.safeParse({ harness: 'pi' });
    expect(result.success).toBe(true);
  });

  it('accepts harness claude-sdk with claudeSdk config', () => {
    const result = agentRuntimeEntrySchema.safeParse({
      harness: 'claude-sdk',
      claudeSdk: { disableSubagents: true },
    });
    expect(result.success).toBe(true);
  });

  it('accepts harness pi with pi config', () => {
    const result = agentRuntimeEntrySchema.safeParse({
      harness: 'pi',
      pi: { apiKey: 'test-key', thinkingLevel: 'medium' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects harness pi with claudeSdk sub-block (cross-kind conflict)', () => {
    const result = agentRuntimeEntrySchema.safeParse({
      harness: 'pi',
      claudeSdk: { disableSubagents: true },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join('\n');
      expect(messages).toMatch(/harness "pi".*cannot include "claudeSdk"/);
    }
  });

  it('rejects harness claude-sdk with pi sub-block (cross-kind conflict)', () => {
    const result = agentRuntimeEntrySchema.safeParse({
      harness: 'claude-sdk',
      pi: { apiKey: 'test' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join('\n');
      expect(messages).toMatch(/harness "claude-sdk".*cannot include "pi"/);
    }
  });

  it('rejects unknown harness value', () => {
    const result = agentRuntimeEntrySchema.safeParse({ harness: 'unknown-backend' });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// eforgeConfigSchema — agentRuntimes cross-field refinements
// ---------------------------------------------------------------------------

describe('eforgeConfigSchema agentRuntimes cross-field validation', () => {
  const validBase = {
    agents: { maxTurns: 30 },
  };

  it('accepts config with no agentRuntimes', () => {
    const result = eforgeConfigSchema.safeParse(validBase);
    expect(result.success).toBe(true);
  });

  it('accepts config with agentRuntimes and defaultAgentRuntime', () => {
    const result = eforgeConfigSchema.safeParse({
      ...validBase,
      agentRuntimes: {
        opus: { harness: 'claude-sdk' },
        mypi: { harness: 'pi' },
      },
      defaultAgentRuntime: 'opus',
    });
    expect(result.success).toBe(true);
  });

  it('rejects config with agentRuntimes but no defaultAgentRuntime', () => {
    const result = eforgeConfigSchema.safeParse({
      ...validBase,
      agentRuntimes: { opus: { harness: 'claude-sdk' } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join('\n');
      expect(messages).toMatch(/"defaultAgentRuntime" is required/);
    }
  });

  it('rejects config where defaultAgentRuntime references a non-existent entry', () => {
    const result = eforgeConfigSchema.safeParse({
      ...validBase,
      agentRuntimes: { opus: { harness: 'claude-sdk' } },
      defaultAgentRuntime: 'missing-runtime',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join('\n');
      expect(messages).toMatch(/"missing-runtime"/);
      expect(messages).toMatch(/not declared in "agentRuntimes"/);
    }
  });

  it('rejects config where agents.roles.*.agentRuntime references a non-existent entry', () => {
    const result = eforgeConfigSchema.safeParse({
      ...validBase,
      agentRuntimes: { opus: { harness: 'claude-sdk' } },
      defaultAgentRuntime: 'opus',
      agents: {
        maxTurns: 30,
        roles: {
          builder: { agentRuntime: 'ghost' },
        },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join('\n');
      expect(messages).toMatch(/agents\.roles\.builder\.agentRuntime/);
      expect(messages).toMatch(/"ghost"/);
      expect(messages).toMatch(/not declared in "agentRuntimes"/);
    }
  });

  it('accepts config where agents.roles.*.agentRuntime references a declared entry', () => {
    const result = eforgeConfigSchema.safeParse({
      ...validBase,
      agentRuntimes: {
        opus: { harness: 'claude-sdk' },
        mypi: { harness: 'pi' },
      },
      defaultAgentRuntime: 'opus',
      agents: {
        maxTurns: 30,
        roles: {
          builder: { agentRuntime: 'mypi' },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects config with pi harness + claudeSdk sub-block in agentRuntimes entry', () => {
    const result = eforgeConfigSchema.safeParse({
      ...validBase,
      agentRuntimes: {
        bad: { harness: 'pi', claudeSdk: { disableSubagents: false } },
      },
      defaultAgentRuntime: 'bad',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join('\n');
      expect(messages).toMatch(/harness "pi".*cannot include "claudeSdk"/);
    }
  });

  // Legacy backend scalar rejection is covered by packages/engine/test/config.legacy-rejection.test.ts
});
