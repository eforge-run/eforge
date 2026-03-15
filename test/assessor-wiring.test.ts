import { describe, it, expect } from 'vitest';
import type { EforgeEvent } from '../src/engine/events.js';
import { StubBackend } from './stub-backend.js';
import { runAssessor } from '../src/engine/agents/assessor.js';

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

describe('runAssessor wiring', () => {
  it('detects scope assessment from agent output', async () => {
    const backend = new StubBackend([{
      text: '<scope assessment="excursion">Cross-cutting change with migration dependency.</scope>',
    }]);

    const events = await collectEvents(runAssessor({
      backend,
      sourceContent: '# Big Feature\n\nMultiple subsystems involved.',
      cwd: '/tmp',
    }));

    const scope = findEvent(events, 'plan:scope');
    expect(scope).toBeDefined();
    expect(scope!.assessment).toBe('excursion');
    expect(scope!.justification).toBe('Cross-cutting change with migration dependency.');
  });

  it('defaults to errand when no scope block found', async () => {
    const backend = new StubBackend([{
      text: 'I explored the codebase but forgot to emit a scope block.',
    }]);

    const events = await collectEvents(runAssessor({
      backend,
      sourceContent: '# Some Plan',
      cwd: '/tmp',
    }));

    const scope = findEvent(events, 'plan:scope');
    expect(scope).toBeDefined();
    expect(scope!.assessment).toBe('errand');
    expect(scope!.justification).toContain('defaulting to errand');
  });

  it('gates agent:message on verbose flag', async () => {
    const makeBackend = () => new StubBackend([{
      text: '<scope assessment="errand">Small change.</scope>',
    }]);

    // verbose=false (default): agent:message should be suppressed
    const quietEvents = await collectEvents(runAssessor({
      backend: makeBackend(),
      sourceContent: 'Plan content',
      cwd: '/tmp',
    }));
    expect(filterEvents(quietEvents, 'agent:message')).toHaveLength(0);

    // verbose=true: agent:message should be emitted
    const verboseEvents = await collectEvents(runAssessor({
      backend: makeBackend(),
      sourceContent: 'Plan content',
      cwd: '/tmp',
      verbose: true,
    }));
    expect(filterEvents(verboseEvents, 'agent:message').length).toBeGreaterThan(0);
  });

  it('always yields agent:result', async () => {
    const backend = new StubBackend([{
      text: '<scope assessment="expedition">Large initiative.</scope>',
    }]);

    const events = await collectEvents(runAssessor({
      backend,
      sourceContent: 'Big plan',
      cwd: '/tmp',
    }));

    expect(findEvent(events, 'agent:result')).toBeDefined();
  });

  it('yields tool_use and tool_result events', async () => {
    const backend = new StubBackend([{
      toolCalls: [{
        tool: 'Read',
        toolUseId: 'tc-1',
        input: { path: 'src/index.ts' },
        output: 'file contents',
      }],
      text: '<scope assessment="errand">Simple change.</scope>',
    }]);

    const events = await collectEvents(runAssessor({
      backend,
      sourceContent: 'Fix bug',
      cwd: '/tmp',
    }));

    expect(findEvent(events, 'agent:tool_use')).toBeDefined();
    expect(findEvent(events, 'agent:tool_result')).toBeDefined();
  });

  it('detects complete scope', async () => {
    const backend = new StubBackend([{
      text: '<scope assessment="complete">Everything is already implemented.</scope>',
    }]);

    const events = await collectEvents(runAssessor({
      backend,
      sourceContent: '# Already Done',
      cwd: '/tmp',
    }));

    const scope = findEvent(events, 'plan:scope');
    expect(scope).toBeDefined();
    expect(scope!.assessment).toBe('complete');
  });
});
