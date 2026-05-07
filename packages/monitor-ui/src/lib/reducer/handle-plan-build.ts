/**
 * Handlers for per-plan build and merge events.
 *
 * Owns: reviewIssues, fileChanges, mergeCommits, perspectiveErrors.
 *
 * NOTE: planStatuses is now driven exclusively by plan:status:change events
 * handled in handle-plan-lifecycle.ts. Build events no longer infer plan-level
 * status — they are wire-level signals only.
 *
 * Stage-advancement rules still active (within-build stages, not plan-level status):
 *   plan:build:doc-sync:start                       → 'doc-sync' (sequential after implement)
 *   plan:build:test:write:start / plan:build:test:start → 'test'
 *   plan:build:test:complete                        → extract productionIssues into reviewIssues
 *   plan:build:review:start                         → 'review'
 *   plan:build:review:complete                      → 'evaluate' + extract issues into reviewIssues
 *   plan:build:evaluate:start                       → 'evaluate'
 *   plan:build:files_changed                        → update fileChanges Map
 *   plan:build:review:parallel:perspective:error    → append error to perspectiveErrors[planId]
 *   plan:merge:complete                             → capture commitSha (status set by plan:status:change)
 *
 * Removed inferences (now handled by plan:status:change lifecycle events):
 *   plan:build:start / plan:build:implement:start  → removed 'implement' setStatus
 *   plan:build:complete                            → removed 'complete' setStatus
 *   plan:build:failed                              → removed 'failed' setStatus
 *   plan:merge:complete                            → removed 'complete' setStatus
 */
import type { ReviewIssue, PipelineStage } from '../types';
import type { RunState } from '../reducer';
import type { EventHandler } from './handler-types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setStatus(state: Readonly<RunState>, planId: string, stage: PipelineStage) {
  return { planStatuses: { ...state.planStatuses, [planId]: stage } };
}

// ---------------------------------------------------------------------------
// Build stage advancement
// ---------------------------------------------------------------------------

/** plan:build:start — stage now driven by plan:status:change(running); no-op here. */
export const handlePlanBuildStart: EventHandler<'plan:build:start'> = (_event, _state) => undefined;

/** plan:build:implement:start — stage now driven by plan:status:change(running); no-op here. */
export const handlePlanBuildImplementStart: EventHandler<'plan:build:implement:start'> = (_event, _state) => undefined;

/** Doc-author runs in parallel with implement — do not advance stage. */
export const handlePlanBuildDocAuthorStart: EventHandler<'plan:build:doc-author:start'> = (_event, _state) =>
  undefined;

/** Doc-author complete — do not advance; next stage sets the status. */
export const handlePlanBuildDocAuthorComplete: EventHandler<'plan:build:doc-author:complete'> = (_event, _state) =>
  undefined;

/** Doc-sync runs sequentially after implement — set visible stage. */
export const handlePlanBuildDocSyncStart: EventHandler<'plan:build:doc-sync:start'> = (event, state) =>
  setStatus(state, event.planId, 'doc-sync');

/** Doc-sync complete — do not advance; next stage (review/evaluate) sets it. */
export const handlePlanBuildDocSyncComplete: EventHandler<'plan:build:doc-sync:complete'> = (_event, _state) =>
  undefined;

/** Implement complete — do not advance; next stage (test or review) sets it. */
export const handlePlanBuildImplementComplete: EventHandler<'plan:build:implement:complete'> = (_event, _state) =>
  undefined;

export const handlePlanBuildTestWriteStart: EventHandler<'plan:build:test:write:start'> = (event, state) =>
  setStatus(state, event.planId, 'test');

/** Test write complete — do not advance; next stage sets it. */
export const handlePlanBuildTestWriteComplete: EventHandler<'plan:build:test:write:complete'> = (_event, _state) =>
  undefined;

export const handlePlanBuildTestStart: EventHandler<'plan:build:test:start'> = (event, state) =>
  setStatus(state, event.planId, 'test');

/** Test complete — extract production issues into reviewIssues (no stage advance). */
export const handlePlanBuildTestComplete: EventHandler<'plan:build:test:complete'> = (event, state) => {
  if (event.productionIssues.length === 0) return undefined;
  const issues: ReviewIssue[] = event.productionIssues.map((i) => ({
    severity: i.severity,
    category: i.category,
    file: i.file,
    description: i.description,
  }));
  return { reviewIssues: { ...state.reviewIssues, [event.planId]: issues } };
};

export const handlePlanBuildReviewStart: EventHandler<'plan:build:review:start'> = (event, state) =>
  setStatus(state, event.planId, 'review');

export const handlePlanBuildReviewComplete: EventHandler<'plan:build:review:complete'> = (event, state) => ({
  planStatuses: { ...state.planStatuses, [event.planId]: 'evaluate' },
  reviewIssues: { ...state.reviewIssues, [event.planId]: event.issues },
});

export const handlePlanBuildEvaluateStart: EventHandler<'plan:build:evaluate:start'> = (event, state) =>
  setStatus(state, event.planId, 'evaluate');

/** plan:build:complete — status now driven by plan:status:change(completed); no-op here. */
export const handlePlanBuildComplete: EventHandler<'plan:build:complete'> = (_event, _state) => undefined;

/** plan:build:failed — status now driven by plan:status:change(failed); no-op here. */
export const handlePlanBuildFailed: EventHandler<'plan:build:failed'> = (_event, _state) => undefined;

// ---------------------------------------------------------------------------
// File changes
// ---------------------------------------------------------------------------

export const handlePlanBuildFilesChanged: EventHandler<'plan:build:files_changed'> = (event, state) => {
  const fileChanges = new Map(state.fileChanges);
  fileChanges.set(event.planId, event.files);
  return { fileChanges };
};

// ---------------------------------------------------------------------------
// Perspective errors
// ---------------------------------------------------------------------------

export const handlePlanBuildReviewPerspectiveError: EventHandler<'plan:build:review:parallel:perspective:error'> = (event, state) => {
  const existing = state.perspectiveErrors[event.planId] ?? [];
  return {
    perspectiveErrors: {
      ...state.perspectiveErrors,
      [event.planId]: [
        ...existing,
        { perspective: event.perspective, error: event.error, timestamp: event.timestamp },
      ],
    },
  };
};

export const handlePlanBuildReviewPerspectiveComplete: EventHandler<'plan:build:review:parallel:perspective:complete'> = (event, state) => {
  const { planId, perspective, issues } = event;
  return {
    reviewIssuesByPerspective: {
      ...state.reviewIssuesByPerspective,
      [planId]: {
        ...(state.reviewIssuesByPerspective[planId] ?? {}),
        [perspective]: issues,
      },
    },
  };
};

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/** plan:merge:complete — status now driven by plan:status:change(merged); capture commitSha only. */
export const handlePlanMergeComplete: EventHandler<'plan:merge:complete'> = (event, state) =>
  event.commitSha ? { mergeCommits: { ...state.mergeCommits, [event.planId]: event.commitSha } } : undefined;
