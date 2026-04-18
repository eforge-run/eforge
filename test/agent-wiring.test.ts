import { describe, it, expect } from 'vitest';
import type { EforgeEvent } from '@eforge-build/engine/events';
import { StubBackend } from './stub-backend.js';
import { collectEvents, findEvent, filterEvents } from './test-events.js';
import { useTempDir } from './test-tmpdir.js';
import { runPlanner } from '@eforge-build/engine/agents/planner';
import { runReview } from '@eforge-build/engine/agents/reviewer';
import { builderImplement, builderEvaluate } from '@eforge-build/engine/agents/builder';
import { runPlanReview } from '@eforge-build/engine/agents/plan-reviewer';
import { runPlanEvaluate } from '@eforge-build/engine/agents/plan-evaluator';
import { runArchitectureEvaluate } from '@eforge-build/engine/agents/plan-evaluator';
import { runModulePlanner } from '@eforge-build/engine/agents/module-planner';
import { runArchitectureReview } from '@eforge-build/engine/agents/architecture-reviewer';
import { runPrdValidator } from '@eforge-build/engine/agents/prd-validator';
import { validatePipeline, formatStageRegistry, getCompileStageNames, getBuildStageNames, getCompileStageDescriptors, getBuildStageDescriptors, resolveAgentConfig, AGENT_ROLE_DEFAULTS } from '@eforge-build/engine/pipeline';
import { DEFAULT_CONFIG, resolveConfig } from '@eforge-build/engine/config';
import type { EforgeConfig } from '@eforge-build/engine/config';

// --- Planner ---

describe('runPlanner wiring', () => {
  const makeTempDir = useTempDir('eforge-planner-test-');

  it('emits plan lifecycle events for a basic run', async () => {
    const backend = new StubBackend([{ text: 'Planning done.' }]);
    const cwd = makeTempDir();

    const events = await collectEvents(runPlanner('Build a widget', {
      backend,
      cwd,
    }));

    expect(findEvent(events, 'plan:start')).toBeDefined();
    // When neither submission tool nor <skip> fires, planner emits plan:error
    const error = findEvent(events, 'plan:error');
    expect(error).toBeDefined();
    expect(error!.reason).toContain('submit_plan_set');
    expect(findEvent(events, 'plan:complete')).toBeUndefined();
    // agent:result should be yielded (always yielded regardless of verbose)
    expect(findEvent(events, 'agent:result')).toBeDefined();
  });

  it('emits plan:skip when agent output contains a skip block', async () => {
    const backend = new StubBackend([{
      text: '<skip>Already implemented in a previous PR.</skip>',
    }]);
    const cwd = makeTempDir();

    const events = await collectEvents(runPlanner('Fix a bug', {
      backend,
      cwd,
    }));

    const skip = findEvent(events, 'plan:skip');
    expect(skip).toBeDefined();
    expect(skip!.reason).toBe('Already implemented in a previous PR.');

    // Skip should short-circuit — no plan:complete or plan scanning
    expect(findEvent(events, 'plan:complete')).toBeUndefined();
    const progressEvents = filterEvents(events, 'plan:progress');
    expect(progressEvents.every(e => e.message !== 'Scanning plan files...')).toBe(true);
  });

  it('triggers clarification callback and restarts with answers', async () => {
    const backend = new StubBackend([
      // First run: agent asks a clarification question
      { text: '<clarification><question id="q1">Which database?</question></clarification>' },
      // Second run: agent produces final output (answers baked into prompt)
      { text: 'Planning with Postgres.' },
    ]);
    const cwd = makeTempDir();

    const clarificationCalls: Array<{ id: string; question: string }[]> = [];
    const events = await collectEvents(runPlanner('Add a feature', {
      backend,
      cwd,
      onClarification: async (questions) => {
        clarificationCalls.push(questions);
        return { q1: 'Postgres' };
      },
    }));

    // Callback was invoked
    expect(clarificationCalls).toHaveLength(1);
    expect(clarificationCalls[0][0].id).toBe('q1');

    // Clarification events emitted
    expect(findEvent(events, 'plan:clarification')).toBeDefined();
    expect(findEvent(events, 'plan:clarification:answer')).toBeDefined();

    // Backend was called twice (first run + restart)
    expect(backend.prompts).toHaveLength(2);
    // Second prompt should contain the clarification answers
    expect(backend.prompts[1]).toContain('Postgres');
    expect(backend.prompts[1]).toContain('Prior Clarifications');
  });

  it('handles multiple clarification rounds', async () => {
    const backend = new StubBackend([
      { text: '<clarification><question id="q1">Database?</question></clarification>' },
      { text: '<clarification><question id="q2">ORM?</question></clarification>' },
      { text: 'Final plan.' },
    ]);
    const cwd = makeTempDir();

    const events = await collectEvents(runPlanner('Add feature', {
      backend,
      cwd,
      onClarification: async (questions) => {
        const id = questions[0].id;
        return { [id]: id === 'q1' ? 'Postgres' : 'Drizzle' };
      },
    }));

    expect(backend.prompts).toHaveLength(3);
    // Third prompt should contain both prior answers
    expect(backend.prompts[2]).toContain('Postgres');
    expect(backend.prompts[2]).toContain('Drizzle');

    const clarifications = filterEvents(events, 'plan:clarification');
    expect(clarifications).toHaveLength(2);
  });

  it('stops after max iterations', async () => {
    // Provide 6 clarification responses (max is 5)
    const responses = Array.from({ length: 6 }, () => ({
      text: '<clarification><question id="q1">Again?</question></clarification>',
    }));
    const backend = new StubBackend(responses);
    const cwd = makeTempDir();

    const events = await collectEvents(runPlanner('Loop forever', {
      backend,
      cwd,
      onClarification: async () => ({ q1: 'yes' }),
    }));

    // Should stop at 5 iterations, not use the 6th response
    expect(backend.prompts).toHaveLength(5);
    // After max iterations without submission or skip, planner emits plan:error
    expect(findEvent(events, 'plan:error')).toBeDefined();
  });

  it('skips clarification in auto mode', async () => {
    const backend = new StubBackend([{
      text: '<clarification><question id="q1">Database?</question></clarification> Done.',
    }]);
    const cwd = makeTempDir();

    let callbackCalled = false;
    const events = await collectEvents(runPlanner('Auto plan', {
      backend,
      cwd,
      auto: true,
      onClarification: async () => {
        callbackCalled = true;
        return {};
      },
    }));

    expect(callbackCalled).toBe(false);
    // No restart — only one backend call
    expect(backend.prompts).toHaveLength(1);
    // After auto mode skips clarification without submission, planner emits plan:error
    expect(findEvent(events, 'plan:error')).toBeDefined();
  });

  it('suppresses agent:message when verbose is false, emits when true', async () => {
    const makeBackend = () => new StubBackend([{ text: 'Some output.' }]);
    const cwd = makeTempDir();

    // verbose=false (default): agent:message should be suppressed
    const quietEvents = await collectEvents(runPlanner('Test', { backend: makeBackend(), cwd }));
    expect(filterEvents(quietEvents, 'agent:message')).toHaveLength(0);

    // verbose=true: agent:message should be emitted
    const cwd2 = makeTempDir();
    const verboseEvents = await collectEvents(runPlanner('Test', { backend: makeBackend(), cwd: cwd2, verbose: true }));
    expect(filterEvents(verboseEvents, 'agent:message').length).toBeGreaterThan(0);
  });

  it('writes plans via submission tool and yields plan:complete', async () => {
    const cwd = makeTempDir();

    const backend = new StubBackend([{
      toolCalls: [{
        tool: 'mcp__eforge__submit_plan_set',
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
      backend,
      cwd,
      name: 'my-plan',
      scope: 'excursion',
    }));

    const complete = findEvent(events, 'plan:complete');
    expect(complete).toBeDefined();
    expect(complete!.plans).toHaveLength(1);
    expect(complete!.plans[0].id).toBe('feature');
    expect(complete!.plans[0].name).toBe('Add feature');
  });
});

// --- Reviewer ---

describe('runReview wiring', () => {
  it('parses review issues from agent output', async () => {
    const backend = new StubBackend([{
      text: `<review-issues>
  <issue severity="critical" category="bug" file="src/a.ts" line="42">Memory leak in handler</issue>
  <issue severity="warning" category="perf" file="src/b.ts">Slow query<fix>Add index</fix></issue>
</review-issues>`,
    }]);

    const events = await collectEvents(runReview({
      backend,
      planContent: 'test plan',
      baseBranch: 'main',
      planId: 'plan-1',
      cwd: '/tmp',
    }));

    expect(findEvent(events, 'build:review:start')).toBeDefined();

    const complete = findEvent(events, 'build:review:complete');
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
    const backend = new StubBackend([{ text: 'Code looks good. No issues found.' }]);

    const events = await collectEvents(runReview({
      backend,
      planContent: 'test plan',
      baseBranch: 'main',
      planId: 'plan-1',
      cwd: '/tmp',
    }));

    const complete = findEvent(events, 'build:review:complete');
    expect(complete).toBeDefined();
    expect(complete!.issues).toHaveLength(0);
  });
});

// --- Builder ---

describe('builderImplement wiring', () => {
  it('emits implement lifecycle events on success', async () => {
    const backend = new StubBackend([{ text: 'Implementation done.' }]);

    const events = await collectEvents(builderImplement(
      { id: 'plan-1', name: 'Feature', dependsOn: [], branch: 'feature/x', body: 'content', filePath: '/tmp/plan.md' },
      { backend, cwd: '/tmp' },
    ));

    expect(findEvent(events, 'build:implement:start')).toBeDefined();
    expect(findEvent(events, 'build:implement:complete')).toBeDefined();
    expect(findEvent(events, 'build:failed')).toBeUndefined();
  });

  it('emits build:failed when backend throws', async () => {
    const backend = new StubBackend([{ error: new Error('Agent timeout') }]);

    const events = await collectEvents(builderImplement(
      { id: 'plan-1', name: 'Feature', dependsOn: [], branch: 'feature/x', body: 'content', filePath: '/tmp/plan.md' },
      { backend, cwd: '/tmp' },
    ));

    const failed = findEvent(events, 'build:failed');
    expect(failed).toBeDefined();
    expect(failed!.error).toContain('Agent timeout');
    // Should NOT emit implement:complete on failure
    expect(findEvent(events, 'build:implement:complete')).toBeUndefined();
  });
});

describe('builderEvaluate wiring', () => {
  it('counts verdicts correctly', async () => {
    const backend = new StubBackend([{
      text: `<evaluation>
  <verdict file="a.ts" action="accept">Good change</verdict>
  <verdict file="b.ts" action="accept">Also good</verdict>
  <verdict file="c.ts" action="reject">Unnecessary</verdict>
  <verdict file="d.ts" action="review">Needs discussion</verdict>
</evaluation>`,
    }]);

    const events = await collectEvents(builderEvaluate(
      { id: 'plan-1', name: 'Feature', dependsOn: [], branch: 'feature/x', body: 'content', filePath: '/tmp/plan.md' },
      { backend, cwd: '/tmp' },
    ));

    const complete = findEvent(events, 'build:evaluate:complete');
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
    const backend = new StubBackend([{ error: new Error('Evaluate failed') }]);

    const events = await collectEvents(builderEvaluate(
      { id: 'plan-1', name: 'Feature', dependsOn: [], branch: 'feature/x', body: 'content', filePath: '/tmp/plan.md' },
      { backend, cwd: '/tmp' },
    ));

    expect(findEvent(events, 'build:failed')).toBeDefined();
    expect(findEvent(events, 'build:evaluate:complete')).toBeUndefined();
  });
});

// --- Plan Reviewer ---

describe('runPlanReview wiring', () => {
  it('parses review issues from plan review output', async () => {
    const backend = new StubBackend([{
      text: `<review-issues>
  <issue severity="warning" category="scope" file="plans/feature.md">Missing edge case</issue>
</review-issues>`,
    }]);

    const events = await collectEvents(runPlanReview({
      backend,
      sourceContent: 'PRD content',
      planSetName: 'my-plan',
      cwd: '/tmp',
    }));

    expect(findEvent(events, 'plan:review:start')).toBeDefined();
    const complete = findEvent(events, 'plan:review:complete');
    expect(complete).toBeDefined();
    expect(complete!.issues).toHaveLength(1);
    expect(complete!.issues[0].category).toBe('scope');
  });
});

// --- Plan Evaluator ---

describe('runPlanEvaluate wiring', () => {
  it('counts evaluation verdicts', async () => {
    const backend = new StubBackend([{
      text: `<evaluation>
  <verdict file="plans/a.md" action="accept">Good fix</verdict>
  <verdict file="plans/b.md" action="reject">Over-scoped</verdict>
</evaluation>`,
    }]);

    const events = await collectEvents(runPlanEvaluate({
      backend,
      planSetName: 'my-plan',
      sourceContent: 'PRD content',
      cwd: '/tmp',
    }));

    expect(findEvent(events, 'plan:evaluate:start')).toBeDefined();
    const complete = findEvent(events, 'plan:evaluate:complete');
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
    const backend = new StubBackend([{ error: new Error('Evaluate crash') }]);

    let thrown: Error | undefined;
    const events: EforgeEvent[] = [];
    try {
      for await (const event of runPlanEvaluate({
        backend,
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

    const complete = findEvent(events, 'plan:evaluate:complete');
    expect(complete).toBeDefined();
    expect(complete!.accepted).toBe(0);
    expect(complete!.rejected).toBe(0);
  });
});

// --- Module Planner ---

describe('runModulePlanner wiring', () => {
  it('emits expedition module lifecycle events', async () => {
    const backend = new StubBackend([{ text: 'Module plan written.' }]);

    const events = await collectEvents(runModulePlanner({
      backend,
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
    const backend = new StubBackend([{ text: 'Module details.' }]);

    const events = await collectEvents(runModulePlanner({
      backend,
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
    const backend = new StubBackend([{ text: 'Module details.' }]);

    const events = await collectEvents(runModulePlanner({
      backend,
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
    const backend = new StubBackend([{ text: 'Module plan written.' }]);
    const depContent = '# Foundation\n\nCreates auth tables and user model.';

    await collectEvents(runModulePlanner({
      backend,
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
    const backend = new StubBackend([{ text: 'Module plan written.' }]);

    await collectEvents(runModulePlanner({
      backend,
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
    const backend = new StubBackend([{ text: 'Module plan written.' }]);

    await collectEvents(runModulePlanner({
      backend,
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
    const backend = new StubBackend([{
      text: `<review-issues>
  <issue severity="warning" category="completeness" file="plans/my-plan/architecture.md">Missing integration contract between auth and api modules</issue>
</review-issues>`,
    }]);

    const events = await collectEvents(runArchitectureReview({
      backend,
      sourceContent: 'PRD content',
      planSetName: 'my-plan',
      architectureContent: '# Architecture\nModules: auth, api',
      cwd: '/tmp',
    }));

    expect(findEvent(events, 'plan:architecture:review:start')).toBeDefined();
    const complete = findEvent(events, 'plan:architecture:review:complete');
    expect(complete).toBeDefined();
    expect(complete!.issues).toHaveLength(1);
    expect(complete!.issues[0].category).toBe('completeness');
    expect(complete!.issues[0].severity).toBe('warning');
  });

  it('yields empty issues for clean architecture', async () => {
    const backend = new StubBackend([{
      text: 'Architecture looks solid. <review-issues></review-issues>',
    }]);

    const events = await collectEvents(runArchitectureReview({
      backend,
      sourceContent: 'PRD content',
      planSetName: 'my-plan',
      architectureContent: '# Architecture\nWell defined.',
      cwd: '/tmp',
    }));

    const complete = findEvent(events, 'plan:architecture:review:complete');
    expect(complete).toBeDefined();
    expect(complete!.issues).toHaveLength(0);
  });
});

// --- Architecture Evaluator ---

describe('runArchitectureEvaluate wiring', () => {
  it('counts evaluation verdicts correctly', async () => {
    const backend = new StubBackend([{
      text: `<evaluation>
  <verdict file="plans/my-plan/architecture.md" action="accept">Good clarification</verdict>
  <verdict file="plans/my-plan/architecture.md" action="reject">Changes module decomposition</verdict>
  <verdict file="plans/my-plan/architecture.md" action="accept">Missing contract added</verdict>
</evaluation>`,
    }]);

    const events = await collectEvents(runArchitectureEvaluate({
      backend,
      planSetName: 'my-plan',
      sourceContent: 'PRD content',
      cwd: '/tmp',
    }));

    expect(findEvent(events, 'plan:architecture:evaluate:start')).toBeDefined();
    const complete = findEvent(events, 'plan:architecture:evaluate:complete');
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
    const backend = new StubBackend([{ error: new Error('Architecture evaluate crash') }]);

    let thrown: Error | undefined;
    const events: EforgeEvent[] = [];
    try {
      for await (const event of runArchitectureEvaluate({
        backend,
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

    const complete = findEvent(events, 'plan:architecture:evaluate:complete');
    expect(complete).toBeDefined();
    expect(complete!.accepted).toBe(0);
    expect(complete!.rejected).toBe(0);
  });
});

// --- PRD Validator ---

describe('runPrdValidator wiring', () => {
  it('emits prd_validation:start and prd_validation:complete with no gaps when agent finds none', async () => {
    const backend = new StubBackend([{
      text: '```json\n{ "gaps": [] }\n```',
    }]);

    const events = await collectEvents(runPrdValidator({
      backend,
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
    const backend = new StubBackend([{
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
      backend,
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
    const backend = new StubBackend([{ error: new Error('Agent crashed') }]);

    // Fail-closed: a crashed validator must not silently certify a build.
    await expect(async () => {
      for await (const _event of runPrdValidator({
        backend,
        cwd: '/tmp',
        prdContent: 'PRD content',
        diff: 'some diff',
      })) {
        // drain
      }
    }).rejects.toThrow('Agent crashed');
  });

  it('yields agent:result event (always yielded)', async () => {
    const backend = new StubBackend([{
      text: '```json\n{ "gaps": [] }\n```',
    }]);

    const events = await collectEvents(runPrdValidator({
      backend,
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

    const result = resolveAgentConfig('builder', config, 'claude-sdk', {
      agents: { builder: { effort: 'xhigh' } },
    });

    expect(result.effort).toBe('xhigh');
    expect(result.effortSource).toBe('planner');
  });

  it('missing planEntry falls back to current behavior', () => {
    const config = makeConfig({
      roles: {
        builder: { effort: 'high' },
      },
    });

    const resultWithPlan = resolveAgentConfig('builder', config, 'claude-sdk');
    const resultWithoutPlan = resolveAgentConfig('builder', config, 'claude-sdk', undefined);

    expect(resultWithPlan.effort).toBe(resultWithoutPlan.effort);
    expect(resultWithPlan.effortSource).toBe('role-config');
  });

  it('xhigh and max effort levels flow through on capable models', () => {
    const config = makeConfig({
      model: { id: 'claude-opus-4-7' },
    });

    const resultXhigh = resolveAgentConfig('builder', config, 'claude-sdk', {
      agents: { builder: { effort: 'xhigh' } },
    });
    expect(resultXhigh.effort).toBe('xhigh');
    expect(resultXhigh.effortClamped).toBe(false);

    const resultMax = resolveAgentConfig('builder', config, 'claude-sdk', {
      agents: { builder: { effort: 'max' } },
    });
    expect(resultMax.effort).toBe('max');
    expect(resultMax.effortClamped).toBe(false);
  });

  it('clamping reflects in resolved config for Sonnet model with max effort', () => {
    const config = makeConfig({
      model: { id: 'claude-sonnet-4-0' },
    });

    const result = resolveAgentConfig('builder', config, 'claude-sdk', {
      agents: { builder: { effort: 'max' } },
    });

    expect(result.effort).toBe('xhigh');
    expect(result.effortClamped).toBe(true);
    expect(result.effortOriginal).toBe('max');
    expect(result.effortSource).toBe('planner');
  });

  it('planEntry thinking override wins over per-role config', () => {
    const config = makeConfig({
      model: { id: 'claude-opus-4-6' },
      roles: {
        builder: { thinking: { type: 'disabled' } },
      },
    });

    const result = resolveAgentConfig('builder', config, 'claude-sdk', {
      agents: { builder: { thinking: { type: 'enabled', budgetTokens: 5000 } } },
    });

    expect(result.thinking).toEqual({ type: 'enabled', budgetTokens: 5000 });
  });

  it('effortSource is global-config when effort comes from global config', () => {
    const config = makeConfig({
      effort: 'medium',
    });

    const result = resolveAgentConfig('builder', config, 'claude-sdk');

    expect(result.effort).toBe('medium');
    expect(result.effortSource).toBe('global-config');
  });

  it('effortSource and thinkingSource are default when no effort/thinking is configured', () => {
    const config = makeConfig({});
    const result = resolveAgentConfig('builder', config, 'claude-sdk');
    // Builder now has a per-role effort default of 'high'
    expect(result.effort).toBe('high');
    expect(result.effortSource).toBe('default');
    expect(result.thinking).toBeUndefined();
    expect(result.thinkingSource).toBe('default');
  });

  it('thinkingSource tracks planner provenance', () => {
    const config = makeConfig({
      model: { id: 'claude-opus-4-6' },
      roles: {
        builder: { thinking: { type: 'disabled' } },
      },
    });

    const result = resolveAgentConfig('builder', config, 'claude-sdk', {
      agents: { builder: { thinking: { type: 'enabled', budgetTokens: 5000 } } },
    });

    expect(result.thinking).toEqual({ type: 'enabled', budgetTokens: 5000 });
    expect(result.thinkingSource).toBe('planner');
  });

  it('thinkingSource tracks role-config provenance', () => {
    const config = makeConfig({
      model: { id: 'claude-opus-4-6' },
      roles: {
        builder: { thinking: { type: 'enabled', budgetTokens: 3000 } },
      },
    });

    const result = resolveAgentConfig('builder', config, 'claude-sdk');

    expect(result.thinking).toEqual({ type: 'enabled', budgetTokens: 3000 });
    expect(result.thinkingSource).toBe('role-config');
  });

  it('thinkingSource tracks global-config provenance', () => {
    const config = makeConfig({
      model: { id: 'claude-opus-4-6' },
      thinking: { type: 'enabled', budgetTokens: 8000 },
    });

    const result = resolveAgentConfig('builder', config, 'claude-sdk');

    expect(result.thinking).toEqual({ type: 'enabled', budgetTokens: 8000 });
    expect(result.thinkingSource).toBe('global-config');
  });

  it('effortSource is always stamped even when effort is set', () => {
    const config = makeConfig({
      effort: 'medium',
    });

    const result = resolveAgentConfig('builder', config, 'claude-sdk');

    expect(result.effort).toBe('medium');
    expect(result.effortSource).toBe('global-config');
    expect(result.thinkingSource).toBe('default');
  });
});

// --- Per-role effort defaults ---

describe('resolveAgentConfig per-role effort defaults', () => {
  function makeConfig(overrides?: Partial<EforgeConfig['agents']>): EforgeConfig {
    return resolveConfig({
      agents: {
        ...overrides,
      },
    });
  }

  const effortTable: Array<{ role: string; expectedEffort: string }> = [
    { role: 'planner', expectedEffort: 'high' },
    { role: 'builder', expectedEffort: 'high' },
    { role: 'module-planner', expectedEffort: 'high' },
    { role: 'architecture-reviewer', expectedEffort: 'high' },
    { role: 'architecture-evaluator', expectedEffort: 'high' },
    { role: 'cohesion-reviewer', expectedEffort: 'high' },
    { role: 'cohesion-evaluator', expectedEffort: 'high' },
    { role: 'plan-reviewer', expectedEffort: 'high' },
    { role: 'plan-evaluator', expectedEffort: 'high' },
    { role: 'reviewer', expectedEffort: 'high' },
    { role: 'evaluator', expectedEffort: 'high' },
    { role: 'review-fixer', expectedEffort: 'medium' },
    { role: 'validation-fixer', expectedEffort: 'medium' },
    { role: 'merge-conflict-resolver', expectedEffort: 'medium' },
    { role: 'doc-updater', expectedEffort: 'medium' },
    { role: 'test-writer', expectedEffort: 'medium' },
    { role: 'tester', expectedEffort: 'medium' },
    { role: 'gap-closer', expectedEffort: 'medium' },
  ];

  for (const { role, expectedEffort } of effortTable) {
    it(`${role} defaults to effort '${expectedEffort}' with effortSource 'default'`, () => {
      const config = makeConfig({});
      const result = resolveAgentConfig(role as import('@eforge-build/engine/events').AgentRole, config, 'claude-sdk');
      expect(result.effort).toBe(expectedEffort);
      expect(result.effortSource).toBe('default');
    });
  }

  it('user per-role effort overrides built-in default', () => {
    const config = makeConfig({
      roles: {
        builder: { effort: 'xhigh' },
      },
    });

    const result = resolveAgentConfig('builder', config, 'claude-sdk');
    expect(result.effort).toBe('xhigh');
    expect(result.effortSource).toBe('role-config');
  });

  it('plan override effort overrides both user config and built-in default', () => {
    const config = makeConfig({
      roles: {
        builder: { effort: 'xhigh' },
      },
    });

    const result = resolveAgentConfig('builder', config, 'claude-sdk', {
      agents: { builder: { effort: 'max' } },
    });
    expect(result.effort).toBe('max');
    expect(result.effortSource).toBe('planner');
  });
});

// --- Thinking coercion ---

describe('resolveAgentConfig thinking coercion', () => {
  function makeConfig(overrides?: Partial<EforgeConfig['agents']>): EforgeConfig {
    return resolveConfig({
      agents: {
        ...overrides,
      },
    });
  }

  it('coerces enabled thinking to adaptive on Opus 4.7', () => {
    const config = makeConfig({
      model: { id: 'claude-opus-4-7' },
      thinking: { type: 'enabled', budgetTokens: 10000 },
    });

    const result = resolveAgentConfig('builder', config, 'claude-sdk');
    expect(result.thinking).toEqual({ type: 'adaptive' });
    expect(result.thinkingCoerced).toBe(true);
    expect(result.thinkingOriginal).toEqual({ type: 'enabled', budgetTokens: 10000 });
  });

  it('does not coerce enabled thinking on Opus 4.6', () => {
    const config = makeConfig({
      model: { id: 'claude-opus-4-6' },
      thinking: { type: 'enabled' },
    });

    const result = resolveAgentConfig('builder', config, 'claude-sdk');
    expect(result.thinking).toEqual({ type: 'enabled' });
    expect(result.thinkingCoerced).toBeUndefined();
  });

  it('does not coerce adaptive thinking on Opus 4.7 (already the target)', () => {
    const config = makeConfig({
      model: { id: 'claude-opus-4-7' },
      thinking: { type: 'adaptive' },
    });

    const result = resolveAgentConfig('builder', config, 'claude-sdk');
    expect(result.thinking).toEqual({ type: 'adaptive' });
    expect(result.thinkingCoerced).toBeUndefined();
  });

  it('does not coerce when thinking is undefined regardless of model', () => {
    const config = makeConfig({
      model: { id: 'claude-opus-4-7' },
    });

    const result = resolveAgentConfig('builder', config, 'claude-sdk');
    expect(result.thinking).toBeUndefined();
    expect(result.thinkingCoerced).toBeUndefined();
  });
});

// --- Thinking coercion warning event ---

describe('agent:warning event for thinking coercion', () => {
  it('emits agent:warning with code thinking-coerced when thinkingCoerced is true', async () => {
    const backend = new StubBackend([{ text: 'Done.' }]);

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
    const backend = new StubBackend([{ text: 'Done.' }]);

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
    const backend = new StubBackend([{ text: 'Done.' }]);

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
