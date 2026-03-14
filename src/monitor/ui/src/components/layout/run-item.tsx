import type { RunInfo } from '@/lib/types';
import { formatTime } from '@/lib/format';
import { cn } from '@/lib/utils';

interface RunItemProps {
  run: RunInfo;
  isActive: boolean;
  onSelect: (runId: string) => void;
}

export function RunItem({ run, isActive, onSelect }: RunItemProps) {
  return (
    <div
      className={cn(
        'px-2.5 py-2 rounded-md cursor-pointer mb-0.5',
        'hover:bg-bg-tertiary',
        isActive && 'bg-bg-tertiary border-l-2 border-cyan',
      )}
      onClick={() => onSelect(run.id)}
    >
      <div className="text-xs font-semibold text-text-bright">{run.command}</div>
      <div className="text-[11px] text-text-dim mt-0.5">{run.planSet}</div>
      <div className="flex items-center gap-2 mt-1 text-[11px]">
        <span
          className={cn(
            'inline-block px-1.5 py-px rounded-full text-[10px] font-semibold uppercase tracking-wide',
            run.status === 'running' && 'bg-blue/15 text-blue',
            run.status === 'completed' && 'bg-green/15 text-green',
            run.status === 'failed' && 'bg-red/15 text-red',
          )}
        >
          {run.status}
        </span>
        <span className="text-text-dim">{formatTime(run.startedAt)}</span>
      </div>
    </div>
  );
}
