/**
 * Test E from the validation plan.
 *
 * End-to-end regression that captures the user-visible symptom:
 *   1. Replay a compile-mode fixture containing a `planning:complete` event
 *      with non-trivial dependsOn relationships.
 *   2. Compute `effectiveOrchestration = state.orchestration ?? state.earlyOrchestration`
 *      with `state.orchestration === null` (the SWR fetch hasn't returned —
 *      this is exactly the window during which the user reports the bug).
 *   3. Assert that today, no dependency-graph data is reachable through
 *      `effectiveOrchestration`, even though the source data is present in
 *      the event log.
 *
 * If this test ever passes (effectiveOrchestration becoming non-null after
 * the fix lands), the regression is captured. If it fails to capture the
 * symptom even today, our hypothesis about the bug location is wrong and
 * the proposed fix needs re-investigation.
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

  it('TODAY: replaying the fixture leaves effectiveOrchestration null when SWR fetch returns null', () => {
    const state = (fixtureEvents as unknown as FixtureEntry[]).reduce(
      (acc, { event, eventId }) => eforgeReducer(acc, { type: 'ADD_EVENT', event, eventId }),
      initialRunState,
    );

    // The component-level `effectiveOrchestration` resolution from app.tsx:161–164.
    // We simulate the in-flight window where the SWR fetch has not yet returned
    // (the daemon serves 200 + null until planning:complete is logged, and SWR
    // caches that null until focus revalidation).
    const swrOrchestration: OrchestrationConfig | null = null;
    const effectiveOrchestration = swrOrchestration ?? state.earlyOrchestration;

    // The bug: even though the planning:complete event has been processed
    // (state.planStatuses is populated), there's no orchestration object the
    // UI can read dependsOn / build / depth data from.
    expect(state.planStatuses).toEqual({ 'plan-01': 'complete', 'plan-02': 'complete' });
    expect(effectiveOrchestration).toBeNull();

    // Stronger framing: the dependency-graph data carried by the event is
    // unreachable through any RunState field accessible to the UI.
    expect(state.earlyOrchestration).toBeNull();
    expect(state.expeditionModules).toHaveLength(0); // not expedition mode
  });

  // Forward-looking contract for the post-fix state. Marked `todo` so the
  // suite stays green until the fix lands. The eforge build that implements
  // `handlePlanningComplete` synthesizing `earlyOrchestration` should
  // convert this to a real `it(...)` block and assert:
  //   - effectiveOrchestration is non-null
  //   - plans.length === 2
  //   - plans[0].dependsOn === []
  //   - plans[1].dependsOn === ['plan-01']
  // Plan reference: ~/.claude/plans/i-am-noticing-bugginess-synthetic-meadow.md
  it.todo('DESIRED: after the fix, effectiveOrchestration is populated immediately with dependsOn');
});
