import { describe, it, expect } from 'vitest';
import { handleAgentStart, handleAgentUsage, handleAgentResult, handleAgentStop } from '../handle-agent';
import { initialRunState } from '../../reducer';
import type { AgentThread } from '../../reducer';
import type { EforgeEvent } from '../../types';

function makeEvent<T extends EforgeEvent['type']>(
  type: T,
  extra: object,
): Extract<EforgeEvent, { type: T }> {
  return { type, timestamp: '2024-01-15T10:00:00.000Z', sessionId: 's1', ...extra } as unknown as Extract<EforgeEvent, { type: T }>;
}

function makeThread(overrides: Partial<AgentThread> = {}): AgentThread {
  return {
    agentId: 'a1',
    agent: 'builder',
    planId: 'plan-01',
    startedAt: '2024-01-15T10:00:00.000Z',
    endedAt: null,
    durationMs: null,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    cacheRead: null,
    costUsd: null,
    numTurns: null,
    model: 'claude-sonnet',
    ...overrides,
  };
}

describe('handle-agent', () => {
  // ---------------------------------------------------------------------------
  // agent:start — all 11 enumerated fields
  // ---------------------------------------------------------------------------
  describe('handleAgentStart', () => {
    it('populates all 11 enumerated runtime fields on the new AgentThread', () => {
      const event = makeEvent('agent:start', {
        agentId: 'a1',
        agent: 'builder',
        planId: 'plan-01',
        model: 'claude-sonnet-4-5',
        harness: 'claude-sdk',
        harnessSource: 'tier',
        tier: 'heavy',
        tierSource: 'role',
        effort: 'high',
        effortSource: 'role',
        thinking: { type: 'enabled', budgetTokens: 8000 },
        thinkingSource: 'role',
        effortClamped: false,
        effortOriginal: 'high',
        perspective: 'security',
      });
      const delta = handleAgentStart(event, initialRunState);
      expect(delta?.agentThreads).toHaveLength(1);
      const thread = delta?.agentThreads?.[0];
      // The 11 enumerated runtime fields:
      expect(thread?.tier).toBe('heavy');
      expect(thread?.tierSource).toBe('role');
      expect(thread?.effort).toBe('high');
      expect(thread?.effortSource).toBe('role');
      expect(thread?.thinking).toBe('enabled (8.0k tokens)');
      expect(thread?.thinkingSource).toBe('role');
      expect(thread?.harness).toBe('claude-sdk');
      expect(thread?.harnessSource).toBe('tier');
      expect(thread?.effortClamped).toBe(false);
      expect(thread?.effortOriginal).toBe('high');
      expect(thread?.perspective).toBe('security');
    });

    it('initializes numeric fields to null, endedAt to null, durationMs to null', () => {
      const event = makeEvent('agent:start', {
        agentId: 'a1',
        agent: 'builder',
        model: 'claude-haiku',
        harness: 'claude-sdk',
        harnessSource: 'tier',
        tier: 'light',
        tierSource: 'role',
      });
      const delta = handleAgentStart(event, initialRunState);
      const thread = delta?.agentThreads?.[0];
      expect(thread?.endedAt).toBeNull();
      expect(thread?.durationMs).toBeNull();
      expect(thread?.inputTokens).toBeNull();
      expect(thread?.outputTokens).toBeNull();
      expect(thread?.totalTokens).toBeNull();
      expect(thread?.cacheRead).toBeNull();
      expect(thread?.costUsd).toBeNull();
      expect(thread?.numTurns).toBeNull();
    });

    it('appends to existing agentThreads (does not replace)', () => {
      const existing = makeThread({ agentId: 'existing', agent: 'planner', planId: undefined });
      const state = { ...initialRunState, agentThreads: [existing] };
      const event = makeEvent('agent:start', {
        agentId: 'a1',
        agent: 'builder',
        model: 'claude-sonnet',
        harness: 'claude-sdk',
        harnessSource: 'tier',
        tier: 'heavy',
        tierSource: 'role',
      });
      const delta = handleAgentStart(event, state);
      expect(delta?.agentThreads).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------
  // agent:usage — delta and final paths
  // ---------------------------------------------------------------------------
  describe('handleAgentUsage', () => {
    it('(a) non-final adds to liveAgentUsage[agentId] numeric fields additively', () => {
      const state = {
        ...initialRunState,
        agentThreads: [makeThread({ agentId: 'a1' })],
        liveAgentUsage: { a1: { input: 100, output: 50, cacheRead: 20, cacheCreation: 0, cost: 0.001, turns: 1 } },
      };
      const event = makeEvent('agent:usage', {
        agentId: 'a1',
        agent: 'builder',
        usage: { input: 200, output: 100, total: 300, cacheRead: 40, cacheCreation: 10 },
        costUsd: 0.002,
        numTurns: 1,
        // final: false is the default (omitted = non-final)
      });
      const delta = handleAgentUsage(event, state);
      expect(delta?.liveAgentUsage?.['a1']).toEqual({
        input: 300,
        output: 150,
        cacheRead: 60,
        cacheCreation: 10,
        cost: 0.003,
        turns: 2,
      });
    });

    it('seeds liveAgentUsage from zero on first delta event for an agent', () => {
      const state = {
        ...initialRunState,
        agentThreads: [makeThread({ agentId: 'a1' })],
      };
      const event = makeEvent('agent:usage', {
        agentId: 'a1',
        agent: 'builder',
        usage: { input: 500, output: 250, total: 750, cacheRead: 0, cacheCreation: 0 },
        costUsd: 0.005,
        numTurns: 1,
      });
      const delta = handleAgentUsage(event, state);
      expect(delta?.liveAgentUsage?.['a1']).toMatchObject({ input: 500, output: 250, turns: 1 });
    });

    it('(b) final overwrites liveAgentUsage[agentId] with event totals (last-wins)', () => {
      const state = {
        ...initialRunState,
        agentThreads: [makeThread({ agentId: 'a1', inputTokens: 100, outputTokens: 50 })],
        liveAgentUsage: { a1: { input: 100, output: 50, cacheRead: 0, cacheCreation: 0, cost: 0.001, turns: 1 } },
      };
      const event = makeEvent('agent:usage', {
        agentId: 'a1',
        agent: 'builder',
        usage: { input: 2000, output: 1000, total: 3000, cacheRead: 400, cacheCreation: 100 },
        costUsd: 0.02,
        numTurns: 5,
        final: true,
      });
      const delta = handleAgentUsage(event, state);
      expect(delta?.liveAgentUsage?.['a1']).toEqual({
        input: 2000,
        output: 1000,
        cacheRead: 400,
        cacheCreation: 100,
        cost: 0.02,
        turns: 5,
      });
      // Also updates the thread's token fields
      const thread = delta?.agentThreads?.[0];
      expect(thread?.inputTokens).toBe(2000);
      expect(thread?.outputTokens).toBe(1000);
      expect(thread?.totalTokens).toBe(3000);
      expect(thread?.numTurns).toBe(5);
    });
  });

  // ---------------------------------------------------------------------------
  // agent:result — reverse-walk thread matching, token accumulation
  // ---------------------------------------------------------------------------
  describe('handleAgentResult', () => {
    it('accumulates tokens into global totals', () => {
      const state = { ...initialRunState, tokensIn: 100, tokensOut: 50, totalCost: 0.001 };
      const event = makeEvent('agent:result', {
        agent: 'builder',
        planId: 'plan-01',
        result: {
          durationMs: 5000,
          durationApiMs: 4000,
          numTurns: 2,
          totalCostUsd: 0.01,
          usage: { input: 1000, output: 500, total: 1500, cacheRead: 200, cacheCreation: 50 },
          modelUsage: {},
        },
      });
      const delta = handleAgentResult(event, state);
      expect(delta?.tokensIn).toBe(1100);
      expect(delta?.tokensOut).toBe(550);
      expect(delta?.totalCost).toBeCloseTo(0.011, 5);
    });

    it('(c) reverse-walk: updates the MOST RECENT thread matching (agent, planId) with durationMs === null', () => {
      // Two threads for the same (agent, planId) both with durationMs === null
      const olderThread = makeThread({ agentId: 'a0', agent: 'builder', planId: 'plan-01', durationMs: null });
      const newerThread = makeThread({ agentId: 'a1', agent: 'builder', planId: 'plan-01', durationMs: null });
      const state = { ...initialRunState, agentThreads: [olderThread, newerThread] };

      const event = makeEvent('agent:result', {
        agent: 'builder',
        planId: 'plan-01',
        result: {
          durationMs: 12000,
          durationApiMs: 11000,
          numTurns: 3,
          totalCostUsd: 0.005,
          usage: { input: 800, output: 400, total: 1200, cacheRead: 100, cacheCreation: 0 },
          modelUsage: {},
        },
      });
      const delta = handleAgentResult(event, state);
      const threads = delta?.agentThreads ?? [];
      // newerThread (index 1 / agentId a1) should be updated
      expect(threads[1]?.agentId).toBe('a1');
      expect(threads[1]?.durationMs).toBe(12000);
      // olderThread (index 0 / agentId a0) should be untouched
      expect(threads[0]?.agentId).toBe('a0');
      expect(threads[0]?.durationMs).toBeNull();
    });

    it('removes liveAgentUsage entry for the matched thread agentId', () => {
      const thread = makeThread({ agentId: 'a1', agent: 'reviewer', planId: 'plan-01', durationMs: null });
      const state = {
        ...initialRunState,
        agentThreads: [thread],
        liveAgentUsage: { a1: { input: 1000, output: 500, cacheRead: 0, cacheCreation: 0, cost: 0.01, turns: 2 } },
      };
      const event = makeEvent('agent:result', {
        agent: 'reviewer',
        planId: 'plan-01',
        result: {
          durationMs: 8000,
          durationApiMs: 7000,
          numTurns: 2,
          totalCostUsd: 0.01,
          usage: { input: 1000, output: 500, total: 1500, cacheRead: 0, cacheCreation: 0 },
          modelUsage: {},
        },
      });
      const delta = handleAgentResult(event, state);
      expect(delta?.liveAgentUsage?.['a1']).toBeUndefined();
    });

    it('returns only token deltas when no matching thread is found', () => {
      const event = makeEvent('agent:result', {
        agent: 'builder',
        planId: 'plan-42',
        result: {
          durationMs: 1000,
          durationApiMs: 900,
          numTurns: 1,
          totalCostUsd: 0.001,
          usage: { input: 100, output: 50, total: 150, cacheRead: 0, cacheCreation: 0 },
          modelUsage: {},
        },
      });
      const delta = handleAgentResult(event, initialRunState);
      // Token fields present
      expect(delta?.tokensIn).toBe(100);
      // No thread changes
      expect(delta?.agentThreads).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // agent:stop
  // ---------------------------------------------------------------------------
  describe('handleAgentStop', () => {
    it('(e) sets endedAt on the matching thread', () => {
      const thread = makeThread({ agentId: 'a1' });
      const state = {
        ...initialRunState,
        agentThreads: [thread],
        liveAgentUsage: { a1: { input: 100, output: 50, cacheRead: 0, cacheCreation: 0, cost: 0.001, turns: 1 } },
      };
      const event = makeEvent('agent:stop', { agentId: 'a1', agent: 'builder' });
      const delta = handleAgentStop(event, state);
      expect(delta?.agentThreads?.[0]?.endedAt).toBe('2024-01-15T10:00:00.000Z');
    });

    it('(e) deletes liveAgentUsage[agentId]', () => {
      const thread = makeThread({ agentId: 'a1' });
      const state = {
        ...initialRunState,
        agentThreads: [thread],
        liveAgentUsage: { a1: { input: 100, output: 50, cacheRead: 0, cacheCreation: 0, cost: 0.001, turns: 1 } },
      };
      const event = makeEvent('agent:stop', { agentId: 'a1', agent: 'builder' });
      const delta = handleAgentStop(event, state);
      expect(Object.keys(delta?.liveAgentUsage ?? {})).not.toContain('a1');
    });

    it('agent:stop does not affect other agents in liveAgentUsage', () => {
      const threads = [makeThread({ agentId: 'a1' }), makeThread({ agentId: 'a2' })];
      const state = {
        ...initialRunState,
        agentThreads: threads,
        liveAgentUsage: {
          a1: { input: 100, output: 50, cacheRead: 0, cacheCreation: 0, cost: 0.001, turns: 1 },
          a2: { input: 200, output: 100, cacheRead: 0, cacheCreation: 0, cost: 0.002, turns: 2 },
        },
      };
      const event = makeEvent('agent:stop', { agentId: 'a1', agent: 'builder' });
      const delta = handleAgentStop(event, state);
      expect(delta?.liveAgentUsage?.['a2']).toBeDefined();
      expect(delta?.liveAgentUsage?.['a1']).toBeUndefined();
    });
  });
});
