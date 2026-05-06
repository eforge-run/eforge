/**
 * AC #1 regression gate — plan status is driven by plan:status:change events.
 *
 * Three assertions prove the reducer relies on explicit lifecycle events and
 * no longer infers plan-row status from plan:build:* events:
 *
 *   1. With plan:status:change events present, planStatuses are correctly set.
 *   2. With plan:status:change events stripped, planStatuses are NOT set —
 *      proving the reducer no longer infers from plan:build:* events.
 *   3. thinkingOriginal with snake_case budget_tokens survives round-trip
 *      through the reducer after AC #8 normalization.
 *
 * This test MUST fail before this expedition lands (the assertions assert
 * the new behavior directly). It passes only after all three ACs are wired.
 */
import { describe, it, expect } from 'vitest';
import { eforgeReducer, initialRunState } from '@/lib/reducer';
import type { AgentThread } from '@/lib/reducer';
import type { EforgeEvent } from '@/lib/types';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

type StoredEvent = { event: EforgeEvent; eventId: string };

function makeEvent<T extends EforgeEvent['type']>(
  type: T,
  extra: object,
  eventId: string,
): StoredEvent {
  return {
    event: { type, timestamp: '2024-01-15T10:00:00.000Z', ...extra } as unknown as EforgeEvent,
    eventId,
  };
}

function replayEvents(events: StoredEvent[]) {
  return events.reduce(
    (acc, { event, eventId }) => eforgeReducer(acc, { type: 'ADD_EVENT', event, eventId }),
    initialRunState,
  );
}

// ---------------------------------------------------------------------------
// Fixture: two-plan sequence ending in merged + failed
// plan-A: pending → running → completed → merged
// plan-B: pending → running → failed
// Also includes build events (which must NOT affect planStatuses after AC #6)
// ---------------------------------------------------------------------------

const SESSION_EVENTS: StoredEvent[] = [
  makeEvent('session:start', { sessionId: 's1' }, 'ev-01'),
  makeEvent('phase:start', { sessionId: 's1', runId: 'run-1', planSet: 'test', command: 'build' }, 'ev-02'),

  // plan-A lifecycle
  makeEvent('plan:build:start', { sessionId: 's1', planId: 'plan-A' }, 'ev-03'),
  makeEvent('plan:status:change', { planId: 'plan-A', status: 'running' }, 'ev-04'),
  makeEvent('agent:start', {
    sessionId: 's1',
    planId: 'plan-A',
    agentId: 'agent-a1',
    agent: 'builder',
    model: 'claude-sonnet-4-5',
    harness: 'claude-sdk',
    harnessSource: 'tier',
    tier: 'heavy',
    tierSource: 'role',
    // AC #8: thinkingOriginal uses snake_case budget_tokens (Zod wire format)
    thinking: { type: 'enabled', budget_tokens: 8000 },
    thinkingSource: 'tier',
    effortClamped: false,
    effortOriginal: 'medium',
    thinkingCoerced: true,
    thinkingOriginal: { type: 'enabled', budget_tokens: 32000 },
  }, 'ev-05'),
  makeEvent('agent:stop', { sessionId: 's1', planId: 'plan-A', agentId: 'agent-a1', agent: 'builder' }, 'ev-06'),
  makeEvent('plan:build:complete', { sessionId: 's1', planId: 'plan-A' }, 'ev-07'),
  makeEvent('plan:status:change', { planId: 'plan-A', status: 'completed' }, 'ev-08'),
  makeEvent('plan:merge:complete', { sessionId: 's1', planId: 'plan-A', commitSha: 'abc123' }, 'ev-09'),
  makeEvent('plan:status:change', { planId: 'plan-A', status: 'merged' }, 'ev-10'),

  // plan-B lifecycle
  makeEvent('plan:build:start', { sessionId: 's1', planId: 'plan-B' }, 'ev-11'),
  makeEvent('plan:status:change', { planId: 'plan-B', status: 'running' }, 'ev-12'),
  makeEvent('plan:build:failed', { sessionId: 's1', planId: 'plan-B', error: 'build error' }, 'ev-13'),
  makeEvent('plan:status:change', { planId: 'plan-B', status: 'failed' }, 'ev-14'),
  makeEvent('plan:error:set', { planId: 'plan-B', error: 'build error' }, 'ev-15'),

  makeEvent('session:end', { sessionId: 's1', result: { status: 'failed', durationMs: 60000 } }, 'ev-16'),
];

// ---------------------------------------------------------------------------
// AC #1 — Assertion 1: lifecycle events drive planStatuses correctly
// ---------------------------------------------------------------------------

describe('AC #1 regression gate', () => {
  it('plan:status:change(merged) sets planStatuses[plan-A] = "complete"', () => {
    const state = replayEvents(SESSION_EVENTS);
    expect(state.planStatuses['plan-A']).toBe('complete');
  });

  it('plan:status:change(failed) sets planStatuses[plan-B] = "failed"', () => {
    const state = replayEvents(SESSION_EVENTS);
    expect(state.planStatuses['plan-B']).toBe('failed');
  });

  it('mergeCommits captures commitSha from plan:merge:complete', () => {
    const state = replayEvents(SESSION_EVENTS);
    expect(state.mergeCommits['plan-A']).toBe('abc123');
  });

  // ---------------------------------------------------------------------------
  // AC #1 — Assertion 2: stripping lifecycle events proves no inference
  // If the reducer still infers from build events, this test would fail.
  // ---------------------------------------------------------------------------
  it('planStatuses is empty when all plan:status:change events are stripped', () => {
    const stripped = SESSION_EVENTS.filter(
      ({ event }) => event.type !== 'plan:status:change',
    );
    const state = replayEvents(stripped);
    // Without lifecycle events, planStatuses must be empty — no build-event inference
    expect(Object.keys(state.planStatuses)).toHaveLength(0);
  });

  it('plan:build:complete alone does NOT set planStatuses (no inference)', () => {
    // Replay only the build events for plan-A, no lifecycle events
    const buildOnly = SESSION_EVENTS.filter(({ event }) =>
      ['session:start', 'phase:start', 'plan:build:start', 'plan:build:complete'].includes(event.type),
    );
    const state = replayEvents(buildOnly);
    expect(state.planStatuses['plan-A']).toBeUndefined();
  });

  it('plan:build:failed alone does NOT set planStatuses (no inference)', () => {
    const buildOnly = SESSION_EVENTS.filter(({ event }) =>
      ['session:start', 'phase:start', 'plan:build:start', 'plan:build:failed'].includes(event.type),
    );
    const state = replayEvents(buildOnly);
    expect(state.planStatuses['plan-B']).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // AC #8 — Assertion 3: thinkingOriginal with snake_case survives round-trip
  // normalizeThinking() in handle-agent.ts maps budget_tokens → budgetTokens
  // ---------------------------------------------------------------------------
  it('thinkingOriginal with snake_case budget_tokens is normalized to camelCase', () => {
    const state = replayEvents(SESSION_EVENTS);
    const thread = state.agentThreads.find((t: AgentThread) => t.agentId === 'agent-a1');
    expect(thread).toBeDefined();
    // Wire sends budget_tokens (snake_case); reducer normalizes to budgetTokens (camelCase)
    expect(thread?.thinkingOriginal).toEqual({ type: 'enabled', budgetTokens: 32000 });
    expect(thread?.thinkingCoerced).toBe(true);
  });
});
