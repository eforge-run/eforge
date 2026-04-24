/**
 * Tests that agent:start event payloads carry agentRuntime and harness fields
 * and never a backend field, for both single-runtime and mixed-runtime configs.
 */
import { describe, it, expect } from 'vitest';
import type { EforgeEvent } from '@eforge-build/engine/events';
import { StubHarness } from '../../../test/stub-harness.js';

async function collectStartEvents(harness: StubHarness, agentRuntimeName: string): Promise<EforgeEvent[]> {
  const events: EforgeEvent[] = [];
  for await (const event of harness.run(
    {
      prompt: 'test prompt',
      cwd: '/tmp',
      maxTurns: 1,
      tools: 'coding',
      agentRuntimeName,
    },
    'builder',
  )) {
    events.push(event);
  }
  return events;
}

describe('agent:start event payload shape', () => {
  it('carries agentRuntime and harness fields for claude-sdk runtime', async () => {
    const harness = new StubHarness([{ text: 'done' }]);
    const events = await collectStartEvents(harness, 'my-sdk-runtime');

    const startEvent = events.find((e) => e.type === 'agent:start');
    expect(startEvent).toBeDefined();
    // Must have agentRuntime field matching the runtime name
    expect(startEvent).toHaveProperty('agentRuntime', 'my-sdk-runtime');
    // Must have harness field
    expect(startEvent).toHaveProperty('harness');
    // Must NOT have backend field (old naming, removed in favor of harness)
    expect(startEvent).not.toHaveProperty('backend');
  });

  it('mixed-runtime config: each runtime produces agent:start with its own agentRuntime name', async () => {
    // Two separate harnesses representing different runtimes in a mixed config
    const sdkHarness = new StubHarness([{ text: 'sdk result' }]);
    const piHarness = new StubHarness([{ text: 'pi result' }]);

    const [sdkEvents, piEvents] = await Promise.all([
      collectStartEvents(sdkHarness, 'my-sdk-runtime'),
      collectStartEvents(piHarness, 'my-pi-runtime'),
    ]);

    const sdkStart = sdkEvents.find((e) => e.type === 'agent:start');
    const piStart = piEvents.find((e) => e.type === 'agent:start');

    // SDK runtime event
    expect(sdkStart).toHaveProperty('agentRuntime', 'my-sdk-runtime');
    expect(sdkStart).toHaveProperty('harness', 'claude-sdk');
    expect(sdkStart).not.toHaveProperty('backend');

    // Pi runtime event (StubHarness always emits harness: 'claude-sdk'; real PiHarness emits 'pi')
    expect(piStart).toHaveProperty('agentRuntime', 'my-pi-runtime');
    expect(piStart).toHaveProperty('harness');
    expect(piStart).not.toHaveProperty('backend');
  });

  it('agentRuntime defaults to "stub" when no agentRuntimeName is provided', async () => {
    const harness = new StubHarness([{ text: 'done' }]);
    const events: EforgeEvent[] = [];
    for await (const event of harness.run(
      { prompt: 'test', cwd: '/tmp', maxTurns: 1, tools: 'coding' },
      'builder',
    )) {
      events.push(event);
    }
    const startEvent = events.find((e) => e.type === 'agent:start');
    expect(startEvent).toHaveProperty('agentRuntime', 'stub');
    expect(startEvent).not.toHaveProperty('backend');
  });
});
