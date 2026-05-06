/**
 * Handlers for plan lifecycle state events.
 *
 * Owns: planStatuses (driven exclusively by plan:status:change events)
 *
 * Stage-advancement for plan:status:change status values:
 *   pending   → no-op (plan reset — leave prior stage visible or unset)
 *   running   → 'implement'  (replaces plan:build:start / plan:build:implement:start inference)
 *   completed → 'complete'   (replaces plan:build:complete inference)
 *   failed    → 'failed'     (replaces plan:build:failed inference)
 *   blocked   → 'failed'     (blocked plans are shown as failed in the UI)
 *   merged    → 'complete'   (replaces plan:merge:complete inference)
 *
 * plan:error:set   — engine-side error tracking; no per-session UI state effect.
 * plan:error:clear — engine-side error tracking; no per-session UI state effect.
 * merge:worktree:set   — daemon-scoped concern; no per-session UI state effect.
 * merge:worktree:clear — daemon-scoped concern; no per-session UI state effect.
 */
import type { PipelineStage } from '../types';
import type { EventHandler } from './handler-types';

// ---------------------------------------------------------------------------
// Helper: map engine plan status to UI pipeline stage
// ---------------------------------------------------------------------------

function toStage(status: string): PipelineStage | undefined {
  switch (status) {
    case 'running':   return 'implement';
    case 'completed': return 'complete';
    case 'failed':    return 'failed';
    case 'blocked':   return 'failed';
    case 'merged':    return 'complete';
    case 'pending':   return undefined; // plan reset — do not advance stage
    default:          return undefined;
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * plan:status:change — maps engine PlanStatus to UI PipelineStage.
 * This is the sole driver of planStatuses in the session reducer;
 * build-event inference heuristics have been removed from handle-plan-build.ts.
 */
export const handlePlanStatusChange: EventHandler<'plan:status:change'> = (event, state) => {
  const stage = toStage(event.status);
  if (stage === undefined) return undefined;
  return { planStatuses: { ...state.planStatuses, [event.planId]: stage } };
};

/** plan:error:set — engine-side error tracking; no per-session UI state effect. */
export const handlePlanErrorSet: EventHandler<'plan:error:set'> = (_event, _state) => undefined;

/** plan:error:clear — engine-side error tracking; no per-session UI state effect. */
export const handlePlanErrorClear: EventHandler<'plan:error:clear'> = (_event, _state) => undefined;

/** merge:worktree:set — daemon-scoped concern; no per-session UI state effect. */
export const handleMergeWorktreeSet: EventHandler<'merge:worktree:set'> = (_event, _state) => undefined;

/** merge:worktree:clear — daemon-scoped concern; no per-session UI state effect. */
export const handleMergeWorktreeClear: EventHandler<'merge:worktree:clear'> = (_event, _state) => undefined;
