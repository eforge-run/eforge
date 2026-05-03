/**
 * Handlers for per-plan build and merge events.
 *
 * Owns: planStatuses, reviewIssues, fileChanges, mergeCommits.
 *
 * Stage-advancement rules (encoded explicitly as switch arms):
 *   plan:build:start / plan:build:implement:start  → 'implement'
 *   plan:build:doc-author:start / :complete         → no-op (runs parallel with implement)
 *   plan:build:doc-sync:start                       → 'doc-sync' (sequential after implement)
 *   plan:build:doc-sync:complete                    → no-op (next stage sets the status)
 *   plan:build:implement:complete                   → no-op (next stage sets the status)
 *   plan:build:test:write:start / plan:build:test:start → 'test'
 *   plan:build:test:write:complete                  → no-op (next stage sets the status)
 *   plan:build:test:complete                        → extract productionIssues into reviewIssues
 *   plan:build:review:start                         → 'review'
 *   plan:build:review:complete                      → 'evaluate' + extract issues into reviewIssues
 *   plan:build:evaluate:start                       → 'evaluate'
 *   plan:build:complete                             → 'complete'
 *   plan:build:failed                               → 'failed'
 *   plan:build:files_changed                        → update fileChanges Map
 *   plan:merge:complete                             → 'complete' + capture commitSha
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

export const handlePlanBuildStart: EventHandler<'plan:build:start'> = (event, state) =>
  setStatus(state, event.planId, 'implement');

export const handlePlanBuildImplementStart: EventHandler<'plan:build:implement:start'> = (event, state) =>
  setStatus(state, event.planId, 'implement');

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

export const handlePlanBuildComplete: EventHandler<'plan:build:complete'> = (event, state) =>
  setStatus(state, event.planId, 'complete');

export const handlePlanBuildFailed: EventHandler<'plan:build:failed'> = (event, state) =>
  setStatus(state, event.planId, 'failed');

// ---------------------------------------------------------------------------
// File changes
// ---------------------------------------------------------------------------

export const handlePlanBuildFilesChanged: EventHandler<'plan:build:files_changed'> = (event, state) => {
  const fileChanges = new Map(state.fileChanges);
  fileChanges.set(event.planId, event.files);
  return { fileChanges };
};

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

export const handlePlanMergeComplete: EventHandler<'plan:merge:complete'> = (event, state) => ({
  planStatuses: { ...state.planStatuses, [event.planId]: 'complete' },
  ...(event.commitSha && { mergeCommits: { ...state.mergeCommits, [event.planId]: event.commitSha } }),
});
