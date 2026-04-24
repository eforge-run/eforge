import { describe, it, expect } from 'vitest';
import type { EforgeEvent } from '@eforge-build/engine/events';
import { StubHarness } from './stub-harness.js';
import { findEvent, filterEvents } from './test-events.js';
import { runFormatter } from '@eforge-build/engine/agents/formatter';

async function collectEventsAndResult(
  gen: AsyncGenerator<EforgeEvent, { body: string }>,
): Promise<{ events: EforgeEvent[]; result: { body: string } }> {
  const events: EforgeEvent[] = [];
  let iterResult = await gen.next();
  while (!iterResult.done) {
    events.push(iterResult.value);
    iterResult = await gen.next();
  }
  return { events, result: iterResult.value };
}

describe('runFormatter wiring', () => {
  it('yields formatted body from agent output', async () => {
    const formattedContent = '## Problem\n\nWidget is broken.\n\n## Goal\n\nFix the widget.';
    const backend = new StubHarness([{ text: formattedContent }]);

    const { events, result } = await collectEventsAndResult(
      runFormatter({ harness: backend, sourceContent: 'Fix the broken widget' }),
    );

    expect(result.body).toBe(formattedContent);
    // agent:start and agent:stop should always be yielded
    expect(findEvent(events, 'agent:start')).toBeDefined();
    expect(findEvent(events, 'agent:stop')).toBeDefined();
    expect(findEvent(events, 'agent:result')).toBeDefined();
  });

  it('emits events in correct sequence', async () => {
    const backend = new StubHarness([{ text: 'Formatted output.' }]);

    const { events } = await collectEventsAndResult(
      runFormatter({ harness: backend, sourceContent: 'raw input' }),
    );

    const types = events.map((e) => e.type);
    const startIdx = types.indexOf('agent:start');
    const resultIdx = types.indexOf('agent:result');
    const stopIdx = types.indexOf('agent:stop');

    expect(startIdx).toBeLessThan(resultIdx);
    expect(resultIdx).toBeLessThan(stopIdx);
  });

  it('passes source content to backend prompt', async () => {
    const backend = new StubHarness([{ text: 'Formatted.' }]);
    const sourceContent = 'Please add dark mode support to the app';

    await collectEventsAndResult(
      runFormatter({ harness: backend, sourceContent }),
    );

    expect(backend.prompts).toHaveLength(1);
    expect(backend.prompts[0]).toContain(sourceContent);
  });

  it('uses tools: none and maxTurns: 1', async () => {
    const backend = new StubHarness([{ text: 'Formatted.' }]);

    await collectEventsAndResult(
      runFormatter({ harness: backend, sourceContent: 'test' }),
    );

    expect(backend.calls).toHaveLength(1);
    expect(backend.calls[0].tools).toBe('none');
    expect(backend.calls[0].maxTurns).toBe(1);
  });

  it('suppresses agent:message when verbose is false', async () => {
    const backend = new StubHarness([{ text: 'Some output.' }]);

    const { events } = await collectEventsAndResult(
      runFormatter({ harness: backend, sourceContent: 'test' }),
    );

    expect(filterEvents(events, 'agent:message')).toHaveLength(0);
  });

  it('emits agent:message when verbose is true', async () => {
    const backend = new StubHarness([{ text: 'Some output.' }]);

    const { events } = await collectEventsAndResult(
      runFormatter({ harness: backend, sourceContent: 'test', verbose: true }),
    );

    expect(filterEvents(events, 'agent:message').length).toBeGreaterThan(0);
  });

  it('sets agent role to formatter', async () => {
    const backend = new StubHarness([{ text: 'Formatted.' }]);

    const { events } = await collectEventsAndResult(
      runFormatter({ harness: backend, sourceContent: 'test' }),
    );

    const start = findEvent(events, 'agent:start');
    expect(start).toBeDefined();
    expect(start!.agent).toBe('formatter');
  });
});
