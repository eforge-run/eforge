/**
 * Unit tests for formatThinking — the helper used by plan-row.tsx to render
 * thinkingOriginal in the agent-stage hover (AC #8 display path).
 *
 * formatThinking converts a thinking config object (or any unknown value) into
 * a compact human-readable string for the monitor UI hover tooltip.
 */

import { describe, it, expect } from 'vitest';
import { formatThinking } from '@/lib/format';

describe('formatThinking', () => {
  // -------------------------------------------------------------------------
  // Falsy / absent values
  // -------------------------------------------------------------------------
  it('returns undefined for null', () => {
    expect(formatThinking(null)).toBeUndefined();
  });

  it('returns undefined for undefined', () => {
    expect(formatThinking(undefined)).toBeUndefined();
  });

  it('returns undefined for 0', () => {
    expect(formatThinking(0)).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(formatThinking('')).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // String passthrough
  // -------------------------------------------------------------------------
  it('returns a string value unchanged', () => {
    expect(formatThinking('disabled')).toBe('disabled');
  });

  it('returns an arbitrary string unchanged', () => {
    expect(formatThinking('some-custom-value')).toBe('some-custom-value');
  });

  // -------------------------------------------------------------------------
  // Object with type field
  // -------------------------------------------------------------------------
  it('returns "disabled" for { type: "disabled" }', () => {
    expect(formatThinking({ type: 'disabled' })).toBe('disabled');
  });

  it('returns "adaptive" for { type: "adaptive" }', () => {
    expect(formatThinking({ type: 'adaptive' })).toBe('adaptive');
  });

  it('returns "enabled" for { type: "enabled" } without budgetTokens', () => {
    expect(formatThinking({ type: 'enabled' })).toBe('enabled');
  });

  it('formats enabled+budgetTokens with abbreviated token count', () => {
    // 8000 → "8.0k tokens"
    expect(formatThinking({ type: 'enabled', budgetTokens: 8000 })).toBe('enabled (8.0k tokens)');
  });

  it('formats large budgetTokens with k abbreviation', () => {
    // 32000 → "32.0k tokens"
    expect(formatThinking({ type: 'enabled', budgetTokens: 32000 })).toBe('enabled (32.0k tokens)');
  });

  it('formats 1000 budgetTokens as "1.0k tokens"', () => {
    expect(formatThinking({ type: 'enabled', budgetTokens: 1000 })).toBe('enabled (1.0k tokens)');
  });

  // -------------------------------------------------------------------------
  // Zod-derived schema uses budget_tokens (snake_case) — formatThinking must
  // accept both camelCase and snake_case keys.
  // -------------------------------------------------------------------------
  it('formats budget_tokens (snake_case wire format) identically to budgetTokens', () => {
    // AC #8: the Zod schema emits budget_tokens (snake_case); formatThinking
    // now accepts both keys so the agent-stage hover renders correctly.
    expect(formatThinking({ type: 'enabled', budget_tokens: 32000 })).toBe('enabled (32.0k tokens)');
  });

  it('formats budget_tokens: 0 as "enabled (0 tokens)"', () => {
    expect(formatThinking({ type: 'enabled', budget_tokens: 0 })).toBe('enabled (0 tokens)');
  });

  it('formats large budget_tokens with k abbreviation', () => {
    expect(formatThinking({ type: 'enabled', budget_tokens: 100000 })).toBe('enabled (100.0k tokens)');
  });

  // -------------------------------------------------------------------------
  // Fallback: unknown object → JSON.stringify
  // -------------------------------------------------------------------------
  it('returns JSON string for unrecognised object shape', () => {
    const value = { foo: 'bar', count: 42 };
    expect(formatThinking(value)).toBe(JSON.stringify(value));
  });

  it('returns JSON string for object with unrecognised type', () => {
    const value = { type: 'unknown-mode', budgetTokens: 999 };
    expect(formatThinking(value)).toBe(JSON.stringify(value));
  });

  // -------------------------------------------------------------------------
  // thinkingOriginal shapes from the wire protocol (AC #8 regression gate)
  // -------------------------------------------------------------------------
  it('formats thinkingOriginal with snake_case budget_tokens as "enabled (32.0k tokens)"', () => {
    // AC #8: agent:start emits thinkingOriginal: { type: 'enabled', budget_tokens: 32000 }
    // (snake_case from the Zod wire schema). formatThinking must produce the correct
    // human-readable string for the agent-stage hover tooltip.
    const wirePayload = { type: 'enabled', budget_tokens: 32000 };
    expect(formatThinking(wirePayload)).toBe('enabled (32.0k tokens)');
  });
});
