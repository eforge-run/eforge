/**
 * Protected-paths extension — demonstrates the `beforePlanMerge` policy gate.
 *
 * This extension blocks plan merges that touch files under `infra/` and
 * requires human approval for changes to `packages/engine/`. All other
 * changes are allowed automatically.
 *
 * RUNTIME STATUS: The `beforePlanMerge` hook type contract is fully defined in
 * this release. Runtime dispatch (policy-gate evaluation before merge) is NOT
 * yet wired into the engine pipeline. This module serves as a compile-checked
 * type demonstration only — it will have no runtime effect until the policy-gate
 * runtime is implemented.
 *
 * Demonstrates:
 * - `beforePlanMerge` registration
 * - `PolicyDecision` discriminated union (`allow`, `block`, `require-approval`)
 * - `PolicyGateContext` access (`ctx.planId`, `ctx.diff.files`)
 */

import type { EforgeExtensionAPI, PolicyDecision } from '@eforge-build/extension-sdk';

export default function protectedPaths(eforge: EforgeExtensionAPI): void {
  eforge.beforePlanMerge(async (ctx): Promise<PolicyDecision> => {
    const changedPaths = ctx.diff.files.map((f) => f.path);

    // Block merges that touch infra/ entirely.
    const hasInfraChanges = changedPaths.some((p) => p.startsWith('infra/'));
    if (hasInfraChanges) {
      return {
        decision: 'block',
        reason: `Plan ${ctx.planId} touches infra/ — automated merges to infra are not permitted. Merge manually after review.`,
      };
    }

    // Require human approval for engine changes.
    const hasEngineChanges = changedPaths.some((p) => p.startsWith('packages/engine/'));
    if (hasEngineChanges) {
      return {
        decision: 'require-approval',
        reason: `Plan ${ctx.planId} modifies packages/engine/ — manual approval required before merging.`,
      };
    }

    return { decision: 'allow' };
  });
}
