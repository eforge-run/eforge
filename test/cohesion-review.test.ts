import { describe, it, expect } from 'vitest';
import { StubBackend } from './stub-backend.js';
import { collectEvents, findEvent, filterEvents } from './test-events.js';
import { runCohesionReview } from '@eforge-build/engine/agents/cohesion-reviewer';
import { runCohesionEvaluate } from '@eforge-build/engine/agents/plan-evaluator';

// --- Cohesion Reviewer ---

describe('runCohesionReview wiring', () => {
  it('emits cohesion review lifecycle events', async () => {
    const backend = new StubBackend([{ text: '<review-issues></review-issues>' }]);

    const events = await collectEvents(runCohesionReview({
      backend,
      sourceContent: 'PRD content',
      planSetName: 'my-expedition',
      architectureContent: '# Architecture\nModular design.',
      cwd: '/tmp',
    }));

    expect(findEvent(events, 'planning:cohesion:start')).toBeDefined();
    const complete = findEvent(events, 'planning:cohesion:complete');
    expect(complete).toBeDefined();
    expect(complete!.issues).toHaveLength(0);
    // agent:result should always be yielded
    expect(findEvent(events, 'agent:result')).toBeDefined();
  });

  it('parses review issues from cohesion review output', async () => {
    const backend = new StubBackend([{
      text: `<review-issues>
  <issue severity="critical" category="cohesion" file="plans/mod-a.md" line="15">File overlap: src/index.ts modified by both mod-a and mod-b without dependency</issue>
  <issue severity="warning" category="feasibility" file="plans/mod-b.md">Vague criterion: "tests pass properly" — replace with "pnpm test exits with code 0"<fix>Replaced "tests pass properly" with "pnpm test exits with code 0"</fix></issue>
  <issue severity="critical" category="dependency" file="plans/mod-c.md">Missing dependency: mod-c uses types from mod-a but does not list mod-a in depends_on</issue>
</review-issues>`,
    }]);

    const events = await collectEvents(runCohesionReview({
      backend,
      sourceContent: 'PRD content',
      planSetName: 'my-expedition',
      architectureContent: '# Architecture',
      cwd: '/tmp',
    }));

    const complete = findEvent(events, 'planning:cohesion:complete');
    expect(complete).toBeDefined();
    expect(complete!.issues).toHaveLength(3);
    expect(complete!.issues[0]).toMatchObject({
      severity: 'critical',
      category: 'cohesion',
      file: 'plans/mod-a.md',
      line: 15,
    });
    expect(complete!.issues[1]).toMatchObject({
      severity: 'warning',
      category: 'feasibility',
      file: 'plans/mod-b.md',
    });
    expect(complete!.issues[1].fix).toBe('Replaced "tests pass properly" with "pnpm test exits with code 0"');
    expect(complete!.issues[2]).toMatchObject({
      severity: 'critical',
      category: 'dependency',
    });
  });

  it('yields empty issues for plain text output (no XML)', async () => {
    const backend = new StubBackend([{ text: 'Everything looks good. No cross-module issues found.' }]);

    const events = await collectEvents(runCohesionReview({
      backend,
      sourceContent: 'PRD content',
      planSetName: 'my-expedition',
      architectureContent: '# Architecture',
      cwd: '/tmp',
    }));

    const complete = findEvent(events, 'planning:cohesion:complete');
    expect(complete).toBeDefined();
    expect(complete!.issues).toHaveLength(0);
  });

  it('uses coding tools', async () => {
    const backend = new StubBackend([{ text: '<review-issues></review-issues>' }]);

    await collectEvents(runCohesionReview({
      backend,
      sourceContent: 'PRD',
      planSetName: 'test',
      architectureContent: '',
      cwd: '/tmp',
    }));

    expect(backend.calls).toHaveLength(1);
    expect(backend.calls[0].tools).toBe('coding');
  });

  it('suppresses agent:message when verbose is false', async () => {
    const backend = new StubBackend([{ text: 'Some output.' }]);

    const events = await collectEvents(runCohesionReview({
      backend,
      sourceContent: 'PRD',
      planSetName: 'test',
      architectureContent: '',
      cwd: '/tmp',
    }));

    expect(filterEvents(events, 'agent:message')).toHaveLength(0);
  });

  it('emits agent:message when verbose is true', async () => {
    const backend = new StubBackend([{ text: 'Some output.' }]);

    const events = await collectEvents(runCohesionReview({
      backend,
      sourceContent: 'PRD',
      planSetName: 'test',
      architectureContent: '',
      cwd: '/tmp',
      verbose: true,
    }));

    expect(filterEvents(events, 'agent:message').length).toBeGreaterThan(0);
  });

  it('propagates errors (non-fatal handling is engine responsibility)', async () => {
    const backend = new StubBackend([{ error: new Error('Cohesion review crashed') }]);

    let thrown: Error | undefined;
    try {
      await collectEvents(runCohesionReview({
        backend,
        sourceContent: 'PRD',
        planSetName: 'test',
        architectureContent: '',
        cwd: '/tmp',
      }));
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown).toBeDefined();
    expect(thrown!.message).toBe('Cohesion review crashed');
  });
});

// --- Cohesion Evaluator ---

describe('runCohesionEvaluate wiring', () => {
  it('emits cohesion evaluation lifecycle events', async () => {
    const backend = new StubBackend([{
      text: `<evaluation>
  <verdict file="plans/mod-a.md" action="accept">
    <original>No dependency on mod-b</original>
    <fix>Added mod-b to depends_on</fix>
    <rationale>mod-a uses types from mod-b</rationale>
    <if-accepted>Correct dependency ordering</if-accepted>
    <if-rejected>Build failure when mod-a runs before mod-b</if-rejected>
  </verdict>
</evaluation>`,
    }]);

    const events = await collectEvents(runCohesionEvaluate({
      backend,
      planSetName: 'my-expedition',
      sourceContent: 'PRD content',
      cwd: '/tmp',
    }));

    expect(findEvent(events, 'planning:cohesion:evaluate:start')).toBeDefined();
    const complete = findEvent(events, 'planning:cohesion:evaluate:complete');
    expect(complete).toBeDefined();
    expect(complete!.accepted).toBe(1);
    expect(complete!.rejected).toBe(0);
    expect(complete!.verdicts).toEqual([
      { file: 'plans/mod-a.md', action: 'accept', reason: 'mod-a uses types from mod-b' },
    ]);
    // agent:result should always be yielded
    expect(findEvent(events, 'agent:result')).toBeDefined();
  });

  it('counts evaluation verdicts correctly', async () => {
    const backend = new StubBackend([{
      text: `<evaluation>
  <verdict file="plans/a.md" action="accept">
    <original>Original</original>
    <fix>Fix</fix>
    <rationale>Good fix</rationale>
    <if-accepted>Better</if-accepted>
    <if-rejected>Worse</if-rejected>
  </verdict>
  <verdict file="plans/b.md" action="accept">
    <original>Original</original>
    <fix>Fix</fix>
    <rationale>Also good</rationale>
    <if-accepted>Better</if-accepted>
    <if-rejected>Worse</if-rejected>
  </verdict>
  <verdict file="plans/c.md" action="reject">
    <original>Original</original>
    <fix>Fix</fix>
    <rationale>Alters approach</rationale>
    <if-accepted>Different</if-accepted>
    <if-rejected>Same</if-rejected>
  </verdict>
  <verdict file="plans/d.md" action="review">
    <original>Original</original>
    <fix>Fix</fix>
    <rationale>Debatable</rationale>
    <if-accepted>Maybe better</if-accepted>
    <if-rejected>Status quo</if-rejected>
  </verdict>
</evaluation>`,
    }]);

    const events = await collectEvents(runCohesionEvaluate({
      backend,
      planSetName: 'my-expedition',
      sourceContent: 'PRD content',
      cwd: '/tmp',
    }));

    const complete = findEvent(events, 'planning:cohesion:evaluate:complete');
    expect(complete).toBeDefined();
    expect(complete!.accepted).toBe(2);
    expect(complete!.rejected).toBe(2); // reject + review both count as rejected
    expect(complete!.verdicts).toEqual([
      { file: 'plans/a.md', action: 'accept', reason: 'Good fix' },
      { file: 'plans/b.md', action: 'accept', reason: 'Also good' },
      { file: 'plans/c.md', action: 'reject', reason: 'Alters approach' },
      { file: 'plans/d.md', action: 'review', reason: 'Debatable' },
    ]);
  });

  it('emits zero counts and re-throws on error', async () => {
    const backend = new StubBackend([{ error: new Error('Evaluate crash') }]);

    let thrown: Error | undefined;
    const events: EforgeEvent[] = [];
    try {
      for await (const event of runCohesionEvaluate({
        backend,
        planSetName: 'my-expedition',
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

    const complete = findEvent(events, 'planning:cohesion:evaluate:complete');
    expect(complete).toBeDefined();
    expect(complete!.accepted).toBe(0);
    expect(complete!.rejected).toBe(0);
  });

  it('handles empty evaluation output', async () => {
    const backend = new StubBackend([{ text: 'No fixes to evaluate.' }]);

    const events = await collectEvents(runCohesionEvaluate({
      backend,
      planSetName: 'my-expedition',
      sourceContent: 'PRD content',
      cwd: '/tmp',
    }));

    const complete = findEvent(events, 'planning:cohesion:evaluate:complete');
    expect(complete).toBeDefined();
    expect(complete!.accepted).toBe(0);
    expect(complete!.rejected).toBe(0);
  });

  it('uses coding tools', async () => {
    const backend = new StubBackend([{ text: '<evaluation></evaluation>' }]);

    await collectEvents(runCohesionEvaluate({
      backend,
      planSetName: 'test',
      sourceContent: 'PRD',
      cwd: '/tmp',
    }));

    expect(backend.calls).toHaveLength(1);
    expect(backend.calls[0].tools).toBe('coding');
  });
});
