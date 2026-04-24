import { describe, it, expect } from 'vitest';
import type { EforgeEvent } from '@eforge-build/engine/events';
import { withSessionId, runSession } from '@eforge-build/engine/session';

async function* asyncIterableFrom(events: EforgeEvent[]): AsyncGenerator<EforgeEvent> {
  for (const event of events) {
    yield event;
  }
}

async function collect(gen: AsyncGenerator<EforgeEvent>): Promise<EforgeEvent[]> {
  const events: EforgeEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

describe('withSessionId', () => {
  it('auto-derives sessionId from first phase:start runId and stamps all events', async () => {
    const events: EforgeEvent[] = [
      { type: 'phase:start', runId: 'run-1', planSet: 'test', command: 'compile', timestamp: '2024-01-01T00:00:00Z' },
      { type: 'planning:start', source: 'test.md' },
      { type: 'phase:end', runId: 'run-1', result: { status: 'completed', summary: 'done' }, timestamp: '2024-01-01T00:01:00Z' },
    ];

    const result = await collect(withSessionId(asyncIterableFrom(events)));

    // All events stamped with sessionId, no session:start/end emitted
    expect(result).toHaveLength(3);
    expect(result[0].type).toBe('phase:start');
    expect(result[0].sessionId).toBe('run-1');
    expect(result[1].sessionId).toBe('run-1');
    expect(result[2].sessionId).toBe('run-1');
  });

  it('uses pre-set sessionId when provided (stamping-only, no envelope)', async () => {
    const events: EforgeEvent[] = [
      { type: 'phase:start', runId: 'run-1', planSet: 'test', command: 'compile', timestamp: '2024-01-01T00:00:00Z' },
      { type: 'planning:start', source: 'test.md' },
      { type: 'phase:end', runId: 'run-1', result: { status: 'completed', summary: 'done' }, timestamp: '2024-01-01T00:01:00Z' },
    ];

    const result = await collect(withSessionId(asyncIterableFrom(events), { sessionId: 'session-42' }));

    expect(result[0].type).toBe('phase:start');
    expect(result[0].sessionId).toBe('session-42');
    expect(result[1].sessionId).toBe('session-42');
    expect(result[2].sessionId).toBe('session-42');
    expect(result).toHaveLength(3); // No session:start/end emitted
  });

  it('preserves engine-emitted sessionId in queue mode passthrough', async () => {
    const events: EforgeEvent[] = [
      { type: 'session:start', sessionId: 'queue-session-1', timestamp: '2024-01-01T00:00:00Z' },
      { type: 'phase:start', runId: 'run-1', planSet: 'test', command: 'compile', timestamp: '2024-01-01T00:00:01Z' },
      { type: 'phase:end', runId: 'run-1', result: { status: 'completed', summary: 'done' }, timestamp: '2024-01-01T00:01:00Z' },
      { type: 'session:end', sessionId: 'queue-session-1', result: { status: 'completed', summary: 'done' }, timestamp: '2024-01-01T00:02:00Z' },
    ];

    const result = await collect(withSessionId(asyncIterableFrom(events)));

    expect(result).toHaveLength(4);
    expect(result.every(e => e.sessionId === 'queue-session-1')).toBe(true);
  });

  it('preserves each event\'s existing sessionId when events carry heterogeneous sessionIds', async () => {
    const events: EforgeEvent[] = [
      { type: 'phase:start', runId: 'run-1', planSet: 'test', command: 'compile', timestamp: '2024-01-01T00:00:00Z', sessionId: 'session-A' },
      { type: 'planning:start', source: 'test.md', sessionId: 'session-B' },
      { type: 'phase:end', runId: 'run-1', result: { status: 'completed', summary: 'done' }, timestamp: '2024-01-01T00:01:00Z', sessionId: 'session-A' },
    ];

    // withSessionId called with no pre-set sessionId — should preserve each event's own sessionId
    const result = await collect(withSessionId(asyncIterableFrom(events)));

    expect(result[0].sessionId).toBe('session-A');
    expect(result[1].sessionId).toBe('session-B');
    expect(result[2].sessionId).toBe('session-A');
  });

  it('preserves runIds on phase events', async () => {
    const events: EforgeEvent[] = [
      { type: 'phase:start', runId: 'run-1', planSet: 'test', command: 'compile', timestamp: '2024-01-01T00:00:00Z' },
      { type: 'phase:end', runId: 'run-1', result: { status: 'completed', summary: 'done' }, timestamp: '2024-01-01T00:01:00Z' },
    ];

    const result = await collect(withSessionId(asyncIterableFrom(events), { sessionId: 'session-99' }));

    const phaseStart = result.find((e) => e.type === 'phase:start');
    expect(phaseStart?.type === 'phase:start' && phaseStart.runId).toBe('run-1');
  });
});

describe('runSession', () => {
  it('emits session:start before first event and session:end after last', async () => {
    const events: EforgeEvent[] = [
      { type: 'phase:start', runId: 'run-1', planSet: 'test', command: 'compile', timestamp: '2024-01-01T00:00:00Z' },
      { type: 'planning:start', source: 'test.md' },
      { type: 'phase:end', runId: 'run-1', result: { status: 'completed', summary: 'done' }, timestamp: '2024-01-01T00:01:00Z' },
    ];

    const result = await collect(runSession(asyncIterableFrom(events), 'session-1'));

    expect(result[0].type).toBe('session:start');
    expect(result[0].sessionId).toBe('session-1');
    expect(result[1].sessionId).toBe('session-1');
    expect(result[2].sessionId).toBe('session-1');
    expect(result[3].sessionId).toBe('session-1');
    expect(result[4].type).toBe('session:end');
    expect(result[4].sessionId).toBe('session-1');
    expect(result[4].type === 'session:end' && result[4].result.status).toBe('completed');
  });

  it('emits session:end with failed result when compile phase fails', async () => {
    const events: EforgeEvent[] = [
      { type: 'phase:start', runId: 'run-1', planSet: 'test', command: 'compile', timestamp: '2024-01-01T00:00:00Z' },
      { type: 'phase:end', runId: 'run-1', result: { status: 'failed', summary: 'compile failed' }, timestamp: '2024-01-01T00:01:00Z' },
    ];

    const result = await collect(runSession(asyncIterableFrom(events), 'session-fail'));

    expect(result[0].type).toBe('session:start');
    const sessionEnd = result.find((e) => e.type === 'session:end');
    expect(sessionEnd).toBeDefined();
    expect(sessionEnd!.sessionId).toBe('session-fail');
    expect(sessionEnd!.type === 'session:end' && sessionEnd!.result.status).toBe('failed');
  });

  it('emits session:end with completed result when generator returns early (plan:skip)', async () => {
    async function* skipStream(): AsyncGenerator<EforgeEvent> {
      yield { type: 'phase:start', runId: 'run-1', planSet: 'test', command: 'compile', timestamp: '2024-01-01T00:00:00Z' } as EforgeEvent;
      yield { type: 'planning:skip', reason: 'already done' } as EforgeEvent;
      yield { type: 'phase:end', runId: 'run-1', result: { status: 'completed', summary: 'skipped' }, timestamp: '2024-01-01T00:01:00Z' } as EforgeEvent;
      // Generator returns early — no build phase
      return;
    }

    const result = await collect(runSession(skipStream(), 'session-scope'));

    expect(result[0].type).toBe('session:start');
    const sessionEnd = result.find((e) => e.type === 'session:end');
    expect(sessionEnd).toBeDefined();
    expect(sessionEnd!.type === 'session:end' && sessionEnd!.result.status).toBe('completed');
  });

  it('emits session:end with failed result when build phase fails after successful compile', async () => {
    const events: EforgeEvent[] = [
      { type: 'phase:start', runId: 'run-1', planSet: 'test', command: 'compile', timestamp: '2024-01-01T00:00:00Z' },
      { type: 'phase:end', runId: 'run-1', result: { status: 'completed', summary: 'plan done' }, timestamp: '2024-01-01T00:01:00Z' },
      { type: 'phase:start', runId: 'run-2', planSet: 'test', command: 'build', timestamp: '2024-01-01T00:02:00Z' },
      { type: 'phase:end', runId: 'run-2', result: { status: 'failed', summary: 'build failed' }, timestamp: '2024-01-01T00:03:00Z' },
    ];

    const result = await collect(runSession(asyncIterableFrom(events), 'session-build-fail'));

    const sessionEnd = result.find((e) => e.type === 'session:end');
    expect(sessionEnd).toBeDefined();
    expect(sessionEnd!.type === 'session:end' && sessionEnd!.result.status).toBe('failed');
  });

  it('emits session:end with failed result when upstream throws', async () => {
    async function* throwingStream(): AsyncGenerator<EforgeEvent> {
      yield { type: 'phase:start', runId: 'run-1', planSet: 'test', command: 'compile', timestamp: '2024-01-01T00:00:00Z' } as EforgeEvent;
      yield { type: 'planning:start', source: 'test.md' } as EforgeEvent;
      throw new Error('upstream explosion');
    }

    const result: EforgeEvent[] = [];
    try {
      for await (const event of runSession(throwingStream(), 'session-throw')) {
        result.push(event);
      }
    } catch {
      // expected
    }

    expect(result[0].type).toBe('session:start');
    expect(result[0].sessionId).toBe('session-throw');

    const sessionEnd = result.find((e) => e.type === 'session:end');
    expect(sessionEnd).toBeDefined();
    expect(sessionEnd!.sessionId).toBe('session-throw');
    expect(sessionEnd!.type === 'session:end' && sessionEnd!.result.status).toBe('failed');
    expect(sessionEnd!.type === 'session:end' && sessionEnd!.result.summary).toBe('Session terminated abnormally');
  });

  it('includes agent error in fallback summary when agent:stop has error and no phase:end follows', async () => {
    async function* agentErrorStream(): AsyncGenerator<EforgeEvent> {
      yield { type: 'phase:start', runId: 'run-1', planSet: 'test', command: 'compile', timestamp: '2024-01-01T00:00:00Z' } as EforgeEvent;
      yield { type: 'agent:start', agentId: 'a1', agent: 'planner', timestamp: '2024-01-01T00:00:01Z' } as EforgeEvent;
      yield { type: 'agent:stop', agentId: 'a1', agent: 'planner', error: 'Model returned empty response', timestamp: '2024-01-01T00:00:05Z' } as EforgeEvent;
      // No phase:end — upstream terminates after agent error
    }

    const result = await collect(runSession(agentErrorStream(), 'session-agent-err'));

    const sessionEnd = result.find((e) => e.type === 'session:end');
    expect(sessionEnd).toBeDefined();
    expect(sessionEnd!.type === 'session:end' && sessionEnd!.result.status).toBe('failed');
    expect(sessionEnd!.type === 'session:end' && sessionEnd!.result.summary).toBe('Session failed: Model returned empty response');
  });

  it('uses generic fallback when no agent error and no phase:end', async () => {
    async function* emptyishStream(): AsyncGenerator<EforgeEvent> {
      yield { type: 'phase:start', runId: 'run-1', planSet: 'test', command: 'compile', timestamp: '2024-01-01T00:00:00Z' } as EforgeEvent;
      // No agent:stop with error, no phase:end
    }

    const result = await collect(runSession(emptyishStream(), 'session-no-result'));

    const sessionEnd = result.find((e) => e.type === 'session:end');
    expect(sessionEnd).toBeDefined();
    expect(sessionEnd!.type === 'session:end' && sessionEnd!.result.summary).toBe('Session terminated abnormally');
  });

  it('emits session:end with completed result for enqueue-only sessions', async () => {
    const events: EforgeEvent[] = [
      { type: 'enqueue:start', source: 'my-feature.md' },
      { type: 'agent:start', agentId: 'a1', agent: 'formatter', timestamp: '2024-01-01T00:00:00Z' },
      { type: 'agent:stop', agentId: 'a1', agent: 'formatter', timestamp: '2024-01-01T00:00:10Z' },
      { type: 'enqueue:complete', id: 'prd-001', filePath: '/queue/prd-001.md', title: 'My Great Feature' },
    ];

    const result = await collect(runSession(asyncIterableFrom(events), 'session-enqueue'));

    expect(result[0].type).toBe('session:start');
    expect(result[0].sessionId).toBe('session-enqueue');

    const sessionEnd = result.find((e) => e.type === 'session:end');
    expect(sessionEnd).toBeDefined();
    expect(sessionEnd!.type === 'session:end' && sessionEnd!.result.status).toBe('completed');
    expect(sessionEnd!.type === 'session:end' && sessionEnd!.result.summary).toContain('My Great Feature');
  });

  it('emits session:end with failed result when enqueue:failed is in the event stream', async () => {
    const events: EforgeEvent[] = [
      { type: 'enqueue:start', source: 'my-feature.md' },
      { type: 'enqueue:failed', error: 'Formatter crashed: invalid input' },
    ];

    const result = await collect(runSession(asyncIterableFrom(events), 'session-enqueue-fail'));

    expect(result[0].type).toBe('session:start');
    expect(result[0].sessionId).toBe('session-enqueue-fail');

    const sessionEnd = result.find((e) => e.type === 'session:end');
    expect(sessionEnd).toBeDefined();
    expect(sessionEnd!.type === 'session:end' && sessionEnd!.result.status).toBe('failed');
    expect(sessionEnd!.type === 'session:end' && sessionEnd!.result.summary).toBe('Enqueue failed: Formatter crashed: invalid input');
  });

  it('emits exactly one session:start and one session:end for full three-phase completion', async () => {
    const events: EforgeEvent[] = [
      { type: 'enqueue:start', source: 'test-prd.md' },
      { type: 'enqueue:complete', id: 'prd-1', filePath: '/queue/test.md', title: 'Test PRD' },
      { type: 'phase:start', runId: 'run-1', planSet: 'test', command: 'compile', timestamp: '2024-01-01T00:00:00Z' },
      { type: 'phase:end', runId: 'run-1', result: { status: 'completed', summary: 'plan done' }, timestamp: '2024-01-01T00:01:00Z' },
      { type: 'phase:start', runId: 'run-2', planSet: 'test', command: 'build', timestamp: '2024-01-01T00:02:00Z' },
      { type: 'phase:end', runId: 'run-2', result: { status: 'completed', summary: 'build done' }, timestamp: '2024-01-01T00:03:00Z' },
    ];

    const result = await collect(runSession(asyncIterableFrom(events), 'session-full'));

    const sessionStarts = result.filter((e) => e.type === 'session:start');
    const sessionEnds = result.filter((e) => e.type === 'session:end');

    expect(sessionStarts).toHaveLength(1);
    expect(sessionEnds).toHaveLength(1);
    expect(sessionStarts[0].sessionId).toBe('session-full');
    expect(sessionEnds[0].sessionId).toBe('session-full');
    expect(sessionEnds[0].type === 'session:end' && sessionEnds[0].result.status).toBe('completed');

    // All events stamped with sessionId
    expect(result.every((e) => e.sessionId === 'session-full')).toBe(true);
  });
});
