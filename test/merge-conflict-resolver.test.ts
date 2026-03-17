import { describe, it, expect } from 'vitest';
import type { EforgeEvent } from '../src/engine/events.js';
import type { MergeConflictInfo } from '../src/engine/worktree.js';
import { StubBackend } from './stub-backend.js';
import { runMergeConflictResolver } from '../src/engine/agents/merge-conflict-resolver.js';

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

function makeConflict(overrides?: Partial<MergeConflictInfo>): MergeConflictInfo {
  return {
    branch: 'feature/plan-01',
    baseBranch: 'main',
    conflictedFiles: ['src/index.ts'],
    conflictDiff: '<<<<<<< HEAD\nold\n=======\nnew\n>>>>>>> feature/plan-01',
    ...overrides,
  };
}

describe('runMergeConflictResolver wiring', () => {
  it('emits lifecycle events for a successful run', async () => {
    const backend = new StubBackend([{ text: 'Conflicts resolved.' }]);
    const conflict = makeConflict();

    const events = await collectEvents(runMergeConflictResolver({
      backend,
      cwd: '/tmp/test-repo',
      conflict,
    }));

    const start = findEvent(events, 'merge:resolve:start');
    expect(start).toBeDefined();
    expect(start!.planId).toBe('feature/plan-01');

    const complete = findEvent(events, 'merge:resolve:complete');
    expect(complete).toBeDefined();
    expect(complete!.planId).toBe('feature/plan-01');
    expect(complete!.resolved).toBe(true);

    // agent:start and agent:stop should be yielded (always-yielded events)
    expect(findEvent(events, 'agent:start')).toBeDefined();
    expect(findEvent(events, 'agent:stop')).toBeDefined();
    expect(findEvent(events, 'agent:result')).toBeDefined();
  });

  it('emits resolved: false on non-abort error', async () => {
    const backend = new StubBackend([{ error: new Error('LLM failed') }]);
    const conflict = makeConflict();

    const events = await collectEvents(runMergeConflictResolver({
      backend,
      cwd: '/tmp/test-repo',
      conflict,
    }));

    const complete = findEvent(events, 'merge:resolve:complete');
    expect(complete).toBeDefined();
    expect(complete!.resolved).toBe(false);
  });

  it('re-throws AbortError', async () => {
    const abortError = new Error('Aborted');
    abortError.name = 'AbortError';
    const backend = new StubBackend([{ error: abortError }]);
    const conflict = makeConflict();

    await expect(
      collectEvents(runMergeConflictResolver({
        backend,
        cwd: '/tmp/test-repo',
        conflict,
      })),
    ).rejects.toThrow('Aborted');
  });

  it('passes correct options to backend.run()', async () => {
    const backend = new StubBackend([{ text: 'Done.' }]);
    const conflict = makeConflict();

    await collectEvents(runMergeConflictResolver({
      backend,
      cwd: '/tmp/test-repo',
      conflict,
    }));

    expect(backend.calls).toHaveLength(1);
    const call = backend.calls[0];
    expect(call.tools).toBe('coding');
    expect(call.maxTurns).toBe(30);
    expect(call.cwd).toBe('/tmp/test-repo');
  });

  it('includes plan context in prompt when provided', async () => {
    const backend = new StubBackend([{ text: 'Done.' }]);
    const conflict = makeConflict({
      planName: 'Add user authentication',
      planSummary: 'Implements JWT-based auth with login/logout endpoints',
      otherPlanName: 'Add database models',
      otherPlanSummary: 'Creates User and Session tables with migrations',
    });

    await collectEvents(runMergeConflictResolver({
      backend,
      cwd: '/tmp/test-repo',
      conflict,
    }));

    const prompt = backend.prompts[0];
    expect(prompt).toContain('Add user authentication');
    expect(prompt).toContain('Implements JWT-based auth with login/logout endpoints');
    expect(prompt).toContain('Add database models');
    expect(prompt).toContain('Creates User and Session tables with migrations');
  });

  it('includes conflict details in prompt', async () => {
    const backend = new StubBackend([{ text: 'Done.' }]);
    const conflict = makeConflict({
      branch: 'feat/my-feature',
      baseBranch: 'develop',
      conflictedFiles: ['src/a.ts', 'src/b.ts'],
      conflictDiff: '<<<<<<< conflict markers here >>>>>>>',
    });

    await collectEvents(runMergeConflictResolver({
      backend,
      cwd: '/tmp/test-repo',
      conflict,
    }));

    const prompt = backend.prompts[0];
    expect(prompt).toContain('feat/my-feature');
    expect(prompt).toContain('develop');
    expect(prompt).toContain('src/a.ts');
    expect(prompt).toContain('src/b.ts');
    expect(prompt).toContain('<<<<<<< conflict markers here >>>>>>>');
  });

  it('runs without error when optional plan context is omitted', async () => {
    const backend = new StubBackend([{ text: 'Done.' }]);
    const conflict = makeConflict(); // no planName, planSummary, etc.

    const events = await collectEvents(runMergeConflictResolver({
      backend,
      cwd: '/tmp/test-repo',
      conflict,
    }));

    // Should complete successfully
    const complete = findEvent(events, 'merge:resolve:complete');
    expect(complete).toBeDefined();
    expect(complete!.resolved).toBe(true);

    // Template vars should resolve to empty strings, not {{var}} placeholders
    const prompt = backend.prompts[0];
    expect(prompt).not.toContain('{{plan_name}}');
    expect(prompt).not.toContain('{{plan_summary}}');
    expect(prompt).not.toContain('{{other_plan_name}}');
    expect(prompt).not.toContain('{{other_plan_summary}}');
  });
});
