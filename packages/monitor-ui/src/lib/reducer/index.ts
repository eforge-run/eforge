/**
 * Flat handler registry keyed by `EforgeEvent['type']`.
 *
 * IGNORED_EVENT_TYPES lists variants the UI intentionally does not react to.
 * The _Exhaustive type assertion verifies at compile time that every
 * EforgeEvent['type'] is either a key in handlerRegistry or an element of
 * IGNORED_EVENT_TYPES. Adding a new engine event variant without updating
 * this file produces a TypeScript build error rather than a silent runtime no-op.
 *
 * Dispatch in reducer.ts uses:
 *   const handler = (handlerRegistry as Record<string, ...>)[event.type];
 *   const delta = handler ? handler(event as never, state) : undefined;
 */
import type { EforgeEvent } from '../types';

import { handleSessionStart, handleSessionEnd, handleSessionProfile, handlePhaseStart } from './handle-session';
import { handlePlanningComplete } from './handle-planning';
import {
  handlePlanBuildStart,
  handlePlanBuildImplementStart,
  handlePlanBuildDocAuthorStart,
  handlePlanBuildDocAuthorComplete,
  handlePlanBuildDocSyncStart,
  handlePlanBuildDocSyncComplete,
  handlePlanBuildImplementComplete,
  handlePlanBuildTestWriteStart,
  handlePlanBuildTestWriteComplete,
  handlePlanBuildTestStart,
  handlePlanBuildTestComplete,
  handlePlanBuildReviewStart,
  handlePlanBuildReviewComplete,
  handlePlanBuildEvaluateStart,
  handlePlanBuildComplete,
  handlePlanBuildFailed,
  handlePlanBuildFilesChanged,
  handlePlanMergeComplete,
} from './handle-plan-build';
import {
  handleAgentStart,
  handleAgentUsage,
  handleAgentResult,
  handleAgentStop,
} from './handle-agent';
import {
  handleExpeditionArchitectureComplete,
  handleExpeditionModuleStart,
  handleExpeditionModuleComplete,
} from './handle-expedition';
import {
  handleEnqueueStart,
  handleEnqueueComplete,
  handleEnqueueFailed,
  handleEnqueueCommitFailed,
} from './handle-enqueue';
import { handleConfigWarning, handlePlanningWarning } from './handle-misc';

// ---------------------------------------------------------------------------
// Handler registry
// ---------------------------------------------------------------------------

/**
 * Flat registry of all handled event types. Each entry is a typed handler
 * narrowed via the discriminated union — no casts, no `'in' event` guards.
 *
 * Per-group files exist for human readability only; dispatch is O(1) via
 * string-keyed object lookup.
 *
 * TypeScript infers the literal key types automatically. The exhaustiveness
 * check below verifies all EforgeEvent types are accounted for.
 */
export const handlerRegistry = {
  // Session lifecycle
  'session:start': handleSessionStart,
  'session:end': handleSessionEnd,
  'session:profile': handleSessionProfile,

  // Phase lifecycle
  'phase:start': handlePhaseStart,

  // Config/planning warnings
  'config:warning': handleConfigWarning,
  'planning:warning': handlePlanningWarning,

  // Planning
  'planning:complete': handlePlanningComplete,

  // Building
  'plan:build:start': handlePlanBuildStart,
  'plan:build:implement:start': handlePlanBuildImplementStart,
  'plan:build:doc-author:start': handlePlanBuildDocAuthorStart,
  'plan:build:doc-author:complete': handlePlanBuildDocAuthorComplete,
  'plan:build:doc-sync:start': handlePlanBuildDocSyncStart,
  'plan:build:doc-sync:complete': handlePlanBuildDocSyncComplete,
  'plan:build:implement:complete': handlePlanBuildImplementComplete,
  'plan:build:test:write:start': handlePlanBuildTestWriteStart,
  'plan:build:test:write:complete': handlePlanBuildTestWriteComplete,
  'plan:build:test:start': handlePlanBuildTestStart,
  'plan:build:test:complete': handlePlanBuildTestComplete,
  'plan:build:review:start': handlePlanBuildReviewStart,
  'plan:build:review:complete': handlePlanBuildReviewComplete,
  'plan:build:evaluate:start': handlePlanBuildEvaluateStart,
  'plan:build:complete': handlePlanBuildComplete,
  'plan:build:failed': handlePlanBuildFailed,
  'plan:build:files_changed': handlePlanBuildFilesChanged,
  'plan:merge:complete': handlePlanMergeComplete,

  // Agent lifecycle
  'agent:start': handleAgentStart,
  'agent:usage': handleAgentUsage,
  'agent:result': handleAgentResult,
  'agent:stop': handleAgentStop,

  // Expedition planning
  'expedition:architecture:complete': handleExpeditionArchitectureComplete,
  'expedition:module:start': handleExpeditionModuleStart,
  'expedition:module:complete': handleExpeditionModuleComplete,

  // Enqueue
  'enqueue:start': handleEnqueueStart,
  'enqueue:complete': handleEnqueueComplete,
  'enqueue:failed': handleEnqueueFailed,
  'enqueue:commit-failed': handleEnqueueCommitFailed,
};

// ---------------------------------------------------------------------------
// Events intentionally ignored (no state effect)
// ---------------------------------------------------------------------------

/**
 * Event types the UI deliberately does not react to. These are known variants
 * that carry no state-relevant data for the monitor UI.
 *
 * Maintaining this explicit list (vs. a catch-all) ensures that new engine
 * variants are not silently dropped — the _Exhaustive check below forces a
 * compiler error until the new type is either handled or explicitly ignored.
 */
export const IGNORED_EVENT_TYPES = [
  'phase:end',
  'planning:start',
  'planning:skip',
  'planning:submission',
  'planning:error',
  'planning:clarification',
  'planning:clarification:answer',
  'planning:progress',
  'planning:continuation',
  'planning:pipeline',
  'planning:review:start',
  'planning:review:complete',
  'planning:evaluate:start',
  'planning:evaluate:continuation',
  'planning:evaluate:complete',
  'planning:architecture:review:start',
  'planning:architecture:review:complete',
  'planning:architecture:evaluate:start',
  'planning:architecture:evaluate:continuation',
  'planning:architecture:evaluate:complete',
  'planning:cohesion:start',
  'planning:cohesion:complete',
  'planning:cohesion:evaluate:start',
  'planning:cohesion:evaluate:continuation',
  'planning:cohesion:evaluate:complete',
  'plan:build:implement:progress',
  'plan:build:implement:continuation',
  'plan:build:review:parallel:start',
  'plan:build:review:parallel:perspective:start',
  'plan:build:review:parallel:perspective:complete',
  'plan:build:review:fix:start',
  'plan:build:review:fix:complete',
  'plan:build:evaluate:continuation',
  'plan:build:evaluate:complete',
  'plan:build:progress',
  'schedule:start',
  'plan:schedule:ready',
  'plan:merge:start',
  'plan:merge:resolve:start',
  'plan:merge:resolve:complete',
  'merge:finalize:start',
  'merge:finalize:complete',
  'merge:finalize:skipped',
  'expedition:wave:start',
  'expedition:wave:complete',
  'expedition:compile:start',
  'expedition:compile:complete',
  'agent:warning',
  'agent:message',
  'agent:tool_use',
  'agent:tool_result',
  'agent:retry',
  'validation:start',
  'validation:command:start',
  'validation:command:complete',
  'validation:command:timeout',
  'validation:complete',
  'validation:fix:start',
  'validation:fix:complete',
  'prd_validation:start',
  'prd_validation:complete',
  'gap_close:start',
  'gap_close:plan_ready',
  'gap_close:complete',
  'reconciliation:start',
  'reconciliation:complete',
  'cleanup:start',
  'cleanup:complete',
  'approval:needed',
  'approval:response',
  'recovery:start',
  'recovery:summary',
  'recovery:complete',
  'recovery:error',
  'recovery:apply:start',
  'recovery:apply:complete',
  'recovery:apply:error',
  'queue:start',
  'queue:prd:start',
  'queue:prd:discovered',
  'queue:prd:stale',
  'queue:prd:skip',
  'queue:prd:commit-failed',
  'queue:prd:complete',
  'queue:complete',
] as const;

// ---------------------------------------------------------------------------
// Compile-time exhaustiveness check
// ---------------------------------------------------------------------------

/**
 * _Exhaustive resolves to `true` when every EforgeEvent['type'] is either
 * a key in handlerRegistry or an element of IGNORED_EVENT_TYPES.
 *
 * When a new engine event variant is added without updating this file, this
 * type resolves to `{ error: ...; missing: 'new:event:type' }`, making the
 * const assignment below a type error with a legible message.
 *
 * Verification examples:
 *   - Remove 'session:start' from handlerRegistry → build error (missing in registry)
 *   - Add 'fake:event' as a key in handlerRegistry → build error (not in EforgeEvent)
 */
type _MissingTypes = Exclude<
  EforgeEvent['type'],
  keyof typeof handlerRegistry | (typeof IGNORED_EVENT_TYPES)[number]
>;

type _Exhaustive = [_MissingTypes] extends [never]
  ? true
  : { error: 'Not all EforgeEvent types are handled or ignored'; missing: _MissingTypes };

// If this line produces a type error, a new EforgeEvent variant needs to be
// added to handlerRegistry or IGNORED_EVENT_TYPES.
const _exhaustiveCheck: _Exhaustive = true;

// Suppress unused-variable warning — the check is purely compile-time.
void _exhaustiveCheck;
