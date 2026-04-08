import type { PipelineStage } from '@/lib/types';

/** Extended status that includes orchestration-level states beyond build pipeline stages */
export type GraphNodeStatus = PipelineStage | 'pending' | 'running' | 'blocked' | 'merged';

export interface StatusStyle {
  color: string;
  bgColor: string;
  icon: string;
  animated: boolean;
}

const STATUS_STYLES: Record<GraphNodeStatus, StatusStyle> = {
  pending: {
    color: 'var(--color-text-dim)',
    bgColor: 'var(--color-secondary)',
    icon: '○',
    animated: false,
  },
  running: {
    color: 'var(--color-blue)',
    bgColor: 'rgba(88, 166, 255, 0.15)',
    icon: '◌',
    animated: true,
  },
  implement: {
    color: 'var(--color-blue)',
    bgColor: 'rgba(88, 166, 255, 0.15)',
    icon: '◌',
    animated: true,
  },
  review: {
    color: 'var(--color-purple)',
    bgColor: 'rgba(188, 140, 255, 0.15)',
    icon: '◌',
    animated: true,
  },
  evaluate: {
    color: 'var(--color-cyan)',
    bgColor: 'rgba(57, 210, 192, 0.15)',
    icon: '◌',
    animated: true,
  },
  complete: {
    color: 'var(--color-green)',
    bgColor: 'rgba(63, 185, 80, 0.15)',
    icon: '✓',
    animated: false,
  },
  failed: {
    color: 'var(--color-red)',
    bgColor: 'rgba(248, 81, 73, 0.15)',
    icon: '✗',
    animated: false,
  },
  blocked: {
    color: 'var(--color-yellow)',
    bgColor: 'rgba(210, 153, 34, 0.15)',
    icon: '⊘',
    animated: false,
  },
  merged: {
    color: 'var(--color-green)',
    bgColor: 'rgba(63, 185, 80, 0.12)',
    icon: '✓',
    animated: false,
  },
  test: {
    color: 'var(--color-cyan)',
    bgColor: 'rgba(57, 210, 192, 0.15)',
    icon: '◌',
    animated: true,
  },
  plan: {
    color: 'var(--color-blue)',
    bgColor: 'rgba(88, 166, 255, 0.15)',
    icon: '◌',
    animated: true,
  },
  'doc-update': {
    color: 'var(--color-purple)',
    bgColor: 'rgba(188, 140, 255, 0.15)',
    icon: '◌',
    animated: true,
  },
};

const FALLBACK_STYLE: StatusStyle = {
  color: 'var(--color-text-dim)',
  bgColor: 'var(--color-secondary)',
  icon: '?',
  animated: false,
};

export function getStatusStyle(status: GraphNodeStatus | string): StatusStyle {
  return STATUS_STYLES[status as GraphNodeStatus] ?? FALLBACK_STYLE;
}

/** Map PipelineStage (from reducer) to GraphNodeStatus, with orchestration awareness */
export function resolveNodeStatus(
  planId: string,
  pipelineStatus: PipelineStage | undefined,
  mergedPlanIds: Set<string>,
): GraphNodeStatus {
  if (mergedPlanIds.has(planId)) return 'merged';
  if (pipelineStatus) return pipelineStatus;
  return 'pending';
}
