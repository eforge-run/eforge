/**
 * Test E from the validation plan.
 *
 * End-to-end regression that verifies the fix for the user-visible symptom:
 *   1. Replay a compile-mode fixture containing a `planning:complete` event
 *      with non-trivial dependsOn relationships.
 *   2. Compute `effectiveOrchestration = state.orchestration ?? state.earlyOrchestration`
 *      with `state.orchestration === null` (the SWR fetch hasn't returned —
 *      this is exactly the window during which the user reports the bug).
 *   3. Assert that after the fix, dependency-graph data IS reachable through
 *      `effectiveOrchestration` immediately after the event is processed.
 */
import { describe, it, expect } from 'vitest';
import { eforgeReducer, initialRunState } from '../../reducer';
import type { EforgeEvent, OrchestrationConfig } from '../../types';
import fixtureEvents from './fixtures/sample-build.json';

type FixtureEntry = { event: EforgeEvent; eventId: string };

describe('regression: orchestration data gap during compile-mode planning', () => {
  it('the fixture contains planning:complete with dependsOn data (sanity)', () => {
    const planningComplete = (fixtureEvents as unknown as FixtureEntry[])
      .map((f) => f.event)
      .find((e): e is Extract<EforgeEvent, { type: 'planning:complete' }> => e.type === 'planning:complete');

    expect(planningComplete).toBeDefined();
    // The data the UI needs IS in the event payload.
    expect(planningComplete!.plans).toHaveLength(2);
    expect(planningComplete!.plans[0].id).toBe('plan-01');
    expect(planningComplete!.plans[0].dependsOn).toEqual([]);
    expect(planningComplete!.plans[1].id).toBe('plan-02');
    expect(planningComplete!.plans[1].dependsOn).toEqual(['plan-01']);
  });

  it('after the fix, effectiveOrchestration is populated immediately with dependsOn', () => {
    const state = (fixtureEvents as unknown as FixtureEntry[]).reduce(
      (acc, { event, eventId }) => eforgeReducer(acc, { type: 'ADD_EVENT', event, eventId }),
      initialRunState,
    );

    // The component-level `effectiveOrchestration` resolution from app.tsx:161–164.
    // We simulate the in-flight window where the SWR fetch has not yet returned.
    const swrOrchestration: OrchestrationConfig | null = null;
    const effectiveOrchestration = swrOrchestration ?? state.earlyOrchestration;

    // After the fix: earlyOrchestration is synthesized from the planning:complete
    // event, so effectiveOrchestration is non-null even before the SWR fetch returns.
    // planStatuses ends at 'evaluate' because this fixture lacks plan:status:change events
    // (status is now driven exclusively by those lifecycle events, not build events).
    expect(state.planStatuses).toEqual({ 'plan-01': 'evaluate', 'plan-02': 'evaluate' });
    expect(effectiveOrchestration).not.toBeNull();
    expect(effectiveOrchestration?.plans).toHaveLength(2);
    expect(effectiveOrchestration?.plans[0].dependsOn).toEqual([]);
    expect(effectiveOrchestration?.plans[1].dependsOn).toEqual(['plan-01']);
    expect(state.expeditionModules).toHaveLength(0); // not expedition mode
  });
});
