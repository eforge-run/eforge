/**
 * Plan lifecycle guards - validates status transitions before delegating
 * to the single-entry-point `mutateState()` mutator in state.ts.
 */

import type { EforgeState, PlanState } from '../events.js';
import { mutateState } from '../state.js';

type PlanStatus = PlanState['status'];

/**
 * Valid transitions: from-status -> list of allowed to-statuses.
 *
 * pending  -> running  (plan starts executing)
 * pending  -> blocked  (dependency failed)
 * running  -> completed (plan finished successfully)
 * running  -> failed   (plan errored)
 * completed -> merged  (squash-merged into feature branch)
 * completed -> failed  (merge failed or skipped due to dep merge failure)
 * failed   -> pending  (resume resets failed plans)
 * blocked  -> pending  (resume unblocks when deps resolve)
 */
export const VALID_TRANSITIONS: Record<PlanStatus, PlanStatus[]> = {
  pending: ['running', 'blocked'],
  running: ['completed', 'failed', 'pending'],
  completed: ['merged', 'failed'],
  failed: ['pending'],
  blocked: ['pending'],
  merged: [],
};

export interface TransitionMetadata {
  error?: string;
}

/**
 * Resume a EforgeState by resetting running plans to pending and
 * re-evaluating blocked plans whose dependencies have resolved.
 */
export function resumeState(state: EforgeState): EforgeState {
  // Reset running plans to pending for re-execution
  for (const [id, plan] of Object.entries(state.plans)) {
    if (plan.status === 'running') {
      // Clear any prior error before transitioning back to pending
      if (plan.error !== undefined) {
        mutateState(state, { type: 'plan:error:clear', planId: id, timestamp: new Date().toISOString() });
      }
      transitionPlan(state, id, 'pending');
    }
  }
  // Re-evaluate blocked plans — unblock if all deps resolved
  for (const [planId, plan] of Object.entries(state.plans)) {
    if (plan.status === 'blocked') {
      const allDepsResolved = plan.dependsOn.every((dep) => {
        const depState = state.plans[dep];
        return depState && (depState.status === 'completed' || depState.status === 'merged');
      });
      if (allDepsResolved) {
        transitionPlan(state, planId, 'pending');
      }
    }
  }
  return state;
}

/**
 * Transition a plan to a new status, validating the transition is legal.
 * Throws if the transition is not in `VALID_TRANSITIONS`.
 *
 * Routes all state mutations through `mutateState()` from state.ts —
 * the single mutation entry point — rather than assigning fields directly.
 */
export function transitionPlan(
  state: EforgeState,
  planId: string,
  to: PlanStatus,
  metadata?: TransitionMetadata,
): EforgeState {
  const plan = state.plans[planId];
  if (!plan) {
    throw new Error(`Unknown plan ID: '${planId}'`);
  }

  const from = plan.status;
  const allowed = VALID_TRANSITIONS[from];

  if (!allowed.includes(to)) {
    throw new Error(
      `Invalid plan transition for '${planId}': '${from}' -> '${to}'. ` +
      `Allowed transitions from '${from}': [${allowed.map((s) => `'${s}'`).join(', ')}]`,
    );
  }

  // Route status change through the single mutation entry point
  mutateState(state, {
    type: 'plan:status:change',
    planId,
    status: to,
    timestamp: new Date().toISOString(),
  });

  // Route error metadata through the single mutation entry point
  if (metadata?.error !== undefined) {
    mutateState(state, {
      type: 'plan:error:set',
      planId,
      error: metadata.error,
      timestamp: new Date().toISOString(),
    });
  }

  return state;
}
