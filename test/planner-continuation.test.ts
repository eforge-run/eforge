import { describe, it, expect } from 'vitest';
import type { EforgeEvent } from '@eforge-build/engine/events';
import { AgentTerminalError, PlannerSubmissionError } from '@eforge-build/engine/harness';
import { StubHarness } from './stub-harness.js';
import { collectEvents } from './test-events.js';
import { useTempDir } from './test-tmpdir.js';
import { runPlanner } from '@eforge-build/engine/agents/planner';
import { DEFAULT_CONFIG } from '@eforge-build/engine/config';
import { resolveAgentConfig } from '@eforge-build/engine/pipeline';

// --- runPlanner with continuation context ---

describe('runPlanner with continuation context', () => {
  const makeTempDir = useTempDir('eforge-planner-continuation-test-');

  it('includes continuation context in prompt when provided', async () => {
    const backend = new StubHarness([{ text: 'Plan complete.' }]);
    const cwd = makeTempDir();

    // Planner throws PlannerSubmissionError because no submit tool was called,
    // but the prompt has already been captured by the stub.
    await expect(collectEvents(runPlanner('Build a widget', {
      harness: backend,
      cwd,
      auto: true,
      continuationContext: {
        attempt: 1,
        maxContinuations: 2,
        existingPlans: 'plan-01.md: Widget scaffolding',
        reason: 'max_turns',
      },
    }))).rejects.toThrow(PlannerSubmissionError);

    expect(backend.prompts).toHaveLength(1);
    const prompt = backend.prompts[0];
    expect(prompt).toContain('Continuation Context');
    expect(prompt).toContain('continuation attempt 1 of 2');
    expect(prompt).toContain('Do NOT redo');
    expect(prompt).toContain('plan-01.md: Widget scaffolding');
  });
});

// --- runPlanner without continuation context ---

describe('runPlanner without continuation context', () => {
  const makeTempDir = useTempDir('eforge-planner-no-continuation-test-');

  it('does not include continuation context when not provided', async () => {
    const backend = new StubHarness([{ text: 'Plan complete.' }]);
    const cwd = makeTempDir();

    // Planner throws PlannerSubmissionError because no submit tool was called.
    await expect(collectEvents(runPlanner('Build a widget', {
      harness: backend,
      cwd,
      auto: true,
    }))).rejects.toThrow(PlannerSubmissionError);

    expect(backend.prompts).toHaveLength(1);
    const prompt = backend.prompts[0];
    expect(prompt).not.toContain('Continuation Context');
    expect(prompt).not.toContain('continuation attempt');
  });
});

// --- plan:continuation event type ---

describe('plan:continuation event type', () => {
  it('is a valid EforgeEvent', () => {
    // Type-check: this should compile without errors
    const event: EforgeEvent = {
      type: 'plan:continuation',
      attempt: 1,
      maxContinuations: 2,
    };
    expect(event.type).toBe('plan:continuation');
    expect(event.attempt).toBe(1);
    expect(event.maxContinuations).toBe(2);
  });

  it('accepts an optional reason of max_turns', () => {
    const event: EforgeEvent = {
      type: 'plan:continuation',
      attempt: 1,
      maxContinuations: 2,
      reason: 'max_turns',
    };
    expect(event.reason).toBe('max_turns');
  });

  it('accepts an optional reason of dropped_submission', () => {
    const event: EforgeEvent = {
      type: 'plan:continuation',
      attempt: 1,
      maxContinuations: 2,
      reason: 'dropped_submission',
    };
    expect(event.reason).toBe('dropped_submission');
  });
});

// --- Continuation context coexists with prior clarifications ---

describe('Continuation context coexists with prior clarifications', () => {
  const makeTempDir = useTempDir('eforge-planner-continuation-clarify-test-');

  it('includes both continuation context and prior clarifications in prompt', async () => {
    // First call: emit clarification questions, second call: complete
    const backend = new StubHarness([
      { text: '<clarification><question id="q1">What framework?</question></clarification>' },
      { text: 'Plan complete after clarification.' },
    ]);
    const cwd = makeTempDir();

    // The planner throws PlannerSubmissionError after the second iteration
    // (no submit tool call). Both prompts are captured before the throw.
    try {
      await collectEvents(runPlanner('Build a widget', {
        harness: backend,
        cwd,
        auto: false,
        continuationContext: {
          attempt: 1,
          maxContinuations: 2,
          existingPlans: 'plan-01.md: Widget scaffolding',
          reason: 'max_turns',
        },
        onClarification: async () => ({ q1: 'React' }),
      }));
    } catch { /* expected PlannerSubmissionError */ }

    // First prompt should contain continuation context
    expect(backend.prompts.length).toBeGreaterThanOrEqual(2);
    const firstPrompt = backend.prompts[0];
    expect(firstPrompt).toContain('Continuation Context');
    expect(firstPrompt).toContain('continuation attempt 1 of 2');

    // Second prompt should contain both continuation context and prior clarifications
    const secondPrompt = backend.prompts[1];
    expect(secondPrompt).toContain('Continuation Context');
    expect(secondPrompt).toContain('Prior Clarifications');
    expect(secondPrompt).toContain('React');
  });
});

// --- StubHarness error_max_turns propagation ---

describe('StubHarness error_max_turns propagation', () => {
  const makeTempDir = useTempDir('eforge-planner-maxturns-test-');

  it('propagates error_max_turns from runPlanner', async () => {
    const backend = new StubHarness([{
      error: new AgentTerminalError('error_max_turns', 'Reached maximum number of turns (30).'),
    }]);
    const cwd = makeTempDir();

    await expect(
      collectEvents(runPlanner('Build a widget', {
        harness: backend,
        cwd,
        auto: true,
      })),
    ).rejects.toThrow('error_max_turns');
  });
});

// --- runPlanner throws PlannerSubmissionError on dropped submission ---

describe('runPlanner throws PlannerSubmissionError on dropped submission', () => {
  const makeTempDir = useTempDir('eforge-planner-dropped-submission-test-');

  it('rejects with PlannerSubmissionError when no submission tool is called and no skip', async () => {
    const backend = new StubHarness([{ text: 'I thought about it but never called submit.' }]);
    const cwd = makeTempDir();

    let thrown: unknown;
    try {
      await collectEvents(runPlanner('Build a widget', {
        harness: backend,
        cwd,
        auto: true,
        scope: 'excursion',
      }));
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(PlannerSubmissionError);
    expect((thrown as Error).message).toMatch(/Planner agent completed without calling a submission tool/);
    expect((thrown as Error).message).toContain('submit_plan_set');
    expect((thrown as Error).message).toContain('<skip>');
  });
});

// --- continuationContext threads reason into prompt ---

describe('continuationContext threads reason into prompt', () => {
  const makeTempDir = useTempDir('eforge-planner-continuation-reason-test-');

  it('reason=dropped_submission produces submission-focused wording without the existing-plans list', async () => {
    const backend = new StubHarness([{ text: 'Thinking...' }]);
    const cwd = makeTempDir();

    try {
      await collectEvents(runPlanner('Build a widget', {
        harness: backend,
        cwd,
        auto: true,
        scope: 'excursion',
        continuationContext: {
          attempt: 1,
          maxContinuations: 2,
          existingPlans: 'plan-01.md: Should NOT appear',
          reason: 'dropped_submission',
        },
      }));
    } catch { /* expected PlannerSubmissionError */ }

    expect(backend.prompts).toHaveLength(1);
    const prompt = backend.prompts[0];
    // Submission-focused wording
    expect(prompt).toContain('did not call');
    expect(prompt).toContain('MUST call');
    // max-turns wording must be absent
    expect(prompt).not.toContain('hit the max turns limit');
    // existing-plans list must be omitted for dropped_submission
    expect(prompt).not.toContain('plan-01.md: Should NOT appear');
  });

  it('reason=max_turns produces the existing max-turns wording with the existing-plans list', async () => {
    const backend = new StubHarness([{ text: 'Thinking...' }]);
    const cwd = makeTempDir();

    try {
      await collectEvents(runPlanner('Build a widget', {
        harness: backend,
        cwd,
        auto: true,
        scope: 'excursion',
        continuationContext: {
          attempt: 1,
          maxContinuations: 2,
          existingPlans: 'plan-01.md: Widget scaffolding',
          reason: 'max_turns',
        },
      }));
    } catch { /* expected PlannerSubmissionError */ }

    expect(backend.prompts).toHaveLength(1);
    const prompt = backend.prompts[0];
    expect(prompt).toContain('hit the max turns limit');
    expect(prompt).toContain('plan-01.md: Widget scaffolding');
    // Dropped-submission wording must be absent for max_turns
    expect(prompt).not.toContain('MUST call');
  });
});

// --- resolveAgentConfig for builder is 80 ---

describe('resolveAgentConfig for builder', () => {
  it('returns maxTurns of 80', () => {
    const result = resolveAgentConfig('builder', DEFAULT_CONFIG);
    expect(result.maxTurns).toBe(80);
  });
});

// --- resolveAgentConfig for planner is 30 ---

describe('resolveAgentConfig for planner', () => {
  it('returns maxTurns of 30 (global default, no role-specific override)', () => {
    const result = resolveAgentConfig('planner', DEFAULT_CONFIG);
    expect(result.maxTurns).toBe(30);
  });
});
