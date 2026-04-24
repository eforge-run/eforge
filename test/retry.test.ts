/**
 * Tests for the unified retry policy (`packages/engine/src/retry.ts`).
 *
 * Covers:
 * - `shouldRetry` predicates for each registered policy.
 * - `withRetry` integration: retry-then-success, exhaustion, abort-success.
 * - `isDroppedSubmission` predicate behavior.
 * - `getPolicy` fallback for unregistered roles.
 */
import { describe, it, expect } from 'vitest';
import type { EforgeEvent, AgentRole } from '@eforge-build/engine/events';
import { AgentTerminalError, PlannerSubmissionError } from '@eforge-build/engine/backend';
import {
  withRetry,
  DEFAULT_RETRY_POLICIES,
  getPolicy,
  isDroppedSubmission,
  type RetryPolicy,
  type RetryAttemptInfo,
  type EvaluatorContinuationInput,
  type PlannerContinuationInput,
  type BuilderContinuationInput,
} from '@eforge-build/engine/retry';
import { builderEvaluate } from '@eforge-build/engine/agents/builder';
import { StubBackend } from './stub-backend.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ts = () => new Date().toISOString();

function makeAttemptInfo<Input>(
  partial: Partial<RetryAttemptInfo<Input>> & { prevInput: Input },
): RetryAttemptInfo<Input> {
  return {
    attempt: 1,
    maxAttempts: 2,
    subtype: 'error_max_turns',
    events: [],
    ...partial,
  } as RetryAttemptInfo<Input>;
}

/** Script a single "attempt" that yields some events then throws a terminal error. */
function makeThrowingAgent(
  events: EforgeEvent[],
  terminal: AgentTerminalError | Error,
): (input: unknown) => AsyncGenerator<EforgeEvent, undefined> {
  return async function* () {
    for (const ev of events) yield ev;
    throw terminal;
  };
}

/** Script a single "attempt" that yields events then returns normally. */
function makeSuccessfulAgent(
  events: EforgeEvent[],
): (input: unknown) => AsyncGenerator<EforgeEvent, undefined> {
  return async function* () {
    for (const ev of events) yield ev;
    return;
  };
}

/** Glue together multiple per-attempt generators into a single `runAgent`. */
function makeMultiAttemptAgent(
  perAttempt: Array<(input: unknown) => AsyncGenerator<EforgeEvent, undefined>>,
): (input: unknown) => AsyncGenerator<EforgeEvent, undefined> {
  let idx = 0;
  return async function* (input: unknown) {
    const fn = perAttempt[idx++];
    if (!fn) throw new Error(`makeMultiAttemptAgent: no scripted response at attempt index ${idx - 1}`);
    yield* fn(input);
  };
}

// ---------------------------------------------------------------------------
// Policy.shouldRetry / retryableSubtypes predicates
// ---------------------------------------------------------------------------

describe('DEFAULT_RETRY_POLICIES — planner policy', () => {
  const planner = DEFAULT_RETRY_POLICIES.planner!;

  it('has retryableSubtypes including error_max_turns', () => {
    expect(planner.retryableSubtypes.has('error_max_turns')).toBe(true);
  });

  it('has label "planner-continuation"', () => {
    expect(planner.label).toBe('planner-continuation');
  });

  it('has maxAttempts = 3', () => {
    expect(planner.maxAttempts).toBe(3);
  });

  it('shouldRetry returns true for PlannerSubmissionError with dropped-submission events', () => {
    const events: EforgeEvent[] = [
      { timestamp: ts(), type: 'agent:message', agentId: 'a1', agent: 'planner', content: 'done' },
    ];
    const info = makeAttemptInfo({
      prevInput: {} as unknown,
      subtype: 'error_during_execution',
      events,
      error: new PlannerSubmissionError('no submission tool called'),
    });
    expect(planner.shouldRetry!(info as RetryAttemptInfo<unknown>)).toBe(true);
  });

  it('shouldRetry returns false when submit_plan_set tool was used', () => {
    const events: EforgeEvent[] = [
      {
        timestamp: ts(),
        type: 'agent:tool_use',
        agentId: 'a1',
        agent: 'planner',
        tool: 'submit_plan_set',
        toolUseId: 'tu-1',
        input: {},
      },
    ];
    const info = makeAttemptInfo({
      prevInput: {} as unknown,
      subtype: 'error_during_execution',
      events,
      error: new PlannerSubmissionError('submitted but still treated as error'),
    });
    expect(planner.shouldRetry!(info as RetryAttemptInfo<unknown>)).toBe(false);
  });

  it('shouldRetry returns false when plan:skip was emitted', () => {
    const events: EforgeEvent[] = [
      { timestamp: ts(), type: 'planning:skip', reason: 'already implemented' },
    ];
    const info = makeAttemptInfo({
      prevInput: {} as unknown,
      subtype: 'error_during_execution',
      events,
      error: new PlannerSubmissionError('skip path'),
    });
    expect(planner.shouldRetry!(info as RetryAttemptInfo<unknown>)).toBe(false);
  });

  it('shouldRetry returns false for non-PlannerSubmissionError even when events look like a dropped submission', () => {
    // An unrelated AgentTerminalError (e.g. error_during_execution) that never
    // called a submission tool must NOT be retried — the prior ad-hoc loop
    // only retried PlannerSubmissionError / isMaxTurnsError.
    const events: EforgeEvent[] = [
      { timestamp: ts(), type: 'agent:message', agentId: 'a1', agent: 'planner', content: 'crashed' },
    ];
    const info = makeAttemptInfo({
      prevInput: {} as unknown,
      subtype: 'error_during_execution',
      events,
      error: new AgentTerminalError('error_during_execution', 'boom'),
    });
    expect(planner.shouldRetry!(info as RetryAttemptInfo<unknown>)).toBe(false);
  });
});

describe('DEFAULT_RETRY_POLICIES — builder policy', () => {
  const builder = DEFAULT_RETRY_POLICIES.builder!;

  it('retryableSubtypes includes error_max_turns', () => {
    expect(builder.retryableSubtypes.has('error_max_turns')).toBe(true);
  });

  it('retryableSubtypes does not include error_during_execution', () => {
    expect(builder.retryableSubtypes.has('error_during_execution')).toBe(false);
  });

  it('has no `shouldRetry` that would match dropped-submission', () => {
    // Builder's policy only uses retryableSubtypes; no custom shouldRetry.
    expect(builder.shouldRetry).toBeUndefined();
  });
});

describe('DEFAULT_RETRY_POLICIES — evaluator policy', () => {
  const evaluator = DEFAULT_RETRY_POLICIES.evaluator!;

  it('retryableSubtypes includes error_max_turns', () => {
    expect(evaluator.retryableSubtypes.has('error_max_turns')).toBe(true);
  });

  it('has maxAttempts = 2 (matches prior maxContinuations: 1 + initial attempt)', () => {
    expect(evaluator.maxAttempts).toBe(2);
  });

  it('retryableSubtypes does not include error_during_execution', () => {
    expect(evaluator.retryableSubtypes.has('error_during_execution')).toBe(false);
  });
});

describe('DEFAULT_RETRY_POLICIES — plan-evaluator / cohesion-evaluator / architecture-evaluator', () => {
  for (const role of ['plan-evaluator', 'cohesion-evaluator', 'architecture-evaluator'] as const) {
    it(`${role} policy retries on error_max_turns`, () => {
      const policy = DEFAULT_RETRY_POLICIES[role]!;
      expect(policy.retryableSubtypes.has('error_max_turns')).toBe(true);
      expect(policy.maxAttempts).toBe(2);
    });
  }
});

describe('getPolicy — unregistered roles default to no-retry', () => {
  const unregisteredRoles: AgentRole[] = [
    'reviewer',
    'review-fixer',
    'module-planner',
    'formatter',
    'doc-updater',
    'test-writer',
    'tester',
    'validation-fixer',
    'merge-conflict-resolver',
    'staleness-assessor',
    'prd-validator',
    'dependency-detector',
    'pipeline-composer',
    'gap-closer',
  ];

  for (const role of unregisteredRoles) {
    it(`${role} has a no-retry default policy`, () => {
      const policy = getPolicy(role);
      expect(policy.maxAttempts).toBe(1);
      expect(policy.retryableSubtypes.size).toBe(0);
    });
  }

  it('registered roles come back from getPolicy', () => {
    const planner = getPolicy('planner');
    expect(planner.label).toBe('planner-continuation');
    expect(planner.maxAttempts).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// isDroppedSubmission
// ---------------------------------------------------------------------------

describe('isDroppedSubmission', () => {
  it('returns true when no submission tool was called and no skip was emitted', () => {
    const events: EforgeEvent[] = [
      { timestamp: ts(), type: 'agent:message', agentId: 'a1', agent: 'planner', content: 'hmm' },
    ];
    expect(isDroppedSubmission(events)).toBe(true);
  });

  it('returns false when submit_plan_set was called', () => {
    const events: EforgeEvent[] = [
      {
        timestamp: ts(),
        type: 'agent:tool_use',
        agentId: 'a1',
        agent: 'planner',
        tool: 'submit_plan_set',
        toolUseId: 'tu-1',
        input: {},
      },
    ];
    expect(isDroppedSubmission(events)).toBe(false);
  });

  it('returns false when submit_architecture was called', () => {
    const events: EforgeEvent[] = [
      {
        timestamp: ts(),
        type: 'agent:tool_use',
        agentId: 'a1',
        agent: 'planner',
        tool: 'submit_architecture',
        toolUseId: 'tu-1',
        input: {},
      },
    ];
    expect(isDroppedSubmission(events)).toBe(false);
  });

  it('returns false when plan:skip was emitted', () => {
    const events: EforgeEvent[] = [
      { timestamp: ts(), type: 'planning:skip', reason: 'already done' },
    ];
    expect(isDroppedSubmission(events)).toBe(false);
  });

  it('returns true for empty event list', () => {
    expect(isDroppedSubmission([])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// withRetry integration
// ---------------------------------------------------------------------------

/**
 * A minimal evaluator-shaped policy that retries on error_max_turns.
 * Uses the `checkHasUnstagedChanges` hook on the Input to control the
 * abort-success short-circuit behavior in tests.
 */
function makeEvaluatorPolicy(override?: Partial<RetryPolicy<EvaluatorContinuationInput>>): RetryPolicy<EvaluatorContinuationInput> {
  const base = DEFAULT_RETRY_POLICIES.evaluator as RetryPolicy<EvaluatorContinuationInput>;
  return {
    ...base,
    maxAttempts: 2,
    ...override,
  };
}

describe('withRetry — retry-then-success', () => {
  it('yields all first-attempt events, emits agent:retry, yields all second-attempt events, and returns the final result', async () => {
    const firstEvents: EforgeEvent[] = [
      { timestamp: ts(), type: 'plan:build:evaluate:start', planId: 'p1' },
    ];
    const secondEvents: EforgeEvent[] = [
      { timestamp: ts(), type: 'plan:build:evaluate:complete', planId: 'p1', accepted: 1, rejected: 0 },
    ];

    const agent = makeMultiAttemptAgent([
      makeThrowingAgent(firstEvents, new AgentTerminalError('error_max_turns', 'turns exhausted')),
      makeSuccessfulAgent(secondEvents),
    ]);

    const policy = makeEvaluatorPolicy({
      // Override the default to always "retry" so the abort-success check doesn't trigger.
      buildContinuationInput: (info) => ({
        kind: 'retry',
        input: info.prevInput,
      }),
    });
    const initial: EvaluatorContinuationInput = {
      worktreePath: '/tmp/noop',
      planId: 'p1',
      evaluatorOptions: {},
    };

    const out: EforgeEvent[] = [];
    for await (const ev of withRetry(agent, policy, initial)) {
      out.push(ev);
    }

    // First-attempt events came through.
    expect(out.filter((e) => e.type === 'plan:build:evaluate:start')).toHaveLength(1);
    // agent:retry fired with the expected shape.
    const retryEvt = out.find((e) => e.type === 'agent:retry') as
      | Extract<EforgeEvent, { type: 'agent:retry' }>
      | undefined;
    expect(retryEvt).toBeDefined();
    expect(retryEvt!.agent).toBe('evaluator');
    expect(retryEvt!.attempt).toBe(1);
    expect(retryEvt!.maxAttempts).toBe(2);
    expect(retryEvt!.subtype).toBe('error_max_turns');
    expect(retryEvt!.label).toBe('evaluator-continuation');
    // Policy onRetry emitted the domain continuation event.
    expect(out.filter((e) => e.type === 'plan:build:evaluate:continuation')).toHaveLength(1);
    // Second-attempt events came through.
    expect(out.filter((e) => e.type === 'plan:build:evaluate:complete')).toHaveLength(1);
  });
});

describe('withRetry — exhaustion', () => {
  it('rethrows the terminal error after maxAttempts consecutive retryable failures', async () => {
    const firstErr = new AgentTerminalError('error_max_turns', 'first');
    const secondErr = new AgentTerminalError('error_max_turns', 'second');

    const agent = makeMultiAttemptAgent([
      makeThrowingAgent([], firstErr),
      makeThrowingAgent([], secondErr),
    ]);

    const policy = makeEvaluatorPolicy({
      buildContinuationInput: (info) => ({
        kind: 'retry',
        input: info.prevInput,
      }),
    });
    const initial: EvaluatorContinuationInput = {
      worktreePath: '/tmp/noop',
      evaluatorOptions: {},
    };

    let thrown: unknown;
    try {
      // Drain the generator; final attempt's error should surface.
      for await (const _ev of withRetry(agent, policy, initial)) {
        // collect events but we only care about terminal behavior
      }
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(AgentTerminalError);
    expect((thrown as AgentTerminalError).subtype).toBe('error_max_turns');
    expect((thrown as AgentTerminalError).message).toContain('second');
  });

  it('does not start a third attempt after two consecutive retryable failures', async () => {
    let callCount = 0;
    const makeCountingAgent = (): ((input: unknown) => AsyncGenerator<EforgeEvent, undefined>) => {
      return async function* () {
        callCount++;
        throw new AgentTerminalError('error_max_turns', `attempt ${callCount}`);
      };
    };

    const policy = makeEvaluatorPolicy({
      buildContinuationInput: (info) => ({
        kind: 'retry',
        input: info.prevInput,
      }),
    });
    const initial: EvaluatorContinuationInput = {
      worktreePath: '/tmp/noop',
      evaluatorOptions: {},
    };

    try {
      for await (const _ev of withRetry(makeCountingAgent(), policy, initial)) {
        // noop
      }
    } catch {
      // expected
    }

    expect(callCount).toBe(policy.maxAttempts);
  });
});

describe('withRetry — evaluator abort-success on clean worktree', () => {
  it('returns success without a second attempt when the policy returns abort-success', async () => {
    let callCount = 0;
    const agent = async function* (_input: EvaluatorContinuationInput): AsyncGenerator<EforgeEvent, undefined> {
      callCount++;
      yield { timestamp: ts(), type: 'plan:build:evaluate:start', planId: 'p1' };
      throw new AgentTerminalError('error_max_turns', 'turns exhausted');
    };

    // Policy overrides the default continuation builder to simulate a clean
    // worktree by always returning abort-success.
    const policy = makeEvaluatorPolicy({
      buildContinuationInput: () => ({ kind: 'abort-success' }),
    });
    const initial: EvaluatorContinuationInput = {
      worktreePath: '/tmp/noop',
      planId: 'p1',
      evaluatorOptions: {},
      checkHasUnstagedChanges: async () => false,
    };

    const out: EforgeEvent[] = [];
    // Must not throw.
    for await (const ev of withRetry(agent, policy, initial)) {
      out.push(ev);
    }

    expect(callCount).toBe(1);
    // No agent:retry event when we abort-success.
    expect(out.find((e) => e.type === 'agent:retry')).toBeUndefined();
    // First-attempt events came through.
    expect(out.filter((e) => e.type === 'plan:build:evaluate:start')).toHaveLength(1);
  });
});

describe('withRetry — non-retryable errors propagate immediately', () => {
  it('rethrows unrelated errors without a retry', async () => {
    let callCount = 0;
    const agent = async function* (_input: unknown): AsyncGenerator<EforgeEvent, undefined> {
      callCount++;
      throw new Error('boom: unrelated');
    };

    const policy = makeEvaluatorPolicy();
    const initial: EvaluatorContinuationInput = {
      worktreePath: '/tmp/noop',
      evaluatorOptions: {},
    };

    let thrown: unknown;
    try {
      for await (const _ev of withRetry(agent, policy, initial)) { /* noop */ }
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('boom: unrelated');
    expect(callCount).toBe(1);
  });

  it('does not retry a non-retryable AgentTerminalError subtype', async () => {
    let callCount = 0;
    const agent = async function* (_input: unknown): AsyncGenerator<EforgeEvent, undefined> {
      callCount++;
      throw new AgentTerminalError('error_max_budget_usd', 'out of money');
    };

    const policy = makeEvaluatorPolicy();
    const initial: EvaluatorContinuationInput = {
      worktreePath: '/tmp/noop',
      evaluatorOptions: {},
    };

    let thrown: unknown;
    try {
      for await (const _ev of withRetry(agent, policy, initial)) { /* noop */ }
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AgentTerminalError);
    expect((thrown as AgentTerminalError).subtype).toBe('error_max_budget_usd');
    expect(callCount).toBe(1);
  });
});

describe('withRetry — stream-based terminal via build:failed with terminalSubtype', () => {
  it('treats a yielded build:failed + terminalSubtype as retryable and holds back the event', async () => {
    // First attempt yields build:failed (without throwing); second attempt succeeds.
    const firstAttempt: (input: unknown) => AsyncGenerator<EforgeEvent, undefined> =
      async function* () {
        yield { timestamp: ts(), type: 'plan:build:evaluate:start', planId: 'p1' };
        yield { timestamp: ts(), type: 'plan:build:failed', planId: 'p1', error: 'maxed out', terminalSubtype: 'error_max_turns' };
      };
    const secondAttempt: (input: unknown) => AsyncGenerator<EforgeEvent, undefined> =
      async function* () {
        yield { timestamp: ts(), type: 'plan:build:evaluate:complete', planId: 'p1', accepted: 1, rejected: 0 };
      };

    const agent = makeMultiAttemptAgent([firstAttempt, secondAttempt]);

    const policy = makeEvaluatorPolicy({
      buildContinuationInput: (info) => ({ kind: 'retry', input: info.prevInput }),
    });
    const initial: EvaluatorContinuationInput = {
      worktreePath: '/tmp/noop',
      planId: 'p1',
      evaluatorOptions: {},
    };

    const out: EforgeEvent[] = [];
    for await (const ev of withRetry(agent, policy, initial)) {
      out.push(ev);
    }

    // The held-back build:failed was not propagated because retry succeeded.
    expect(out.find((e) => e.type === 'plan:build:failed')).toBeUndefined();
    // agent:retry fired with the stream-detected subtype.
    const retry = out.find((e) => e.type === 'agent:retry');
    expect(retry).toBeDefined();
    // Second attempt completed normally.
    expect(out.filter((e) => e.type === 'plan:build:evaluate:complete')).toHaveLength(1);
  });

  it('yields the held-back build:failed when retries are exhausted', async () => {
    const firstAttempt: (input: unknown) => AsyncGenerator<EforgeEvent, undefined> =
      async function* () {
        yield { timestamp: ts(), type: 'plan:build:failed', planId: 'p1', error: 'maxed out 1', terminalSubtype: 'error_max_turns' };
      };
    const secondAttempt: (input: unknown) => AsyncGenerator<EforgeEvent, undefined> =
      async function* () {
        yield { timestamp: ts(), type: 'plan:build:failed', planId: 'p1', error: 'maxed out 2', terminalSubtype: 'error_max_turns' };
      };

    const agent = makeMultiAttemptAgent([firstAttempt, secondAttempt]);

    const policy = makeEvaluatorPolicy({
      buildContinuationInput: (info) => ({ kind: 'retry', input: info.prevInput }),
    });
    const initial: EvaluatorContinuationInput = {
      worktreePath: '/tmp/noop',
      planId: 'p1',
      evaluatorOptions: {},
    };

    const out: EforgeEvent[] = [];
    for await (const ev of withRetry(agent, policy, initial)) {
      out.push(ev);
    }

    // Final held-back build:failed surfaces after exhaustion.
    const failures = out.filter((e) => e.type === 'plan:build:failed') as Array<Extract<EforgeEvent, { type: 'plan:build:failed' }>>;
    expect(failures).toHaveLength(1);
    expect(failures[0].error).toBe('maxed out 2');
  });
});

// ---------------------------------------------------------------------------
// withRetry + StubBackend + builderEvaluate — end-to-end integration
// ---------------------------------------------------------------------------
//
// These tests exercise the retry wrapper through a real agent generator
// (`builderEvaluate`) backed by `StubBackend`, which is the integration
// configuration the plan's verification criteria explicitly call out.

const makePlanFile = (id = 'plan-01') => ({
  id,
  name: 'Test Plan',
  dependsOn: [],
  branch: 'test/main',
  body: '# Test\n\nImplement something.',
  filePath: '/tmp/test-plan.md',
});

describe('withRetry + StubBackend + builderEvaluate', () => {
  it('scripts error_max_turns on attempt 1, success on attempt 2, and returns second-attempt events', async () => {
    // First backend call throws max-turns; second returns a normal evaluation.
    const backend = new StubBackend([
      { error: new AgentTerminalError('error_max_turns', 'Reached maximum number of turns (30).') },
      { text: '<evaluation></evaluation>' },
    ]);
    const plan = makePlanFile();

    // Wrap builderEvaluate with the evaluator retry policy. The policy's
    // buildContinuationInput would normally run hasUnstagedChanges against
    // the worktree; override via the `checkHasUnstagedChanges` hook so the
    // retry proceeds (rather than short-circuiting to abort-success).
    const runEvaluator = async function* (input: EvaluatorContinuationInput): AsyncGenerator<EforgeEvent> {
      yield* builderEvaluate(plan, {
        backend,
        cwd: input.worktreePath,
      });
    };

    const policy = DEFAULT_RETRY_POLICIES.evaluator as RetryPolicy<EvaluatorContinuationInput>;
    const initial: EvaluatorContinuationInput = {
      worktreePath: '/tmp',
      planId: plan.id,
      evaluatorOptions: {},
      checkHasUnstagedChanges: async () => true, // force retry
    };

    const out: EforgeEvent[] = [];
    for await (const ev of withRetry(runEvaluator, policy, initial)) {
      out.push(ev);
    }

    // First attempt's terminal build:failed was held back (retry consumed it)
    // and not re-yielded because retry succeeded.
    expect(out.find((e) => e.type === 'plan:build:failed')).toBeUndefined();

    // agent:retry was emitted between attempts.
    const retryEvt = out.find((e) => e.type === 'agent:retry') as
      | Extract<EforgeEvent, { type: 'agent:retry' }>
      | undefined;
    expect(retryEvt).toBeDefined();
    expect(retryEvt!.agent).toBe('evaluator');
    expect(retryEvt!.subtype).toBe('error_max_turns');
    expect(retryEvt!.attempt).toBe(1);
    expect(retryEvt!.maxAttempts).toBe(2);

    // Second attempt ran to completion — builderEvaluate emits two
    // build:evaluate:start events (one per attempt) and at least one
    // completion-style event from the second successful attempt.
    const starts = out.filter((e) => e.type === 'plan:build:evaluate:start');
    expect(starts.length).toBeGreaterThanOrEqual(2);
    const completes = out.filter((e) => e.type === 'plan:build:evaluate:complete');
    expect(completes.length).toBe(1);

    // Backend was called exactly twice (once per attempt).
    expect(backend.prompts).toHaveLength(2);
  });

  it('exhausts retries and surfaces the final build:failed when both attempts throw error_max_turns', async () => {
    const backend = new StubBackend([
      { error: new AgentTerminalError('error_max_turns', 'first attempt max turns') },
      { error: new AgentTerminalError('error_max_turns', 'second attempt max turns') },
    ]);
    const plan = makePlanFile();

    const runEvaluator = async function* (input: EvaluatorContinuationInput): AsyncGenerator<EforgeEvent> {
      yield* builderEvaluate(plan, {
        backend,
        cwd: input.worktreePath,
      });
    };

    const policy = DEFAULT_RETRY_POLICIES.evaluator as RetryPolicy<EvaluatorContinuationInput>;
    const initial: EvaluatorContinuationInput = {
      worktreePath: '/tmp',
      planId: plan.id,
      evaluatorOptions: {},
      checkHasUnstagedChanges: async () => true,
    };

    const out: EforgeEvent[] = [];
    for await (const ev of withRetry(runEvaluator, policy, initial)) {
      out.push(ev);
    }

    // Only the held-back build:failed from the LAST attempt is yielded.
    const failures = out.filter(
      (e) => e.type === 'plan:build:failed',
    ) as Array<Extract<EforgeEvent, { type: 'plan:build:failed' }>>;
    expect(failures).toHaveLength(1);
    expect(failures[0].error).toContain('second attempt max turns');
    expect(failures[0].terminalSubtype).toBe('error_max_turns');

    // No third attempt was made.
    expect(backend.prompts).toHaveLength(2);
  });

  it('evaluator abort-success: first attempt throws error_max_turns but worktree is clean — no retry', async () => {
    const backend = new StubBackend([
      { error: new AgentTerminalError('error_max_turns', 'turns exhausted') },
    ]);
    const plan = makePlanFile();

    const runEvaluator = async function* (input: EvaluatorContinuationInput): AsyncGenerator<EforgeEvent> {
      yield* builderEvaluate(plan, {
        backend,
        cwd: input.worktreePath,
      });
    };

    const policy = DEFAULT_RETRY_POLICIES.evaluator as RetryPolicy<EvaluatorContinuationInput>;
    const initial: EvaluatorContinuationInput = {
      worktreePath: '/tmp',
      planId: plan.id,
      evaluatorOptions: {},
      // Clean worktree => evaluator policy short-circuits to abort-success.
      checkHasUnstagedChanges: async () => false,
    };

    const out: EforgeEvent[] = [];
    for await (const ev of withRetry(runEvaluator, policy, initial)) {
      out.push(ev);
    }

    // Only one backend call — no retry ran.
    expect(backend.prompts).toHaveLength(1);
    // No agent:retry event emitted.
    expect(out.find((e) => e.type === 'agent:retry')).toBeUndefined();
    // Held-back terminal build:failed was dropped (abort-success treats the
    // state as success).
    expect(out.find((e) => e.type === 'plan:build:failed')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Type-surface smoke tests (ensures continuation input shapes compile)
// ---------------------------------------------------------------------------

describe('RetryPolicy type surface', () => {
  it('planner continuation input type accepts expected fields', () => {
    const input: PlannerContinuationInput = {
      sideEffects: {
        cwd: '/tmp/cwd',
        planSetName: 'test',
        outputDir: 'eforge/plans',
      },
      plannerOptions: {
        continuationContext: {
          attempt: 1,
          maxContinuations: 1,
          existingPlans: '',
          reason: 'max_turns',
        },
      },
    };
    expect(input.plannerOptions.continuationContext?.reason).toBe('max_turns');
  });

  it('builder continuation input type accepts expected fields', () => {
    const input: BuilderContinuationInput = {
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
      planId: 'plan-01',
      builderOptions: {
        continuationContext: {
          attempt: 1,
          maxContinuations: 3,
          completedDiff: '',
        },
      },
    };
    expect(input.planId).toBe('plan-01');
  });

  it('evaluator continuation input type accepts expected fields', () => {
    const input: EvaluatorContinuationInput = {
      worktreePath: '/tmp/wt',
      planId: 'plan-01',
      evaluatorOptions: {
        evaluatorContinuationContext: {
          attempt: 1,
          maxContinuations: 1,
        },
      },
    };
    expect(input.evaluatorOptions.evaluatorContinuationContext?.attempt).toBe(1);
  });
});
