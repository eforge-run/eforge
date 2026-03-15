import { memo } from 'react';
import type { NodeProps } from '@xyflow/react';

export interface WaveGroupData {
  label: string;
  [key: string]: unknown;
}

function WaveGroupComponent({ data }: NodeProps) {
  const groupData = data as unknown as WaveGroupData;

  return (
    <div className="relative w-full h-full">
      <div
        className="absolute text-[10px] font-semibold uppercase tracking-wider"
        style={{
          top: 8,
          left: 14,
          color: 'var(--color-text-dim)',
          opacity: 0.6,
        }}
      >
        {groupData.label}
      </div>
    </div>
  );
}

export const WaveGroupNode = memo(WaveGroupComponent);
