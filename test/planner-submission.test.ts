import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { EforgeEvent } from '@eforge-build/engine/events';
import type { PlanSetSubmission, ArchitectureSubmission } from '@eforge-build/engine/schemas';
import { PlannerSubmissionError } from '@eforge-build/engine/backend';
import { StubBackend } from './stub-backend.js';
import { collectEvents } from './test-events.js';
import { useTempDir } from './test-tmpdir.js';
import { runPlanner } from '@eforge-build/engine/agents/planner';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validPlanSetPayload(): PlanSetSubmission {
  return {
    name: 'test-plan',
    description: 'A test plan set',
    mode: 'excursion',
    baseBranch: 'main',
    plans: [
      {
        frontmatter: {
          id: 'plan-01-widgets',
          name: 'Widget Feature',
          dependsOn: [],
          branch: 'test-plan/widgets',
        },
        body: '# Widget Feature\n\n## Implementation\n\nAdd widget support.',
      },
    ],
    orchestration: {
      validate: [],
      plans: [
        {
          id: 'plan-01-widgets',
          name: 'Widget Feature',
          dependsOn: [],
          branch: 'test-plan/widgets',
        },
      ],
    },
  };
}

function validArchitecturePayload(): ArchitectureSubmission {
  return {
    architecture: '# Architecture\n\n## Vision\n\nBuild a modular system.',
    modules: [
      { id: 'foundation', description: 'Core types and utilities', dependsOn: [] },
      { id: 'auth', description: 'Authentication system', dependsOn: ['foundation'] },
    ],
    index: {
      name: 'build-modular-system',
      description: 'A modular system',
      mode: 'expedition',
      validate: [],
      modules: {
        'foundation': { description: 'Core types and utilities', depends_on: [] },
        'auth': { description: 'Authentication system', depends_on: ['foundation'] },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Planner submission tool: plan set', () => {
  const makeTempDir = useTempDir('eforge-planner-submission-test-');

  it('writes plan files via writePlanSet and yields plan:complete when submit_plan_set is called', async () => {
    const payload = validPlanSetPayload();
    const backend = new StubBackend([{
      toolCalls: [{
        tool: 'submit_plan_set',
        toolUseId: 'tu-1',
        input: payload,
        output: '',
      }],
      text: 'Plans submitted.',
    }]);
    const cwd = makeTempDir();

    const events = await collectEvents(runPlanner('Build widgets', {
      backend,
      cwd,
      auto: true,
      scope: 'excursion',
    }));

    // Should yield plan:submission event
    const submissionEvents = events.filter(e => e.type === 'planning:submission');
    expect(submissionEvents).toHaveLength(1);
    const submission = submissionEvents[0] as EforgeEvent & { type: 'planning:submission' };
    expect(submission.planCount).toBe(1);
    expect(submission.hasMigrations).toBe(false);

    // Should yield plan:complete
    const completeEvents = events.filter(e => e.type === 'planning:complete');
    expect(completeEvents).toHaveLength(1);
    const complete = completeEvents[0] as EforgeEvent & { type: 'planning:complete' };
    expect(complete.plans).toHaveLength(1);
    expect(complete.plans[0].id).toBe('plan-01-widgets');
    expect(complete.plans[0].name).toBe('Widget Feature');

    // Verify plan file was written with YAML frontmatter
    const planPath = resolve(cwd, 'eforge/plans/build-widgets/plan-01-widgets.md');
    const content = await readFile(planPath, 'utf-8');
    expect(content).toContain('id: plan-01-widgets');
    expect(content).toContain('name: Widget Feature');
    expect(content).toContain('depends_on: []');
    expect(content).toContain('branch: test-plan/widgets');
    expect(content).toContain('# Widget Feature');

    // Should have passed customTools to the backend
    expect(backend.customToolSets).toHaveLength(1);
    const tools = backend.customToolSets[0];
    expect(tools).toBeDefined();
    expect(tools!.some(t => t.name === 'submit_plan_set')).toBe(true);
  });
});

describe('Planner submission tool: no submission and no skip', () => {
  const makeTempDir = useTempDir('eforge-planner-no-submission-test-');

  it('throws PlannerSubmissionError when neither submission nor skip occurs', async () => {
    const backend = new StubBackend([{ text: 'I generated some plans.' }]);
    const cwd = makeTempDir();

    await expect(collectEvents(runPlanner('Build widgets', {
      backend,
      cwd,
      auto: true,
      scope: 'excursion',
    }))).rejects.toThrow(PlannerSubmissionError);

    await expect(collectEvents(runPlanner('Build widgets', {
      backend: new StubBackend([{ text: 'I generated some plans.' }]),
      cwd: makeTempDir(),
      auto: true,
      scope: 'excursion',
    }))).rejects.toThrow('submit_plan_set');
  });
});

describe('Planner submission tool: skip behavior preserved', () => {
  const makeTempDir = useTempDir('eforge-planner-skip-test-');

  it('yields plan:skip when <skip> XML block is present', async () => {
    const backend = new StubBackend([{
      text: '<skip>All requirements are already implemented.</skip>',
    }]);
    const cwd = makeTempDir();

    const events = await collectEvents(runPlanner('Build widgets', {
      backend,
      cwd,
      auto: true,
      scope: 'excursion',
    }));

    const skipEvents = events.filter(e => e.type === 'planning:skip');
    expect(skipEvents).toHaveLength(1);
    const skip = skipEvents[0] as EforgeEvent & { type: 'planning:skip' };
    expect(skip.reason).toContain('already implemented');

    // Should NOT yield plan:error or plan:complete
    expect(events.filter(e => e.type === 'planning:error')).toHaveLength(0);
    expect(events.filter(e => e.type === 'planning:complete')).toHaveLength(0);
  });
});

describe('Planner submission tool: architecture', () => {
  const makeTempDir = useTempDir('eforge-planner-arch-submission-test-');

  it('writes architecture files and yields expedition events when submit_architecture is called', async () => {
    const payload = validArchitecturePayload();
    const backend = new StubBackend([{
      toolCalls: [{
        tool: 'submit_architecture',
        toolUseId: 'tu-1',
        input: payload,
        output: '',
      }],
      text: 'Architecture submitted.',
    }]);
    const cwd = makeTempDir();

    const events = await collectEvents(runPlanner('Build modular system', {
      backend,
      cwd,
      auto: true,
      scope: 'expedition',
    }));

    // Should yield plan:submission event
    const submissionEvents = events.filter(e => e.type === 'planning:submission');
    expect(submissionEvents).toHaveLength(1);
    const submission = submissionEvents[0] as EforgeEvent & { type: 'planning:submission' };
    expect(submission.planCount).toBe(2); // 2 modules
    expect(submission.hasMigrations).toBe(false);

    // Should yield expedition:architecture:complete
    const archEvents = events.filter(e => e.type === 'expedition:architecture:complete');
    expect(archEvents).toHaveLength(1);
    const archComplete = archEvents[0] as EforgeEvent & { type: 'expedition:architecture:complete' };
    expect(archComplete.modules).toHaveLength(2);
    expect(archComplete.modules[0].id).toBe('foundation');
    expect(archComplete.modules[1].id).toBe('auth');

    // Verify architecture.md was written
    const archPath = resolve(cwd, 'eforge/plans/build-modular-system/architecture.md');
    const archContent = await readFile(archPath, 'utf-8');
    expect(archContent).toContain('# Architecture');

    // Verify index.yaml was written
    const indexPath = resolve(cwd, 'eforge/plans/build-modular-system/index.yaml');
    const indexContent = await readFile(indexPath, 'utf-8');
    expect(indexContent).toContain('foundation');
    expect(indexContent).toContain('auth');

    // Should have passed customTools with submit_architecture
    expect(backend.customToolSets).toHaveLength(1);
    const tools = backend.customToolSets[0];
    expect(tools).toBeDefined();
    expect(tools!.some(t => t.name === 'submit_architecture')).toBe(true);
  });
});

describe('Planner submission tool: plan:submission event metadata', () => {
  const makeTempDir = useTempDir('eforge-planner-submission-meta-test-');

  it('yields plan:submission with correct planCount and body size', async () => {
    const payload = validPlanSetPayload();
    // Add a second plan
    payload.plans.push({
      frontmatter: {
        id: 'plan-02-gadgets',
        name: 'Gadget Feature',
        dependsOn: ['plan-01-widgets'],
        branch: 'test-plan/gadgets',
        migrations: [{ timestamp: '20260415120000', description: 'Add gadgets table' }],
      },
      body: '# Gadget Feature\n\nAdd gadget support.',
    });
    payload.orchestration.plans.push({
      id: 'plan-02-gadgets',
      name: 'Gadget Feature',
      dependsOn: ['plan-01-widgets'],
      branch: 'test-plan/gadgets',
    });

    const backend = new StubBackend([{
      toolCalls: [{
        tool: 'submit_plan_set',
        toolUseId: 'tu-1',
        input: payload,
        output: '',
      }],
    }]);
    const cwd = makeTempDir();

    const events = await collectEvents(runPlanner('Build widgets', {
      backend,
      cwd,
      auto: true,
      scope: 'excursion',
    }));

    const submissionEvents = events.filter(e => e.type === 'planning:submission');
    expect(submissionEvents).toHaveLength(1);
    const submission = submissionEvents[0] as EforgeEvent & { type: 'planning:submission' };
    expect(submission.planCount).toBe(2);
    expect(submission.totalBodySize).toBe(
      payload.plans[0].body.length + payload.plans[1].body.length,
    );
    expect(submission.hasMigrations).toBe(true);
  });
});

describe('Planner submission tool: validation error formatting', () => {
  const makeTempDir = useTempDir('eforge-planner-submission-validation-test-');

  it('returns a per-path, retry-oriented error when submit_plan_set receives invalid input', async () => {
    // Payload with two common model mistakes, both structural so zod reports
    // them in a single pass: an optional object set to null, and a required
    // array field set to null. Both failures should appear in the tool's
    // output, each keyed to a concrete JSON path, so the model can retry
    // with corrections rather than abandoning the tool.
    const payload = validPlanSetPayload() as unknown as Record<string, unknown>;
    const firstPlan = (payload.plans as Array<Record<string, unknown>>)[0];
    const firstFrontmatter = firstPlan.frontmatter as Record<string, unknown>;
    firstPlan.frontmatter = {
      ...firstFrontmatter,
      agents: null,
      dependsOn: null,
    };

    const backend = new StubBackend([{
      toolCalls: [{
        tool: 'submit_plan_set',
        toolUseId: 'tu-1',
        input: payload,
        output: '',
      }],
      text: 'attempted submit',
    }]);
    const cwd = makeTempDir();

    // Collect events up to the point the planner throws PlannerSubmissionError
    // (the payload is invalid, so onSubmit is never called). We inspect the
    // accumulated events for the tool_result, then assert the rejection.
    const events: EforgeEvent[] = [];
    await expect((async () => {
      for await (const ev of runPlanner('Build widgets', {
        backend,
        cwd,
        auto: true,
        scope: 'excursion',
      })) {
        events.push(ev);
      }
    })()).rejects.toThrow(PlannerSubmissionError);

    const toolResult = events.find(
      (e): e is EforgeEvent & { type: 'agent:tool_result' } =>
        e.type === 'agent:tool_result' && e.tool === 'submit_plan_set',
    );
    expect(toolResult).toBeDefined();
    const output = toolResult!.output;

    // Retry framing — without these, the model abandons the tool and falls
    // back to Write. See the "tool not available" symptom in
    // eval/results/2026-04-21T21-19-00/.../eforge.log.
    expect(output).toContain('Submission rejected');
    expect(output).toContain('call the submission tool again');
    expect(output).toContain('Do NOT fall back to Write');

    // Per-path breakdown — one line per zod issue.
    expect(output).toMatch(/plans\.0\.frontmatter\.agents:/);
    expect(output).toMatch(/plans\.0\.frontmatter\.dependsOn:/);
  });
});
