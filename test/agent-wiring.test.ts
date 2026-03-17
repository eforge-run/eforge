import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EforgeEvent } from '../src/engine/events.js';
import { StubBackend } from './stub-backend.js';
import { runPlanner, formatProfileDescriptions } from '../src/engine/agents/planner.js';
import { runAssessor } from '../src/engine/agents/assessor.js';
import { runReview } from '../src/engine/agents/reviewer.js';
import { builderImplement, builderEvaluate } from '../src/engine/agents/builder.js';
import { runPlanReview } from '../src/engine/agents/plan-reviewer.js';
import { runPlanEvaluate } from '../src/engine/agents/plan-evaluator.js';
import { runModulePlanner } from '../src/engine/agents/module-planner.js';
import type { ResolvedProfileConfig } from '../src/engine/config.js';

async function collectEvents(gen: AsyncGenerator<EforgeEvent>): Promise<EforgeEvent[]> {
  const events: EforgeEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

function findEvent<T extends EforgeEvent['type']>(
  events: EforgeEvent[],
  type: T,
): Extract<EforgeEvent, { type: T }> | undefined {
  return events.find((e) => e.type === type) as Extract<EforgeEvent, { type: T }> | undefined;
}

function filterEvents<T extends EforgeEvent['type']>(
  events: EforgeEvent[],
  type: T,
): Array<Extract<EforgeEvent, { type: T }>> {
  return events.filter((e) => e.type === type) as Array<Extract<EforgeEvent, { type: T }>>;
}

// --- Planner ---

describe('runPlanner wiring', () => {
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'eforge-planner-test-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it('emits plan lifecycle events for a basic run', async () => {
    const backend = new StubBackend([{ text: 'Planning done.' }]);
    const cwd = makeTempDir();

    const events = await collectEvents(runPlanner('Build a widget', {
      backend,
      cwd,
    }));

    expect(findEvent(events, 'plan:start')).toBeDefined();
    expect(findEvent(events, 'plan:complete')).toBeDefined();
    expect(findEvent(events, 'plan:complete')!.plans).toEqual([]);
    // agent:result should be yielded (always yielded regardless of verbose)
    expect(findEvent(events, 'agent:result')).toBeDefined();
  });

  it('detects scope assessment from agent output', async () => {
    const backend = new StubBackend([{
      text: '<scope assessment="errand">Small change — one file.</scope>',
    }]);
    const cwd = makeTempDir();

    const events = await collectEvents(runPlanner('Fix a bug', {
      backend,
      cwd,
    }));

    const scope = findEvent(events, 'plan:scope');
    expect(scope).toBeDefined();
    expect(scope!.assessment).toBe('errand');
    expect(scope!.justification).toBe('Small change — one file.');
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
    expect(findEvent(events, 'plan:complete')).toBeDefined();
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
    expect(findEvent(events, 'plan:complete')).toBeDefined();
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

  it('scans plan directory for generated plan files', async () => {
    const cwd = makeTempDir();
    const planDir = join(cwd, 'plans', 'my-plan');
    mkdirSync(planDir, { recursive: true });

    // Write a valid plan file with YAML frontmatter
    writeFileSync(join(planDir, 'feature.md'), `---
id: feature
name: Add feature
dependsOn: []
branch: feature/add-feature
---

# Implementation

Do the thing.
`, 'utf-8');

    const backend = new StubBackend([{ text: 'Done planning.' }]);
    const events = await collectEvents(runPlanner('my-plan', {
      backend,
      cwd,
      name: 'my-plan',
    }));

    const complete = findEvent(events, 'plan:complete');
    expect(complete).toBeDefined();
    expect(complete!.plans).toHaveLength(1);
    expect(complete!.plans[0].id).toBe('feature');
    expect(complete!.plans[0].name).toBe('Add feature');
  });
});

// --- Profile formatting ---

const stubProfile: ResolvedProfileConfig = {
  description: 'Small focused change',
  compile: ['planner'],
  build: ['builder', 'reviewer', 'evaluator'],
  agents: {},
  review: { strategy: 'auto', perspectives: ['code'], maxRounds: 1, evaluatorStrictness: 'standard' },
};

describe('formatProfileDescriptions', () => {
  it('returns empty string for empty profiles', () => {
    expect(formatProfileDescriptions({})).toBe('');
  });

  it('returns a markdown table with one row', () => {
    const result = formatProfileDescriptions({ errand: stubProfile });
    expect(result).toContain('| Profile | Description |');
    expect(result).toContain('| `errand` | Small focused change |');
  });

  it('returns a markdown table with multiple profiles', () => {
    const result = formatProfileDescriptions({
      errand: stubProfile,
      migration: { ...stubProfile, description: 'Database migration work' },
    });
    expect(result).toContain('| `errand` |');
    expect(result).toContain('| `migration` | Database migration work |');
  });
});

// --- Planner profile emission ---

describe('runPlanner profile emission', () => {
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'eforge-planner-profile-test-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it('emits plan:profile when agent output contains a profile block', async () => {
    const backend = new StubBackend([{
      text: '<profile name="excursion">Multi-file feature work across 8 files.</profile>',
    }]);
    const cwd = makeTempDir();

    const events = await collectEvents(runPlanner('Build feature', {
      backend,
      cwd,
      profiles: { excursion: stubProfile },
    }));

    const profile = findEvent(events, 'plan:profile');
    expect(profile).toBeDefined();
    expect(profile!.profileName).toBe('excursion');
    expect(profile!.rationale).toBe('Multi-file feature work across 8 files.');
    expect(profile!.config).toBe(stubProfile);
  });

  it('emits both plan:profile and plan:scope when profile name matches a built-in scope', async () => {
    const backend = new StubBackend([{
      text: '<profile name="excursion">Cross-cutting change.</profile>',
    }]);
    const cwd = makeTempDir();

    const events = await collectEvents(runPlanner('Build feature', {
      backend,
      cwd,
      profiles: { excursion: stubProfile },
    }));

    const profile = findEvent(events, 'plan:profile');
    expect(profile).toBeDefined();
    expect(profile!.profileName).toBe('excursion');

    const scope = findEvent(events, 'plan:scope');
    expect(scope).toBeDefined();
    expect(scope!.assessment).toBe('excursion');
    expect(scope!.justification).toBe('Cross-cutting change.');
  });

  it('emits only plan:profile when profile name is a custom name', async () => {
    const backend = new StubBackend([{
      text: '<profile name="migration">Database migration work.</profile>',
    }]);
    const cwd = makeTempDir();

    const events = await collectEvents(runPlanner('Run migration', {
      backend,
      cwd,
      profiles: { migration: { ...stubProfile, description: 'Migration profile' } },
    }));

    const profile = findEvent(events, 'plan:profile');
    expect(profile).toBeDefined();
    expect(profile!.profileName).toBe('migration');

    // No plan:scope emitted for custom profile names
    const scope = findEvent(events, 'plan:scope');
    expect(scope).toBeUndefined();
  });

  it('emits only plan:scope when no profile block but scope block is present (backwards compatible)', async () => {
    const backend = new StubBackend([{
      text: '<scope assessment="errand">Small change — one file.</scope>',
    }]);
    const cwd = makeTempDir();

    const events = await collectEvents(runPlanner('Fix bug', {
      backend,
      cwd,
    }));

    const scope = findEvent(events, 'plan:scope');
    expect(scope).toBeDefined();
    expect(scope!.assessment).toBe('errand');

    const profile = findEvent(events, 'plan:profile');
    expect(profile).toBeUndefined();
  });

  it('includes profiles template variable in prompt when profiles are provided', async () => {
    const backend = new StubBackend([{ text: 'Planning done.' }]);
    const cwd = makeTempDir();

    await collectEvents(runPlanner('Build feature', {
      backend,
      cwd,
      profiles: { errand: stubProfile },
    }));

    expect(backend.prompts[0]).toContain('Small focused change');
    expect(backend.prompts[0]).toContain('`errand`');
  });
});

// --- Assessor profile emission ---

describe('runAssessor profile emission', () => {
  it('emits plan:profile when agent output contains a profile block', async () => {
    const backend = new StubBackend([{
      text: '<profile name="excursion">Multi-file work.</profile><scope assessment="excursion">Cross-cutting change.</scope>',
    }]);

    const events = await collectEvents(runAssessor({
      backend,
      sourceContent: 'test plan',
      cwd: '/tmp',
      profiles: { excursion: stubProfile },
    }));

    const profile = findEvent(events, 'plan:profile');
    expect(profile).toBeDefined();
    expect(profile!.profileName).toBe('excursion');
    expect(profile!.rationale).toBe('Multi-file work.');
    expect(profile!.config).toBe(stubProfile);
  });

  it('emits plan:scope without plan:profile when no profile block present (backwards compatible)', async () => {
    const backend = new StubBackend([{
      text: '<scope assessment="errand">Small change.</scope>',
    }]);

    const events = await collectEvents(runAssessor({
      backend,
      sourceContent: 'test plan',
      cwd: '/tmp',
    }));

    const scope = findEvent(events, 'plan:scope');
    expect(scope).toBeDefined();
    expect(scope!.assessment).toBe('errand');

    const profile = findEvent(events, 'plan:profile');
    expect(profile).toBeUndefined();
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
