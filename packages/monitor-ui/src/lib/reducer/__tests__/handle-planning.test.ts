/**
 * Tests for compile-phase planning event handling.
 *
 * Test A from the validation plan: prove the reducer drops dependency-graph
 * data carried in `planning:complete` events. These tests assert TODAY's
 * behavior; they will need to be updated alongside the fix that synthesizes
 * `earlyOrchestration` from the event payload.
 *
 * If these assertions ever flip without an accompanying fix, our hypothesis
 * about the source of the user-visible bug (delayed swim-lane stages and
 * missing dependency edges) needs re-investigation.
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
  // Test A — gap proof
  // ---------------------------------------------------------------------------
  // The event payload carries plan IDs and dependsOn. ThreadPipeline derives
  // dependency edges, depth bars, and dependency-tooltip text from
  // `orchestration.plans[].dependsOn`. With orchestration null and no early
  // synthesis, this data round-trips through the event but is unreachable in
  // the UI until the SWR HTTP fetch eventually completes.
  describe('Test A: dependency-graph data carried by planning:complete is dropped', () => {
    it('event carries dependsOn relationships', () => {
      // Pre-condition: confirm the fixture-style event we feed actually carries
      // the data the UI needs. If this assertion fails, the test is wrong.
      const event = makeEvent('planning:complete', { plans: PLANS });
      expect(event.plans[1].dependsOn).toEqual(['plan-01']);
    });

    it('TODAY: handler does not populate earlyOrchestration', () => {
      const event = makeEvent('planning:complete', { plans: PLANS });
      const delta = handlePlanningComplete(event, initialRunState);
      // The handler returns only { planStatuses }. earlyOrchestration is
      // either absent from the delta or null — either way, it does not
      // surface dependsOn data to the UI.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const earlyOrch = (delta as any)?.earlyOrchestration;
      expect(earlyOrch == null).toBe(true);
    });

    it('TODAY: dependency information is unreachable downstream', () => {
      // Replay a state and confirm that even after applying the delta, no
      // mechanism in the reducer surfaces dependsOn data anywhere in
      // RunState. The UI component that needs it (ThreadPipeline) reads
      // exclusively from `state.earlyOrchestration` (or the SWR-fetched
      // orchestration prop, which is null in this test).
      const event = makeEvent('planning:complete', { plans: PLANS });
      const delta = handlePlanningComplete(event, initialRunState);
      const newState = { ...initialRunState, ...delta };
      expect(newState.earlyOrchestration).toBeNull();
      // moduleStatuses is the expedition-mode equivalent — not used in compile.
      expect(Object.keys(newState.moduleStatuses)).toHaveLength(0);
    });
  });
});
