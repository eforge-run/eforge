import { describe, it, expect } from 'vitest';
import { STRICTNESS_BLOCKS } from '@eforge-build/engine/agents/builder';

// --- Evaluator strictness blocks ---

describe('STRICTNESS_BLOCKS', () => {
  it('strict block contains "high bar" text', () => {
    expect(STRICTNESS_BLOCKS['strict']).toContain('high bar');
  });

  it('lenient block contains "low bar" text', () => {
    expect(STRICTNESS_BLOCKS['lenient']).toContain('low bar');
  });

  it('standard block is empty string', () => {
    expect(STRICTNESS_BLOCKS['standard']).toBe('');
  });

  it('strict block mentions rejecting when in doubt', () => {
    expect(STRICTNESS_BLOCKS['strict']).toContain('When in doubt, reject');
  });

  it('lenient block mentions accepting when in doubt', () => {
    expect(STRICTNESS_BLOCKS['lenient']).toContain('When in doubt, accept');
  });
});
