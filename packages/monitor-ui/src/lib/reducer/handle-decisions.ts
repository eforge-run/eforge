/**
 * Handler for build-phase orchestrator decision events.
 *
 * Owns: decisions (keyed by planId).
 */
import type { EventHandler } from './handler-types';

/**
 * plan:build:decision — appends the inner decision payload to decisions[planId].
 *
 * Mirrors the append-to-nested-record pattern used by
 * handlePlanBuildReviewPerspectiveComplete (handle-plan-build.ts:135-146).
 */
export const handlePlanBuildDecision: EventHandler<'plan:build:decision'> = (event, state) => {
  const { planId, decision } = event;
  return {
    decisions: {
      ...state.decisions,
      [planId]: [...(state.decisions[planId] ?? []), decision],
    },
  };
};
