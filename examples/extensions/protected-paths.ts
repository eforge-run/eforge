/**
 * Protected-paths extension — demonstrates runtime policy gates.
 *
 * This extension blocks plan and final merges that touch files under `infra/`
 * and requires human approval for changes to `packages/engine/`. In the current
 * MVP, `require-approval` blocks because no approval workflow exists. All other
 * changes are allowed automatically.
 *
 * Demonstrates:
 * - `beforePlanMerge` registration
 * - `beforeFinalMerge` registration
 * - `PolicyDecision` discriminated union (`allow`, `block`, `require-approval`)
 * - policy context access (`ctx.planId`, `ctx.diff.files`, final merge branches)
 */

import type { EforgeExtensionAPI, ExtensionDiff, PolicyDecision } from '@eforge-build/extension-sdk';

function decideProtectedPaths(changedPaths: string[], target: string): PolicyDecision {
  // Block merges that touch infra/ entirely.
  const hasInfraChanges = changedPaths.some((p) => p.startsWith('infra/'));
  if (hasInfraChanges) {
    return {
      decision: 'block',
      reason: `${target} touches infra/ — automated merges to infra are not permitted. Merge manually after review.`,
    };
  }

  // Require human approval for engine changes. This blocks in the current MVP.
  const hasEngineChanges = changedPaths.some((p) => p.startsWith('packages/engine/'));
  if (hasEngineChanges) {
    return {
      decision: 'require-approval',
      reason: `${target} modifies packages/engine/ — manual approval required before merging.`,
    };
  }

  return { decision: 'allow' };
}

function pathsFromDiff(diff: ExtensionDiff): string[] {
  return diff.files.map((f) => f.path);
}

export default function protectedPaths(eforge: EforgeExtensionAPI): void {
  eforge.beforePlanMerge(async (ctx): Promise<PolicyDecision> => (
    decideProtectedPaths(pathsFromDiff(ctx.diff), `Plan ${ctx.planId}`)
  ));

  eforge.beforeFinalMerge(async (ctx): Promise<PolicyDecision> => (
    decideProtectedPaths(pathsFromDiff(ctx.diff), `Final merge ${ctx.featureBranch} -> ${ctx.baseBranch}`)
  ));
}
