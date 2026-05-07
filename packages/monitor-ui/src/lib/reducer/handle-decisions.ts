/**
 * Handlers for build-phase and plan-phase decision events.
 *
 * Owns: decisions (keyed by planId for build-phase, '__run__' for plan-phase).
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

/**
 * planning:decision — appends the inner decision payload to decisions[planId]
 * when a planId is present, or to decisions['__run__'] for session-level
 * planning decisions (scope, build-pipeline, review-profile, plan-set-shape).
 *
 * The `'__run__'` sentinel identifies decisions that apply to the entire
 * planning session rather than a specific plan.
 */
export const handlePlanningDecision: EventHandler<'planning:decision'> = (event, state) => {
  const { planId, decision } = event;
  const key = planId ?? '__run__';
  return {
    decisions: {
      ...state.decisions,
      [key]: [...(state.decisions[key] ?? []), decision],
    },
  };
};
