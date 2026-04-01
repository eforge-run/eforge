import { describe, it, expect } from 'vitest';
import { withRunId } from '../src/engine/session.js';
import type { EforgeEvent } from '../src/engine/events.js';

async function collectEvents(gen: AsyncGenerator<EforgeEvent>): Promise<EforgeEvent[]> {
  const events: EforgeEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

describe('withRunId', () => {
  it('stamps runId on events between phase:start and phase:end', async () => {
    async function* events(): AsyncGenerator<EforgeEvent> {
      yield { type: 'session:start', sessionId: 's1', timestamp: '2024-01-01T00:00:00Z' } as unknown as EforgeEvent;
      yield { type: 'phase:start', runId: 'run-1', planSet: 'test', command: 'compile', timestamp: '2024-01-01T00:00:00Z' } as unknown as EforgeEvent;
      yield { type: 'plan:start', source: 'test.md' } as unknown as EforgeEvent;
      yield { type: 'plan:complete', plans: [] } as unknown as EforgeEvent;
      yield { type: 'phase:end', runId: 'run-1', result: { status: 'completed' }, timestamp: '2024-01-01T00:01:00Z' } as unknown as EforgeEvent;
      yield { type: 'session:end', sessionId: 's1', result: { status: 'completed', summary: 'Done' }, timestamp: '2024-01-01T00:01:00Z' } as unknown as EforgeEvent;
    }

    const result = await collectEvents(withRunId(events()));

    // session:start before phase — no runId
    expect(result[0].runId).toBeUndefined();

    // phase:start — stamped
    expect(result[1].runId).toBe('run-1');

    // Events within phase — stamped
    expect(result[2].runId).toBe('run-1');
    expect(result[3].runId).toBe('run-1');

    // phase:end — stamped
    expect(result[4].runId).toBe('run-1');

    // session:end — stamped with lastRunId
    expect(result[5].runId).toBe('run-1');
  });

  it('does not stamp runId on events outside any phase (queue events)', async () => {
    async function* events(): AsyncGenerator<EforgeEvent> {
      yield { type: 'queue:start', prdCount: 2, dir: '/tmp/queue' } as unknown as EforgeEvent;
      yield { type: 'queue:prd:start', prdId: 'prd-1', title: 'Feature 1' } as unknown as EforgeEvent;
      yield { type: 'queue:prd:complete', prdId: 'prd-1', status: 'completed' } as unknown as EforgeEvent;
      yield { type: 'queue:prd:skip', prdId: 'prd-2', reason: 'already completed' } as unknown as EforgeEvent;
      yield { type: 'queue:complete', processed: 1, skipped: 0 } as unknown as EforgeEvent;
    }

    const result = await collectEvents(withRunId(events()));

    for (const event of result) {
      expect(event.runId).toBeUndefined();
    }
  });

  it('stamps lastRunId on session:end after phase:end', async () => {
    async function* events(): AsyncGenerator<EforgeEvent> {
      yield { type: 'session:start', sessionId: 's1', timestamp: '2024-01-01T00:00:00Z' } as unknown as EforgeEvent;
      yield { type: 'phase:start', runId: 'run-compile', planSet: 'test', command: 'compile', timestamp: '2024-01-01T00:00:00Z' } as unknown as EforgeEvent;
      yield { type: 'phase:end', runId: 'run-compile', result: { status: 'completed' }, timestamp: '2024-01-01T00:00:30Z' } as unknown as EforgeEvent;
      yield { type: 'phase:start', runId: 'run-build', planSet: 'test', command: 'build', timestamp: '2024-01-01T00:00:31Z' } as unknown as EforgeEvent;
      yield { type: 'phase:end', runId: 'run-build', result: { status: 'completed' }, timestamp: '2024-01-01T00:01:00Z' } as unknown as EforgeEvent;
      yield { type: 'session:end', sessionId: 's1', result: { status: 'completed', summary: 'Done' }, timestamp: '2024-01-01T00:01:00Z' } as unknown as EforgeEvent;
    }

    const result = await collectEvents(withRunId(events()));

    // session:end should have the last phase's runId
    const sessionEnd = result.find(e => e.type === 'session:end');
    expect(sessionEnd!.runId).toBe('run-build');
  });

  it('handles multi-phase session correctly', async () => {
    async function* events(): AsyncGenerator<EforgeEvent> {
      yield { type: 'session:start', sessionId: 's1', timestamp: '2024-01-01T00:00:00Z' } as unknown as EforgeEvent;
      // Compile phase
      yield { type: 'phase:start', runId: 'run-compile', planSet: 'test', command: 'compile', timestamp: '2024-01-01T00:00:00Z' } as unknown as EforgeEvent;
      yield { type: 'plan:start', source: 'test.md' } as unknown as EforgeEvent;
      yield { type: 'phase:end', runId: 'run-compile', result: { status: 'completed' }, timestamp: '2024-01-01T00:00:30Z' } as unknown as EforgeEvent;
      // Build phase
      yield { type: 'phase:start', runId: 'run-build', planSet: 'test', command: 'build', timestamp: '2024-01-01T00:00:31Z' } as unknown as EforgeEvent;
      yield { type: 'build:start', planId: 'plan-01' } as unknown as EforgeEvent;
      yield { type: 'build:complete', planId: 'plan-01' } as unknown as EforgeEvent;
      yield { type: 'phase:end', runId: 'run-build', result: { status: 'completed' }, timestamp: '2024-01-01T00:01:00Z' } as unknown as EforgeEvent;
      yield { type: 'session:end', sessionId: 's1', result: { status: 'completed', summary: 'Done' }, timestamp: '2024-01-01T00:01:00Z' } as unknown as EforgeEvent;
    }

    const result = await collectEvents(withRunId(events()));

    // Events in compile phase
    expect(result[2].runId).toBe('run-compile'); // plan:start

    // Events in build phase
    expect(result[5].runId).toBe('run-build'); // build:start
    expect(result[6].runId).toBe('run-build'); // build:complete

    // session:end gets lastRunId (from build phase)
    expect(result[8].runId).toBe('run-build');
  });
});
