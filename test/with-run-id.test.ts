import { describe, it, expect } from 'vitest';
import { withRunId } from '@eforge-build/engine/session';
import type { EforgeEvent } from '@eforge-build/engine/events';

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
      yield { type: 'planning:start', source: 'test.md' } as unknown as EforgeEvent;
      yield { type: 'planning:complete', plans: [] } as unknown as EforgeEvent;
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

  it('preserves pre-existing runId values on interleaved parallel PRD events', async () => {
    // Simulate two parallel PRD sessions (A and B) whose events interleave
    // through a single withRunId middleware. Events are pre-stamped with runId
    // by per-sub-generator withRunId wrapping in buildSinglePrd.
    async function* interleavedEvents(): AsyncGenerator<EforgeEvent> {
      // Session A: phase:start
      yield { type: 'phase:start', runId: 'run-A', planSet: 'prd-a', command: 'compile', timestamp: '2024-01-01T00:00:00Z' } as unknown as EforgeEvent;
      // Session B: phase:start (interleaved)
      yield { type: 'phase:start', runId: 'run-B', planSet: 'prd-b', command: 'compile', timestamp: '2024-01-01T00:00:01Z' } as unknown as EforgeEvent;
      // Session A: plan:start (pre-stamped with run-A)
      yield { type: 'planning:start', source: 'a.md', runId: 'run-A' } as unknown as EforgeEvent;
      // Session B: plan:start (pre-stamped with run-B)
      yield { type: 'planning:start', source: 'b.md', runId: 'run-B' } as unknown as EforgeEvent;
      // Session A: phase:end
      yield { type: 'phase:end', runId: 'run-A', result: { status: 'completed' }, timestamp: '2024-01-01T00:01:00Z' } as unknown as EforgeEvent;
      // Session B: phase:end
      yield { type: 'phase:end', runId: 'run-B', result: { status: 'completed' }, timestamp: '2024-01-01T00:01:01Z' } as unknown as EforgeEvent;
    }

    const result = await collectEvents(withRunId(interleavedEvents()));

    // A's plan:start retains run-A (not corrupted to run-B)
    expect(result[2].runId).toBe('run-A');
    // B's plan:start retains run-B
    expect(result[3].runId).toBe('run-B');
    // A's phase:end retains run-A
    expect(result[4].runId).toBe('run-A');
    // B's phase:end retains run-B
    expect(result[5].runId).toBe('run-B');
  });

  it('does not stamp unstamped events outside phases when pre-stamped events are interleaved', async () => {
    async function* events(): AsyncGenerator<EforgeEvent> {
      // Queue event before any phase — no runId
      yield { type: 'queue:start', prdCount: 1, dir: '/tmp/q' } as unknown as EforgeEvent;
      // Pre-stamped event from a parallel session
      yield { type: 'phase:start', runId: 'run-X', planSet: 'prd-x', command: 'compile', timestamp: '2024-01-01T00:00:00Z' } as unknown as EforgeEvent;
      yield { type: 'phase:end', runId: 'run-X', result: { status: 'completed' }, timestamp: '2024-01-01T00:01:00Z' } as unknown as EforgeEvent;
      // Queue event after phase — should still not be stamped
      yield { type: 'queue:complete', processed: 1, skipped: 0 } as unknown as EforgeEvent;
    }

    const result = await collectEvents(withRunId(events()));

    expect(result[0].runId).toBeUndefined();
    expect(result[3].runId).toBeUndefined();
  });

  it('handles multi-phase session correctly', async () => {
    async function* events(): AsyncGenerator<EforgeEvent> {
      yield { type: 'session:start', sessionId: 's1', timestamp: '2024-01-01T00:00:00Z' } as unknown as EforgeEvent;
      // Compile phase
      yield { type: 'phase:start', runId: 'run-compile', planSet: 'test', command: 'compile', timestamp: '2024-01-01T00:00:00Z' } as unknown as EforgeEvent;
      yield { type: 'planning:start', source: 'test.md' } as unknown as EforgeEvent;
      yield { type: 'phase:end', runId: 'run-compile', result: { status: 'completed' }, timestamp: '2024-01-01T00:00:30Z' } as unknown as EforgeEvent;
      // Build phase
      yield { type: 'phase:start', runId: 'run-build', planSet: 'test', command: 'build', timestamp: '2024-01-01T00:00:31Z' } as unknown as EforgeEvent;
      yield { type: 'plan:build:start', planId: 'plan-01' } as unknown as EforgeEvent;
      yield { type: 'plan:build:complete', planId: 'plan-01' } as unknown as EforgeEvent;
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
