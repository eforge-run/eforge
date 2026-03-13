import { describe, it, expect } from 'vitest';
import { mapSDKMessages } from '../src/engine/agents/common.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ForgeEvent } from '../src/engine/events.js';

/** Convert an array to an AsyncIterable of SDKMessages (cast through unknown) */
async function* asyncIterableFrom(items: unknown[]): AsyncGenerator<SDKMessage> {
  for (const item of items) {
    yield item as SDKMessage;
  }
}

/** Collect all events from an async generator */
async function collectEvents(gen: AsyncGenerator<ForgeEvent>): Promise<ForgeEvent[]> {
  const events: ForgeEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

describe('mapSDKMessages', () => {
  it('maps assistant text block to agent:message', async () => {
    const messages = asyncIterableFrom([
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Hello world' }],
        },
      },
    ]);

    const events = await collectEvents(mapSDKMessages(messages, 'planner'));
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: 'agent:message',
      planId: undefined,
      agent: 'planner',
      content: 'Hello world',
    });
  });

  it('maps tool_use block to agent:tool_use', async () => {
    const messages = asyncIterableFrom([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'read_file', input: { path: '/foo.ts' } },
          ],
        },
      },
    ]);

    const events = await collectEvents(mapSDKMessages(messages, 'builder'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'agent:tool_use',
      agent: 'builder',
      tool: 'read_file',
      input: { path: '/foo.ts' },
    });
  });

  it('maps stream text_delta to agent:message', async () => {
    const messages = asyncIterableFrom([
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'streaming chunk' },
        },
      },
    ]);

    const events = await collectEvents(mapSDKMessages(messages, 'reviewer'));
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: 'agent:message',
      planId: undefined,
      agent: 'reviewer',
      content: 'streaming chunk',
    });
  });

  it('maps result success to agent:message', async () => {
    const messages = asyncIterableFrom([
      {
        type: 'result',
        subtype: 'success',
        result: 'Final result text',
      },
    ]);

    const events = await collectEvents(mapSDKMessages(messages, 'planner'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'agent:message',
      content: 'Final result text',
    });
  });

  it('throws on result error', async () => {
    const messages = asyncIterableFrom([
      {
        type: 'result',
        subtype: 'error',
        errors: ['Something failed', 'Another error'],
      },
    ]);

    await expect(
      collectEvents(mapSDKMessages(messages, 'builder')),
    ).rejects.toThrow('Something failed; Another error');
  });

  it('ignores unknown message types', async () => {
    const messages = asyncIterableFrom([
      { type: 'system' },
      { type: 'user' },
    ]);

    const events = await collectEvents(mapSDKMessages(messages, 'planner'));
    expect(events).toHaveLength(0);
  });

  it('propagates planId', async () => {
    const messages = asyncIterableFrom([
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'hello' }],
        },
      },
    ]);

    const events = await collectEvents(mapSDKMessages(messages, 'builder', 'plan-42'));
    expect(events[0]).toMatchObject({ planId: 'plan-42' });
  });

  it('maps multiple blocks in one assistant message', async () => {
    const messages = asyncIterableFrom([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Starting...' },
            { type: 'tool_use', name: 'write_file', input: { path: '/a.ts' } },
            { type: 'text', text: 'Done.' },
          ],
        },
      },
    ]);

    const events = await collectEvents(mapSDKMessages(messages, 'builder'));
    expect(events).toHaveLength(3);
    expect(events[0].type).toBe('agent:message');
    expect(events[1].type).toBe('agent:tool_use');
    expect(events[2].type).toBe('agent:message');
  });
});
