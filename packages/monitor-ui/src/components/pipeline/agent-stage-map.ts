import type { AgentRole, BuildStageSpec, PipelineStage } from '@/lib/types';
import type { AgentThread } from '@/lib/reducer';

export const REVIEW_AGENTS = new Set([
  'reviewer', 'review-fixer', 'plan-reviewer', 'architecture-reviewer', 'cohesion-reviewer',
  'evaluator', 'plan-evaluator', 'architecture-evaluator', 'cohesion-evaluator',
]);

/** Map agent roles to pipeline-stage color classes */
export const AGENT_TO_STAGE: Record<AgentRole, string> = {
  'planner': 'planner',
  'plan-reviewer': 'plan-review-cycle',
  'plan-evaluator': 'plan-review-cycle',
  'module-planner': 'module-planning',
  'architecture-reviewer': 'architecture-review-cycle',
  'architecture-evaluator': 'architecture-review-cycle',
  'cohesion-reviewer': 'cohesion-review-cycle',
  'cohesion-evaluator': 'cohesion-review-cycle',
  'builder': 'implement',
  'doc-author': 'doc-author',
  'doc-syncer': 'doc-sync',
  'reviewer': 'review',
  'review-fixer': 'review-fix',
  'evaluator': 'evaluate',
  'validation-fixer': 'validate',
  'formatter': 'formatter',
  'tester': 'test',
  'test-writer': 'test-write',
  'merge-conflict-resolver': 'merge',
  'staleness-assessor': 'staleness',
  'prd-validator': 'prd-validation',
  'gap-closer': 'gap-close',
  'dependency-detector': 'dependency-detection',
  'pipeline-composer': 'pipeline-composition',
  'recovery-analyst': 'recovery',
};

/** Map composite stage names to their child pipeline stages */
export const COMPOSITE_STAGES: Record<string, string[]> = {
  'review-cycle': ['review', 'evaluate'],
  'test-cycle': ['test', 'evaluate'],
};

export type StageStatus = 'pending' | 'active' | 'completed' | 'failed';

/** Minimum timeline window (ms) so short-elapsed bars don't fill 100% width */
export const MIN_TIMELINE_WINDOW_MS = 300_000;

/** Normalize a BuildStageSpec to its string name (for parallel groups, join with '+') */
export function buildStageName(spec: BuildStageSpec): string {
  return Array.isArray(spec) ? spec.join('+') : spec;
}

/** Resolve a raw pipeline stage to its build stage name using the plan's actual build stages.
 *  For stages that appear in a composite (e.g. 'review' in 'review-cycle'), returns the composite
 *  name if that composite is present in the plan's buildStages. Falls back to the raw stage name. */
export function resolveBuildStage(pipelineStage: string, buildStages?: BuildStageSpec[]): string {
  if (!buildStages || buildStages.length === 0) return pipelineStage;

  // Direct match - check if the stage itself is a build stage
  const directMatch = buildStages.some((spec) => {
    const name = buildStageName(spec);
    return name === pipelineStage || (Array.isArray(spec) && spec.includes(pipelineStage));
  });
  if (directMatch) return pipelineStage;

  // Check composites - find the last composite that contains this pipeline stage and is in buildStages
  let resolved = pipelineStage;
  for (const [composite, children] of Object.entries(COMPOSITE_STAGES)) {
    if (!children.includes(pipelineStage)) continue;
    const inBuild = buildStages.some((spec) => {
      const name = buildStageName(spec);
      return name === composite || (Array.isArray(spec) && spec.includes(composite));
    });
    if (inBuild) resolved = composite;
  }

  return resolved;
}

export function getStageStatus(stage: string, activeStages: Set<string>, completedStages: Set<string>): StageStatus {
  if (activeStages.has(stage)) return 'active';
  if (completedStages.has(stage)) return 'completed';
  return 'pending';
}

/** Compute status for each build stage given the current PipelineStage */
export function getBuildStageStatuses(
  buildStages: BuildStageSpec[],
  currentStage: PipelineStage | undefined,
  threads?: AgentThread[],
): StageStatus[] {
  if (!currentStage || buildStages.length === 0) return buildStages.map(() => 'pending');

  // All completed
  if (currentStage === 'complete') return buildStages.map(() => 'completed');

  // Failed - find the furthest-reached build stage from thread data and mark it as failed
  if (currentStage === 'failed') {
    let furthestIdx = -1;
    if (threads && threads.length > 0) {
      for (const thread of threads) {
        const agentStage = AGENT_TO_STAGE[thread.agent as AgentRole];
        if (!agentStage) continue;
        const mappedName = resolveBuildStage(agentStage, buildStages);
        if (!mappedName) continue;
        const idx = buildStages.findIndex((spec) => {
          const name = buildStageName(spec);
          return name === mappedName || (Array.isArray(spec) && spec.includes(mappedName));
        });
        if (idx > furthestIdx) furthestIdx = idx;
      }
    }
    // Fall back to the last stage if no thread data available
    if (furthestIdx === -1) furthestIdx = buildStages.length - 1;

    return buildStages.map((_, i) => {
      if (i < furthestIdx) return 'completed';
      if (i === furthestIdx) return 'failed';
      return 'pending';
    });
  }

  // Map current PipelineStage to build stage name
  const mappedName = resolveBuildStage(currentStage, buildStages);
  if (!mappedName) return buildStages.map(() => 'pending');

  // Find the index of the current stage in the build stages
  const currentIdx = buildStages.findIndex((spec) => {
    const name = buildStageName(spec);
    return name === mappedName || (Array.isArray(spec) && spec.includes(mappedName));
  });

  if (currentIdx === -1) return buildStages.map(() => 'pending');

  return buildStages.map((_, i) => {
    if (i < currentIdx) return 'completed';
    if (i === currentIdx) return 'active';
    return 'pending';
  });
}
