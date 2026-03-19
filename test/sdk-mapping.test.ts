import { describe, it, expect } from 'vitest';
import { mapSDKMessages } from '../src/engine/backends/claude-sdk.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { collectEvents } from './test-events.js';

/** Convert an array to an AsyncIterable of SDKMessages (cast through unknown) */
async function* asyncIterableFrom(items: unknown[]): AsyncGenerator<SDKMessage> {
  for (const item of items) {
    yield item as SDKMessage;
  }
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

  it('maps result success to agent:message and agent:result', async () => {
    const messages = asyncIterableFrom([
      {
        type: 'result',
        subtype: 'success',
        result: 'Final result text',
        duration_ms: 5000,
        duration_api_ms: 4000,
        num_turns: 3,
        total_cost_usd: 0.05,
        usage: { input_tokens: 100, output_tokens: 200 },
        modelUsage: {
          'claude-sonnet-4-20250514': {
            inputTokens: 60,
            outputTokens: 200,
            cacheReadInputTokens: 30,
            cacheCreationInputTokens: 10,
            costUSD: 0.05,
          },
        },
      },
    ]);

    const events = await collectEvents(mapSDKMessages(messages, 'planner'));
    // Result text is NOT re-emitted as agent:message (already came from assistant message).
    // Only agent:result is emitted with resultText captured for tracing.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'agent:result',
      agent: 'planner',
      result: {
        durationMs: 5000,
        numTurns: 3,
        totalCostUsd: 0.05,
        usage: { input: 100, output: 200, total: 300, cacheRead: 30, cacheCreation: 10 },
        resultText: 'Final result text',
      },
    });
  });

  it('aggregates tokens across multiple models in modelUsage', async () => {
    const messages = asyncIterableFrom([
      {
        type: 'result',
        subtype: 'success',
        result: 'Done',
        duration_ms: 10000,
        duration_api_ms: 9000,
        num_turns: 7,
        total_cost_usd: 0.87,
        // SDK aggregate only reflects primary model
        usage: { input_tokens: 7, output_tokens: 11267 },
        modelUsage: {
          'claude-opus-4-6': {
            inputTokens: 7,
            outputTokens: 11267,
            cacheReadInputTokens: 500,
            cacheCreationInputTokens: 100,
            costUSD: 0.53,
          },
          'claude-haiku-4-5-20251001': {
            inputTokens: 126,
            outputTokens: 12591,
            cacheReadInputTokens: 200,
            cacheCreationInputTokens: 50,
            costUSD: 0.34,
          },
        },
      },
    ]);

    const events = await collectEvents(mapSDKMessages(messages, 'planner'));
    const resultEvent = events.find((e) => e.type === 'agent:result');
    expect(resultEvent).toBeDefined();
    if (resultEvent?.type === 'agent:result') {
      // Aggregate should sum ALL models, not just the SDK's primary model usage
      // input = uncached + cacheRead + cacheCreation across all models
      expect(resultEvent.result.usage).toEqual({
        input: (7 + 500 + 100) + (126 + 200 + 50),
        output: 11267 + 12591,
        total: (7 + 500 + 100) + (126 + 200 + 50) + 11267 + 12591,
        cacheRead: 500 + 200,
        cacheCreation: 100 + 50,
      });
      // Per-model entries should include cache fields
      expect(resultEvent.result.modelUsage['claude-opus-4-6']).toEqual({
        inputTokens: 7 + 500 + 100,
        outputTokens: 11267,
        cacheReadInputTokens: 500,
        cacheCreationInputTokens: 100,
        costUSD: 0.53,
      });
      expect(resultEvent.result.modelUsage['claude-haiku-4-5-20251001']).toEqual({
        inputTokens: 126 + 200 + 50,
        outputTokens: 12591,
        cacheReadInputTokens: 200,
        cacheCreationInputTokens: 50,
        costUSD: 0.34,
      });
    }
  });

  it('throws on result error after yielding agent:result', async () => {
    const messages = asyncIterableFrom([
      {
        type: 'result',
        subtype: 'error_during_execution',
        errors: ['Something failed', 'Another error'],
        duration_ms: 1000,
        duration_api_ms: 800,
        num_turns: 1,
        total_cost_usd: 0.01,
        usage: { input_tokens: 50, output_tokens: 10 },
        modelUsage: {},
      },
    ]);

    const gen = mapSDKMessages(messages, 'builder');
    // First yield should be agent:result with usage data (even on error)
    const first = await gen.next();
    expect(first.done).toBe(false);
    expect(first.value).toMatchObject({
      type: 'agent:result',
      agent: 'builder',
      result: {
        durationMs: 1000,
        numTurns: 1,
        totalCostUsd: 0.01,
        usage: { input: 50, output: 10, total: 60 },
      },
    });
    // Next iteration should throw
    await expect(gen.next()).rejects.toThrow('Something failed; Another error');
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
