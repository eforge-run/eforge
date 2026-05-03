import type { OrchestrationConfig } from '@/lib/types';

/** Compute a depth map from the orchestration config's dependency graph.
 *  Depth = longest path from any root (no dependencies) to this node. */
export function computeDepthMap(plans: OrchestrationConfig['plans']): Map<string, number> {
  const depthMap = new Map<string, number>();
  const depsById = new Map<string, string[]>();
  for (const plan of plans) {
    depsById.set(plan.id, plan.dependsOn);
  }

  function getDepth(id: string, visited: Set<string>): number {
    if (depthMap.has(id)) return depthMap.get(id)!;
    if (visited.has(id)) return 0; // cycle guard
    visited.add(id);
    const deps = depsById.get(id);
    if (!deps || deps.length === 0) {
      depthMap.set(id, 0);
      return 0;
    }
    let maxParentDepth = 0;
    for (const dep of deps) {
      const d = getDepth(dep, visited);
      if (d + 1 > maxParentDepth) maxParentDepth = d + 1;
    }
    depthMap.set(id, maxParentDepth);
    return maxParentDepth;
  }

  for (const plan of plans) {
    getDepth(plan.id, new Set());
  }

  return depthMap;
}
