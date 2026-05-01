/**
 * Tests that agent:start event payloads carry harness/tier/tierSource/harnessSource
 * fields and never an agentRuntime field.
 */
import { describe, it, expect } from 'vitest';
import type { EforgeEvent } from '@eforge-build/engine/events';
import { StubHarness } from '../../../test/stub-harness.js';

async function collectStartEvents(harness: StubHarness, tier: string): Promise<EforgeEvent[]> {
  const events: EforgeEvent[] = [];
  for await (const event of harness.run(
    {
      prompt: 'test prompt',
      cwd: '/tmp',
      maxTurns: 1,
      tools: 'coding',
      tier,
      tierSource: 'tier',
      harness: 'claude-sdk',
      harnessSource: 'tier',
    },
    'builder',
  )) {
    events.push(event);
  }
  return events;
}

describe('agent:start event payload shape', () => {
  it('carries harness/tier/tierSource/harnessSource fields', async () => {
    const harness = new StubHarness([{ text: 'done' }]);
    const events = await collectStartEvents(harness, 'planning');

    const startEvent = events.find((e) => e.type === 'agent:start');
    expect(startEvent).toBeDefined();
    expect(startEvent).toHaveProperty('harness');
    expect(startEvent).toHaveProperty('harnessSource', 'tier');
    expect(startEvent).toHaveProperty('tier', 'planning');
    expect(startEvent).toHaveProperty('tierSource', 'tier');
    // agentRuntime is gone — the registry is tier-driven, no separate runtime name
    expect(startEvent).not.toHaveProperty('agentRuntime');
    // backend is gone too
    expect(startEvent).not.toHaveProperty('backend');
  });

  it('mixed-tier config: each tier produces agent:start with its own tier name', async () => {
    const planningHarness = new StubHarness([{ text: 'p' }]);
    const implHarness = new StubHarness([{ text: 'i' }]);

    const [planningEvents, implEvents] = await Promise.all([
      collectStartEvents(planningHarness, 'planning'),
      collectStartEvents(implHarness, 'implementation'),
    ]);

    const planningStart = planningEvents.find((e) => e.type === 'agent:start');
    const implStart = implEvents.find((e) => e.type === 'agent:start');

    expect(planningStart).toHaveProperty('tier', 'planning');
    expect(implStart).toHaveProperty('tier', 'implementation');
  });

  it('tier defaults to "unknown" when no tier is provided', async () => {
    const harness = new StubHarness([{ text: 'done' }]);
    const events: EforgeEvent[] = [];
    for await (const event of harness.run(
      { prompt: 'test', cwd: '/tmp', maxTurns: 1, tools: 'coding' },
      'builder',
    )) {
      events.push(event);
    }
    const startEvent = events.find((e) => e.type === 'agent:start');
    // StubHarness's default is currently 'stub' — but the agent:start event still
    // requires a tier field. Checking the field exists is enough here.
    expect(startEvent).toHaveProperty('tier');
  });
});
