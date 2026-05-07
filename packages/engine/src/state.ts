import type { EforgeEvent, EforgeState } from './events.js';

/**
 * Single mutation entry point for EforgeState.
 *
 * Applies the given lifecycle event to the state in place and returns it.
 * Handles the five lifecycle event variants introduced in plan-01-foundation:
 *   plan:status:change, plan:error:set, plan:error:clear,
 *   merge:worktree:set, merge:worktree:clear.
 *
 * All other event types are ignored (no-op, returns state unchanged).
 *
 * Convention: All engine code that mutates plan.status, plan.error,
 * state.completedPlans, or state.mergeWorktreePath must go through this
 * function. Direct field assignments to those properties outside this file
 * are forbidden — the grep gate enforces zero hits outside state.ts.
 */
export function mutateState(state: EforgeState, event: EforgeEvent): EforgeState {
  switch (event.type) {
    case 'plan:status:change': {
      const plan = state.plans[event.planId];
      if (!plan) break;
      plan.status = event.status;
      if (
        (event.status === 'completed' || event.status === 'merged') &&
        !state.completedPlans.includes(event.planId)
      ) {
        state.completedPlans.push(event.planId);
      }
      break;
    }
    case 'plan:error:set': {
      const plan = state.plans[event.planId];
      if (!plan) break;
      plan.error = event.error;
      break;
    }
    case 'plan:error:clear': {
      const plan = state.plans[event.planId];
      if (!plan) break;
      delete plan.error;
      break;
    }
    case 'merge:worktree:set': {
      state.mergeWorktreePath = event.path;
      break;
    }
    case 'merge:worktree:clear': {
      delete state.mergeWorktreePath;
      break;
    }
    default:
      break;
  }
  return state;
}

/**
 * Convenience wrapper that directly sets a plan's status in state, updating
 * completedPlans when the status is 'completed' or 'merged'.
 *
 * Throws if planId is not present in state.plans. All callers must go through
 * this function rather than assigning plan.status directly.
 */
export function updatePlanStatus(
  state: EforgeState,
  planId: string,
  status: EforgeState['plans'][string]['status'],
): void {
  const plan = state.plans[planId];
  if (!plan) {
    throw new Error(`Unknown plan: ${planId}`);
  }
  plan.status = status;
  if (
    (status === 'completed' || status === 'merged') &&
    !state.completedPlans.includes(planId)
  ) {
    state.completedPlans.push(planId);
  }
}
