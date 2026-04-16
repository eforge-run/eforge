import { describe, it, expect } from 'vitest';
import { runPrdValidator } from '@eforge-build/engine/agents/prd-validator';
import { StubBackend } from './stub-backend.js';
import { collectEvents, findEvent } from './test-events.js';

function makeOptions(backend: StubBackend) {
  return {
    backend,
    cwd: process.cwd(),
    prdContent: 'A PRD',
    diff: 'diff --git a/x b/x',
  };
}

describe('runPrdValidator fail-closed behavior', () => {
  it('re-throws non-abort errors from the backend', async () => {
    const backend = new StubBackend([
      { error: new Error('connect ECONNREFUSED') },
    ]);

    await expect(async () => {
      for await (const _ of runPrdValidator(makeOptions(backend))) {
        // drain
      }
    }).rejects.toThrow('connect ECONNREFUSED');
  });

  it('re-throws AbortError from the backend', async () => {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    const backend = new StubBackend([
      { error: abortErr },
    ]);

    await expect(async () => {
      for await (const _ of runPrdValidator(makeOptions(backend))) {
        // drain
      }
    }).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('throws when the backend produces no accumulated text', async () => {
    const backend = new StubBackend([
      { /* no text, no tool calls */ },
    ]);

    await expect(async () => {
      for await (const _ of runPrdValidator(makeOptions(backend))) {
        // drain
      }
    }).rejects.toThrow(/PRD validator produced no output/);
  });

  it('yields passed=false with a synthetic gap when output contains no JSON block', async () => {
    const backend = new StubBackend([
      { text: 'Here are my thoughts but no JSON block anywhere.' },
    ]);

    const events = await collectEvents(runPrdValidator(makeOptions(backend)));
    const complete = findEvent(events, 'prd_validation:complete');
    expect(complete).toBeDefined();
    expect(complete!.passed).toBe(false);
    expect(complete!.gaps).toHaveLength(1);
    expect(complete!.gaps[0].requirement).toBe('PRD validator output unparseable');
  });

  it('yields passed=true for valid JSON with empty gaps array', async () => {
    const backend = new StubBackend([
      { text: '```json\n{"completionPercent": 100, "gaps": []}\n```' },
    ]);

    const events = await collectEvents(runPrdValidator(makeOptions(backend)));
    const complete = findEvent(events, 'prd_validation:complete');
    expect(complete).toBeDefined();
    expect(complete!.passed).toBe(true);
    expect(complete!.gaps).toHaveLength(0);
    expect(complete!.completionPercent).toBe(100);
  });
});
