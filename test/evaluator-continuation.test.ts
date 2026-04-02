import { describe, it, expect } from 'vitest';
import type { EforgeEvent } from '../src/engine/events.js';
import { StubBackend } from './stub-backend.js';
import { collectEvents, findEvent, filterEvents } from './test-events.js';
import { builderEvaluate, STRICTNESS_BLOCKS } from '../src/engine/agents/builder.js';
import { AGENT_MAX_CONTINUATIONS_DEFAULTS } from '../src/engine/pipeline.js';

const makePlanFile = (id = 'plan-01') => ({
  id,
  name: 'Test Plan',
  dependsOn: [],
  branch: 'test/main',
  body: '# Test\n\nImplement something.',
  filePath: '/tmp/test-plan.md',
});

// --- AGENT_MAX_CONTINUATIONS_DEFAULTS ---

describe('AGENT_MAX_CONTINUATIONS_DEFAULTS', () => {
  it('contains evaluator defaults set to 1', () => {
    expect(AGENT_MAX_CONTINUATIONS_DEFAULTS['evaluator']).toBe(1);
    expect(AGENT_MAX_CONTINUATIONS_DEFAULTS['plan-evaluator']).toBe(1);
    expect(AGENT_MAX_CONTINUATIONS_DEFAULTS['cohesion-evaluator']).toBe(1);
    expect(AGENT_MAX_CONTINUATIONS_DEFAULTS['architecture-evaluator']).toBe(1);
  });
});

// --- builderEvaluate error handling ---

describe('builderEvaluate', () => {
  it('re-throws error_max_turns errors', async () => {
    const backend = new StubBackend([{
      error: new Error('Agent evaluator failed: error_max_turns'),
    }]);
    const plan = makePlanFile();

    await expect(async () => {
      await collectEvents(builderEvaluate(plan, {
        backend,
        cwd: '/tmp',
      }));
    }).rejects.toThrow('error_max_turns');
  });

  it('catches non-max_turns errors and yields build:failed', async () => {
    const backend = new StubBackend([{
      error: new Error('Agent evaluator failed: some_other_error'),
    }]);
    const plan = makePlanFile();

    const events = await collectEvents(builderEvaluate(plan, {
      backend,
      cwd: '/tmp',
    }));

    const failed = findEvent(events, 'build:failed');
    expect(failed).toBeDefined();
    expect(failed!.error).toContain('some_other_error');
  });

  it('passes continuation_context to prompt when evaluatorContinuationContext is provided', async () => {
    const backend = new StubBackend([{
      text: '<evaluation></evaluation>',
    }]);
    const plan = makePlanFile();

    await collectEvents(builderEvaluate(plan, {
      backend,
      cwd: '/tmp',
      evaluatorContinuationContext: { attempt: 1, maxContinuations: 2 },
    }));

    expect(backend.prompts[0]).toContain('Continuation Context');
    expect(backend.prompts[0]).toContain('attempt 1 of 2');
    expect(backend.prompts[0]).toContain('Do NOT run `git reset --soft HEAD~1` again');
  });

  it('passes empty continuation_context when evaluatorContinuationContext is absent', async () => {
    const backend = new StubBackend([{
      text: '<evaluation></evaluation>',
    }]);
    const plan = makePlanFile();

    await collectEvents(builderEvaluate(plan, {
      backend,
      cwd: '/tmp',
    }));

    expect(backend.prompts[0]).not.toContain('Continuation Context');
  });

  it('emits build:evaluate:start and build:evaluate:complete on success', async () => {
    const backend = new StubBackend([{
      text: `<evaluation>
  <verdict file="src/foo.ts" action="accept">
    <staged>impl</staged>
    <fix>fix</fix>
    <rationale>good</rationale>
    <if-accepted>better</if-accepted>
    <if-rejected>same</if-rejected>
  </verdict>
</evaluation>`,
    }]);
    const plan = makePlanFile();

    const events = await collectEvents(builderEvaluate(plan, {
      backend,
      cwd: '/tmp',
    }));

    expect(findEvent(events, 'build:evaluate:start')).toBeDefined();
    expect(findEvent(events, 'build:evaluate:complete')).toBeDefined();
    expect(findEvent(events, 'build:failed')).toBeUndefined();
  });
});
