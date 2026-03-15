import { describe, it, expect } from 'vitest';
import type { EforgeEvent } from '../src/engine/events.js';
import { withSessionId } from '../src/engine/session.js';

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
  it('auto-derives sessionId from first phase:start runId and emits session envelope', async () => {
    const events: EforgeEvent[] = [
      { type: 'phase:start', runId: 'run-1', planSet: 'test', command: 'compile', timestamp: '2024-01-01T00:00:00Z' },
      { type: 'plan:start', source: 'test.md' },
      { type: 'phase:end', runId: 'run-1', result: { status: 'completed', summary: 'done' }, timestamp: '2024-01-01T00:01:00Z' },
    ];

    const result = await collect(withSessionId(asyncIterableFrom(events)));

    // session:start emitted before first phase:start
    expect(result[0].type).toBe('session:start');
    expect(result[0].sessionId).toBe('run-1');
    // All events stamped with sessionId
    expect(result[1].sessionId).toBe('run-1');
    expect(result[2].sessionId).toBe('run-1');
    expect(result[3].sessionId).toBe('run-1');
    // session:end emitted at the end
    expect(result[4].type).toBe('session:end');
    expect(result[4].sessionId).toBe('run-1');
  });

  it('uses pre-set sessionId when provided (no session envelope by default)', async () => {
    const events: EforgeEvent[] = [
      { type: 'phase:start', runId: 'run-1', planSet: 'test', command: 'compile', timestamp: '2024-01-01T00:00:00Z' },
      { type: 'plan:start', source: 'test.md' },
      { type: 'phase:end', runId: 'run-1', result: { status: 'completed', summary: 'done' }, timestamp: '2024-01-01T00:01:00Z' },
    ];

    // When sessionId is pre-set, session envelope defaults to off (caller controls it)
    const result = await collect(withSessionId(asyncIterableFrom(events), { sessionId: 'session-42' }));

    expect(result[0].type).toBe('phase:start');
    expect(result[0].sessionId).toBe('session-42');
    expect(result[1].sessionId).toBe('session-42');
    expect(result[2].sessionId).toBe('session-42');
    expect(result).toHaveLength(3); // No session:start/end emitted
  });

  it('suppresses session:start/end when flags are false (run command phase 2)', async () => {
    const events: EforgeEvent[] = [
      { type: 'phase:start', runId: 'run-2', planSet: 'test', command: 'build', timestamp: '2024-01-01T00:02:00Z' },
      { type: 'phase:end', runId: 'run-2', result: { status: 'completed', summary: 'done' }, timestamp: '2024-01-01T00:03:00Z' },
    ];

    // Phase 2 of run: no session:start, yes session:end
    const result = await collect(withSessionId(asyncIterableFrom(events), {
      sessionId: 'shared-session',
      emitSessionStart: false,
      emitSessionEnd: true,
    }));

    expect(result[0].type).toBe('phase:start');
    expect(result[0].sessionId).toBe('shared-session');
    expect(result[1].type).toBe('phase:end');
    // session:end at the end
    expect(result[2].type).toBe('session:end');
  });

  it('run command: phase 1 emits session:start, phase 2 emits session:end', async () => {
    const phase1: EforgeEvent[] = [
      { type: 'phase:start', runId: 'run-1', planSet: 'test', command: 'compile', timestamp: '2024-01-01T00:00:00Z' },
      { type: 'phase:end', runId: 'run-1', result: { status: 'completed', summary: 'plan done' }, timestamp: '2024-01-01T00:01:00Z' },
    ];
    const phase2: EforgeEvent[] = [
      { type: 'phase:start', runId: 'run-2', planSet: 'test', command: 'build', timestamp: '2024-01-01T00:02:00Z' },
      { type: 'phase:end', runId: 'run-2', result: { status: 'completed', summary: 'build done' }, timestamp: '2024-01-01T00:03:00Z' },
    ];

    const result1 = await collect(withSessionId(asyncIterableFrom(phase1), {
      sessionId: 'session-shared',
      emitSessionStart: true,
      emitSessionEnd: false,
    }));

    const result2 = await collect(withSessionId(asyncIterableFrom(phase2), {
      sessionId: 'session-shared',
      emitSessionStart: false,
      emitSessionEnd: true,
    }));

    // Phase 1: session:start + phase events, no session:end
    expect(result1[0].type).toBe('session:start');
    expect(result1.some((e) => e.type === 'session:end')).toBe(false);

    // Phase 2: phase events + session:end, no session:start
    expect(result2.some((e) => e.type === 'session:start')).toBe(false);
    expect(result2[result2.length - 1].type).toBe('session:end');

    // All events share the same sessionId
    const allEvents = [...result1, ...result2];
    expect(allEvents.every((e) => e.sessionId === 'session-shared')).toBe(true);
  });

  it('emits session:end with failed result when upstream throws before phase:end', async () => {
    async function* throwingStream(): AsyncGenerator<EforgeEvent> {
      yield { type: 'phase:start', runId: 'run-1', planSet: 'test', command: 'compile', timestamp: '2024-01-01T00:00:00Z' } as EforgeEvent;
      yield { type: 'plan:start', source: 'test.md' } as EforgeEvent;
      throw new Error('upstream explosion');
    }

    const result: EforgeEvent[] = [];
    try {
      for await (const event of withSessionId(throwingStream())) {
        result.push(event);
      }
    } catch {
      // expected
    }

    // session:start emitted, events stamped, then session:end with failed result
    expect(result[0].type).toBe('session:start');
    expect(result[0].sessionId).toBe('run-1');

    const sessionEnd = result.find((e) => e.type === 'session:end');
    expect(sessionEnd).toBeDefined();
    expect(sessionEnd!.sessionId).toBe('run-1');
    expect(sessionEnd!.type === 'session:end' && sessionEnd!.result.status).toBe('failed');
    expect(sessionEnd!.type === 'session:end' && sessionEnd!.result.summary).toBe('Session terminated abnormally');
  });

  it('emits session:end with failed result when stream ends without phase:end', async () => {
    const events: EforgeEvent[] = [
      { type: 'phase:start', runId: 'run-1', planSet: 'test', command: 'compile', timestamp: '2024-01-01T00:00:00Z' },
      { type: 'plan:start', source: 'test.md' },
      // No phase:end - stream just ends
    ];

    const result = await collect(withSessionId(asyncIterableFrom(events)));

    expect(result[0].type).toBe('session:start');
    const sessionEnd = result.find((e) => e.type === 'session:end');
    expect(sessionEnd).toBeDefined();
    expect(sessionEnd!.type === 'session:end' && sessionEnd!.result.status).toBe('failed');
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
