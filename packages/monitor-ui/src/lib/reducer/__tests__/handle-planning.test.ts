/**
 * Tests for compile-phase planning event handling.
 *
 * Test A from the validation plan: prove the reducer synthesizes earlyOrchestration
 * from dependency-graph data carried in `planning:complete` events.
 */
import { describe, it, expect } from 'vitest';
import { handlePlanningComplete } from '../handle-planning';
import { initialRunState } from '../../reducer';
import type { EforgeEvent } from '../../types';

function makeEvent<T extends EforgeEvent['type']>(
  type: T,
  extra: object,
): Extract<EforgeEvent, { type: T }> {
  return { type, timestamp: '2024-01-15T10:00:00.000Z', sessionId: 's1', ...extra } as unknown as Extract<EforgeEvent, { type: T }>;
}

const PLANS = [
  {
    id: 'plan-01',
    name: 'Plan One',
    dependsOn: [],
    branch: 'feature/plan-01',
    body: 'Body 1',
    filePath: '.eforge/plans/plan-01.md',
  },
  {
    id: 'plan-02',
    name: 'Plan Two',
    dependsOn: ['plan-01'],
    branch: 'feature/plan-02',
    body: 'Body 2',
    filePath: '.eforge/plans/plan-02.md',
  },
];

describe('handlePlanningComplete', () => {
  it('seeds planStatuses with plan for every submitted plan', () => {
    const event = makeEvent('planning:complete', { plans: PLANS });
    const delta = handlePlanningComplete(event, initialRunState);
    expect(delta?.planStatuses).toEqual({
      'plan-01': 'plan',
      'plan-02': 'plan',
    });
  });

  // ---------------------------------------------------------------------------
  // Test A — earlyOrchestration synthesis
  // ---------------------------------------------------------------------------
  // The event payload carries plan IDs and dependsOn. handlePlanningComplete now
  // synthesizes earlyOrchestration so ThreadPipeline can render dependency edges,
  // depth bars, and tooltips immediately — before the SWR HTTP fetch returns.
  describe('Test A: dependency-graph data synthesized into earlyOrchestration', () => {
    it('event carries dependsOn relationships', () => {
      // Pre-condition: confirm the fixture-style event we feed actually carries
      // the data the UI needs. If this assertion fails, the test is wrong.
      const event = makeEvent('planning:complete', { plans: PLANS });
      expect(event.plans[1].dependsOn).toEqual(['plan-01']);
    });

    it('handler populates earlyOrchestration with compile mode', () => {
      const event = makeEvent('planning:complete', { plans: PLANS });
      const delta = handlePlanningComplete(event, initialRunState);
      expect(delta?.earlyOrchestration).not.toBeNull();
      expect(delta?.earlyOrchestration?.mode).toBe('compile');
      expect(delta?.earlyOrchestration?.pipeline?.scope).toBe('plan');
    });

    it('earlyOrchestration plans carry dependsOn from the event', () => {
      const event = makeEvent('planning:complete', { plans: PLANS });
      const delta = handlePlanningComplete(event, initialRunState);
      expect(delta?.earlyOrchestration?.plans).toHaveLength(2);
      expect(delta?.earlyOrchestration?.plans?.[0]?.id).toBe('plan-01');
      expect(delta?.earlyOrchestration?.plans?.[0]?.dependsOn).toEqual([]);
      expect(delta?.earlyOrchestration?.plans?.[1]?.id).toBe('plan-02');
      expect(delta?.earlyOrchestration?.plans?.[1]?.dependsOn).toEqual(['plan-01']);
    });

    it('dependency information is reachable in state after applying the delta', () => {
      const event = makeEvent('planning:complete', { plans: PLANS });
      const delta = handlePlanningComplete(event, initialRunState);
      const newState = { ...initialRunState, ...delta };
      expect(newState.earlyOrchestration).not.toBeNull();
      expect(newState.earlyOrchestration?.plans?.[1]?.dependsOn).toEqual(['plan-01']);
      // moduleStatuses is the expedition-mode equivalent — not used in compile.
      expect(Object.keys(newState.moduleStatuses)).toHaveLength(0);
    });

    it('plans default to empty build and auto review when planConfigs absent', () => {
      const event = makeEvent('planning:complete', { plans: PLANS });
      const delta = handlePlanningComplete(event, initialRunState);
      expect(delta?.earlyOrchestration?.plans?.[0]?.build).toEqual([]);
      expect(delta?.earlyOrchestration?.plans?.[0]?.review?.strategy).toBe('auto');
      expect(delta?.earlyOrchestration?.plans?.[0]?.review?.maxRounds).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Test A variant — planConfigs propagation
  // ---------------------------------------------------------------------------
  describe('Test A variant: planConfigs propagate to synthesized plans', () => {
    it('propagates build and review from planConfigs when present', () => {
      const planConfigs = [
        {
          id: 'plan-01',
          build: ['npm run build'],
          review: {
            strategy: 'parallel' as const,
            perspectives: ['security'],
            maxRounds: 2,
            evaluatorStrictness: 'strict' as const,
          },
        },
      ];
      const event = makeEvent('planning:complete', { plans: PLANS, planConfigs });
      const delta = handlePlanningComplete(event, initialRunState);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const plan01 = delta?.earlyOrchestration?.plans?.find((p: any) => p.id === 'plan-01');
      expect(plan01?.build).toEqual(['npm run build']);
      expect(plan01?.review?.strategy).toBe('parallel');
      expect(plan01?.review?.maxRounds).toBe(2);
      expect(plan01?.review?.evaluatorStrictness).toBe('strict');
    });

    it('plans without planConfigs entry keep defaults', () => {
      const planConfigs = [{ id: 'plan-01', build: ['npm test'] }];
      const event = makeEvent('planning:complete', { plans: PLANS, planConfigs });
      const delta = handlePlanningComplete(event, initialRunState);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const plan02 = delta?.earlyOrchestration?.plans?.find((p: any) => p.id === 'plan-02');
      expect(plan02?.build).toEqual([]);
      expect(plan02?.review?.strategy).toBe('auto');
    });
  });
});
