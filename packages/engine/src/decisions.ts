/**
 * Build-phase decision emission helper.
 *
 * Convention: All engine code that emits `plan:build:decision` events must
 * call `emitBuildDecision(ctx, decision)` from this file. Direct yields of
 * `{ type: 'plan:build:decision', ... }` outside this file are forbidden —
 * a grep gate (added in plan-02 alongside the emission sites) enforces zero hits.
 */
import { BuildDecisionSchema } from '@eforge-build/client';
import type { EforgeEvent, BuildDecision } from '@eforge-build/client';
import type { BuildStageContext } from './pipeline/types.js';

export type { BuildDecision };

/** Narrowed event shape returned by `emitBuildDecision` — preserves field-level type info for callers. */
export type BuildDecisionEvent = Extract<EforgeEvent, { type: 'plan:build:decision' }>;

/**
 * Constructs a fully-formed `plan:build:decision` event.
 *
 * Validates the `decision` payload through `BuildDecisionSchema.parse` so
 * production code throws on malformed payloads. Attaches `timestamp` and
 * `planId` from the provided context.
 *
 * @param ctx - The current build stage context (provides `planId`).
 * @param decision - The typed inner decision payload (must satisfy `BuildDecision`).
 * @returns A narrowed `plan:build:decision` event with typed `planId` and `decision` fields.
 */
export function emitBuildDecision(ctx: BuildStageContext, decision: BuildDecision): BuildDecisionEvent {
  // Validate the inner payload — throws ZodError if malformed
  const validated = BuildDecisionSchema.parse(decision);
  return {
    timestamp: new Date().toISOString(),
    type: 'plan:build:decision',
    planId: ctx.planId,
    decision: validated,
  };
}
