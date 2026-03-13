import { describe, it, expect } from 'vitest';
import type { ForgeEvent } from '../src/engine/events.js';
import { mapSDKMessages, truncateOutput } from '../src/engine/agents/common.js';

/**
 * Helper: collect all events from an async generator into an array.
 */
async function collectEvents(gen: AsyncGenerator<ForgeEvent>): Promise<ForgeEvent[]> {
  const events: ForgeEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

/**
 * Helper: create an async iterable from an array of SDK messages.
 */
function asyncIterableFrom<T>(items: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i < items.length) {
            return { value: items[i++], done: false };
          }
          return { value: undefined, done: true };
        },
      };
    },
  };
}

describe('mapSDKMessages tool events', () => {
  it('emits agent:tool_use with toolUseId from assistant message', async () => {
    const messages = asyncIterableFrom([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tu_abc123', name: 'Read', input: { path: '/src/index.ts' } },
          ],
        },
      } as unknown,
      {
        type: 'result',
        subtype: 'success',
        result: 'done',
        modelUsage: {},
      } as unknown,
    ]);

    const events = await collectEvents(mapSDKMessages(messages as AsyncIterable<any>, 'planner'));
    const toolUse = events.find((e) => e.type === 'agent:tool_use');

    expect(toolUse).toBeDefined();
    expect(toolUse).toMatchObject({
      type: 'agent:tool_use',
      agent: 'planner',
      tool: 'Read',
      toolUseId: 'tu_abc123',
      input: { path: '/src/index.ts' },
    });
  });

  it('emits agent:tool_result from tool_use_summary message', async () => {
    const messages = asyncIterableFrom([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tu_def456', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      } as unknown,
      {
        type: 'tool_use_summary',
        summary: 'Listed directory contents',
        preceding_tool_use_ids: ['tu_def456'],
        uuid: 'uuid-1',
        session_id: '',
      } as unknown,
      {
        type: 'result',
        subtype: 'success',
        result: 'done',
        modelUsage: {},
      } as unknown,
    ]);

    const events = await collectEvents(mapSDKMessages(messages as AsyncIterable<any>, 'builder', 'plan-1'));
    const toolResult = events.find((e) => e.type === 'agent:tool_result');

    expect(toolResult).toBeDefined();
    expect(toolResult).toMatchObject({
      type: 'agent:tool_result',
      agent: 'builder',
      planId: 'plan-1',
      tool: 'Bash',
      toolUseId: 'tu_def456',
      output: 'Listed directory contents',
    });
  });

  it('emits tool_result for each tool in a batch summary', async () => {
    const messages = asyncIterableFrom([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tu_111', name: 'Grep', input: { pattern: 'foo' } },
            { type: 'tool_use', id: 'tu_222', name: 'Read', input: { path: '/a.ts' } },
          ],
        },
      } as unknown,
      {
        type: 'tool_use_summary',
        summary: 'Found matches and read file',
        preceding_tool_use_ids: ['tu_111', 'tu_222'],
        uuid: 'uuid-2',
        session_id: '',
      } as unknown,
      {
        type: 'result',
        subtype: 'success',
        result: 'done',
        modelUsage: {},
      } as unknown,
    ]);

    const events = await collectEvents(mapSDKMessages(messages as AsyncIterable<any>, 'planner'));
    const toolResults = events.filter((e) => e.type === 'agent:tool_result');

    expect(toolResults).toHaveLength(2);
    expect(toolResults[0]).toMatchObject({ tool: 'Grep', toolUseId: 'tu_111' });
    expect(toolResults[1]).toMatchObject({ tool: 'Read', toolUseId: 'tu_222' });
  });

  it('ignores unhandled SDK message types', async () => {
    const messages = asyncIterableFrom([
      {
        type: 'system',
        subtype: 'init',
        uuid: 'uuid-3',
        session_id: '',
      } as unknown,
      {
        type: 'result',
        subtype: 'success',
        result: 'done',
        modelUsage: {},
      } as unknown,
    ]);

    const events = await collectEvents(mapSDKMessages(messages as AsyncIterable<any>, 'planner'));
    const toolResults = events.filter((e) => e.type === 'agent:tool_result');
    expect(toolResults).toHaveLength(0);
  });

  it('falls back to "unknown" tool name when toolUseId not previously seen', async () => {
    const messages = asyncIterableFrom([
      {
        type: 'tool_use_summary',
        summary: 'did something',
        preceding_tool_use_ids: ['tu_orphan'],
        uuid: 'uuid-4',
        session_id: '',
      } as unknown,
      {
        type: 'result',
        subtype: 'success',
        result: 'done',
        modelUsage: {},
      } as unknown,
    ]);

    const events = await collectEvents(mapSDKMessages(messages as AsyncIterable<any>, 'planner'));
    const toolResult = events.find((e) => e.type === 'agent:tool_result');
    expect(toolResult).toMatchObject({ tool: 'unknown', toolUseId: 'tu_orphan' });
  });

  it('truncates long tool_use_summary output', async () => {
    const longSummary = 'x'.repeat(8000);
    const messages = asyncIterableFrom([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tu_long', name: 'Read', input: {} },
          ],
        },
      } as unknown,
      {
        type: 'tool_use_summary',
        summary: longSummary,
        preceding_tool_use_ids: ['tu_long'],
        uuid: 'uuid-5',
        session_id: '',
      } as unknown,
      {
        type: 'result',
        subtype: 'success',
        result: 'done',
        modelUsage: {},
      } as unknown,
    ]);

    const events = await collectEvents(mapSDKMessages(messages as AsyncIterable<any>, 'planner'));
    const toolResult = events.find((e) => e.type === 'agent:tool_result');
    expect(toolResult).toBeDefined();
    if (toolResult?.type === 'agent:tool_result') {
      expect(toolResult.output.length).toBeLessThan(8000);
      expect(toolResult.output).toContain('... [truncated from 8000 chars]');
    }
  });
});

describe('truncateOutput', () => {
  it('returns short strings unchanged', () => {
    expect(truncateOutput('hello', 100)).toBe('hello');
  });

  it('truncates long strings with suffix', () => {
    const input = 'a'.repeat(200);
    const result = truncateOutput(input, 100);
    expect(result.length).toBeLessThan(200);
    expect(result).toContain('... [truncated from 200 chars]');
    expect(result.startsWith('a'.repeat(100))).toBe(true);
  });

  it('returns exact-length strings unchanged', () => {
    const input = 'x'.repeat(50);
    expect(truncateOutput(input, 50)).toBe(input);
  });
});
