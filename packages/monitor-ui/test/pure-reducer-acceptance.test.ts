/**
 * Plan-04 pure-reducer acceptance tests.
 *
 * Validates the acceptance criteria that are not covered by the broader
 * event-replay-equivalence.test.ts suite:
 *
 * AC #8  — thinkingCoerced / thinkingOriginal populate AgentThread at the
 *           handler level (unit test for handleAgentStart) and survive
 *           full-reducer dispatch.
 * AC #5  — IGNORED_EVENT_TYPES covers the 5 new plan-lifecycle and
 *           merge-worktree event variants so the exhaustiveness check passes
 *           and the reducer never crashes on them.
 * AC #5b — daemonHandlerRegistry is derived from eventRegistry.project
 *           entries; no hand-curated DAEMON_IGNORED_EVENT_TYPES list remains.
 */

import { describe, it, expect } from 'vitest';
import { handleAgentStart } from '@/lib/reducer/handle-agent';
import { initialRunState, eforgeReducer } from '@/lib/reducer';
import { initialDaemonState } from '@/lib/daemon-reducer';
import { IGNORED_EVENT_TYPES } from '@/lib/reducer/index';
import { daemonHandlerRegistry } from '@/lib/daemon-reducer/index';
import { eventRegistry } from '@eforge-build/client/browser';
import type { AgentThread } from '@/lib/reducer';
import type { EforgeEvent } from '@/lib/types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeEvent<T extends EforgeEvent['type']>(
  type: T,
  extra: object,
): Extract<EforgeEvent, { type: T }> {
  return {
    type,
    timestamp: '2024-01-15T10:00:00.000Z',
    sessionId: 's1',
    ...extra,
  } as unknown as Extract<EforgeEvent, { type: T }>;
}

// ---------------------------------------------------------------------------
// AC #8 — thinkingCoerced / thinkingOriginal in AgentThread
// ---------------------------------------------------------------------------

describe('AC #8 — thinkingCoerced / thinkingOriginal survive into AgentThread', () => {
  it('handleAgentStart captures thinkingCoerced:true and thinkingOriginal', () => {
    const event = makeEvent('agent:start', {
      agentId: 'agent-x',
      agent: 'builder',
      planId: 'plan-01',
      model: 'claude-sonnet-4-5',
      harness: 'claude-sdk',
      harnessSource: 'tier',
      tier: 'heavy',
      tierSource: 'role',
      thinking: { type: 'enabled', budget_tokens: 8000 },
      thinkingSource: 'tier',
      thinkingCoerced: true,
      thinkingOriginal: { type: 'enabled', budget_tokens: 32000 },
    });

    const delta = handleAgentStart(event, initialRunState);
    const thread = delta?.agentThreads?.[0] as AgentThread | undefined;

    expect(thread).toBeDefined();
    expect(thread?.thinkingCoerced).toBe(true);
    expect(thread?.thinkingOriginal).toEqual({ type: 'enabled', budget_tokens: 32000 });
  });

  it('handleAgentStart captures thinkingCoerced:false when budget was not reduced', () => {
    const event = makeEvent('agent:start', {
      agentId: 'agent-y',
      agent: 'reviewer',
      model: 'claude-haiku-4-5',
      harness: 'claude-sdk',
      harnessSource: 'tier',
      tier: 'light',
      tierSource: 'role',
      thinking: { type: 'disabled' },
      thinkingSource: 'tier',
      thinkingCoerced: false,
    });

    const delta = handleAgentStart(event, initialRunState);
    const thread = delta?.agentThreads?.[0] as AgentThread | undefined;

    expect(thread?.thinkingCoerced).toBe(false);
    expect(thread?.thinkingOriginal).toBeUndefined();
  });

  it('handleAgentStart leaves thinkingCoerced and thinkingOriginal undefined when absent', () => {
    const event = makeEvent('agent:start', {
      agentId: 'agent-z',
      agent: 'planner',
      model: 'claude-sonnet-4-5',
      harness: 'claude-sdk',
      harnessSource: 'tier',
      tier: 'standard',
      tierSource: 'role',
    });

    const delta = handleAgentStart(event, initialRunState);
    const thread = delta?.agentThreads?.[0] as AgentThread | undefined;

    expect(thread?.thinkingCoerced).toBeUndefined();
    expect(thread?.thinkingOriginal).toBeUndefined();
  });

  it('thinkingCoerced survives ADD_EVENT dispatch through eforgeReducer', () => {
    const event = makeEvent('agent:start', {
      sessionId: 's-think',
      agentId: 'agent-coerced',
      agent: 'builder',
      planId: 'plan-01',
      model: 'claude-sonnet-4-5',
      harness: 'claude-sdk',
      harnessSource: 'tier',
      tier: 'heavy',
      tierSource: 'tier',
      thinking: { type: 'enabled', budget_tokens: 16000 },
      thinkingSource: 'tier',
      thinkingCoerced: true,
      thinkingOriginal: { type: 'enabled', budget_tokens: 64000 },
    });

    const state = eforgeReducer(initialRunState, {
      type: 'ADD_EVENT',
      event,
      eventId: 'ev-coerce-01',
    });

    const thread = state.agentThreads.find((t: AgentThread) => t.agentId === 'agent-coerced');
    expect(thread).toBeDefined();
    expect(thread?.thinkingCoerced).toBe(true);
    expect(thread?.thinkingOriginal).toEqual({ type: 'enabled', budget_tokens: 64000 });
  });

  it('thinkingOriginal is identical between ADD_EVENT and BATCH_LOAD paths', () => {
    const event = makeEvent('agent:start', {
      sessionId: 's-batch',
      agentId: 'agent-batch',
      agent: 'builder',
      planId: 'plan-02',
      model: 'claude-sonnet-4-5',
      harness: 'claude-sdk',
      harnessSource: 'tier',
      tier: 'heavy',
      tierSource: 'plan',
      thinking: { type: 'enabled', budget_tokens: 8000 },
      thinkingSource: 'plan',
      thinkingCoerced: true,
      thinkingOriginal: { type: 'enabled', budget_tokens: 16000 },
    });

    const addEventState = eforgeReducer(initialRunState, {
      type: 'ADD_EVENT',
      event,
      eventId: 'ev-b01',
    });
    const batchState = eforgeReducer(initialRunState, {
      type: 'BATCH_LOAD',
      events: [{ event, eventId: 'ev-b01' }],
    });

    const addThread = addEventState.agentThreads.find(
      (t: AgentThread) => t.agentId === 'agent-batch',
    );
    const batchThread = batchState.agentThreads.find(
      (t: AgentThread) => t.agentId === 'agent-batch',
    );

    expect(addThread?.thinkingCoerced).toBe(true);
    expect(addThread?.thinkingOriginal).toEqual({ type: 'enabled', budget_tokens: 16000 });
    expect(batchThread?.thinkingCoerced).toBe(addThread?.thinkingCoerced);
    expect(batchThread?.thinkingOriginal).toEqual(addThread?.thinkingOriginal);
  });
});

// ---------------------------------------------------------------------------
// AC #5 — IGNORED_EVENT_TYPES covers the 5 new lifecycle event variants
// ---------------------------------------------------------------------------

const NEW_LIFECYCLE_TYPES = [
  'plan:status:change',
  'plan:error:set',
  'plan:error:clear',
  'merge:worktree:set',
  'merge:worktree:clear',
] as const;

describe('AC #5 — IGNORED_EVENT_TYPES covers new lifecycle event variants', () => {
  for (const eventType of NEW_LIFECYCLE_TYPES) {
    it(`IGNORED_EVENT_TYPES includes '${eventType}'`, () => {
      expect(IGNORED_EVENT_TYPES as readonly string[]).toContain(eventType);
    });
  }

  it('reducer does not crash on plan:status:change', () => {
    const event = makeEvent('plan:status:change', { planId: 'plan-01', status: 'running' });
    expect(() =>
      eforgeReducer(initialRunState, { type: 'ADD_EVENT', event, eventId: 'ev-psc' }),
    ).not.toThrow();
  });

  it('reducer does not crash on plan:error:set', () => {
    const event = makeEvent('plan:error:set', {
      planId: 'plan-01',
      error: 'Agent exceeded max turns',
    });
    expect(() =>
      eforgeReducer(initialRunState, { type: 'ADD_EVENT', event, eventId: 'ev-pes' }),
    ).not.toThrow();
  });

  it('reducer does not crash on plan:error:clear', () => {
    const event = makeEvent('plan:error:clear', { planId: 'plan-01' });
    expect(() =>
      eforgeReducer(initialRunState, { type: 'ADD_EVENT', event, eventId: 'ev-pec' }),
    ).not.toThrow();
  });

  it('reducer does not crash on merge:worktree:set', () => {
    const event = makeEvent('merge:worktree:set', { path: '/tmp/merge-worktree' });
    expect(() =>
      eforgeReducer(initialRunState, { type: 'ADD_EVENT', event, eventId: 'ev-mws' }),
    ).not.toThrow();
  });

  it('reducer does not crash on merge:worktree:clear', () => {
    const event = makeEvent('merge:worktree:clear', {});
    expect(() =>
      eforgeReducer(initialRunState, { type: 'ADD_EVENT', event, eventId: 'ev-mwc' }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC #5b — daemonHandlerRegistry derived from eventRegistry.project entries
// ---------------------------------------------------------------------------

describe('AC #5b — daemonHandlerRegistry derived from eventRegistry project functions', () => {
  it('daemonHandlerRegistry contains exactly the types with project functions in eventRegistry', () => {
    const typesWithProject = (
      Object.entries(eventRegistry) as Array<[string, { project?: unknown }]>
    )
      .filter(([, meta]) => typeof meta.project === 'function')
      .map(([type]) => type);

    for (const type of typesWithProject) {
      expect(
        daemonHandlerRegistry[type],
        `daemonHandlerRegistry should contain '${type}' (has project in eventRegistry)`,
      ).toBeDefined();
      expect(
        typeof daemonHandlerRegistry[type],
        `daemonHandlerRegistry['${type}'] should be a function`,
      ).toBe('function');
    }
  });

  it('daemonHandlerRegistry does NOT contain types without project functions', () => {
    const typesWithoutProject = (
      Object.entries(eventRegistry) as Array<[string, { project?: unknown }]>
    )
      .filter(([, meta]) => meta.project == null)
      .map(([type]) => type);

    for (const type of typesWithoutProject) {
      expect(
        daemonHandlerRegistry[type],
        `daemonHandlerRegistry should NOT contain '${type}' (no project in eventRegistry)`,
      ).toBeUndefined();
    }
  });

  it('daemonHandlerRegistry is non-empty', () => {
    expect(Object.keys(daemonHandlerRegistry).length).toBeGreaterThan(0);
  });

  it('session:start handler creates a new run entry in daemon state', () => {
    const handler = daemonHandlerRegistry['session:start'];
    expect(handler).toBeDefined();

    const event = makeEvent('session:start', { sessionId: 'sess-registry-test' });
    const delta = handler!(event as never, initialDaemonState) as {
      runs?: Array<{ id: string; sessionId?: string; status: string }>;
    } | undefined;

    expect(delta?.runs).toBeDefined();
    expect(delta?.runs?.length).toBeGreaterThan(0);
    const run = delta?.runs?.find((r) => r.sessionId === 'sess-registry-test');
    expect(run).toBeDefined();
    expect(run?.status).toBe('running');
  });

  it('daemon:heartbeat handler updates latestHeartbeat payload', () => {
    const handler = daemonHandlerRegistry['daemon:heartbeat'];
    expect(handler).toBeDefined();

    const event = makeEvent('daemon:heartbeat', {
      uptime: 30000,
      queueDepth: 2,
      runningBuilds: 1,
      autoBuild: { enabled: true, paused: false },
      subscribers: 3,
    });

    const delta = handler!(event as never, initialDaemonState) as {
      latestHeartbeat?: { payload: { uptime: number; queueDepth: number; runningBuilds: number } };
    } | undefined;

    expect(delta?.latestHeartbeat).toBeDefined();
    expect(delta?.latestHeartbeat?.payload.uptime).toBe(30000);
    expect(delta?.latestHeartbeat?.payload.queueDepth).toBe(2);
    expect(delta?.latestHeartbeat?.payload.runningBuilds).toBe(1);
  });

  it('queue:prd:discovered handler adds new item to queue', () => {
    const handler = daemonHandlerRegistry['queue:prd:discovered'];
    expect(handler).toBeDefined();

    const event = makeEvent('queue:prd:discovered', {
      prdId: 'prd-test-123',
      title: 'My Feature',
    });

    const delta = handler!(event as never, initialDaemonState) as {
      queue?: Array<{ id: string; title: string; status: string }>;
    } | undefined;

    const newItem = delta?.queue?.find((q) => q.id === 'prd-test-123');
    expect(newItem).toBeDefined();
    expect(newItem?.title).toBe('My Feature');
    expect(newItem?.status).toBe('pending');
  });
});
