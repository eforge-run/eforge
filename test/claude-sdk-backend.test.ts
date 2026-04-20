import { describe, it, expect } from 'vitest';
import { mapSDKMessages, resolveDisallowedTools, SUBAGENT_TOOL_NAME } from '@eforge-build/engine/backends/claude-sdk';
import { AgentTerminalError } from '@eforge-build/engine/backend';

async function* iter<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

describe('mapSDKMessages error formatting', () => {
  // Regression: the SDK's result error carries both a `subtype` (e.g. `error_max_turns`)
  // and a human-readable `errors[]`. The backend must throw `AgentTerminalError` carrying
  // the subtype so pipeline continuation logic can branch on it without parsing strings.
  it('throws AgentTerminalError with subtype when SDK errors[] is populated', async () => {
    const msgs = [
      {
        type: 'result',
        subtype: 'error_max_turns',
        is_error: true,
        errors: ['Reached maximum number of turns (30).'],
        duration_ms: 0,
        duration_api_ms: 0,
        num_turns: 30,
        stop_reason: null,
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        modelUsage: {},
        permission_denials: [],
        uuid: '00000000-0000-0000-0000-000000000000',
      },
    ] as unknown[];

    const gen = mapSDKMessages(iter(msgs as never[]), 'builder', 'agent-id', 'plan-01');

    let caught: unknown;
    try {
      for await (const _ of gen) { /* drain */ }
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AgentTerminalError);
    const terminal = caught as AgentTerminalError;
    expect(terminal.subtype).toBe('error_max_turns');
    expect(terminal.message).toContain('Reached maximum number of turns');
  });

  it('throws AgentTerminalError with subtype when errors[] is empty', async () => {
    const msgs = [
      {
        type: 'result',
        subtype: 'error_max_turns',
        is_error: true,
        duration_ms: 0,
        duration_api_ms: 0,
        num_turns: 30,
        stop_reason: null,
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        modelUsage: {},
        permission_denials: [],
        uuid: '00000000-0000-0000-0000-000000000000',
      },
    ] as unknown[];

    const gen = mapSDKMessages(iter(msgs as never[]), 'builder', 'agent-id', 'plan-01');

    let caught: unknown;
    try {
      for await (const _ of gen) { /* drain */ }
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AgentTerminalError);
    expect((caught as AgentTerminalError).subtype).toBe('error_max_turns');
  });
});

describe('resolveDisallowedTools (claudeSdk.disableSubagents)', () => {
  it('returns undefined when nothing is disallowed and subagents are allowed', () => {
    expect(resolveDisallowedTools(undefined, false)).toBeUndefined();
    expect(resolveDisallowedTools([], false)).toEqual([]);
  });

  it('returns the role list unchanged when subagents are allowed', () => {
    expect(resolveDisallowedTools(['Bash', 'Write'], false)).toEqual(['Bash', 'Write']);
  });

  it('returns a copy so the caller cannot mutate role config', () => {
    const roleList = ['Bash'];
    const resolved = resolveDisallowedTools(roleList, false);
    expect(resolved).not.toBe(roleList);
  });

  it('appends Task when disableSubagents is true and role has no disallowedTools', () => {
    expect(resolveDisallowedTools(undefined, true)).toEqual([SUBAGENT_TOOL_NAME]);
  });

  it('appends Task to an existing role disallowedTools list', () => {
    expect(resolveDisallowedTools(['Bash', 'Write'], true)).toEqual(['Bash', 'Write', SUBAGENT_TOOL_NAME]);
  });

  it('does not duplicate Task when the role already disallows it', () => {
    expect(resolveDisallowedTools(['Task', 'Bash'], true)).toEqual(['Task', 'Bash']);
  });

  it('exposes Task as the subagent tool name', () => {
    expect(SUBAGENT_TOOL_NAME).toBe('Task');
  });
});
