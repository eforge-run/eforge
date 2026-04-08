import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { getStatusStyle, type GraphNodeStatus } from './graph-status';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';

export interface DagNodeData {
  planId: string;
  planName: string;
  status: GraphNodeStatus;
  highlighted: boolean | null; // null = normal, true = highlighted, false = dimmed
  [key: string]: unknown;
}

function DagNodeComponent({ data }: NodeProps) {
  const nodeData = data as unknown as DagNodeData;
  const style = getStatusStyle(nodeData.status);
  const isDimmed = nodeData.highlighted === false;

  return (
    <div
      style={{
        background: style.bgColor,
        borderColor: style.color,
        opacity: isDimmed ? 0.25 : 1,
        transition: 'opacity 0.2s ease, background 0.3s ease, border-color 0.3s ease',
      }}
      className="rounded-lg border px-4 py-3 w-[200px] cursor-pointer"
    >
      <Handle
        type="target"
        position={Position.Top}
        style={{ background: 'var(--color-border)', width: 6, height: 6, border: 'none', opacity: 0.4 }}
      />

      <div className="flex items-center gap-2">
        <span
          style={{
            color: style.color,
            animation: style.animated ? 'pulse-opacity 1.5s ease-in-out infinite' : 'none',
          }}
          className="text-sm font-bold"
        >
          {style.icon}
        </span>

        <div className="flex flex-col min-w-0 flex-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className="text-[11px] font-medium truncate"
                style={{ color: 'var(--color-foreground)' }}
              >
                {nodeData.planName}
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">{nodeData.planName}</TooltipContent>
          </Tooltip>
          <span className="text-[9px]" style={{ color: 'var(--color-text-dim)' }}>
            {nodeData.status}
          </span>
        </div>
      </div>

      <Handle
        type="source"
        position={Position.Bottom}
        style={{ background: 'var(--color-border)', width: 6, height: 6, border: 'none', opacity: 0.4 }}
      />
    </div>
  );
}

export const DagNode = memo(DagNodeComponent);
