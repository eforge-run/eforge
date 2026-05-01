import { describe, it, expect } from 'vitest';
import type { EforgeEvent } from '@eforge-build/engine/events';
import { PlannerSubmissionError } from '@eforge-build/engine/harness';
import type { AgentHarness } from '@eforge-build/engine/harness';
import { StubHarness } from './stub-harness.js';
import { collectEvents, findEvent, filterEvents } from './test-events.js';
import { useTempDir } from './test-tmpdir.js';
import { runPlanner } from '@eforge-build/engine/agents/planner';
import { runReview } from '@eforge-build/engine/agents/reviewer';
import { builderImplement, builderEvaluate } from '@eforge-build/engine/agents/builder';
import { runParallelReview } from '@eforge-build/engine/agents/parallel-reviewer';
import { runPlanReview } from '@eforge-build/engine/agents/plan-reviewer';
import { runPlanEvaluate } from '@eforge-build/engine/agents/plan-evaluator';
import { runArchitectureEvaluate } from '@eforge-build/engine/agents/plan-evaluator';
import { runModulePlanner } from '@eforge-build/engine/agents/module-planner';
import { runArchitectureReview } from '@eforge-build/engine/agents/architecture-reviewer';
import { runPrdValidator } from '@eforge-build/engine/agents/prd-validator';
import { validatePipeline, formatStageRegistry, getCompileStageNames, getBuildStageNames, getCompileStageDescriptors, getBuildStageDescriptors, resolveAgentConfig, AGENT_ROLE_DEFAULTS } from '@eforge-build/engine/pipeline';
import { DEFAULT_CONFIG, resolveConfig } from '@eforge-build/engine/config';
import type { EforgeConfig } from '@eforge-build/engine/config';
import { singletonRegistry, type AgentRuntimeRegistry } from '@eforge-build/engine/agent-runtime-registry';

// --- Planner ---

describe('runPlanner wiring', () => {
  const makeTempDir = useTempDir('eforge-planner-test-');

  it('throws PlannerSubmissionError when neither submission tool nor <skip> fires', async () => {
    const backend = new StubHarness([{ text: 'Planning done.' }]);
    const cwd = makeTempDir();

    // Collect events until the throw. plan:start and agent:result are yielded
    // before the terminal throw, so we can verify lifecycle emission too.
    const events: EforgeEvent[] = [];
    let thrown: unknown;
    try {
      for await (const ev of runPlanner('Build a widget', { harness: backend, cwd })) {
        events.push(ev);
      }
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(PlannerSubmissionError);
    expect((thrown as Error).message).toContain('submit_plan_set');
    expect(findEvent(events, 'planning:start')).toBeDefined();
    expect(findEvent(events, 'planning:complete')).toBeUndefined();
    // agent:result should have been yielded before the throw
    expect(findEvent(events, 'agent:result')).toBeDefined();
    // No plan:error events are yielded any more — the terminal is always thrown.
    expect(events.filter(e => e.type === 'planning:error')).toHaveLength(0);
  });

  it('emits plan:skip when agent output contains a skip block', async () => {
    const backend = new StubHarness([{
      text: '<skip>Already implemented in a previous PR.</skip>',
    }]);
    const cwd = makeTempDir();

    const events = await collectEvents(runPlanner('Fix a bug', {
      harness: backend,
      cwd,
    }));

    const skip = findEvent(events, 'planning:skip');
    expect(skip).toBeDefined();
    expect(skip!.reason).toBe('Already implemented in a previous PR.');

    // Skip should short-circuit — no plan:complete or plan scanning
    expect(findEvent(events, 'planning:complete')).toBeUndefined();
    const progressEvents = filterEvents(events, 'planning:progress');
    expect(progressEvents.every(e => e.message !== 'Scanning plan files...')).toBe(true);
  });

  it('triggers clarification callback and restarts with answers', async () => {
    const backend = new StubHarness([
      // First run: agent asks a clarification question
      { text: '<clarification><question id="q1">Which database?</question></clarification>' },
      // Second run: agent produces final output (answers baked into prompt)
      { text: 'Planning with Postgres.' },
    ]);
    const cwd = makeTempDir();

    const clarificationCalls: Array<{ id: string; question: string }[]> = [];
    const events: EforgeEvent[] = [];
    // Second iteration emits no submission tool so the planner throws
    // PlannerSubmissionError — collect pre-throw events for lifecycle asserts.
    try {
      for await (const ev of runPlanner('Add a feature', {
        harness: backend,
        cwd,
        onClarification: async (questions) => {
          clarificationCalls.push(questions);
          return { q1: 'Postgres' };
        },
      })) {
        events.push(ev);
      }
    } catch { /* expected PlannerSubmissionError */ }

    // Callback was invoked
    expect(clarificationCalls).toHaveLength(1);
    expect(clarificationCalls[0][0].id).toBe('q1');

    // Clarification events emitted
    expect(findEvent(events, 'planning:clarification')).toBeDefined();
    expect(findEvent(events, 'planning:clarification:answer')).toBeDefined();

    // Backend was called twice (first run + restart)
    expect(backend.prompts).toHaveLength(2);
    // Second prompt should contain the clarification answers
    expect(backend.prompts[1]).toContain('Postgres');
    expect(backend.prompts[1]).toContain('Prior Clarifications');
  });

  it('handles multiple clarification rounds', async () => {
    const backend = new StubHarness([
      { text: '<clarification><question id="q1">Database?</question></clarification>' },
      { text: '<clarification><question id="q2">ORM?</question></clarification>' },
      { text: 'Final plan.' },
    ]);
    const cwd = makeTempDir();

    const events: EforgeEvent[] = [];
    // Third iteration emits no submission tool so the planner throws.
    try {
      for await (const ev of runPlanner('Add feature', {
        harness: backend,
        cwd,
        onClarification: async (questions) => {
          const id = questions[0].id;
          return { [id]: id === 'q1' ? 'Postgres' : 'Drizzle' };
        },
      })) {
        events.push(ev);
      }
    } catch { /* expected PlannerSubmissionError */ }

    expect(backend.prompts).toHaveLength(3);
    // Third prompt should contain both prior answers
    expect(backend.prompts[2]).toContain('Postgres');
    expect(backend.prompts[2]).toContain('Drizzle');

    const clarifications = filterEvents(events, 'planning:clarification');
    expect(clarifications).toHaveLength(2);
  });

  it('stops after max iterations', async () => {
    // Provide 6 clarification responses (max is 5)
    const responses = Array.from({ length: 6 }, () => ({
      text: '<clarification><question id="q1">Again?</question></clarification>',
    }));
    const backend = new StubHarness(responses);
    const cwd = makeTempDir();

    // After max iterations without submission or skip, planner throws
    // PlannerSubmissionError instead of yielding plan:error.
    await expect(collectEvents(runPlanner('Loop forever', {
      harness: backend,
      cwd,
      onClarification: async () => ({ q1: 'yes' }),
    }))).rejects.toThrow(PlannerSubmissionError);

    // Should stop at 5 iterations, not use the 6th response
    expect(backend.prompts).toHaveLength(5);
  });

  it('skips clarification in auto mode', async () => {
    const backend = new StubHarness([{
      text: '<clarification><question id="q1">Database?</question></clarification> Done.',
    }]);
    const cwd = makeTempDir();

    let callbackCalled = false;
    // In auto mode the clarification callback must not fire, and the planner
    // throws PlannerSubmissionError because no submission tool was called.
    await expect(collectEvents(runPlanner('Auto plan', {
      harness: backend,
      cwd,
      auto: true,
      onClarification: async () => {
        callbackCalled = true;
        return {};
      },
    }))).rejects.toThrow(PlannerSubmissionError);

    expect(callbackCalled).toBe(false);
    // No restart — only one backend call
    expect(backend.prompts).toHaveLength(1);
  });

  it('suppresses agent:message when verbose is false, emits when true', async () => {
    const makeBackend = () => new StubHarness([{ text: 'Some output.' }]);
    const cwd = makeTempDir();

    // verbose=false (default): agent:message should be suppressed. Planner
    // throws PlannerSubmissionError after the stream completes without a
    // submission tool call, but pre-throw events are still collected.
    const quietEvents: EforgeEvent[] = [];
    try {
      for await (const ev of runPlanner('Test', { harness: makeBackend(), cwd })) {
        quietEvents.push(ev);
      }
    } catch { /* expected PlannerSubmissionError */ }
    expect(filterEvents(quietEvents, 'agent:message')).toHaveLength(0);

    // verbose=true: agent:message should be emitted
    const cwd2 = makeTempDir();
    const verboseEvents: EforgeEvent[] = [];
    try {
      for await (const ev of runPlanner('Test', { harness: makeBackend(), cwd: cwd2, verbose: true })) {
        verboseEvents.push(ev);
      }
    } catch { /* expected PlannerSubmissionError */ }
    expect(filterEvents(verboseEvents, 'agent:message').length).toBeGreaterThan(0);
  });

  it('writes plans via submission tool and yields plan:complete', async () => {
    const cwd = makeTempDir();

    const backend = new StubHarness([{
      toolCalls: [{
        tool: 'submit_plan_set',
        toolUseId: 'tu-1',
        input: {
          name: 'my-plan',
          description: 'A test plan',
          mode: 'excursion',
          baseBranch: 'main',
          plans: [{
            frontmatter: {
              id: 'feature',
              name: 'Add feature',
              dependsOn: [],
              branch: 'feature/add-feature',
            },
            body: '# Implementation\n\nDo the thing.',
          }],
          orchestration: {
            validate: [],
            plans: [{
              id: 'feature',
              name: 'Add feature',
              dependsOn: [],
              branch: 'feature/add-feature',
            }],
          },
        },
        output: '',
      }],
      text: 'Done planning.',
    }]);
    const events = await collectEvents(runPlanner('my-plan', {
      harness: backend,
      cwd,
      name: 'my-plan',
      scope: 'excursion',
    }));

    const complete = findEvent(events, 'planning:complete');
    expect(complete).toBeDefined();
    expect(complete!.plans).toHaveLength(1);
    expect(complete!.plans[0].id).toBe('feature');
    expect(complete!.plans[0].name).toBe('Add feature');
  });
});

// --- Planner submission tool naming ---

describe('runPlanner submission tool naming', () => {
  const makeTempDir = useTempDir('eforge-planner-submit-name-');

  /**
   * StubHarness subclass whose `effectiveCustomToolName` returns a
   * distinguishable prefix so tests can verify that the planner asks the
   * backend for the per-backend tool name and interpolates it into the
   * rendered prompt.
   */
  class PrefixedStubHarness extends StubHarness {
    override effectiveCustomToolName(name: string): string {
      return `stub__${name}`;
    }
  }

  it('injects backend-provided effective tool name into the rendered prompt (excursion)', async () => {
    const backend = new PrefixedStubHarness([{ text: '' }]);
    const cwd = makeTempDir();

    // No submission tool is called in this stub response so the planner throws
    // PlannerSubmissionError after recording the prompt. The prompt capture
    // is what this test verifies.
    await expect(collectEvents(runPlanner('Add a thing', {
      harness: backend,
      cwd,
      scope: 'excursion',
    }))).rejects.toThrow(PlannerSubmissionError);

    expect(backend.prompts).toHaveLength(1);
    const prompt = backend.prompts[0];
    expect(prompt).toContain('stub__submit_plan_set');
    expect(prompt).not.toContain('mcp__eforge_engine__');
    // The bare name must not appear standalone (surrounded by non-identifier
    // chars). It is allowed as a substring of `stub__submit_plan_set`, so
    // strip that compound token before asserting the bare name is absent.
    const withoutPrefixed = prompt.split('stub__submit_plan_set').join('');
    expect(withoutPrefixed).not.toMatch(/\bsubmit_plan_set\b/);
  });

  it('injects backend-provided effective tool name into the rendered prompt (expedition)', async () => {
    const backend = new PrefixedStubHarness([{ text: '' }]);
    const cwd = makeTempDir();

    // No submission tool is called in this stub response so the planner throws
    // PlannerSubmissionError after recording the prompt.
    await expect(collectEvents(runPlanner('Design a system', {
      harness: backend,
      cwd,
      scope: 'expedition',
    }))).rejects.toThrow(PlannerSubmissionError);

    expect(backend.prompts).toHaveLength(1);
    const prompt = backend.prompts[0];
    expect(prompt).toContain('stub__submit_architecture');
    expect(prompt).not.toContain('mcp__eforge_engine__');
  });

  it('reports backend-visible names in the thrown PlannerSubmissionError when no submission tool was called', async () => {
    const backend = new PrefixedStubHarness([{ text: 'Nothing to do.' }]);
    const cwd = makeTempDir();

    let thrown: unknown;
    try {
      await collectEvents(runPlanner('Hmm', {
        harness: backend,
        cwd,
        scope: 'excursion',
      }));
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(PlannerSubmissionError);
    const message = (thrown as Error).message;
    expect(message).toContain('stub__submit_plan_set');
    expect(message).not.toContain('mcp__eforge_engine__');
  });
});

// --- Reviewer ---

describe('runReview wiring', () => {
  it('parses review issues from agent output', async () => {
    const backend = new StubHarness([{
      text: `<review-issues>
  <issue severity="critical" category="bug" file="src/a.ts" line="42">Memory leak in handler</issue>
  <issue severity="warning" category="perf" file="src/b.ts">Slow query<fix>Add index</fix></issue>
</review-issues>`,
    }]);

    const events = await collectEvents(runReview({
      harness: backend,
      planContent: 'test plan',
      baseBranch: 'main',
      planId: 'plan-1',
      cwd: '/tmp',
    }));

    expect(findEvent(events, 'plan:build:review:start')).toBeDefined();

    const complete = findEvent(events, 'plan:build:review:complete');
    expect(complete).toBeDefined();
    expect(complete!.issues).toHaveLength(2);
    expect(complete!.issues[0]).toMatchObject({
      severity: 'critical',
      category: 'bug',
      file: 'src/a.ts',
      line: 42,
      description: 'Memory leak in handler',
    });
    expect(complete!.issues[1].fix).toBe('Add index');
  });

  it('yields empty issues for plain text output', async () => {
    const backend = new StubHarness([{ text: 'Code looks good. No issues found.' }]);

    const events = await collectEvents(runReview({
      harness: backend,
      planContent: 'test plan',
      baseBranch: 'main',
      planId: 'plan-1',
      cwd: '/tmp',
    }));

    const complete = findEvent(events, 'plan:build:review:complete');
    expect(complete).toBeDefined();
    expect(complete!.issues).toHaveLength(0);
  });
});

// --- Builder ---

describe('builderImplement wiring', () => {
  it('emits implement lifecycle events on success', async () => {
    const backend = new StubHarness([{ text: 'Implementation done.' }]);

    const events = await collectEvents(builderImplement(
      { id: 'plan-1', name: 'Feature', dependsOn: [], branch: 'feature/x', body: 'content', filePath: '/tmp/plan.md' },
      { harness: backend, cwd: '/tmp' },
    ));

    expect(findEvent(events, 'plan:build:implement:start')).toBeDefined();
    expect(findEvent(events, 'plan:build:implement:complete')).toBeDefined();
    expect(findEvent(events, 'plan:build:failed')).toBeUndefined();
  });

  it('emits build:failed when backend throws', async () => {
    const backend = new StubHarness([{ error: new Error('Agent timeout') }]);

    const events = await collectEvents(builderImplement(
      { id: 'plan-1', name: 'Feature', dependsOn: [], branch: 'feature/x', body: 'content', filePath: '/tmp/plan.md' },
      { harness: backend, cwd: '/tmp' },
    ));

    const failed = findEvent(events, 'plan:build:failed');
    expect(failed).toBeDefined();
    expect(failed!.error).toContain('Agent timeout');
    // Should NOT emit implement:complete on failure
    expect(findEvent(events, 'plan:build:implement:complete')).toBeUndefined();
  });
});

describe('builderEvaluate wiring', () => {
  it('counts verdicts correctly', async () => {
    const backend = new StubHarness([{
      text: `<evaluation>
  <verdict file="a.ts" action="accept">Good change</verdict>
  <verdict file="b.ts" action="accept">Also good</verdict>
  <verdict file="c.ts" action="reject">Unnecessary</verdict>
  <verdict file="d.ts" action="review">Needs discussion</verdict>
</evaluation>`,
    }]);

    const events = await collectEvents(builderEvaluate(
      { id: 'plan-1', name: 'Feature', dependsOn: [], branch: 'feature/x', body: 'content', filePath: '/tmp/plan.md' },
      { harness: backend, cwd: '/tmp' },
    ));

    const complete = findEvent(events, 'plan:build:evaluate:complete');
    expect(complete).toBeDefined();
    expect(complete!.accepted).toBe(2);
    expect(complete!.rejected).toBe(2); // reject + review both count as rejected
    expect(complete!.verdicts).toHaveLength(4);
    expect(complete!.verdicts).toEqual([
      { file: 'a.ts', action: 'accept', reason: 'Good change' },
      { file: 'b.ts', action: 'accept', reason: 'Also good' },
      { file: 'c.ts', action: 'reject', reason: 'Unnecessary' },
      { file: 'd.ts', action: 'review', reason: 'Needs discussion' },
    ]);
  });

  // builderEvaluate catches errors and yields build:failed (no re-throw) —
  // the builder owns the plan lifecycle so it handles errors gracefully.
  // Contrast with runPlanEvaluate which re-throws after yielding zero counts,
  // because plan evaluation errors propagate to the engine's plan() method.
  it('emits build:failed when backend throws', async () => {
    const backend = new StubHarness([{ error: new Error('Evaluate failed') }]);

    const events = await collectEvents(builderEvaluate(
      { id: 'plan-1', name: 'Feature', dependsOn: [], branch: 'feature/x', body: 'content', filePath: '/tmp/plan.md' },
      { harness: backend, cwd: '/tmp' },
    ));

    expect(findEvent(events, 'plan:build:failed')).toBeDefined();
    expect(findEvent(events, 'plan:build:evaluate:complete')).toBeUndefined();
  });
});

// --- Plan Reviewer ---

describe('runPlanReview wiring', () => {
  it('parses review issues from plan review output', async () => {
    const backend = new StubHarness([{
      text: `<review-issues>
  <issue severity="warning" category="scope" file="plans/feature.md">Missing edge case</issue>
</review-issues>`,
    }]);

    const events = await collectEvents(runPlanReview({
      harness: backend,
      sourceContent: 'PRD content',
      planSetName: 'my-plan',
      cwd: '/tmp',
    }));

    expect(findEvent(events, 'planning:review:start')).toBeDefined();
    const complete = findEvent(events, 'planning:review:complete');
    expect(complete).toBeDefined();
    expect(complete!.issues).toHaveLength(1);
    expect(complete!.issues[0].category).toBe('scope');
  });
});

// --- Plan Evaluator ---

describe('runPlanEvaluate wiring', () => {
  it('counts evaluation verdicts', async () => {
    const backend = new StubHarness([{
      text: `<evaluation>
  <verdict file="plans/a.md" action="accept">Good fix</verdict>
  <verdict file="plans/b.md" action="reject">Over-scoped</verdict>
</evaluation>`,
    }]);

    const events = await collectEvents(runPlanEvaluate({
      harness: backend,
      planSetName: 'my-plan',
      sourceContent: 'PRD content',
      cwd: '/tmp',
    }));

    expect(findEvent(events, 'planning:evaluate:start')).toBeDefined();
    const complete = findEvent(events, 'planning:evaluate:complete');
    expect(complete).toBeDefined();
    expect(complete!.accepted).toBe(1);
    expect(complete!.rejected).toBe(1);
    expect(complete!.verdicts).toEqual([
      { file: 'plans/a.md', action: 'accept', reason: 'Good fix' },
      { file: 'plans/b.md', action: 'reject', reason: 'Over-scoped' },
    ]);
  });

  // runPlanEvaluate re-throws after yielding a zero-count complete event —
  // the engine's plan() method catches this and reports it as non-fatal.
  // Contrast with builderEvaluate which swallows errors into build:failed.
  it('emits zero counts and re-throws on error', async () => {
    const backend = new StubHarness([{ error: new Error('Evaluate crash') }]);

    let thrown: Error | undefined;
    const events: EforgeEvent[] = [];
    try {
      for await (const event of runPlanEvaluate({
        harness: backend,
        planSetName: 'my-plan',
        sourceContent: 'PRD content',
        cwd: '/tmp',
      })) {
        events.push(event);
      }
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown).toBeDefined();
    expect(thrown!.message).toBe('Evaluate crash');

    const complete = findEvent(events, 'planning:evaluate:complete');
    expect(complete).toBeDefined();
    expect(complete!.accepted).toBe(0);
    expect(complete!.rejected).toBe(0);
  });
});

// --- Module Planner ---

describe('runModulePlanner wiring', () => {
  it('emits expedition module lifecycle events', async () => {
    const backend = new StubHarness([{ text: 'Module plan written.' }]);

    const events = await collectEvents(runModulePlanner({
      harness: backend,
      cwd: '/tmp',
      planSetName: 'my-expedition',
      moduleId: 'auth',
      moduleDescription: 'Authentication system',
      moduleDependsOn: ['foundation'],
      architectureContent: '# Architecture\nModular design.',
      sourceContent: 'PRD content',
    }));

    const start = findEvent(events, 'expedition:module:start');
    expect(start).toBeDefined();
    expect(start!.moduleId).toBe('auth');

    const complete = findEvent(events, 'expedition:module:complete');
    expect(complete).toBeDefined();
    expect(complete!.moduleId).toBe('auth');

    // agent:result always yielded
    expect(findEvent(events, 'agent:result')).toBeDefined();
  });

  it('suppresses agent:message when verbose is false', async () => {
    const backend = new StubHarness([{ text: 'Module details.' }]);

    const events = await collectEvents(runModulePlanner({
      harness: backend,
      cwd: '/tmp',
      planSetName: 'my-expedition',
      moduleId: 'auth',
      moduleDescription: 'Auth',
      moduleDependsOn: [],
      architectureContent: '',
      sourceContent: 'PRD',
    }));

    // agent:message suppressed when verbose is false (default)
    expect(filterEvents(events, 'agent:message')).toHaveLength(0);
  });

  it('emits agent:message when verbose is true', async () => {
    const backend = new StubHarness([{ text: 'Module details.' }]);

    const events = await collectEvents(runModulePlanner({
      harness: backend,
      cwd: '/tmp',
      planSetName: 'my-expedition',
      moduleId: 'auth',
      moduleDescription: 'Auth',
      moduleDependsOn: [],
      architectureContent: '',
      sourceContent: 'PRD',
      verbose: true,
    }));

    expect(filterEvents(events, 'agent:message').length).toBeGreaterThan(0);
  });

  it('includes dependencyPlanContent in prompt when provided', async () => {
    const backend = new StubHarness([{ text: 'Module plan written.' }]);
    const depContent = '# Foundation\n\nCreates auth tables and user model.';

    await collectEvents(runModulePlanner({
      harness: backend,
      cwd: '/tmp',
      planSetName: 'my-expedition',
      moduleId: 'auth',
      moduleDescription: 'Auth',
      moduleDependsOn: ['foundation'],
      architectureContent: '',
      sourceContent: 'PRD',
      dependencyPlanContent: depContent,
    }));

    expect(backend.prompts[0]).toContain(depContent);
  });

  it('uses fallback text when dependencyPlanContent is omitted', async () => {
    const backend = new StubHarness([{ text: 'Module plan written.' }]);

    await collectEvents(runModulePlanner({
      harness: backend,
      cwd: '/tmp',
      planSetName: 'my-expedition',
      moduleId: 'foundation',
      moduleDescription: 'Foundation',
      moduleDependsOn: [],
      architectureContent: '',
      sourceContent: 'PRD',
    }));

    expect(backend.prompts[0]).toContain('No dependencies');
  });

  it('uses fallback text when dependencyPlanContent is undefined', async () => {
    const backend = new StubHarness([{ text: 'Module plan written.' }]);

    await collectEvents(runModulePlanner({
      harness: backend,
      cwd: '/tmp',
      planSetName: 'my-expedition',
      moduleId: 'foundation',
      moduleDescription: 'Foundation',
      moduleDependsOn: [],
      architectureContent: '',
      sourceContent: 'PRD',
      dependencyPlanContent: undefined,
    }));

    expect(backend.prompts[0]).toContain('No dependencies');
  });
});

// --- Architecture Reviewer ---

describe('runArchitectureReview wiring', () => {
  it('emits architecture review lifecycle events with parsed issues', async () => {
    const backend = new StubHarness([{
      text: `<review-issues>
  <issue severity="warning" category="completeness" file="plans/my-plan/architecture.md">Missing integration contract between auth and api modules</issue>
</review-issues>`,
    }]);

    const events = await collectEvents(runArchitectureReview({
      harness: backend,
      sourceContent: 'PRD content',
      planSetName: 'my-plan',
      architectureContent: '# Architecture\nModules: auth, api',
      cwd: '/tmp',
    }));

    expect(findEvent(events, 'planning:architecture:review:start')).toBeDefined();
    const complete = findEvent(events, 'planning:architecture:review:complete');
    expect(complete).toBeDefined();
    expect(complete!.issues).toHaveLength(1);
    expect(complete!.issues[0].category).toBe('completeness');
    expect(complete!.issues[0].severity).toBe('warning');
  });

  it('yields empty issues for clean architecture', async () => {
    const backend = new StubHarness([{
      text: 'Architecture looks solid. <review-issues></review-issues>',
    }]);

    const events = await collectEvents(runArchitectureReview({
      harness: backend,
      sourceContent: 'PRD content',
      planSetName: 'my-plan',
      architectureContent: '# Architecture\nWell defined.',
      cwd: '/tmp',
    }));

    const complete = findEvent(events, 'planning:architecture:review:complete');
    expect(complete).toBeDefined();
    expect(complete!.issues).toHaveLength(0);
  });
});

// --- Architecture Evaluator ---

describe('runArchitectureEvaluate wiring', () => {
  it('counts evaluation verdicts correctly', async () => {
    const backend = new StubHarness([{
      text: `<evaluation>
  <verdict file="plans/my-plan/architecture.md" action="accept">Good clarification</verdict>
  <verdict file="plans/my-plan/architecture.md" action="reject">Changes module decomposition</verdict>
  <verdict file="plans/my-plan/architecture.md" action="accept">Missing contract added</verdict>
</evaluation>`,
    }]);

    const events = await collectEvents(runArchitectureEvaluate({
      harness: backend,
      planSetName: 'my-plan',
      sourceContent: 'PRD content',
      cwd: '/tmp',
    }));

    expect(findEvent(events, 'planning:architecture:evaluate:start')).toBeDefined();
    const complete = findEvent(events, 'planning:architecture:evaluate:complete');
    expect(complete).toBeDefined();
    expect(complete!.accepted).toBe(2);
    expect(complete!.rejected).toBe(1);
    expect(complete!.verdicts).toEqual([
      { file: 'plans/my-plan/architecture.md', action: 'accept', reason: 'Good clarification' },
      { file: 'plans/my-plan/architecture.md', action: 'reject', reason: 'Changes module decomposition' },
      { file: 'plans/my-plan/architecture.md', action: 'accept', reason: 'Missing contract added' },
    ]);
  });

  it('emits zero counts and re-throws on error (architecture)', async () => {
    const backend = new StubHarness([{ error: new Error('Architecture evaluate crash') }]);

    let thrown: Error | undefined;
    const events: EforgeEvent[] = [];
    try {
      for await (const event of runArchitectureEvaluate({
        harness: backend,
        planSetName: 'my-plan',
        sourceContent: 'PRD content',
        cwd: '/tmp',
      })) {
        events.push(event);
      }
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown).toBeDefined();
    expect(thrown!.message).toBe('Architecture evaluate crash');

    const complete = findEvent(events, 'planning:architecture:evaluate:complete');
    expect(complete).toBeDefined();
    expect(complete!.accepted).toBe(0);
    expect(complete!.rejected).toBe(0);
  });
});

// --- PRD Validator ---

describe('runPrdValidator wiring', () => {
  it('emits prd_validation:start and prd_validation:complete with no gaps when agent finds none', async () => {
    const backend = new StubHarness([{
      text: '```json\n{ "gaps": [] }\n```',
    }]);

    const events = await collectEvents(runPrdValidator({
      harness: backend,
      cwd: '/tmp',
      prdContent: '# PRD\n\nAdd a login page.',
      diff: 'diff --git a/src/login.ts b/src/login.ts\n+export function LoginPage() {}',
    }));

    expect(findEvent(events, 'prd_validation:start')).toBeDefined();
    const complete = findEvent(events, 'prd_validation:complete');
    expect(complete).toBeDefined();
    expect(complete!.passed).toBe(true);
    expect(complete!.gaps).toEqual([]);
  });

  it('emits prd_validation:complete with gaps when agent finds issues', async () => {
    const backend = new StubHarness([{
      text: `\`\`\`json
{
  "gaps": [
    {
      "requirement": "Login page should support OAuth",
      "explanation": "No OAuth integration found in the diff"
    },
    {
      "requirement": "Error messages should be user-friendly",
      "explanation": "Error handling uses raw error messages without user-friendly formatting"
    }
  ]
}
\`\`\``,
    }]);

    const events = await collectEvents(runPrdValidator({
      harness: backend,
      cwd: '/tmp',
      prdContent: '# PRD\n\nAdd a login page with OAuth and friendly errors.',
      diff: 'diff --git a/src/login.ts b/src/login.ts\n+export function LoginPage() {}',
    }));

    const complete = findEvent(events, 'prd_validation:complete');
    expect(complete).toBeDefined();
    expect(complete!.passed).toBe(false);
    expect(complete!.gaps).toHaveLength(2);
    expect(complete!.gaps[0].requirement).toBe('Login page should support OAuth');
    expect(complete!.gaps[1].explanation).toContain('Error handling');
  });

  it('re-throws non-abort agent errors (fail-closed)', async () => {
    const backend = new StubHarness([{ error: new Error('Agent crashed') }]);

    // Fail-closed: a crashed validator must not silently certify a build.
    await expect(async () => {
      for await (const _event of runPrdValidator({
        harness: backend,
        cwd: '/tmp',
        prdContent: 'PRD content',
        diff: 'some diff',
      })) {
        // drain
      }
    }).rejects.toThrow('Agent crashed');
  });

  it('yields agent:result event (always yielded)', async () => {
    const backend = new StubHarness([{
      text: '```json\n{ "gaps": [] }\n```',
    }]);

    const events = await collectEvents(runPrdValidator({
      harness: backend,
      cwd: '/tmp',
      prdContent: 'PRD',
      diff: 'diff',
    }));

    expect(findEvent(events, 'agent:result')).toBeDefined();
  });
});

// --- Stage Descriptor Metadata ---

describe('stage descriptor metadata', () => {
  it('all 6 compile stage descriptors have non-empty description, whenToUse, and costHint', () => {
    const descriptors = getCompileStageDescriptors();
    expect(descriptors.length).toBe(6);
    for (const d of descriptors) {
      expect(d.description.length).toBeGreaterThan(0);
      expect(d.whenToUse.length).toBeGreaterThan(0);
      expect(['low', 'medium', 'high']).toContain(d.costHint);
      expect(d.phase).toBe('compile');
    }
  });

  it('all 10 build stage descriptors have non-empty description, whenToUse, and costHint', () => {
    const descriptors = getBuildStageDescriptors();
    expect(descriptors.length).toBe(10);
    for (const d of descriptors) {
      expect(d.description.length).toBeGreaterThan(0);
      expect(d.whenToUse.length).toBeGreaterThan(0);
      expect(['low', 'medium', 'high']).toContain(d.costHint);
      expect(d.phase).toBe('build');
    }
  });
});

// --- Stage Registry: validatePipeline ---

describe('validatePipeline', () => {
  it('returns valid for a correct pipeline', () => {
    const result = validatePipeline(
      ['planner', 'plan-review-cycle'],
      ['implement', 'doc-update', 'review-cycle'],
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('returns error for unknown compile stage', () => {
    const result = validatePipeline(['nonexistent'], ['implement']);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Unknown compile stage') && e.includes('nonexistent'))).toBe(true);
  });

  it('returns error for unknown build stage', () => {
    const result = validatePipeline(['planner'], ['nonexistent']);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Unknown build stage') && e.includes('nonexistent'))).toBe(true);
  });

  it('returns error for missing predecessor', () => {
    // plan-review-cycle requires 'planner' as predecessor
    const result = validatePipeline(['plan-review-cycle'], ['implement']);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('predecessor') && e.includes('planner'))).toBe(true);
  });

  it('returns warning for non-parallelizable stage in parallel group', () => {
    const result = validatePipeline(['planner'], [['implement', 'review-cycle']]);
    expect(result.warnings.some((w) => w.includes('not parallelizable'))).toBe(true);
  });
});

// --- Stage Registry: formatStageRegistry ---

describe('formatStageRegistry', () => {
  it('returns a non-empty markdown table', () => {
    const output = formatStageRegistry();
    expect(output.length).toBeGreaterThan(0);
    expect(output).toContain('| Name |');
    expect(output).toContain('|------|');
  });

  it('contains all registered stage names', () => {
    const output = formatStageRegistry();
    const allNames = [...getCompileStageNames(), ...getBuildStageNames()];
    expect(allNames.length).toBe(16);
    for (const name of allNames) {
      expect(output).toContain(name);
    }
  });
});

// --- resolveAgentConfig per-plan override ---

describe('resolveAgentConfig per-plan override', () => {
  function makeConfig(overrides?: Partial<EforgeConfig['agents']>): EforgeConfig {
    return resolveConfig({
      agents: {
        tiers: {
          planning: { harness: 'claude-sdk' as const, model: 'claude-opus-4-7', effort: 'high' as const },
          implementation: { harness: 'claude-sdk' as const, model: 'claude-sonnet-4-6', effort: 'medium' as const },
          review: { harness: 'claude-sdk' as const, model: 'claude-opus-4-7', effort: 'high' as const },
          evaluation: { harness: 'claude-sdk' as const, model: 'claude-opus-4-7', effort: 'high' as const },
        },
        ...overrides,
      },
    });
  }

  it('planEntry override wins over per-role config for effort', () => {
    const config = makeConfig({
      roles: {
        builder: { effort: 'high' },
      },
    });

    const result = resolveAgentConfig('builder', config, {
      agents: { builder: { effort: 'xhigh' } },
    });

    expect(result.effort).toBe('xhigh');
    expect(result.effortSource).toBe('plan');
  });

  it('missing planEntry falls back to current behavior', () => {
    const config = makeConfig({
      roles: {
        builder: { effort: 'high' },
      },
    });

    const resultWithPlan = resolveAgentConfig('builder', config);
    const resultWithoutPlan = resolveAgentConfig('builder', config, undefined);

    expect(resultWithPlan.effort).toBe(resultWithoutPlan.effort);
    expect(resultWithPlan.effortSource).toBe('role');
  });

  it('xhigh and max effort levels flow through on capable models', () => {
    // Use a tier with claude-opus-4-7 which supports all effort levels
    const config = makeConfig({});

    const resultXhigh = resolveAgentConfig('builder', config, {
      agents: { builder: { effort: 'xhigh' } },
    });
    expect(resultXhigh.effort).toBe('xhigh');
    expect(resultXhigh.effortClamped).toBe(false);

    const resultMax = resolveAgentConfig('reviewer', config, {
      agents: { reviewer: { effort: 'max' } },
    });
    expect(resultMax.effort).toBe('max');
    expect(resultMax.effortClamped).toBe(false);
  });

  it('clamping reflects in resolved config for Sonnet model with max effort', () => {
    // Override implementation tier to use sonnet-4-0 to trigger clamping
    const config = resolveConfig({
      agents: {
        tiers: {
          planning: { harness: 'claude-sdk' as const, model: 'claude-opus-4-7', effort: 'high' as const },
          implementation: { harness: 'claude-sdk' as const, model: 'claude-sonnet-4-0', effort: 'medium' as const },
          review: { harness: 'claude-sdk' as const, model: 'claude-opus-4-7', effort: 'high' as const },
          evaluation: { harness: 'claude-sdk' as const, model: 'claude-opus-4-7', effort: 'high' as const },
        },
      },
    });

    const result = resolveAgentConfig('builder', config, {
      agents: { builder: { effort: 'max' } },
    });

    expect(result.effort).toBe('xhigh');
    expect(result.effortClamped).toBe(true);
    expect(result.effortOriginal).toBe('max');
    expect(result.effortSource).toBe('plan');
  });

  it('planEntry thinking override wins over per-role config', () => {
    const config = makeConfig({
      model: { id: 'claude-opus-4-6' },
      roles: {
        builder: { thinking: { type: 'disabled' } },
      },
    });

    const result = resolveAgentConfig('builder', config, {
      agents: { builder: { thinking: { type: 'enabled', budgetTokens: 5000 } } },
    });

    expect(result.thinking).toEqual({ type: 'enabled', budgetTokens: 5000 });
  });

  it('effortSource is tier when effort comes from tier recipe', () => {
    // Implementation tier has effort: 'medium', builder maps to implementation
    const config = makeConfig({});

    const result = resolveAgentConfig('builder', config);

    expect(result.effort).toBe('medium');
    expect(result.effortSource).toBe('tier');
  });

  it('effortSource and thinkingSource are tier when no overrides configured', () => {
    const config = makeConfig({});
    const result = resolveAgentConfig('builder', config);
    // Builder maps to implementation tier which has effort: 'medium'
    expect(result.effort).toBe('medium');
    expect(result.effortSource).toBe('tier');
    expect(result.thinking).toBeUndefined();
    expect(result.thinkingSource).toBe('tier');
  });

  it('thinkingSource tracks plan provenance', () => {
    const config = makeConfig({
      roles: {
        builder: { thinking: true },
      },
    });

    const result = resolveAgentConfig('builder', config, {
      agents: { builder: { thinking: { type: 'enabled', budgetTokens: 5000 } } },
    });

    expect(result.thinking).toEqual({ type: 'enabled', budgetTokens: 5000 });
    expect(result.thinkingSource).toBe('plan');
  });

  it('thinkingSource tracks role provenance', () => {
    const config = makeConfig({
      roles: {
        builder: { thinking: true },
      },
    });

    const result = resolveAgentConfig('builder', config);

    expect(result.thinking).toEqual({ type: 'enabled' });
    expect(result.thinkingSource).toBe('role');
  });

  it('thinkingSource tracks tier provenance when set in tier recipe', () => {
    const config = resolveConfig({
      agents: {
        tiers: {
          planning: { harness: 'claude-sdk' as const, model: 'claude-opus-4-7', effort: 'high' as const },
          implementation: { harness: 'claude-sdk' as const, model: 'claude-opus-4-6', effort: 'medium' as const, thinking: true },
          review: { harness: 'claude-sdk' as const, model: 'claude-opus-4-7', effort: 'high' as const },
          evaluation: { harness: 'claude-sdk' as const, model: 'claude-opus-4-7', effort: 'high' as const },
        },
      },
    });

    const result = resolveAgentConfig('builder', config);

    expect(result.thinking).toEqual({ type: 'enabled' });
    expect(result.thinkingSource).toBe('tier');
  });

  it('effortSource is always stamped even when effort is set from tier', () => {
    const config = makeConfig({});

    const result = resolveAgentConfig('builder', config);

    expect(result.effort).toBe('medium');
    expect(result.effortSource).toBe('tier');
    expect(result.thinkingSource).toBe('tier');
  });
});

// --- Per-role effort defaults ---

describe('resolveAgentConfig per-role effort defaults', () => {
  function makeConfig(overrides?: Partial<EforgeConfig['agents']>): EforgeConfig {
    return resolveConfig({
      agents: {
        tiers: {
          planning: { harness: 'claude-sdk' as const, model: 'claude-opus-4-7', effort: 'high' as const },
          implementation: { harness: 'claude-sdk' as const, model: 'claude-sonnet-4-6', effort: 'medium' as const },
          review: { harness: 'claude-sdk' as const, model: 'claude-opus-4-7', effort: 'high' as const },
          evaluation: { harness: 'claude-sdk' as const, model: 'claude-opus-4-7', effort: 'high' as const },
        },
        ...overrides,
      },
    });
  }

  // In the new tier-recipe system, effort flows from the tier.
  // planning/review/evaluation tiers have effort: 'high'; implementation has effort: 'medium'.
  const effortTable: Array<{ role: string; expectedEffort: string }> = [
    // Planning tier (effort: 'high')
    { role: 'planner', expectedEffort: 'high' },
    { role: 'module-planner', expectedEffort: 'high' },
    { role: 'merge-conflict-resolver', expectedEffort: 'high' },
    { role: 'doc-updater', expectedEffort: 'high' },
    { role: 'gap-closer', expectedEffort: 'high' },
    // Review tier (effort: 'high')
    { role: 'architecture-reviewer', expectedEffort: 'high' },
    { role: 'cohesion-reviewer', expectedEffort: 'high' },
    { role: 'plan-reviewer', expectedEffort: 'high' },
    { role: 'reviewer', expectedEffort: 'high' },
    // Evaluation tier (effort: 'high')
    { role: 'architecture-evaluator', expectedEffort: 'high' },
    { role: 'cohesion-evaluator', expectedEffort: 'high' },
    { role: 'plan-evaluator', expectedEffort: 'high' },
    { role: 'evaluator', expectedEffort: 'high' },
    // Implementation tier (effort: 'medium')
    { role: 'builder', expectedEffort: 'medium' },
    { role: 'review-fixer', expectedEffort: 'medium' },
    { role: 'validation-fixer', expectedEffort: 'medium' },
    { role: 'test-writer', expectedEffort: 'medium' },
    { role: 'tester', expectedEffort: 'medium' },
  ];

  for (const { role, expectedEffort } of effortTable) {
    it(`${role} defaults to effort '${expectedEffort}' with effortSource 'tier'`, () => {
      const config = makeConfig({});
      const result = resolveAgentConfig(role as import('@eforge-build/engine/events').AgentRole, config);
      expect(result.effort).toBe(expectedEffort);
      expect(result.effortSource).toBe('tier');
    });
  }

  it('user per-role effort overrides tier default', () => {
    const config = makeConfig({
      roles: {
        builder: { effort: 'xhigh' },
      },
    });

    const result = resolveAgentConfig('builder', config);
    expect(result.effort).toBe('xhigh');
    expect(result.effortSource).toBe('role');
  });

  it('plan override effort overrides both user config and tier default', () => {
    // reviewer maps to review tier which uses claude-opus-4-7 and supports 'max' effort
    const config = makeConfig({
      roles: {
        reviewer: { effort: 'xhigh' },
      },
    });

    const result = resolveAgentConfig('reviewer', config, {
      agents: { reviewer: { effort: 'max' } },
    });
    expect(result.effort).toBe('max');
    expect(result.effortSource).toBe('plan');
  });
});

// --- Thinking coercion ---

describe('resolveAgentConfig thinking coercion', () => {
  function makeConfig(overrides?: Partial<EforgeConfig['agents']>): EforgeConfig {
    return resolveConfig({
      agents: {
        tiers: {
          planning: { harness: 'claude-sdk' as const, model: 'claude-opus-4-7', effort: 'high' as const },
          implementation: { harness: 'claude-sdk' as const, model: 'claude-sonnet-4-6', effort: 'medium' as const },
          review: { harness: 'claude-sdk' as const, model: 'claude-opus-4-7', effort: 'high' as const },
          evaluation: { harness: 'claude-sdk' as const, model: 'claude-opus-4-7', effort: 'high' as const },
        },
        ...overrides,
      },
    });
  }

  it('coerces enabled thinking to adaptive on Opus 4.7', () => {
    // Use a tier with claude-opus-4-7 and thinking: true → gets coerced to adaptive
    const config = resolveConfig({
      agents: {
        tiers: {
          planning: { harness: 'claude-sdk' as const, model: 'claude-opus-4-7', effort: 'high' as const },
          implementation: { harness: 'claude-sdk' as const, model: 'claude-opus-4-7', effort: 'medium' as const, thinking: true },
          review: { harness: 'claude-sdk' as const, model: 'claude-opus-4-7', effort: 'high' as const },
          evaluation: { harness: 'claude-sdk' as const, model: 'claude-opus-4-7', effort: 'high' as const },
        },
      },
    });

    const result = resolveAgentConfig('builder', config);
    expect(result.thinking).toEqual({ type: 'adaptive' });
    expect(result.thinkingCoerced).toBe(true);
    expect(result.thinkingOriginal).toEqual({ type: 'enabled' });
  });

  it('does not coerce enabled thinking on Opus 4.6', () => {
    const config = resolveConfig({
      agents: {
        tiers: {
          planning: { harness: 'claude-sdk' as const, model: 'claude-opus-4-6', effort: 'high' as const },
          implementation: { harness: 'claude-sdk' as const, model: 'claude-opus-4-6', effort: 'medium' as const, thinking: true },
          review: { harness: 'claude-sdk' as const, model: 'claude-opus-4-6', effort: 'high' as const },
          evaluation: { harness: 'claude-sdk' as const, model: 'claude-opus-4-6', effort: 'high' as const },
        },
      },
    });

    const result = resolveAgentConfig('builder', config);
    expect(result.thinking).toEqual({ type: 'enabled' });
    expect(result.thinkingCoerced).toBeUndefined();
  });

  it('does not coerce adaptive thinking on Opus 4.7 (already the target)', () => {
    // adaptive thinking is represented as false in the tier boolean field;
    // use plan override with explicit adaptive type instead
    const config = makeConfig({});
    const result = resolveAgentConfig('builder', config, {
      agents: { builder: { thinking: { type: 'adaptive' } } },
    });
    expect(result.thinking).toEqual({ type: 'adaptive' });
    expect(result.thinkingCoerced).toBeUndefined();
  });

  it('does not coerce when thinking is undefined regardless of model', () => {
    const config = makeConfig({
      model: { id: 'claude-opus-4-7' },
    });

    const result = resolveAgentConfig('builder', config);
    expect(result.thinking).toBeUndefined();
    expect(result.thinkingCoerced).toBeUndefined();
  });
});

// --- Thinking coercion warning event ---

describe('agent:warning event for thinking coercion', () => {
  it('emits agent:warning with code thinking-coerced when thinkingCoerced is true', async () => {
    const backend = new StubHarness([{ text: 'Done.' }]);

    const events = await collectEvents(backend.run(
      {
        prompt: 'test',
        cwd: '/tmp',
        maxTurns: 1,
        tools: 'none',
        model: { id: 'claude-opus-4-7' },
        thinking: { type: 'adaptive' },
        thinkingCoerced: true,
        thinkingOriginal: { type: 'enabled', budgetTokens: 10000 },
      },
      'builder',
      'plan-1',
    ));

    const warning = findEvent(events, 'agent:warning');
    expect(warning).toBeDefined();
    expect(warning!.code).toBe('thinking-coerced');
    expect(warning!.message).toContain('claude-opus-4-7');
    expect(warning!.message).toContain('adaptive');
    expect(warning!.agentId).toBeDefined();
    expect(warning!.agent).toBe('builder');
    expect(warning!.planId).toBe('plan-1');
  });

  it('does not emit agent:warning when thinkingCoerced is absent', async () => {
    const backend = new StubHarness([{ text: 'Done.' }]);

    const events = await collectEvents(backend.run(
      {
        prompt: 'test',
        cwd: '/tmp',
        maxTurns: 1,
        tools: 'none',
        model: { id: 'claude-opus-4-6' },
        thinking: { type: 'enabled', budgetTokens: 10000 },
      },
      'builder',
      'plan-1',
    ));

    const warning = findEvent(events, 'agent:warning');
    expect(warning).toBeUndefined();
  });

  it('does not emit agent:warning when thinkingCoerced is false', async () => {
    const backend = new StubHarness([{ text: 'Done.' }]);

    const events = await collectEvents(backend.run(
      {
        prompt: 'test',
        cwd: '/tmp',
        maxTurns: 1,
        tools: 'none',
        model: { id: 'claude-opus-4-6' },
        thinkingCoerced: false,
      },
      'builder',
    ));

    const warning = findEvent(events, 'agent:warning');
    expect(warning).toBeUndefined();
  });
});

// --- Retry policy wiring ---
//
// These tests pin the contract between pipeline agent call sites and the
// shared `withRetry` wrapper from `retry.ts`. They do not re-test policy
// internals (covered in `retry.test.ts`), but confirm that the default
// policies are registered for each agent role the pipeline uses.

describe('DEFAULT_RETRY_POLICIES registration (pipeline-facing)', () => {
  it('registers a policy for every agent that previously had inline retry logic', async () => {
    const { DEFAULT_RETRY_POLICIES } = await import('@eforge-build/engine/retry');

    // Roles that formerly had ad-hoc retry loops in pipeline.ts.
    const requiredRoles = [
      'planner',
      'builder',
      'evaluator',
      'plan-evaluator',
      'cohesion-evaluator',
      'architecture-evaluator',
    ] as const;

    for (const role of requiredRoles) {
      const policy = DEFAULT_RETRY_POLICIES[role];
      expect(policy, `policy missing for ${role}`).toBeDefined();
      expect(policy!.retryableSubtypes.has('error_max_turns')).toBe(true);
      expect(policy!.maxAttempts).toBeGreaterThanOrEqual(2);
    }
  });

  it('preserves prior AGENT_MAX_CONTINUATIONS_DEFAULTS semantics (attempts = maxContinuations + 1)', async () => {
    const { DEFAULT_RETRY_POLICIES } = await import('@eforge-build/engine/retry');

    // AGENT_MAX_CONTINUATIONS_DEFAULTS (maxAttempts = maxContinuations + 1):
    //   planner: 2 => 3 attempts
    //   evaluator / plan-evaluator / cohesion-evaluator / architecture-evaluator: 1 => 2 attempts
    expect(DEFAULT_RETRY_POLICIES.planner!.maxAttempts).toBe(3);
    expect(DEFAULT_RETRY_POLICIES.evaluator!.maxAttempts).toBe(2);
    expect(DEFAULT_RETRY_POLICIES['plan-evaluator']!.maxAttempts).toBe(2);
    expect(DEFAULT_RETRY_POLICIES['cohesion-evaluator']!.maxAttempts).toBe(2);
    expect(DEFAULT_RETRY_POLICIES['architecture-evaluator']!.maxAttempts).toBe(2);
  });
});

// --- AgentRuntimeRegistry dual-stub dispatch ---

describe('AgentRuntimeRegistry dual-stub dispatch', () => {
  /**
   * Build a minimal AgentRuntimeRegistry where specific roles map to specific
   * stubs, and a fallback stub is used for all other roles.
   *
   * This helper lets tests verify that stage wiring dispatches the correct
   * harness per role without needing a full config + buildAgentRuntimeRegistry.
   */
  function makeRoleMappedRegistry(
    roleMap: Map<string, AgentHarness>,
    fallback: AgentHarness,
  ): AgentRuntimeRegistry {
    return {
      forRole(role) { return roleMap.get(role) ?? fallback; },
      byName(name) { return roleMap.get(name) ?? fallback; },
      nameForRole(role) { return roleMap.has(role) ? role : 'default'; },
      configured() { return [...roleMap.keys()]; },
    };
  }

  it('dispatches planner role to plannerStub and reviewer to reviewerStub', () => {
    const plannerStub = new StubHarness([]);
    const reviewerStub = new StubHarness([]);

    const registry = makeRoleMappedRegistry(
      new Map<string, AgentHarness>([
        ['planner', plannerStub],
        ['reviewer', reviewerStub],
      ]),
      plannerStub,
    );

    // Each role resolves to its mapped stub
    expect(registry.forRole('planner')).toBe(plannerStub);
    expect(registry.forRole('reviewer')).toBe(reviewerStub);
    // Cross-checks: stubs are distinct
    expect(registry.forRole('planner')).not.toBe(reviewerStub);
    expect(registry.forRole('reviewer')).not.toBe(plannerStub);
  });

  it('two singletonRegistry instances are distinct registries dispatching to their own stub', () => {
    const stubA = new StubHarness([]);
    const stubB = new StubHarness([]);

    const registryA = singletonRegistry(stubA);
    const registryB = singletonRegistry(stubB);

    // Each singleton registry dispatches every role to its own stub
    expect(registryA.forRole('planner')).toBe(stubA);
    expect(registryA.forRole('builder')).toBe(stubA);
    expect(registryB.forRole('planner')).toBe(stubB);
    expect(registryB.forRole('builder')).toBe(stubB);

    // The two registries dispatch to different stubs for the same role
    expect(registryA.forRole('planner')).not.toBe(registryB.forRole('planner'));
    expect(registryA.forRole('builder')).not.toBe(registryB.forRole('builder'));
  });

  it('forRole reference equality holds across multiple calls (consistent dispatch)', () => {
    const builderStub = new StubHarness([]);
    const plannerStub = new StubHarness([]);

    const registry = makeRoleMappedRegistry(
      new Map<string, AgentHarness>([
        ['builder', builderStub],
        ['planner', plannerStub],
      ]),
      builderStub,
    );

    // Same role resolved twice yields the same reference
    expect(registry.forRole('builder')).toBe(registry.forRole('builder'));
    expect(registry.forRole('planner')).toBe(registry.forRole('planner'));
    // Different roles remain distinct
    expect(registry.forRole('builder')).not.toBe(registry.forRole('planner'));
  });

  it('builder and planner stubs do not accumulate calls from each other', async () => {
    const builderStub = new StubHarness([{ text: 'Build done.' }]);
    const plannerStub = new StubHarness([{ text: 'Plan done.' }]);

    const registry = makeRoleMappedRegistry(
      new Map<string, AgentHarness>([
        ['builder', builderStub],
        ['planner', plannerStub],
      ]),
      builderStub,
    );

    const builderBackend = registry.forRole('builder');
    const plannerBackend = registry.forRole('planner');

    // Drive the builder stub via a direct run call
    await collectEvents(builderBackend.run(
      { prompt: 'build something', cwd: '/tmp', maxTurns: 1, tools: 'none' },
      'builder',
    ));

    // Builder stub accumulated one call, planner stub accumulated zero
    expect(builderStub.prompts).toHaveLength(1);
    expect(plannerStub.prompts).toHaveLength(0);

    // Drive the planner stub
    await collectEvents(plannerBackend.run(
      { prompt: 'plan something', cwd: '/tmp', maxTurns: 1, tools: 'none' },
      'planner',
    ));

    expect(plannerStub.prompts).toHaveLength(1);
    expect(builderStub.prompts).toHaveLength(1); // unchanged
  });
});

// --- Parallel Reviewer: verify perspective ---

describe('runParallelReview verify perspective', () => {
  it('accepts verify as an override perspective and dispatches to reviewer-verify prompt', async () => {
    const backend = new StubHarness([{ text: '<review-issues></review-issues>' }]);

    const events = await collectEvents(
      runParallelReview({
        harness: backend,
        planContent: '# Plan\n\n## Verification\n\n- [ ] `pnpm build`',
        baseBranch: 'main',
        planId: 'plan-verify-wiring',
        cwd: '/tmp',
        strategy: 'parallel',
        perspectives: ['verify'],
      }),
    );

    // The stub should have been invoked once (one perspective = one agent call)
    expect(backend.prompts).toHaveLength(1);

    // The prompt should be the reviewer-verify prompt (contains its unique marker text)
    expect(backend.prompts[0]).toContain('verification specialist');

    // Review lifecycle events should be emitted
    expect(findEvent(events, 'plan:build:review:start')).toBeDefined();
    expect(findEvent(events, 'plan:build:review:parallel:start')).toBeDefined();
    expect(findEvent(events, 'plan:build:review:complete')).toBeDefined();

    // The parallel:start event should include the verify perspective
    const parallelStart = findEvent(events, 'plan:build:review:parallel:start');
    expect(parallelStart).toBeDefined();
    expect(parallelStart!.perspectives).toContain('verify');
  });

  it('verify perspective prompt includes review_issue_schema variable with verification-failure category', async () => {
    const backend = new StubHarness([{ text: '<review-issues></review-issues>' }]);

    await collectEvents(
      runParallelReview({
        harness: backend,
        planContent: '# Plan\n\n## Verification\n\n- [ ] `pnpm type-check`',
        baseBranch: 'main',
        planId: 'plan-schema-wiring',
        cwd: '/tmp',
        strategy: 'parallel',
        perspectives: ['verify'],
      }),
    );

    expect(backend.prompts).toHaveLength(1);
    // The schema YAML ({{review_issue_schema}}) should be substituted in the prompt
    // and contain 'verification-failure' as the only allowed category
    expect(backend.prompts[0]).toContain('verification-failure');
  });

  it('verify perspective is registered alongside the five diff-based perspectives', () => {
    // Run with all 6 perspectives and verify the stub gets called 6 times
    // This confirms all 6 entries exist in PERSPECTIVE_PROMPTS and PERSPECTIVE_SCHEMA_YAML
    const backend = new StubHarness([
      { text: '<review-issues></review-issues>' }, // code
      { text: '<review-issues></review-issues>' }, // security
      { text: '<review-issues></review-issues>' }, // api
      { text: '<review-issues></review-issues>' }, // docs
      { text: '<review-issues></review-issues>' }, // test
      { text: '<review-issues></review-issues>' }, // verify
    ]);

    return collectEvents(
      runParallelReview({
        harness: backend,
        planContent: '# Plan\n\n## Verification\n\n- [ ] `pnpm build`',
        baseBranch: 'main',
        planId: 'plan-six-perspectives',
        cwd: '/tmp',
        strategy: 'parallel',
        perspectives: ['code', 'security', 'api', 'docs', 'test', 'verify'],
      }),
    ).then(() => {
      // 6 perspectives = 6 agent calls
      expect(backend.prompts).toHaveLength(6);
    });
  });
});
