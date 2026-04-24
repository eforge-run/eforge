import { describe, it, expect } from 'vitest';
import type { EforgeEvent } from '@eforge-build/engine/events';
import { AgentTerminalError } from '@eforge-build/engine/backend';
import { StubBackend } from './stub-backend.js';
import { collectEvents, findEvent, filterEvents } from './test-events.js';
import { builderEvaluate, STRICTNESS_BLOCKS } from '@eforge-build/engine/agents/builder';
import { AGENT_MAX_CONTINUATIONS_DEFAULTS } from '@eforge-build/engine/pipeline';
import { runPlanEvaluate, runCohesionEvaluate, runArchitectureEvaluate } from '@eforge-build/engine/agents/plan-evaluator';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  it('yields build:failed with terminalSubtype on error_max_turns (no re-throw — retry is owned by withRetry)', async () => {
    const backend = new StubBackend([{
      error: new AgentTerminalError('error_max_turns', 'Reached maximum number of turns (30).'),
    }]);
    const plan = makePlanFile();

    // Prior behavior re-threw so the pipeline-level retry loop could catch it.
    // With the policy model, builderEvaluate yields a terminal `build:failed`
    // event carrying the subtype; `withRetry` inspects the event and decides
    // whether to retry.
    const events = await collectEvents(builderEvaluate(plan, {
      backend,
      cwd: '/tmp',
    }));

    const failed = findEvent(events, 'plan:build:failed');
    expect(failed).toBeDefined();
    expect(failed!.terminalSubtype).toBe('error_max_turns');
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

    const failed = findEvent(events, 'plan:build:failed');
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

    expect(findEvent(events, 'plan:build:evaluate:start')).toBeDefined();
    expect(findEvent(events, 'plan:build:evaluate:complete')).toBeDefined();
    expect(findEvent(events, 'plan:build:failed')).toBeUndefined();
  });
});

// --- Plan phase evaluator (runPlanEvaluate) continuation context ---

const makePlanEvalOptions = (backend: StubBackend, overrides?: Record<string, unknown>) => ({
  backend,
  planSetName: 'test-set',
  sourceContent: '# Source\n\nSome PRD.',
  cwd: '/tmp',
  ...overrides,
});

describe('runPlanEvaluate continuation context', () => {
  it('passes continuation_context to prompt when continuationContext is provided', async () => {
    const backend = new StubBackend([{
      text: '<evaluation></evaluation>',
    }]);

    await collectEvents(runPlanEvaluate({
      ...makePlanEvalOptions(backend),
      continuationContext: { attempt: 1, maxContinuations: 2 },
    }));

    expect(backend.prompts[0]).toContain('Continuation Context');
    expect(backend.prompts[0]).toContain('attempt 1 of 2');
    expect(backend.prompts[0]).toContain('Do NOT run `git reset --soft HEAD~1` again');
  });

  it('passes empty continuation_context when continuationContext is absent', async () => {
    const backend = new StubBackend([{
      text: '<evaluation></evaluation>',
    }]);

    await collectEvents(runPlanEvaluate(makePlanEvalOptions(backend)));

    expect(backend.prompts[0]).not.toContain('Continuation Context');
  });

  it('re-throws error_max_turns errors', async () => {
    const backend = new StubBackend([{
      error: new AgentTerminalError('error_max_turns', 'Reached maximum number of turns (30).'),
    }]);

    await expect(async () => {
      await collectEvents(runPlanEvaluate(makePlanEvalOptions(backend)));
    }).rejects.toBeInstanceOf(AgentTerminalError);
  });
});

describe('runCohesionEvaluate continuation context', () => {
  it('passes continuation_context to prompt when continuationContext is provided', async () => {
    const backend = new StubBackend([{
      text: '<evaluation></evaluation>',
    }]);

    await collectEvents(runCohesionEvaluate({
      ...makePlanEvalOptions(backend),
      continuationContext: { attempt: 2, maxContinuations: 3 },
    }));

    expect(backend.prompts[0]).toContain('Continuation Context');
    expect(backend.prompts[0]).toContain('attempt 2 of 3');
  });
});

describe('runArchitectureEvaluate continuation context', () => {
  it('passes continuation_context to prompt when continuationContext is provided', async () => {
    const backend = new StubBackend([{
      text: '<evaluation></evaluation>',
    }]);

    await collectEvents(runArchitectureEvaluate({
      ...makePlanEvalOptions(backend),
      continuationContext: { attempt: 1, maxContinuations: 1 },
    }));

    expect(backend.prompts[0]).toContain('Continuation Context');
    expect(backend.prompts[0]).toContain('attempt 1 of 1');
  });
});

// --- Prompt template verification ---

const __dirname = dirname(fileURLToPath(import.meta.url));
const promptsDir = resolve(__dirname, '../packages/engine/src/prompts');

describe('evaluator prompt templates', () => {
  it('evaluator.md contains {{continuation_context}} between Context and Setup sections', async () => {
    const content = await readFile(resolve(promptsDir, 'evaluator.md'), 'utf-8');
    const lines = content.split('\n');
    const contextIdx = lines.findIndex(l => l.startsWith('## Context'));
    const continuationIdx = lines.findIndex(l => l.includes('{{continuation_context}}'));
    const setupIdx = lines.findIndex(l => l.startsWith('## Setup'));
    expect(contextIdx).toBeGreaterThan(-1);
    expect(continuationIdx).toBeGreaterThan(-1);
    expect(setupIdx).toBeGreaterThan(-1);
    expect(continuationIdx).toBeGreaterThan(contextIdx);
    expect(continuationIdx).toBeLessThan(setupIdx);
  });

  it('plan-evaluator.md contains {{continuation_context}} between Context and Setup sections', async () => {
    const content = await readFile(resolve(promptsDir, 'plan-evaluator.md'), 'utf-8');
    const lines = content.split('\n');
    const contextIdx = lines.findIndex(l => l.startsWith('## Context'));
    const continuationIdx = lines.findIndex(l => l.includes('{{continuation_context}}'));
    const setupIdx = lines.findIndex(l => l.startsWith('## Setup') || l.startsWith('## Source'));
    expect(contextIdx).toBeGreaterThan(-1);
    expect(continuationIdx).toBeGreaterThan(-1);
    expect(setupIdx).toBeGreaterThan(-1);
    expect(continuationIdx).toBeGreaterThan(contextIdx);
    expect(continuationIdx).toBeLessThan(setupIdx);
  });
});

// --- Event type existence verification ---

describe('continuation event types', () => {
  it('all 4 continuation event types are part of EforgeEvent union', () => {
    // These are compile-time checks - if the types don't exist, this file won't compile.
    // We verify at runtime by constructing objects that match each type.
    const events: EforgeEvent[] = [
      { timestamp: new Date().toISOString(), type: 'plan:build:evaluate:continuation', planId: 'p1', attempt: 1, maxContinuations: 2 },
      { timestamp: new Date().toISOString(), type: 'planning:evaluate:continuation', attempt: 1, maxContinuations: 2 },
      { timestamp: new Date().toISOString(), type: 'planning:architecture:evaluate:continuation', attempt: 1, maxContinuations: 2 },
      { timestamp: new Date().toISOString(), type: 'planning:cohesion:evaluate:continuation', attempt: 1, maxContinuations: 2 },
    ];
    expect(events).toHaveLength(4);
    expect(events.map(e => e.type)).toEqual([
      'plan:build:evaluate:continuation',
      'planning:evaluate:continuation',
      'planning:architecture:evaluate:continuation',
      'planning:cohesion:evaluate:continuation',
    ]);
  });
});
