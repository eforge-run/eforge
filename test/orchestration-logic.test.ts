import { describe, it, expect } from 'vitest';
import { propagateFailure, resumeState } from '../src/engine/orchestrator.js';
import { AsyncEventQueue } from '../src/engine/concurrency.js';
import type { ForgeState, ForgeEvent, OrchestrationConfig, PlanState } from '../src/engine/events.js';

// --- Helpers ---

function makeState(
  plans: Record<string, Partial<PlanState> & { status: PlanState['status'] }>,
  overrides?: Partial<ForgeState>,
): ForgeState {
  const fullPlans: Record<string, PlanState> = {};
  for (const [id, partial] of Object.entries(plans)) {
    fullPlans[id] = {
      status: partial.status,
      branch: partial.branch ?? `feature/${id}`,
      dependsOn: partial.dependsOn ?? [],
      merged: partial.merged ?? false,
      error: partial.error,
    };
  }
  return {
    setName: 'test-set',
    status: 'running',
    startedAt: '2026-01-01T00:00:00Z',
    baseBranch: 'main',
    worktreeBase: '/tmp/worktrees',
    plans: fullPlans,
    completedPlans: [],
    ...overrides,
  };
}

function makePlans(
  specs: Array<{ id: string; dependsOn?: string[] }>,
): OrchestrationConfig['plans'] {
  return specs.map((s) => ({
    id: s.id,
    name: s.id,
    dependsOn: s.dependsOn ?? [],
    branch: `feature/${s.id}`,
  }));
}

async function drainEvents(queue: AsyncEventQueue<ForgeEvent>): Promise<ForgeEvent[]> {
  queue.addProducer();
  queue.removeProducer();
  const events: ForgeEvent[] = [];
  for await (const event of queue) {
    events.push(event);
  }
  return events;
}

// --- Tests ---

describe('propagateFailure', () => {
  it('does nothing when failed plan has no dependents', async () => {
    const state = makeState({
      a: { status: 'failed' },
      b: { status: 'pending' },
    });
    const plans = makePlans([
      { id: 'a' },
      { id: 'b' },
    ]);
    const queue = new AsyncEventQueue<ForgeEvent>();

    propagateFailure(state, 'a', plans, queue);

    expect(state.plans['b'].status).toBe('pending');
    const events = await drainEvents(queue);
    expect(events).toHaveLength(0);
  });

  it('blocks a single direct dependent', async () => {
    const state = makeState({
      a: { status: 'failed' },
      b: { status: 'pending', dependsOn: ['a'] },
    });
    const plans = makePlans([
      { id: 'a' },
      { id: 'b', dependsOn: ['a'] },
    ]);
    const queue = new AsyncEventQueue<ForgeEvent>();

    propagateFailure(state, 'a', plans, queue);

    expect(state.plans['b'].status).toBe('blocked');
    expect(state.plans['b'].error).toContain('a');
    const events = await drainEvents(queue);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'build:failed', planId: 'b' });
  });

  it('blocks transitive chain A→B→C', async () => {
    const state = makeState({
      a: { status: 'failed' },
      b: { status: 'pending', dependsOn: ['a'] },
      c: { status: 'pending', dependsOn: ['b'] },
    });
    const plans = makePlans([
      { id: 'a' },
      { id: 'b', dependsOn: ['a'] },
      { id: 'c', dependsOn: ['b'] },
    ]);
    const queue = new AsyncEventQueue<ForgeEvent>();

    propagateFailure(state, 'a', plans, queue);

    expect(state.plans['b'].status).toBe('blocked');
    expect(state.plans['c'].status).toBe('blocked');
    const events = await drainEvents(queue);
    expect(events).toHaveLength(2);
  });

  it('blocks diamond A→{B,C}→D (D reached once)', async () => {
    const state = makeState({
      a: { status: 'failed' },
      b: { status: 'pending', dependsOn: ['a'] },
      c: { status: 'pending', dependsOn: ['a'] },
      d: { status: 'pending', dependsOn: ['b', 'c'] },
    });
    const plans = makePlans([
      { id: 'a' },
      { id: 'b', dependsOn: ['a'] },
      { id: 'c', dependsOn: ['a'] },
      { id: 'd', dependsOn: ['b', 'c'] },
    ]);
    const queue = new AsyncEventQueue<ForgeEvent>();

    propagateFailure(state, 'a', plans, queue);

    expect(state.plans['b'].status).toBe('blocked');
    expect(state.plans['c'].status).toBe('blocked');
    expect(state.plans['d'].status).toBe('blocked');
    const events = await drainEvents(queue);
    // 3 events: b, c, d (d only once due to visited set)
    expect(events).toHaveLength(3);
  });

  it('skips completed dependents', async () => {
    const state = makeState({
      a: { status: 'failed' },
      b: { status: 'completed', dependsOn: ['a'] },
    });
    const plans = makePlans([
      { id: 'a' },
      { id: 'b', dependsOn: ['a'] },
    ]);
    const queue = new AsyncEventQueue<ForgeEvent>();

    propagateFailure(state, 'a', plans, queue);

    expect(state.plans['b'].status).toBe('completed');
    const events = await drainEvents(queue);
    expect(events).toHaveLength(0);
  });

  it('skips merged dependents', async () => {
    const state = makeState({
      a: { status: 'failed' },
      b: { status: 'merged', dependsOn: ['a'], merged: true },
    });
    const plans = makePlans([
      { id: 'a' },
      { id: 'b', dependsOn: ['a'] },
    ]);
    const queue = new AsyncEventQueue<ForgeEvent>();

    propagateFailure(state, 'a', plans, queue);

    expect(state.plans['b'].status).toBe('merged');
    const events = await drainEvents(queue);
    expect(events).toHaveLength(0);
  });

  it('blocks multiple direct dependents and their transitive deps', async () => {
    const state = makeState({
      a: { status: 'failed' },
      b: { status: 'pending', dependsOn: ['a'] },
      c: { status: 'pending', dependsOn: ['a'] },
      d: { status: 'pending', dependsOn: ['b'] },
    });
    const plans = makePlans([
      { id: 'a' },
      { id: 'b', dependsOn: ['a'] },
      { id: 'c', dependsOn: ['a'] },
      { id: 'd', dependsOn: ['b'] },
    ]);
    const queue = new AsyncEventQueue<ForgeEvent>();

    propagateFailure(state, 'a', plans, queue);

    expect(state.plans['b'].status).toBe('blocked');
    expect(state.plans['c'].status).toBe('blocked');
    expect(state.plans['d'].status).toBe('blocked');
    const events = await drainEvents(queue);
    expect(events).toHaveLength(3);
  });
});

describe('resumeState', () => {
  it('resets running plans to pending', () => {
    const state = makeState({
      a: { status: 'running' },
      b: { status: 'pending' },
    });

    resumeState(state);

    expect(state.plans['a'].status).toBe('pending');
    expect(state.plans['b'].status).toBe('pending');
  });

  it('leaves completed plans untouched', () => {
    const state = makeState({
      a: { status: 'completed' },
    });

    resumeState(state);

    expect(state.plans['a'].status).toBe('completed');
  });

  it('leaves failed plans untouched', () => {
    const state = makeState({
      a: { status: 'failed' },
    });

    resumeState(state);

    expect(state.plans['a'].status).toBe('failed');
  });

  it('unblocks plan when all deps are resolved', () => {
    const state = makeState({
      a: { status: 'completed' },
      b: { status: 'blocked', dependsOn: ['a'] },
    });

    resumeState(state);

    expect(state.plans['b'].status).toBe('pending');
  });

  it('keeps plan blocked when deps are not resolved', () => {
    const state = makeState({
      a: { status: 'failed' },
      b: { status: 'blocked', dependsOn: ['a'] },
    });

    resumeState(state);

    expect(state.plans['b'].status).toBe('blocked');
  });

  it('keeps plan blocked with partial dep resolution', () => {
    const state = makeState({
      a: { status: 'merged', merged: true },
      b: { status: 'failed' },
      c: { status: 'blocked', dependsOn: ['a', 'b'] },
    });

    resumeState(state);

    expect(state.plans['c'].status).toBe('blocked');
  });
});
