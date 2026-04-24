import { describe, it, expect } from 'vitest';
import type { EforgeEvent } from '@eforge-build/engine/events';
import { StubHarness } from './stub-harness.js';
import { collectEvents, findEvent, filterEvents } from './test-events.js';
import { runValidationFixer } from '@eforge-build/engine/agents/validation-fixer';

const FAILURES = [
  { command: 'pnpm type-check', exitCode: 1, output: 'error TS2345: Argument of type...' },
];

const BASE_OPTIONS = {
  cwd: '/tmp',
  failures: FAILURES,
  attempt: 1,
  maxAttempts: 2,
};

describe('runValidationFixer wiring', () => {
  it('emits start and complete lifecycle events', async () => {
    const backend = new StubHarness([{ text: 'Fixed the type error.' }]);

    const events = await collectEvents(runValidationFixer({ harness: backend, ...BASE_OPTIONS }));

    const start = findEvent(events, 'validation:fix:start');
    expect(start).toBeDefined();
    expect(start!.attempt).toBe(1);
    expect(start!.maxAttempts).toBe(2);

    const complete = findEvent(events, 'validation:fix:complete');
    expect(complete).toBeDefined();
    expect(complete!.attempt).toBe(1);
  });

  it('formats failure context into prompt', async () => {
    const backend = new StubHarness([{ text: 'Done.' }]);

    await collectEvents(runValidationFixer({ harness: backend, ...BASE_OPTIONS }));

    expect(backend.prompts).toHaveLength(1);
    expect(backend.prompts[0]).toContain('pnpm type-check');
    expect(backend.prompts[0]).toContain('Exit code: 1');
    expect(backend.prompts[0]).toContain('error TS2345');
  });

  it('formats multiple failures with separator', async () => {
    const backend = new StubHarness([{ text: 'Done.' }]);
    const failures = [
      { command: 'pnpm type-check', exitCode: 1, output: 'TS error' },
      { command: 'pnpm test', exitCode: 1, output: 'Test failed' },
    ];

    await collectEvents(runValidationFixer({ harness: backend, cwd: '/tmp', failures, attempt: 1, maxAttempts: 2 }));

    expect(backend.prompts[0]).toContain('pnpm type-check');
    expect(backend.prompts[0]).toContain('pnpm test');
    expect(backend.prompts[0]).toContain('Test failed');
  });

  it('passes correct backend options', async () => {
    const backend = new StubHarness([{ text: 'Done.' }]);

    await collectEvents(runValidationFixer({ harness: backend, ...BASE_OPTIONS }));

    expect(backend.calls).toHaveLength(1);
    expect(backend.calls[0].maxTurns).toBe(30);
    expect(backend.calls[0].tools).toBe('coding');
  });

  it('yields agent:result and tool events in non-verbose mode', async () => {
    const backend = new StubHarness([{
      text: 'Fixed it.',
      toolCalls: [{
        tool: 'Edit',
        toolUseId: 'tu-1',
        input: { file: 'src/foo.ts' },
        output: 'File edited',
      }],
    }]);

    const events = await collectEvents(runValidationFixer({ harness: backend, ...BASE_OPTIONS }));

    // agent:result, tool_use, tool_result always emitted
    expect(findEvent(events, 'agent:result')).toBeDefined();
    expect(filterEvents(events, 'agent:tool_use')).toHaveLength(1);
    expect(filterEvents(events, 'agent:tool_result')).toHaveLength(1);
  });

  it('suppresses agent:message when verbose is false', async () => {
    const backend = new StubHarness([{ text: 'Some verbose output.' }]);

    const events = await collectEvents(runValidationFixer({ harness: backend, ...BASE_OPTIONS }));

    expect(filterEvents(events, 'agent:message')).toHaveLength(0);
  });

  it('emits agent:message when verbose is true', async () => {
    const backend = new StubHarness([{ text: 'Some verbose output.' }]);

    const events = await collectEvents(runValidationFixer({ harness: backend, ...BASE_OPTIONS, verbose: true }));

    expect(filterEvents(events, 'agent:message').length).toBeGreaterThan(0);
  });

  it('swallows non-abort errors and still emits complete event', async () => {
    const backend = new StubHarness([{ error: new Error('Agent crashed') }]);

    const events = await collectEvents(runValidationFixer({ harness: backend, ...BASE_OPTIONS }));

    // Should still emit both lifecycle events
    expect(findEvent(events, 'validation:fix:start')).toBeDefined();
    expect(findEvent(events, 'validation:fix:complete')).toBeDefined();
  });

  it('re-throws AbortError', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    const backend = new StubHarness([{ error: abortError }]);

    let thrown: Error | undefined;
    const events: EforgeEvent[] = [];
    try {
      for await (const event of runValidationFixer({ harness: backend, ...BASE_OPTIONS })) {
        events.push(event);
      }
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown).toBeDefined();
    expect(thrown!.name).toBe('AbortError');

    // Start event emitted before the error
    expect(findEvent(events, 'validation:fix:start')).toBeDefined();
    // Complete event NOT emitted — generator threw
    expect(findEvent(events, 'validation:fix:complete')).toBeUndefined();
  });

  it('includes attempt number in prompt template', async () => {
    const backend = new StubHarness([{ text: 'Done.' }]);

    await collectEvents(runValidationFixer({
      harness: backend,
      cwd: '/tmp',
      failures: FAILURES,
      attempt: 2,
      maxAttempts: 3,
    }));

    expect(backend.prompts[0]).toContain('attempt 2 of 3');
  });
});
