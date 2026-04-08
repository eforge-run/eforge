import { memo } from 'react';
import { BaseEdge, getSmoothStepPath, type EdgeProps } from '@xyflow/react';
import { getStatusStyle, type GraphNodeStatus } from './graph-status';

export interface DagEdgeData {
  sourceStatus: GraphNodeStatus;
  targetStatus: GraphNodeStatus;
  [key: string]: unknown;
}

function DagEdgeComponent({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps) {
  const edgeData = data as unknown as DagEdgeData;
  const targetStyle = getStatusStyle(edgeData?.targetStatus ?? 'pending');
  const sourceStyle = getStatusStyle(edgeData?.sourceStatus ?? 'pending');

  // Edge color: use target status if running/active, otherwise source status
  const isTargetActive = targetStyle.animated;
  const edgeColor = isTargetActive ? targetStyle.color : sourceStyle.color;
  const isAnimated = isTargetActive;

  // Completed edges are solid, pending are dashed, active are animated dashes
  const sourceCompleted = ['complete', 'merged'].includes(edgeData?.sourceStatus ?? '');
  const isPending =
    edgeData?.sourceStatus === 'pending' && edgeData?.targetStatus === 'pending';

  const [edgePath] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 8,
  });

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: edgeColor,
          strokeWidth: isTargetActive ? 2 : 1.5,
          strokeDasharray: isPending ? '5 5' : isAnimated ? '8 4' : 'none',
          opacity: isPending ? 0.4 : sourceCompleted && !isTargetActive ? 0.7 : 1,
          transition: 'stroke 0.3s ease, opacity 0.3s ease',
        }}
      />
      {isAnimated && (
        <BaseEdge
          id={`${id}-animated`}
          path={edgePath}
          style={{
            stroke: edgeColor,
            strokeWidth: 2,
            strokeDasharray: '8 4',
            strokeDashoffset: 0,
            animation: 'dash-flow 1s linear infinite',
            opacity: 0.8,
          }}
        />
      )}
    </>
  );
}

export const DagEdge = memo(DagEdgeComponent);
