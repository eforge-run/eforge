import { describe, it, expect } from 'vitest';
import type { EforgeEvent } from '@eforge-build/engine/events';
import { StubHarness } from './stub-harness.js';
import { findEvent, filterEvents } from './test-events.js';
import { runDependencyDetector, type DependencyDetectorResult } from '@eforge-build/engine/agents/dependency-detector';
import { AGENT_ROLES, DEFAULT_CONFIG } from '@eforge-build/engine/config';

async function collectEventsAndResult(
  gen: AsyncGenerator<EforgeEvent, DependencyDetectorResult>,
): Promise<{ events: EforgeEvent[]; result: DependencyDetectorResult }> {
  const events: EforgeEvent[] = [];
  let iterResult = await gen.next();
  while (!iterResult.done) {
    events.push(iterResult.value);
    iterResult = await gen.next();
  }
  return { events, result: iterResult.value };
}

describe('runDependencyDetector wiring', () => {
  it('returns parsed depends_on array from agent JSON output', async () => {
    const backend = new StubHarness([{ text: '["prd-auth-system", "prd-user-model"]' }]);

    const { result } = await collectEventsAndResult(
      runDependencyDetector({
        harness: backend,
        prdContent: 'Add user profile page',
        queueItems: [{ id: 'prd-auth-system', title: 'Auth System', scopeSummary: 'Implements auth' }],
        runningBuilds: [],
      }),
    );

    expect(result.dependsOn).toEqual(['prd-auth-system', 'prd-user-model']);
  });

  it('returns empty array when agent returns []', async () => {
    const backend = new StubHarness([{ text: '[]' }]);

    const { result } = await collectEventsAndResult(
      runDependencyDetector({
        harness: backend,
        prdContent: 'Independent change',
        queueItems: [],
        runningBuilds: [],
      }),
    );

    expect(result.dependsOn).toEqual([]);
  });

  it('returns empty array when agent output is not valid JSON', async () => {
    const backend = new StubHarness([{ text: 'I think these PRDs are related but I cannot determine dependencies.' }]);

    const { result } = await collectEventsAndResult(
      runDependencyDetector({
        harness: backend,
        prdContent: 'Some PRD',
        queueItems: [{ id: 'prd-1', title: 'First', scopeSummary: 'Something' }],
        runningBuilds: [],
      }),
    );

    expect(result.dependsOn).toEqual([]);
  });

  it('extracts JSON array from markdown fenced output', async () => {
    const backend = new StubHarness([{ text: '```json\n["prd-setup"]\n```' }]);

    const { result } = await collectEventsAndResult(
      runDependencyDetector({
        harness: backend,
        prdContent: 'Depends on setup',
        queueItems: [{ id: 'prd-setup', title: 'Setup', scopeSummary: 'Initial setup' }],
        runningBuilds: [],
      }),
    );

    expect(result.dependsOn).toEqual(['prd-setup']);
  });

  it('returns empty array when JSON contains non-string items', async () => {
    const backend = new StubHarness([{ text: '[1, 2, 3]' }]);

    const { result } = await collectEventsAndResult(
      runDependencyDetector({
        harness: backend,
        prdContent: 'Some PRD',
        queueItems: [],
        runningBuilds: [],
      }),
    );

    expect(result.dependsOn).toEqual([]);
  });

  it('yields agent:start, agent:result, agent:stop events', async () => {
    const backend = new StubHarness([{ text: '[]' }]);

    const { events } = await collectEventsAndResult(
      runDependencyDetector({
        harness: backend,
        prdContent: 'test',
        queueItems: [],
        runningBuilds: [],
      }),
    );

    expect(findEvent(events, 'agent:start')).toBeDefined();
    expect(findEvent(events, 'agent:result')).toBeDefined();
    expect(findEvent(events, 'agent:stop')).toBeDefined();
  });

  it('emits events in correct sequence', async () => {
    const backend = new StubHarness([{ text: '[]' }]);

    const { events } = await collectEventsAndResult(
      runDependencyDetector({
        harness: backend,
        prdContent: 'test',
        queueItems: [],
        runningBuilds: [],
      }),
    );

    const types = events.map((e) => e.type);
    const startIdx = types.indexOf('agent:start');
    const resultIdx = types.indexOf('agent:result');
    const stopIdx = types.indexOf('agent:stop');

    expect(startIdx).toBeLessThan(resultIdx);
    expect(resultIdx).toBeLessThan(stopIdx);
  });

  it('sets agent role to dependency-detector', async () => {
    const backend = new StubHarness([{ text: '[]' }]);

    const { events } = await collectEventsAndResult(
      runDependencyDetector({
        harness: backend,
        prdContent: 'test',
        queueItems: [],
        runningBuilds: [],
      }),
    );

    const start = findEvent(events, 'agent:start');
    expect(start).toBeDefined();
    expect(start!.agent).toBe('dependency-detector');
  });

  it('uses tools: none and maxTurns: 1', async () => {
    const backend = new StubHarness([{ text: '[]' }]);

    await collectEventsAndResult(
      runDependencyDetector({
        harness: backend,
        prdContent: 'test',
        queueItems: [],
        runningBuilds: [],
      }),
    );

    expect(backend.calls).toHaveLength(1);
    expect(backend.calls[0].tools).toBe('none');
    expect(backend.calls[0].maxTurns).toBe(1);
  });

  it('passes prdContent and context to backend prompt', async () => {
    const backend = new StubHarness([{ text: '[]' }]);
    const prdContent = 'Add payment processing module';
    const queueItems = [{ id: 'prd-auth', title: 'Auth System', scopeSummary: 'Authentication module' }];
    const runningBuilds = [{ planSetName: 'user-model', planTitles: ['User Model Plan'] }];

    await collectEventsAndResult(
      runDependencyDetector({
        harness: backend,
        prdContent,
        queueItems,
        runningBuilds,
      }),
    );

    expect(backend.prompts).toHaveLength(1);
    expect(backend.prompts[0]).toContain(prdContent);
    expect(backend.prompts[0]).toContain('prd-auth');
    expect(backend.prompts[0]).toContain('user-model');
  });

  it('suppresses agent:message when verbose is false', async () => {
    const backend = new StubHarness([{ text: '["prd-1"]' }]);

    const { events } = await collectEventsAndResult(
      runDependencyDetector({
        harness: backend,
        prdContent: 'test',
        queueItems: [],
        runningBuilds: [],
      }),
    );

    expect(filterEvents(events, 'agent:message')).toHaveLength(0);
  });

  it('emits agent:message when verbose is true', async () => {
    const backend = new StubHarness([{ text: '["prd-1"]' }]);

    const { events } = await collectEventsAndResult(
      runDependencyDetector({
        harness: backend,
        prdContent: 'test',
        queueItems: [],
        runningBuilds: [],
        verbose: true,
      }),
    );

    expect(filterEvents(events, 'agent:message').length).toBeGreaterThan(0);
  });
});

describe('dependency-detector registration', () => {
  it('is included in AGENT_ROLES', () => {
    expect(AGENT_ROLES).toContain('dependency-detector');
  });

  it('maxConcurrentBuilds defaults to 2', () => {
    expect(DEFAULT_CONFIG.maxConcurrentBuilds).toBe(2);
  });
});
