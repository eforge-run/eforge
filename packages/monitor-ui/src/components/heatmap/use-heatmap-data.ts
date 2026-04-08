import { useMemo } from 'react';
import type { RunState } from '@/lib/reducer';

export type RiskLevel = 'none' | 'single' | 'overlap';

export interface HeatmapFile {
  path: string;
  overlapCount: number;
  maxRisk: RiskLevel;
}

export interface HeatmapPlan {
  id: string;
  name: string;
}

export interface HeatmapData {
  files: HeatmapFile[];
  plans: HeatmapPlan[];
  matrix: Map<string, Map<string, RiskLevel>>;
  stats: {
    totalFiles: number;
    overlappingFiles: number;
  };
}

/**
 * Compute heatmap data from fileChanges.
 * Exported separately for testability.
 */
export function computeHeatmapData(
  fileChanges: Map<string, string[]>,
): HeatmapData {
  // Collect all plan IDs from fileChanges
  const allPlanIds = new Set<string>(fileChanges.keys());

  // Build plans list ordered alphabetically
  const plans: HeatmapPlan[] = Array.from(allPlanIds)
    .map((id) => ({
      id,
      name: id,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  // Invert: file → set of planIds that touched it
  const fileToPlanIds = new Map<string, Set<string>>();
  for (const [planId, files] of fileChanges) {
    for (const file of files) {
      let planSet = fileToPlanIds.get(file);
      if (!planSet) {
        planSet = new Set();
        fileToPlanIds.set(file, planSet);
      }
      planSet.add(planId);
    }
  }

  // Determine risk for each file-plan pair
  const matrix = new Map<string, Map<string, RiskLevel>>();
  let overlappingFiles = 0;

  const files: HeatmapFile[] = [];

  for (const [filePath, touchingPlanIds] of fileToPlanIds) {
    const planRisks = new Map<string, RiskLevel>();
    let maxRisk: RiskLevel = 'none';
    const overlapCount = touchingPlanIds.size;
    const isOverlapping = overlapCount > 1;

    if (isOverlapping) {
      overlappingFiles++;
    }

    // Assign risk levels per plan for this file
    for (const planId of allPlanIds) {
      if (!touchingPlanIds.has(planId)) {
        planRisks.set(planId, 'none');
      } else if (!isOverlapping) {
        planRisks.set(planId, 'single');
        if (maxRisk === 'none') maxRisk = 'single';
      } else {
        planRisks.set(planId, 'overlap');
        maxRisk = 'overlap';
      }
    }

    matrix.set(filePath, planRisks);
    files.push({ path: filePath, overlapCount, maxRisk });
  }

  // Sort files by overlap count descending, then alphabetical
  files.sort((a, b) => b.overlapCount - a.overlapCount || a.path.localeCompare(b.path));

  return {
    files,
    plans,
    matrix,
    stats: {
      totalFiles: files.length,
      overlappingFiles,
    },
  };
}

export function useHeatmapData(runState: RunState): HeatmapData {
  return useMemo(
    () => computeHeatmapData(runState.fileChanges),
    [runState.fileChanges],
  );
}
