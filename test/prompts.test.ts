import { describe, it, expect } from 'vitest';
import { loadPrompt } from '@eforge-build/engine/prompts';

describe('loadPrompt() throws on unresolved template variables', () => {
  it('throws when called with partial vars for the planner prompt', async () => {
    await expect(
      loadPrompt('planner', {}),
    ).rejects.toThrow(/loadPrompt\(planner\.md\): unresolved template variables: .+/);
  });

  it('error message contains the prompt identifier', async () => {
    await expect(
      loadPrompt('planner', {}),
    ).rejects.toThrow('loadPrompt(planner');
  });

  it('error message contains at least one specific missing variable name', async () => {
    const error = await loadPrompt('planner', {}).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('source');
  });

  it('deduplicates repeated unresolved variable names in the error message', async () => {
    // The planner prompt uses {{planSetName}} multiple times; it should only appear once in the error
    const error = await loadPrompt('planner', {}).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    const msg = (error as Error).message;
    const matches = msg.match(/\bplanSetName\b/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('returns a string with zero {{...}} tokens when all variables are provided', async () => {
    const prompt = await loadPrompt('builder', {
      plan_id: 'test-plan-01',
      plan_name: 'Test Plan',
      plan_content: 'Implement the feature.',
      parallelLanes: '',
      verification_scope: 'Run pnpm test.',
      continuation_context: '',
    });

    expect(typeof prompt).toBe('string');
    expect(prompt).not.toMatch(/\{\{[a-zA-Z0-9_]+\}\}/);
  });
});
