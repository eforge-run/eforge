import { describe, it, expect } from 'vitest';
import type { EforgeEvent } from '../src/engine/events.js';
import { StubBackend } from './stub-backend.js';
import { collectEvents, findEvent, filterEvents } from './test-events.js';
import { runGapCloser } from '../src/engine/agents/gap-closer.js';

const GAPS = [
  { requirement: 'Must support dark mode', explanation: 'No dark mode CSS classes found in the theme configuration' },
];

const PRD_CONTENT = '# Feature PRD\n\n## Requirements\n\n- Must support dark mode\n- Must have responsive layout';

const BASE_OPTIONS = {
  cwd: '/tmp',
  gaps: GAPS,
  prdContent: PRD_CONTENT,
};

describe('runGapCloser wiring', () => {
  it('emits start and complete lifecycle events', async () => {
    const backend = new StubBackend([{ text: 'Fixed the gaps.' }]);

    const events = await collectEvents(runGapCloser({ backend, ...BASE_OPTIONS }));

    const start = findEvent(events, 'gap_close:start');
    expect(start).toBeDefined();

    const complete = findEvent(events, 'gap_close:complete');
    expect(complete).toBeDefined();
  });

  it('emits start before complete', async () => {
    const backend = new StubBackend([{ text: 'Fixed.' }]);

    const events = await collectEvents(runGapCloser({ backend, ...BASE_OPTIONS }));

    const startIdx = events.findIndex((e) => e.type === 'gap_close:start');
    const completeIdx = events.findIndex((e) => e.type === 'gap_close:complete');
    expect(startIdx).toBeLessThan(completeIdx);
  });

  it('formats gaps and PRD content into prompt', async () => {
    const backend = new StubBackend([{ text: 'Done.' }]);

    await collectEvents(runGapCloser({ backend, ...BASE_OPTIONS }));

    expect(backend.prompts).toHaveLength(1);
    expect(backend.prompts[0]).toContain('Must support dark mode');
    expect(backend.prompts[0]).toContain('No dark mode CSS classes found');
    expect(backend.prompts[0]).toContain('Feature PRD');
  });

  it('passes correct backend options', async () => {
    const backend = new StubBackend([{ text: 'Done.' }]);

    await collectEvents(runGapCloser({ backend, ...BASE_OPTIONS }));

    expect(backend.calls).toHaveLength(1);
    expect(backend.calls[0].maxTurns).toBe(30);
    expect(backend.calls[0].tools).toBe('coding');
  });

  it('yields agent:result and tool events in non-verbose mode', async () => {
    const backend = new StubBackend([{
      text: 'Fixed it.',
      toolCalls: [{
        tool: 'Edit',
        toolUseId: 'tu-1',
        input: { file: 'src/theme.ts' },
        output: 'File edited',
      }],
    }]);

    const events = await collectEvents(runGapCloser({ backend, ...BASE_OPTIONS }));

    expect(findEvent(events, 'agent:result')).toBeDefined();
    expect(filterEvents(events, 'agent:tool_use')).toHaveLength(1);
    expect(filterEvents(events, 'agent:tool_result')).toHaveLength(1);
  });

  it('suppresses agent:message when verbose is false', async () => {
    const backend = new StubBackend([{ text: 'Some verbose output.' }]);

    const events = await collectEvents(runGapCloser({ backend, ...BASE_OPTIONS }));

    expect(filterEvents(events, 'agent:message')).toHaveLength(0);
  });

  it('emits agent:message when verbose is true', async () => {
    const backend = new StubBackend([{ text: 'Some verbose output.' }]);

    const events = await collectEvents(runGapCloser({ backend, ...BASE_OPTIONS, verbose: true }));

    expect(filterEvents(events, 'agent:message').length).toBeGreaterThan(0);
  });

  it('swallows non-abort errors and still emits complete event', async () => {
    const backend = new StubBackend([{ error: new Error('Agent crashed') }]);

    const events = await collectEvents(runGapCloser({ backend, ...BASE_OPTIONS }));

    expect(findEvent(events, 'gap_close:start')).toBeDefined();
    expect(findEvent(events, 'gap_close:complete')).toBeDefined();
  });

  it('re-throws AbortError', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    const backend = new StubBackend([{ error: abortError }]);

    let thrown: Error | undefined;
    const events: EforgeEvent[] = [];
    try {
      for await (const event of runGapCloser({ backend, ...BASE_OPTIONS })) {
        events.push(event);
      }
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown).toBeDefined();
    expect(thrown!.name).toBe('AbortError');

    // Start event emitted before the error
    expect(findEvent(events, 'gap_close:start')).toBeDefined();
    // Complete event NOT emitted — generator threw
    expect(findEvent(events, 'gap_close:complete')).toBeUndefined();
  });
});
