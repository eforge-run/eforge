import { describe, it, expect } from 'vitest';
import type { EforgeEvent } from '../src/engine/events.js';
import { StubBackend } from './stub-backend.js';
import { runDocUpdater } from '../src/engine/agents/doc-updater.js';

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

describe('runDocUpdater wiring', () => {
  it('emits lifecycle events in order: start then complete', async () => {
    const backend = new StubBackend([{
      text: '<doc-update-summary count="2">Updated README and API docs.</doc-update-summary>',
    }]);

    const events = await collectEvents(runDocUpdater({
      backend,
      cwd: '/tmp/test',
      planId: 'plan-01',
      planContent: '# Test plan content',
    }));

    const startEvent = findEvent(events, 'build:doc-update:start');
    const completeEvent = findEvent(events, 'build:doc-update:complete');

    expect(startEvent).toBeDefined();
    expect(startEvent!.planId).toBe('plan-01');
    expect(completeEvent).toBeDefined();
    expect(completeEvent!.planId).toBe('plan-01');

    // Start comes before complete
    const startIdx = events.indexOf(startEvent!);
    const completeIdx = events.indexOf(completeEvent!);
    expect(startIdx).toBeLessThan(completeIdx);
  });

  it('prompt composition includes plan_id and plan_content', async () => {
    const backend = new StubBackend([{ text: '<doc-update-summary count="0"></doc-update-summary>' }]);

    await collectEvents(runDocUpdater({
      backend,
      cwd: '/tmp/test',
      planId: 'plan-42',
      planContent: 'Some plan body here',
    }));

    expect(backend.prompts).toHaveLength(1);
    const prompt = backend.prompts[0];
    expect(prompt).toContain('plan-42');
    expect(prompt).toContain('Some plan body here');
  });

  it('backend options include tools: coding and maxTurns: 20', async () => {
    const backend = new StubBackend([{ text: '' }]);

    await collectEvents(runDocUpdater({
      backend,
      cwd: '/tmp/test',
      planId: 'plan-01',
      planContent: '# Plan',
    }));

    expect(backend.calls).toHaveLength(1);
    expect(backend.calls[0].tools).toBe('coding');
    expect(backend.calls[0].maxTurns).toBe(20);
  });

  it('parses docsUpdated count from XML summary', async () => {
    const backend = new StubBackend([{
      text: '<doc-update-summary count="3">Updated three files.</doc-update-summary>',
    }]);

    const events = await collectEvents(runDocUpdater({
      backend,
      cwd: '/tmp/test',
      planId: 'plan-01',
      planContent: '# Plan',
    }));

    const complete = findEvent(events, 'build:doc-update:complete');
    expect(complete!.docsUpdated).toBe(3);
  });

  it('zero updates when count="0"', async () => {
    const backend = new StubBackend([{
      text: '<doc-update-summary count="0">No docs needed updating.</doc-update-summary>',
    }]);

    const events = await collectEvents(runDocUpdater({
      backend,
      cwd: '/tmp/test',
      planId: 'plan-01',
      planContent: '# Plan',
    }));

    const complete = findEvent(events, 'build:doc-update:complete');
    expect(complete!.docsUpdated).toBe(0);
  });

  it('missing summary XML defaults to 0', async () => {
    const backend = new StubBackend([{
      text: 'Done updating docs, all good.',
    }]);

    const events = await collectEvents(runDocUpdater({
      backend,
      cwd: '/tmp/test',
      planId: 'plan-01',
      planContent: '# Plan',
    }));

    const complete = findEvent(events, 'build:doc-update:complete');
    expect(complete!.docsUpdated).toBe(0);
  });

  it('verbose gating via isAlwaysYieldedAgentEvent', async () => {
    const backend = new StubBackend([{
      text: 'Some agent output',
      toolCalls: [
        { tool: 'Read', toolUseId: 'tc-1', input: { path: '/tmp/README.md' }, output: '# Readme' },
      ],
    }]);

    // Non-verbose: should still yield agent:result, agent:tool_use, agent:tool_result, agent:start, agent:stop
    const events = await collectEvents(runDocUpdater({
      backend,
      cwd: '/tmp/test',
      planId: 'plan-01',
      planContent: '# Plan',
      verbose: false,
    }));

    const agentResult = events.find((e) => e.type === 'agent:result');
    expect(agentResult).toBeDefined();

    const toolUse = events.find((e) => e.type === 'agent:tool_use');
    expect(toolUse).toBeDefined();

    // agent:message should NOT be yielded when not verbose
    const agentMessage = events.find((e) => e.type === 'agent:message');
    expect(agentMessage).toBeUndefined();
  });

  it('verbose mode yields agent:message events', async () => {
    const backend = new StubBackend([{ text: 'Some output' }]);

    const events = await collectEvents(runDocUpdater({
      backend,
      cwd: '/tmp/test',
      planId: 'plan-01',
      planContent: '# Plan',
      verbose: true,
    }));

    const agentMessage = events.find((e) => e.type === 'agent:message');
    expect(agentMessage).toBeDefined();
  });

  it('non-abort errors are swallowed, complete event still yielded', async () => {
    const backend = new StubBackend([{
      error: new Error('Some random failure'),
    }]);

    const events = await collectEvents(runDocUpdater({
      backend,
      cwd: '/tmp/test',
      planId: 'plan-01',
      planContent: '# Plan',
    }));

    // Should still have start and complete
    const startEvent = findEvent(events, 'build:doc-update:start');
    const completeEvent = findEvent(events, 'build:doc-update:complete');
    expect(startEvent).toBeDefined();
    expect(completeEvent).toBeDefined();
    expect(completeEvent!.docsUpdated).toBe(0);
  });

  it('AbortError is re-thrown', async () => {
    const abortError = new Error('Aborted');
    abortError.name = 'AbortError';
    const backend = new StubBackend([{
      error: abortError,
    }]);

    await expect(
      collectEvents(runDocUpdater({
        backend,
        cwd: '/tmp/test',
        planId: 'plan-01',
        planContent: '# Plan',
      })),
    ).rejects.toThrow('Aborted');
  });
});
