/**
 * Plan lifecycle guards - validates status transitions before delegating
 * to the single-entry-point `mutateState()` mutator in state.ts.
 *
 * `transitionPlan` returns the lifecycle events it produced so callers can
 * forward them to the SSE event stream. State mutation via `mutateState`
 * always happens synchronously before the events are returned, so consumers
 * receive the notification after the state has already been applied.
 */

import type { EforgeEvent, EforgeState, PlanState } from '../events.js';
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
 * Transition a plan to a new status, validating the transition is legal.
 * Throws if the transition is not in `VALID_TRANSITIONS`.
 *
 * Routes all state mutations through `mutateState()` from state.ts —
 * the single mutation entry point — rather than assigning fields directly.
 *
 * Returns the lifecycle events produced (plan:status:change and optionally
 * plan:error:set). Callers should forward these to the SSE event stream.
 * State mutation happens synchronously before the events are returned.
 */
export function transitionPlan(
  state: EforgeState,
  planId: string,
  to: PlanStatus,
  metadata?: TransitionMetadata,
): EforgeEvent[] {
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

  const events: EforgeEvent[] = [];

  // Route status change through the single mutation entry point
  const statusChangeEvent: EforgeEvent = {
    type: 'plan:status:change',
    planId,
    status: to,
    timestamp: new Date().toISOString(),
  };
  mutateState(state, statusChangeEvent);
  events.push(statusChangeEvent);

  // Route error metadata through the single mutation entry point
  if (metadata?.error !== undefined) {
    const errorEvent: EforgeEvent = {
      type: 'plan:error:set',
      planId,
      error: metadata.error,
      timestamp: new Date().toISOString(),
    };
    mutateState(state, errorEvent);
    events.push(errorEvent);
  }

  return events;
}
