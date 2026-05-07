/**
 * Event metadata registry: one entry per EforgeEvent variant.
 *
 * Each entry declares:
 *   scope   — 'daemon' (daemon-wide, streamed via /api/daemon-events) or
 *             'session' (per-session build events, not in the daemon stream)
 *   persist — whether the event is stored in the DB and replayed on reconnect
 *   summary — optional human-readable one-line description (string or function)
 *   project — optional state projection for daemon-scoped events; inlines the
 *             logic from packages/monitor-ui/src/lib/daemon-reducer/handle-*.ts
 *
 * Derive DAEMON_EVENT_TYPES by filtering for persist:true entries:
 *   const DAEMON_EVENT_TYPES = Object.keys(eventRegistry).filter(
 *     k => eventRegistry[k as EforgeEvent['type']].persist
 *   );
 *
 * The _Exhaustive type check at the bottom verifies every EforgeEvent['type']
 * has an entry, so adding a new event type to events.schemas.ts forces an
 * update here.
 */

import type { EforgeEvent } from './events.js';
import type { RunInfo, QueueItem, AutoBuildState } from './types.js';

// ---------------------------------------------------------------------------
// Minimal state shape the project functions operate on.
// DaemonState in packages/monitor-ui satisfies this interface structurally.
// ---------------------------------------------------------------------------

export interface ProjectableState {
  /** Runs sorted by startedAt DESC; runs[0] is the most-recent session. */
  runs: RunInfo[];
  /** Current queue snapshot (pending, running, failed items). */
  queue: QueueItem[];
  /** Auto-build state; null when the daemon does not support it. */
  autoBuild: AutoBuildState | null;
  /**
   * The most recently received daemon:heartbeat payload, or null if no
   * heartbeat has been received yet.
   */
  latestHeartbeat: {
    at: number;
    payload: {
      uptime: number;
      queueDepth: number;
      runningBuilds: number;
      autoBuild: { enabled: boolean; paused: boolean };
      subscribers: number;
    };
  } | null;
}

// ---------------------------------------------------------------------------
// EventMeta: per-variant metadata shape
// ---------------------------------------------------------------------------

export type EventScope = 'daemon' | 'session';

export interface EventMeta<T extends EforgeEvent['type']> {
  /** Context this event belongs to. */
  scope: EventScope;
  /** Whether this event is persisted to the DB (and replayed on reconnect). */
  persist: boolean;
  /**
   * Optional human-readable one-line summary. Used by the MCP progress
   * notifications and the monitor UI activity feed.
   *
   * String: static description.
   * Function: computed from the event payload (e.g. includes planId, counts).
   *           May return undefined to suppress output for certain payloads.
   */
  summary?: string | ((event: Extract<EforgeEvent, { type: T }>) => string | undefined);
  /**
   * Optional state projection for daemon-scoped events.
   *
   * Receives the narrowed event and the current (readonly) projectable state.
   * Returns a partial delta to spread into the next state, or undefined when
   * the event causes no state change.
   */
  project?: (
    event: Extract<EforgeEvent, { type: T }>,
    state: Readonly<ProjectableState>,
  ) => Partial<ProjectableState> | undefined;
}

// ---------------------------------------------------------------------------
// Registry shape: every EforgeEvent type must have an entry
// ---------------------------------------------------------------------------

type EventRegistryShape = {
  [T in EforgeEvent['type']]: EventMeta<T>;
};

// ---------------------------------------------------------------------------
// Registry definition
// ---------------------------------------------------------------------------

const eventRegistry = {
  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  'session:start': {
    scope: 'daemon',
    persist: true,
    summary: 'Session started',
    // daemon:run:upsert is now the authoritative source for DaemonState.runs.
    // The old run-synthesis branch is removed — it produced untitled/unknown
    // run rows during enqueue-only sessions that had no phase:start.
    project: () => undefined,
  },

  'session:end': {
    scope: 'daemon',
    persist: true,
    summary: (e) => `Session ended: ${e.result.status}`,
    // Run termination is now reflected via daemon:run:upsert emitted by the
    // recorder when session:end triggers updateRunStatus for enqueue failures.
    project: () => undefined,
  },

  'session:profile': {
    scope: 'session',
    persist: false,
  },

  // -------------------------------------------------------------------------
  // Phase lifecycle
  // -------------------------------------------------------------------------

  'phase:start': {
    scope: 'session',
    persist: false,
    summary: (e) => `Phase: ${e.command} starting`,
  },

  'phase:end': {
    scope: 'session',
    persist: false,
    summary: (e) => `Phase complete: ${e.result.status}`,
  },

  // -------------------------------------------------------------------------
  // Config and plan warnings
  // -------------------------------------------------------------------------

  'config:warning': {
    scope: 'session',
    persist: false,
    summary: (e) => `Config warning: ${e.message}`,
  },

  'planning:warning': {
    scope: 'session',
    persist: false,
    summary: (e) =>
      e.planId ? `Plan warning (${e.planId}): ${e.message}` : `Plan warning: ${e.message}`,
  },

  'planning:module:build-config:invalid': {
    scope: 'session',
    persist: false,
    summary: (e) =>
      `Module ${e.moduleId} emitted invalid <build-config> (${e.reason}): ${e.errors.join('; ')}`,
  },

  // -------------------------------------------------------------------------
  // Planning
  // -------------------------------------------------------------------------

  'planning:start': {
    scope: 'session',
    persist: false,
    summary: (e) => `Planning from ${e.label ?? e.source}`,
  },

  'planning:skip': {
    scope: 'session',
    persist: false,
    summary: (e) => `Planning skipped: ${e.reason}`,
  },

  'planning:submission': {
    scope: 'session',
    persist: false,
    summary: (e) => `Planning submitted ${e.planCount} plan(s)`,
  },

  'planning:error': {
    scope: 'session',
    persist: false,
    summary: (e) => `Planning error: ${e.reason}`,
  },

  'planning:clarification': {
    scope: 'session',
    persist: false,
    summary: (e) => `Planning clarification needed (${e.questions.length} question(s))`,
  },

  'planning:clarification:answer': {
    scope: 'session',
    persist: false,
    summary: 'Clarification answered, resuming planning',
  },

  'planning:progress': {
    scope: 'session',
    persist: false,
  },

  'planning:continuation': {
    scope: 'session',
    persist: false,
    summary: (e) => `Planning continuation attempt ${e.attempt}/${e.maxContinuations}`,
  },

  'planning:pipeline': {
    scope: 'session',
    persist: false,
    summary: (e) => `Pipeline: ${e.scope}`,
  },

  'planning:complete': {
    scope: 'session',
    persist: false,
    summary: (e) =>
      e.plans.length === 0
        ? 'Planning complete: nothing to plan'
        : `Planning complete: ${e.plans.length} plan(s) created`,
  },

  // -------------------------------------------------------------------------
  // Planning review
  // -------------------------------------------------------------------------

  'planning:review:start': {
    scope: 'session',
    persist: false,
    summary: 'Reviewing plan files',
  },

  'planning:review:complete': {
    scope: 'session',
    persist: false,
    summary: (e) =>
      e.issues.length === 0
        ? 'Plan review complete: no issues'
        : `Plan review: ${e.issues.length} issue(s)`,
  },

  'planning:evaluate:start': {
    scope: 'session',
    persist: false,
    summary: 'Evaluating plan review fixes',
  },

  'planning:evaluate:continuation': {
    scope: 'session',
    persist: false,
    summary: (e) => `Plan evaluation continuation attempt ${e.attempt}/${e.maxContinuations}`,
  },

  'planning:evaluate:complete': {
    scope: 'session',
    persist: false,
    summary: (e) => `Plan evaluation: ${e.accepted} accepted, ${e.rejected} rejected`,
  },

  // -------------------------------------------------------------------------
  // Architecture review
  // -------------------------------------------------------------------------

  'planning:architecture:review:start': {
    scope: 'session',
    persist: false,
    summary: 'Reviewing architecture',
  },

  'planning:architecture:review:complete': {
    scope: 'session',
    persist: false,
    summary: (e) =>
      e.issues.length === 0
        ? 'Architecture review complete: no issues'
        : `Architecture review: ${e.issues.length} issue(s)`,
  },

  'planning:architecture:evaluate:start': {
    scope: 'session',
    persist: false,
    summary: 'Evaluating architecture review fixes',
  },

  'planning:architecture:evaluate:continuation': {
    scope: 'session',
    persist: false,
    summary: (e) =>
      `Architecture evaluation continuation attempt ${e.attempt}/${e.maxContinuations}`,
  },

  'planning:architecture:evaluate:complete': {
    scope: 'session',
    persist: false,
    summary: (e) => `Architecture evaluation: ${e.accepted} accepted, ${e.rejected} rejected`,
  },

  // -------------------------------------------------------------------------
  // Cohesion review
  // -------------------------------------------------------------------------

  'planning:cohesion:start': {
    scope: 'session',
    persist: false,
    summary: 'Reviewing cross-module cohesion',
  },

  'planning:cohesion:complete': {
    scope: 'session',
    persist: false,
    summary: (e) =>
      e.issues.length === 0
        ? 'Cohesion review complete: no issues'
        : `Cohesion review: ${e.issues.length} issue(s)`,
  },

  'planning:cohesion:evaluate:start': {
    scope: 'session',
    persist: false,
    summary: 'Evaluating cohesion review fixes',
  },

  'planning:cohesion:evaluate:continuation': {
    scope: 'session',
    persist: false,
    summary: (e) =>
      `Cohesion evaluation continuation attempt ${e.attempt}/${e.maxContinuations}`,
  },

  'planning:cohesion:evaluate:complete': {
    scope: 'session',
    persist: false,
    summary: (e) => `Cohesion evaluation: ${e.accepted} accepted, ${e.rejected} rejected`,
  },

  // -------------------------------------------------------------------------
  // Building (per-plan)
  // -------------------------------------------------------------------------

  'plan:build:start': {
    scope: 'session',
    persist: false,
    summary: (e) => `Plan ${e.planId}: starting`,
  },

  'plan:build:implement:start': {
    scope: 'session',
    persist: false,
    summary: (e) => `Plan ${e.planId}: implementing`,
  },

  'plan:build:implement:progress': {
    scope: 'session',
    persist: false,
  },

  'plan:build:implement:continuation': {
    scope: 'session',
    persist: false,
    summary: (e) =>
      `Plan ${e.planId}: implementation continuation attempt ${e.attempt}/${e.maxContinuations}`,
  },

  'plan:build:implement:complete': {
    scope: 'session',
    persist: false,
    summary: (e) => `Plan ${e.planId}: implementation complete`,
  },

  'plan:build:files_changed': {
    scope: 'session',
    persist: false,
    summary: (e) => `Plan ${e.planId}: ${e.files.length} file(s) changed`,
  },

  'plan:build:review:start': {
    scope: 'session',
    persist: false,
    summary: (e) => `Plan ${e.planId}: reviewing`,
  },

  'plan:build:review:complete': {
    scope: 'session',
    persist: false,
    summary: (e) =>
      e.issues.length === 0
        ? `Plan ${e.planId}: review complete, no issues`
        : `Plan ${e.planId}: review complete, ${e.issues.length} issue(s)`,
  },

  'plan:build:review:parallel:start': {
    scope: 'session',
    persist: false,
    summary: (e) => `Plan ${e.planId}: parallel review (${e.perspectives.join(', ')})`,
  },

  'plan:build:review:parallel:perspective:start': {
    scope: 'session',
    persist: false,
  },

  'plan:build:review:parallel:perspective:complete': {
    scope: 'session',
    persist: false,
    summary: (e) =>
      e.issues.length > 0
        ? `Plan ${e.planId}: ${e.perspective} review, ${e.issues.length} issue(s)`
        : undefined,
  },

  'plan:build:review:parallel:perspective:error': {
    scope: 'session',
    persist: false,
    summary: (e) => `Plan ${e.planId}: ${e.perspective} review failed: ${e.error}`,
  },

  'plan:build:review:fix:start': {
    scope: 'session',
    persist: false,
    summary: (e) => `Plan ${e.planId}: applying ${e.issueCount} fix(es)`,
  },

  'plan:build:review:fix:complete': {
    scope: 'session',
    persist: false,
    summary: (e) => `Plan ${e.planId}: fixes applied`,
  },

  'plan:build:evaluate:start': {
    scope: 'session',
    persist: false,
    summary: (e) => `Plan ${e.planId}: evaluating fixes`,
  },

  'plan:build:evaluate:continuation': {
    scope: 'session',
    persist: false,
    summary: (e) =>
      `Plan ${e.planId}: evaluation continuation attempt ${e.attempt}/${e.maxContinuations}`,
  },

  'plan:build:evaluate:complete': {
    scope: 'session',
    persist: false,
    summary: (e) =>
      `Plan ${e.planId}: evaluation complete, ${e.accepted} accepted, ${e.rejected} rejected`,
  },

  'plan:build:doc-author:start': {
    scope: 'session',
    persist: false,
    summary: (e) => `Plan ${e.planId}: authoring docs`,
  },

  'plan:build:doc-author:complete': {
    scope: 'session',
    persist: false,
    summary: (e) =>
      e.docsAuthored > 0 ? `Plan ${e.planId}: ${e.docsAuthored} doc(s) authored` : undefined,
  },

  'plan:build:doc-sync:start': {
    scope: 'session',
    persist: false,
    summary: (e) => `Plan ${e.planId}: syncing docs`,
  },

  'plan:build:doc-sync:complete': {
    scope: 'session',
    persist: false,
    summary: (e) =>
      e.docsSynced > 0 ? `Plan ${e.planId}: ${e.docsSynced} doc(s) synced` : undefined,
  },

  'plan:build:test:write:start': {
    scope: 'session',
    persist: false,
    summary: (e) => `Plan ${e.planId}: writing tests`,
  },

  'plan:build:test:write:complete': {
    scope: 'session',
    persist: false,
    summary: (e) =>
      e.testsWritten > 0 ? `Plan ${e.planId}: ${e.testsWritten} test file(s) written` : undefined,
  },

  'plan:build:test:start': {
    scope: 'session',
    persist: false,
    summary: (e) => `Plan ${e.planId}: running tests`,
  },

  'plan:build:test:complete': {
    scope: 'session',
    persist: false,
    summary: (e) => {
      const parts = [`${e.passed} passed`];
      if (e.failed > 0) parts.push(`${e.failed} failed`);
      if (e.testBugsFixed > 0) parts.push(`${e.testBugsFixed} test bugs fixed`);
      return `Plan ${e.planId}: tests ${parts.join(', ')}`;
    },
  },

  'plan:build:complete': {
    scope: 'session',
    persist: false,
    summary: (e) => `Plan ${e.planId}: complete`,
  },

  'plan:build:failed': {
    scope: 'session',
    persist: false,
    summary: (e) => `Plan ${e.planId}: failed — ${e.error}`,
  },

  'plan:build:progress': {
    scope: 'session',
    persist: false,
  },

  // -------------------------------------------------------------------------
  // Plan lifecycle state events
  // -------------------------------------------------------------------------

  'plan:status:change': {
    scope: 'session',
    persist: true,
    summary: (e) => `Plan ${e.planId}: status → ${e.status}`,
    // Projection is owned by the session reducer (handle-plan-lifecycle.ts);
    // DaemonState has no per-plan status field, so this is intentionally a no-op.
    project: () => undefined,
  },

  'plan:error:set': {
    scope: 'session',
    persist: true,
    summary: (e) => `Plan ${e.planId}: error set`,
    // Projection is owned by the session reducer (handle-plan-lifecycle.ts);
    // DaemonState has no per-plan status field, so this is intentionally a no-op.
    project: () => undefined,
  },

  'plan:error:clear': {
    scope: 'session',
    persist: true,
    summary: (e) => `Plan ${e.planId}: error cleared`,
    // Projection is owned by the session reducer (handle-plan-lifecycle.ts);
    // DaemonState has no per-plan status field, so this is intentionally a no-op.
    project: () => undefined,
  },

  // -------------------------------------------------------------------------
  // Orchestration
  // -------------------------------------------------------------------------

  'schedule:start': {
    scope: 'session',
    persist: false,
    summary: (e) => `Scheduling ${e.planIds.length} plan(s)`,
  },

  'plan:schedule:ready': {
    scope: 'session',
    persist: false,
    summary: (e) => `Plan ${e.planId} ready to schedule: ${e.reason}`,
  },

  'plan:merge:start': {
    scope: 'session',
    persist: false,
    summary: (e) => `Merging plan ${e.planId}`,
  },

  'plan:merge:complete': {
    scope: 'session',
    persist: false,
    summary: (e) => `Plan ${e.planId} merged`,
  },

  'plan:merge:resolve:start': {
    scope: 'session',
    persist: false,
    summary: (e) => `Resolving merge conflicts for plan ${e.planId}`,
  },

  'plan:merge:resolve:complete': {
    scope: 'session',
    persist: false,
    summary: (e) =>
      e.resolved
        ? `Merge conflicts resolved for plan ${e.planId}`
        : `Failed to resolve merge conflicts for plan ${e.planId}`,
  },

  'merge:finalize:start': {
    scope: 'session',
    persist: false,
    summary: (e) => `Merging ${e.featureBranch} into ${e.baseBranch}`,
  },

  'merge:finalize:complete': {
    scope: 'session',
    persist: false,
    summary: (e) => `Merged ${e.featureBranch} into ${e.baseBranch}`,
  },

  'merge:finalize:skipped': {
    scope: 'session',
    persist: false,
    summary: (e) => `Feature branch merge skipped: ${e.reason}`,
  },

  'merge:worktree:set': {
    scope: 'session',
    persist: true,
    // Projection is owned by the session reducer (handle-plan-lifecycle.ts);
    // DaemonState has no per-plan status field, so this is intentionally a no-op.
    project: () => undefined,
  },

  'merge:worktree:clear': {
    scope: 'session',
    persist: true,
    // Projection is owned by the session reducer (handle-plan-lifecycle.ts);
    // DaemonState has no per-plan status field, so this is intentionally a no-op.
    project: () => undefined,
  },

  // -------------------------------------------------------------------------
  // Expedition planning phases
  // -------------------------------------------------------------------------

  'expedition:architecture:complete': {
    scope: 'session',
    persist: false,
    summary: (e) => `Architecture complete: ${e.modules.length} module(s) defined`,
  },

  'expedition:wave:start': {
    scope: 'session',
    persist: false,
    summary: (e) => `Wave ${e.wave} started: ${e.moduleIds.join(', ')}`,
  },

  'expedition:wave:complete': {
    scope: 'session',
    persist: false,
    summary: (e) => `Wave ${e.wave} complete`,
  },

  'expedition:module:start': {
    scope: 'session',
    persist: false,
    summary: (e) => `Planning module ${e.moduleId}`,
  },

  'expedition:module:complete': {
    scope: 'session',
    persist: false,
    summary: (e) => `Module ${e.moduleId} planned`,
  },

  'expedition:compile:start': {
    scope: 'session',
    persist: false,
    summary: 'Compiling plan files',
  },

  'expedition:compile:complete': {
    scope: 'session',
    persist: false,
    summary: (e) => `Compiled ${e.plans.length} plan file(s)`,
  },

  // -------------------------------------------------------------------------
  // Agent lifecycle
  // -------------------------------------------------------------------------

  'agent:start': {
    scope: 'session',
    persist: false,
    summary: (e) =>
      e.planId ? `Agent ${e.agent} started (plan ${e.planId})` : `Agent ${e.agent} started`,
  },

  'agent:warning': {
    scope: 'session',
    persist: false,
    summary: (e) => `Agent ${e.agent} warning: ${e.message}`,
  },

  'agent:stop': {
    scope: 'session',
    persist: false,
    summary: (e) =>
      e.error
        ? `Agent ${e.agent} stopped with error`
        : `Agent ${e.agent} stopped`,
  },

  'agent:usage': {
    scope: 'session',
    persist: false,
  },

  'agent:message': {
    scope: 'session',
    persist: false,
  },

  'agent:tool_use': {
    scope: 'session',
    persist: false,
  },

  'agent:tool_result': {
    scope: 'session',
    persist: false,
  },

  'agent:result': {
    scope: 'session',
    persist: false,
  },

  'agent:retry': {
    scope: 'session',
    persist: false,
    summary: (e) =>
      `Agent ${e.agent} retry attempt ${e.attempt}/${e.maxAttempts} (${e.subtype})`,
  },

  // -------------------------------------------------------------------------
  // Validation (post-merge)
  // -------------------------------------------------------------------------

  'validation:start': {
    scope: 'session',
    persist: false,
    summary: (e) => `Running post-merge validation (${e.commands.length} command(s))`,
  },

  'validation:command:start': {
    scope: 'session',
    persist: false,
    summary: (e) => `Running: ${e.command}`,
  },

  'validation:command:complete': {
    scope: 'session',
    persist: false,
    summary: (e) =>
      e.exitCode === 0 ? `${e.command} passed` : `${e.command} failed (exit ${e.exitCode})`,
  },

  'validation:command:timeout': {
    scope: 'session',
    persist: false,
    summary: (e) =>
      `${e.command} timed out after ${Math.round(e.timeoutMs / 1000)}s`,
  },

  'validation:complete': {
    scope: 'session',
    persist: false,
    summary: (e) => (e.passed ? 'All validation commands passed' : 'Validation failed'),
  },

  'validation:fix:start': {
    scope: 'session',
    persist: false,
    summary: (e) => `Validation fix attempt ${e.attempt}/${e.maxAttempts}`,
  },

  'validation:fix:complete': {
    scope: 'session',
    persist: false,
    summary: (e) => `Validation fix attempt ${e.attempt} complete`,
  },

  // -------------------------------------------------------------------------
  // PRD validation
  // -------------------------------------------------------------------------

  'prd_validation:start': {
    scope: 'session',
    persist: false,
    summary: 'PRD validation starting',
  },

  'prd_validation:complete': {
    scope: 'session',
    persist: false,
    summary: (e) =>
      e.passed
        ? 'PRD validation passed'
        : `PRD validation failed: ${e.gaps.length} gap(s)`,
  },

  // -------------------------------------------------------------------------
  // Gap closing
  // -------------------------------------------------------------------------

  'gap_close:start': {
    scope: 'session',
    persist: false,
    summary: (e) =>
      e.gapCount !== undefined ? `Closing ${e.gapCount} gap(s)` : 'Closing PRD validation gaps',
  },

  'gap_close:plan_ready': {
    scope: 'session',
    persist: false,
  },

  'gap_close:complete': {
    scope: 'session',
    persist: false,
    summary: 'Gap closing complete',
  },

  // -------------------------------------------------------------------------
  // Reconciliation
  // -------------------------------------------------------------------------

  'reconciliation:start': {
    scope: 'session',
    persist: false,
    summary: 'Reconciling worktree state',
  },

  'reconciliation:complete': {
    scope: 'session',
    persist: false,
    summary: (e) => {
      const parts: string[] = [];
      if (e.report.valid.length > 0) parts.push(`${e.report.valid.length} valid`);
      if (e.report.missing.length > 0) parts.push(`${e.report.missing.length} missing`);
      if (e.report.corrupt.length > 0) parts.push(`${e.report.corrupt.length} corrupt`);
      return `Reconciliation complete: ${parts.join(', ')}`;
    },
  },

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  'cleanup:start': {
    scope: 'session',
    persist: false,
    summary: (e) => `Cleaning up plan files for ${e.planSet}`,
  },

  'cleanup:complete': {
    scope: 'session',
    persist: false,
    summary: (e) => `Plan files removed for ${e.planSet}`,
  },

  // -------------------------------------------------------------------------
  // User interaction
  // -------------------------------------------------------------------------

  'approval:needed': {
    scope: 'session',
    persist: false,
    summary: (e) => `Approval needed: ${e.action}`,
  },

  'approval:response': {
    scope: 'session',
    persist: false,
    summary: (e) => (e.approved ? 'Approved' : 'Denied'),
  },

  // -------------------------------------------------------------------------
  // Enqueue
  // -------------------------------------------------------------------------

  'enqueue:start': {
    scope: 'daemon',
    persist: true,
    summary: (e) => `Enqueueing from ${e.source}`,
    // daemon:run:upsert is now the single source of truth for DaemonState.runs;
    // the project function is intentionally absent. The activity-feed summary
    // is preserved for the ring buffer.
  },

  'enqueue:complete': {
    scope: 'daemon',
    persist: true,
    summary: (e) => `Enqueued: ${e.title}`,
    // daemon:run:upsert is now the single source of truth for DaemonState.runs;
    // the project function is intentionally absent.
  },

  'enqueue:failed': {
    scope: 'daemon',
    persist: true,
    summary: (e) => `Enqueue failed: ${e.error}`,
    // daemon:run:upsert is now the single source of truth for DaemonState.runs;
    // the project function is intentionally absent.
  },

  'enqueue:commit-failed': {
    scope: 'daemon',
    persist: true,
    summary: (e) => `Enqueue commit failed: ${e.error}`,
  },

  // -------------------------------------------------------------------------
  // Recovery analysis
  // -------------------------------------------------------------------------

  'recovery:start': {
    scope: 'session',
    persist: false,
    summary: (e) => `Analysing failed build for PRD ${e.prdId}`,
  },

  'recovery:summary': {
    scope: 'session',
    persist: false,
  },

  'recovery:complete': {
    scope: 'session',
    persist: false,
    summary: (e) => `Recovery analysis complete: ${e.verdict.verdict.toUpperCase()}`,
  },

  'recovery:error': {
    scope: 'session',
    persist: false,
    summary: (e) => `Recovery parse failed: ${e.error}`,
  },

  'recovery:apply:start': {
    scope: 'session',
    persist: false,
  },

  'recovery:apply:complete': {
    scope: 'session',
    persist: false,
    summary: (e) =>
      e.noAction
        ? 'Recovery verdict is manual — no changes made'
        : `Recovery applied: ${e.verdict.toUpperCase()}${e.successorPrdId ? ` → ${e.successorPrdId}` : ''}`,
  },

  'recovery:apply:error': {
    scope: 'session',
    persist: false,
    summary: (e) => `Recovery apply failed: ${e.message}`,
  },

  // -------------------------------------------------------------------------
  // Daemon run-state upsert
  // -------------------------------------------------------------------------

  /**
   * daemon:run:upsert is the authoritative source of truth for DaemonState.runs.
   * Emitted by the recorder immediately after every insertRun / updateRunStatus /
   * updateRunPlanSet call. The payload is a full RunInfo re-read from the DB,
   * so it is always equivalent to what db.getRuns() would return.
   *
   * Projection: finds the existing run by id and replaces it in-place (preserving
   * startedAt DESC ordering), or prepends the run if it is new.
   */
  'daemon:run:upsert': {
    scope: 'daemon',
    persist: true,
    summary: (e) => `Run ${e.run.id}: ${e.run.command} → ${e.run.status}`,
    project(event, state) {
      const idx = state.runs.findIndex((r) => r.id === event.run.id);
      if (idx !== -1) {
        const updated = [...state.runs];
        updated[idx] = event.run;
        return { runs: updated };
      }
      // Prepend new run — caller has already inserted it into the DB with
      // startedAt set, so it will be first in the startedAt DESC ordering.
      return { runs: [event.run, ...state.runs] };
    },
  },

  // -------------------------------------------------------------------------
  // Daemon internal
  // -------------------------------------------------------------------------

  'daemon:auto-build:paused': {
    scope: 'daemon',
    persist: true,
    summary: (e) => `Auto-build paused: ${e.reason}`,
    project(_event, state) {
      if (!state.autoBuild) return undefined;
      if (!state.autoBuild.enabled) return undefined;
      return { autoBuild: { ...state.autoBuild, enabled: false } };
    },
  },

  // -------------------------------------------------------------------------
  // Daemon lifecycle
  // -------------------------------------------------------------------------

  'daemon:lifecycle:starting': {
    scope: 'daemon',
    persist: true,
    summary: (e) => `Daemon starting (pid ${e.pid}, port ${e.port})`,
  },

  'daemon:lifecycle:ready': {
    scope: 'daemon',
    persist: true,
    summary: (e) => `Daemon ready (pid ${e.pid}, port ${e.port})`,
  },

  'daemon:lifecycle:shutdown:start': {
    scope: 'daemon',
    persist: true,
    summary: (e) => `Daemon shutting down (${e.signal}: ${e.reason})`,
  },

  'daemon:lifecycle:shutdown:complete': {
    scope: 'daemon',
    persist: true,
    summary: 'Daemon shutdown complete',
  },

  /**
   * daemon:heartbeat is daemon-scoped but LIVE-ONLY: it is pushed directly
   * to SSE subscribers without being persisted to the DB, and must never be
   * replayed from storage. persist: false prevents it from appearing in
   * DAEMON_EVENT_TYPES.
   */
  'daemon:heartbeat': {
    scope: 'daemon',
    persist: false,
    project(event) {
      return {
        latestHeartbeat: {
          at: Date.now(),
          payload: {
            uptime: event.uptime,
            queueDepth: event.queueDepth,
            runningBuilds: event.runningBuilds,
            autoBuild: event.autoBuild,
            subscribers: event.subscribers,
          },
        },
      };
    },
  },

  // -------------------------------------------------------------------------
  // Daemon scheduler
  // -------------------------------------------------------------------------

  'daemon:scheduler:dequeued': {
    scope: 'daemon',
    persist: true,
    summary: (e) => `Dequeued PRD ${e.prdId} (queue depth: ${e.queueDepth})`,
  },

  'daemon:scheduler:capacity-blocked': {
    scope: 'daemon',
    persist: true,
    summary: (e) => `Scheduler capacity blocked (${e.runningCount}/${e.limit} running)`,
  },

  'daemon:scheduler:dependency-blocked': {
    scope: 'daemon',
    persist: true,
    summary: (e) => `PRD ${e.prdId} blocked by: ${e.blockedBy.join(', ')}`,
  },

  // -------------------------------------------------------------------------
  // Daemon auto-build extensions
  // -------------------------------------------------------------------------

  'daemon:auto-build:enabled': {
    scope: 'daemon',
    persist: true,
    summary: 'Auto-build enabled',
    project(_event, state) {
      if (!state.autoBuild) return undefined;
      if (state.autoBuild.enabled) return undefined;
      return { autoBuild: { ...state.autoBuild, enabled: true } };
    },
  },

  'daemon:auto-build:resumed': {
    scope: 'daemon',
    persist: true,
    summary: 'Auto-build resumed',
    project(_event, state) {
      if (!state.autoBuild) return undefined;
      if (state.autoBuild.enabled) return undefined;
      return { autoBuild: { ...state.autoBuild, enabled: true } };
    },
  },

  'daemon:auto-build:triggered': {
    scope: 'daemon',
    persist: true,
    summary: (e) => `Auto-build triggered: ${e.prdsEnqueued} PRD(s) enqueued`,
  },

  // -------------------------------------------------------------------------
  // Daemon recovery
  // -------------------------------------------------------------------------

  'daemon:recovery:start': {
    scope: 'daemon',
    persist: true,
    summary: 'Daemon recovery started',
  },

  'daemon:recovery:run-marked-failed': {
    scope: 'daemon',
    persist: true,
    summary: (e) => `Run ${e.runId} marked failed: ${e.reason}`,
  },

  'daemon:recovery:lock-removed': {
    scope: 'daemon',
    persist: true,
    summary: (e) => `Stale lock removed: ${e.path} (pid ${e.pid})`,
  },

  'daemon:recovery:complete': {
    scope: 'daemon',
    persist: true,
    summary: (e) =>
      `Daemon recovery complete: ${e.runsFailed} failed, ${e.locksRemoved} lock(s) removed`,
  },

  // -------------------------------------------------------------------------
  // Daemon orphan reaping
  // -------------------------------------------------------------------------

  'daemon:orphan:reaped': {
    scope: 'daemon',
    persist: true,
    summary: (e) => `Orphaned build reaped: ${e.runId} (pid ${e.pid})`,
  },

  // -------------------------------------------------------------------------
  // Daemon errors and warnings
  // -------------------------------------------------------------------------

  'daemon:warning': {
    scope: 'daemon',
    persist: true,
    summary: (e) => `Daemon warning [${e.source}]: ${e.message}`,
  },

  'daemon:error': {
    scope: 'daemon',
    persist: true,
    summary: (e) => `Daemon error [${e.source}]: ${e.message}`,
  },

  // -------------------------------------------------------------------------
  // Queue events
  // -------------------------------------------------------------------------

  'queue:start': {
    scope: 'daemon',
    persist: true,
    summary: (e) => `PRD queue started: ${e.prdCount} PRD(s) in ${e.dir}`,
  },

  'queue:prd:start': {
    scope: 'daemon',
    persist: true,
    summary: (e) => `Processing PRD: ${e.title} (${e.prdId})`,
    project(event, state) {
      const idx = state.queue.findIndex((item) => item.id === event.prdId);
      if (idx === -1) return undefined;
      const updated = [...state.queue];
      updated[idx] = { ...updated[idx], status: 'running' };
      return { queue: updated };
    },
  },

  'queue:prd:discovered': {
    scope: 'daemon',
    persist: true,
    summary: (e) => `Discovered PRD: ${e.title} (${e.prdId})`,
    project(event, state) {
      if (state.queue.some((item) => item.id === event.prdId)) return undefined;
      const newItem: QueueItem = {
        id: event.prdId,
        title: event.title,
        status: 'pending',
      };
      return { queue: [...state.queue, newItem] };
    },
  },

  'queue:prd:stale': {
    scope: 'daemon',
    persist: true,
    summary: (e) => `PRD staleness (${e.prdId}): ${e.verdict} — ${e.justification}`,
    project(event, state) {
      // 'proceed' verdict: queue file remains pending — no state change needed.
      if (event.verdict === 'proceed') return undefined;
      // 'revise' or 'obsolete': file is moved/removed by the engine.
      // Remove the item from the live queue state to match loadQueueItemsSync.
      const filtered = state.queue.filter((item) => item.id !== event.prdId);
      if (filtered.length === state.queue.length) return undefined;
      return { queue: filtered };
    },
  },

  'queue:prd:skip': {
    scope: 'daemon',
    persist: true,
    summary: (e) => `PRD ${e.prdId} skipped: ${e.reason}`,
    project(event, state) {
      const filtered = state.queue.filter((item) => item.id !== event.prdId);
      if (filtered.length === state.queue.length) return undefined;
      return { queue: filtered };
    },
  },

  'queue:prd:commit-failed': {
    scope: 'daemon',
    persist: true,
    summary: (e) => `PRD ${e.prdId} commit failed: ${e.error}`,
    project(event, state) {
      const idx = state.queue.findIndex((item) => item.id === event.prdId);
      if (idx === -1) return undefined;
      const updated = [...state.queue];
      updated[idx] = { ...updated[idx], status: 'failed' };
      return { queue: updated };
    },
  },

  'queue:prd:complete': {
    scope: 'daemon',
    persist: true,
    summary: (e) => `PRD ${e.prdId} complete: ${e.status}`,
    project(event, state) {
      const idx = state.queue.findIndex((item) => item.id === event.prdId);
      if (idx === -1) return undefined;
      if (event.status === 'failed') {
        const updated = [...state.queue];
        updated[idx] = { ...updated[idx], status: 'failed' };
        return { queue: updated };
      }
      return { queue: state.queue.filter((item) => item.id !== event.prdId) };
    },
  },

  'queue:complete': {
    scope: 'daemon',
    persist: true,
    summary: (e) => `Queue complete: ${e.processed} processed, ${e.skipped} skipped`,
    project(_event, state) {
      const failed = state.queue.filter((item) => item.status === 'failed');
      if (failed.length === state.queue.length) return undefined;
      return { queue: failed };
    },
  },
} satisfies EventRegistryShape;

// ---------------------------------------------------------------------------
// Compile-time exhaustiveness check
// ---------------------------------------------------------------------------

/**
 * Verifies every EforgeEvent['type'] has an entry in the registry.
 * TypeScript will produce a type error on the assignment below if any type
 * is missing or misspelled — fix it by adding the missing entry.
 */
type _MissingTypes = Exclude<EforgeEvent['type'], keyof typeof eventRegistry>;
type _Exhaustive = [_MissingTypes] extends [never]
  ? true
  : { error: 'Not all EforgeEvent types are registered in event-registry.ts'; missing: _MissingTypes };
const _exhaustiveCheck: _Exhaustive = true;
void _exhaustiveCheck;

// ---------------------------------------------------------------------------
// DAEMON_EVENT_TYPES: derived from entries with persist:true
// ---------------------------------------------------------------------------

/**
 * Allowlist of event types persisted to the DB and surfaced via
 * GET /api/daemon-events. Derived from registry entries with persist:true.
 *
 * Note: daemon:heartbeat is intentionally absent — it is LIVE-ONLY, pushed
 * directly to SSE subscribers without being persisted to the DB, and must
 * never be replayed from storage (persist:false in the registry).
 */
export const DAEMON_EVENT_TYPES: readonly string[] = (
  Object.keys(eventRegistry) as Array<EforgeEvent['type']>
).filter((type) => (eventRegistry[type] as EventMeta<typeof type>).persist);

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------

export { eventRegistry };
export type { EventRegistryShape };

/**
 * Compute the human-readable summary for an event using the registry.
 * Returns undefined when no summary is defined for the event type.
 */
export function getEventSummary(event: EforgeEvent): string | undefined {
  const meta = (eventRegistry as Record<string, EventMeta<EforgeEvent['type']>>)[event.type];
  if (!meta?.summary) return undefined;
  if (typeof meta.summary === 'string') return meta.summary;
  return (meta.summary as (e: EforgeEvent) => string | undefined)(event) ?? undefined;
}
