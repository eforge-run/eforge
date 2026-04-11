import { describe, it, expect } from 'vitest';
import { normalizeUsage, toModelUsageEntry } from '@eforge-build/engine/backends/usage';

describe('normalizeUsage', () => {
  it('inflates input with cacheRead and cacheCreation', () => {
    expect(
      normalizeUsage({ uncachedInput: 100, output: 50, cacheRead: 500, cacheCreation: 10 }),
    ).toEqual({
      input: 610,
      output: 50,
      total: 660,
      cacheRead: 500,
      cacheCreation: 10,
    });
  });

  it('handles zero counters', () => {
    expect(
      normalizeUsage({ uncachedInput: 0, output: 0, cacheRead: 0, cacheCreation: 0 }),
    ).toEqual({ input: 0, output: 0, total: 0, cacheRead: 0, cacheCreation: 0 });
  });

  it('handles pure-cached input (uncachedInput = 0)', () => {
    const usage = normalizeUsage({
      uncachedInput: 0,
      output: 20,
      cacheRead: 1000,
      cacheCreation: 50,
    });
    expect(usage.input).toBe(1050);
    expect(usage.total).toBe(1070);
  });

  it('guarantees cacheRead <= input for non-negative inputs (invariant)', () => {
    const cases: Array<{ uncachedInput: number; output: number; cacheRead: number; cacheCreation: number }> = [
      { uncachedInput: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      { uncachedInput: 1, output: 0, cacheRead: 0, cacheCreation: 0 },
      { uncachedInput: 0, output: 0, cacheRead: 1000, cacheCreation: 0 },
      { uncachedInput: 0, output: 0, cacheRead: 1000, cacheCreation: 500 },
      { uncachedInput: 42, output: 7, cacheRead: 1234, cacheCreation: 567 },
      { uncachedInput: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheCreation: 1_000_000 },
    ];
    for (const raw of cases) {
      const usage = normalizeUsage(raw);
      expect(usage.cacheRead).toBeLessThanOrEqual(usage.input);
    }
  });
});

describe('toModelUsageEntry', () => {
  it('inflates inputTokens and passes costUSD through unchanged', () => {
    const entry = toModelUsageEntry(
      { uncachedInput: 100, output: 50, cacheRead: 500, cacheCreation: 10 },
      0.1234,
    );
    expect(entry).toEqual({
      inputTokens: 610,
      outputTokens: 50,
      cacheReadInputTokens: 500,
      cacheCreationInputTokens: 10,
      costUSD: 0.1234,
    });
  });

  it('passes cost through even when zero', () => {
    const entry = toModelUsageEntry(
      { uncachedInput: 1, output: 2, cacheRead: 3, cacheCreation: 4 },
      0,
    );
    expect(entry.costUSD).toBe(0);
    expect(entry.inputTokens).toBe(8);
  });
});
