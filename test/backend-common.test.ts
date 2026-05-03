import { describe, it, expect } from 'vitest';
import { buildAgentStartEvent, normalizeToolUseId } from '@eforge-build/engine/harnesses/common';

describe('buildAgentStartEvent', () => {
  it('emits only required fields when optional options are omitted', () => {
    const event = buildAgentStartEvent({
      agentId: 'agent-1',
      agent: 'builder',
      model: 'claude-sonnet-4',
      harness: 'claude-sdk',
      harnessSource: 'tier',
      tier: 'implementation',
      tierSource: 'tier',
    });

    expect(event.type).toBe('agent:start');
    expect(event.agentId).toBe('agent-1');
    expect(event.agent).toBe('builder');
    expect(event.model).toBe('claude-sonnet-4');
    expect(event.harness).toBe('claude-sdk');
    expect(event.harnessSource).toBe('tier');
    expect(event.tier).toBe('implementation');
    expect(event.tierSource).toBe('tier');
    expect(typeof event.timestamp).toBe('string');
    expect(() => new Date(event.timestamp).toISOString()).not.toThrow();

    // No undefined values should appear on the event — optional fields
    // omitted from the options must not surface as explicit undefined keys.
    const entries = Object.entries(event as Record<string, unknown>);
    for (const [key, value] of entries) {
      expect(value, `key ${key} should not be undefined`).not.toBeUndefined();
    }

    // None of the optional keys should be present at all.
    const optionalKeys = [
      'planId',
      'effort',
      'thinking',
      'effortClamped',
      'effortOriginal',
      'effortSource',
      'thinkingSource',
      'thinkingCoerced',
      'thinkingOriginal',
      'perspective',
    ];
    for (const key of optionalKeys) {
      expect(key in event, `optional key ${key} should not be present`).toBe(false);
    }
  });

  it('copies every optional field onto the returned event when supplied', () => {
    const event = buildAgentStartEvent({
      planId: 'plan-42',
      agentId: 'agent-2',
      agent: 'planner',
      model: 'claude-opus-4',
      harness: 'pi',
      harnessSource: 'tier',
      tier: 'planning',
      tierSource: 'tier',
      effort: 'high',
      thinking: { type: 'enabled', budgetTokens: 10_000 },
      effortClamped: true,
      effortOriginal: 'max',
      effortSource: 'plan',
      thinkingSource: 'role',
      thinkingCoerced: true,
      thinkingOriginal: { type: 'enabled' },
      perspective: 'security',
    });

    expect(event).toMatchObject({
      type: 'agent:start',
      planId: 'plan-42',
      agentId: 'agent-2',
      agent: 'planner',
      model: 'claude-opus-4',
      harness: 'pi',
      harnessSource: 'tier',
      tier: 'planning',
      tierSource: 'tier',
      effort: 'high',
      thinking: { type: 'enabled', budgetTokens: 10_000 },
      effortClamped: true,
      effortOriginal: 'max',
      effortSource: 'plan',
      thinkingSource: 'role',
      thinkingCoerced: true,
      thinkingOriginal: { type: 'enabled' },
      perspective: 'security',
    });
  });

  it('never emits keys with undefined values even when explicit undefined is passed', () => {
    const event = buildAgentStartEvent({
      agentId: 'agent-3',
      agent: 'builder',
      model: 'm',
      harness: 'claude-sdk',
      harnessSource: 'tier',
      tier: 'implementation',
      tierSource: 'tier',
      // Explicit undefineds simulate the common caller pattern of forwarding
      // AgentRunOptions fields directly without pre-filtering.
      effort: undefined,
      thinking: undefined,
      effortClamped: undefined,
      effortOriginal: undefined,
      effortSource: undefined,
      thinkingSource: undefined,
      thinkingCoerced: undefined,
      thinkingOriginal: undefined,
      planId: undefined,
      perspective: undefined,
    });

    for (const [key, value] of Object.entries(event as Record<string, unknown>)) {
      expect(value, `key ${key} should not be undefined`).not.toBeUndefined();
    }
    expect('planId' in event).toBe(false);
    expect('effort' in event).toBe(false);
    expect('thinking' in event).toBe(false);
    expect('perspective' in event).toBe(false);
  });
});

describe('normalizeToolUseId', () => {
  it('returns id when only id is present', () => {
    expect(normalizeToolUseId({ id: 'tool_use_abc' })).toBe('tool_use_abc');
  });

  it('returns toolCallId when only toolCallId is present', () => {
    expect(normalizeToolUseId({ toolCallId: 'call_xyz' })).toBe('call_xyz');
  });

  it('prefers id when both id and toolCallId are present', () => {
    expect(normalizeToolUseId({ id: 'tool_use_abc', toolCallId: 'call_xyz' })).toBe('tool_use_abc');
  });

  it('throws a descriptive error naming both field names when neither is present', () => {
    let caught: unknown;
    try {
      normalizeToolUseId({});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain('id');
    expect(message).toContain('toolCallId');
  });
});
