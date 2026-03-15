import { CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import type { RunInfo } from '@/lib/types';
import { formatRelativeTime, formatRunDuration } from '@/lib/format';
import { cn } from '@/lib/utils';

interface RunItemProps {
  run: RunInfo;
  isActive: boolean;
  onSelect: (runId: string) => void;
  compact?: boolean;
}

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="w-3.5 h-3.5 text-green flex-shrink-0" />;
    case 'failed':
      return <XCircle className="w-3.5 h-3.5 text-red flex-shrink-0" />;
    case 'running':
      return <Loader2 className="w-3.5 h-3.5 text-blue flex-shrink-0 animate-spin" />;
    default:
      return <span className="w-3.5 h-3.5 rounded-full bg-text-dim/30 flex-shrink-0" />;
  }
}

export function RunItem({ run, isActive, onSelect, compact }: RunItemProps) {
  const duration = formatRunDuration(run.startedAt, run.completedAt);
  const relative = formatRelativeTime(run.startedAt);

  return (
    <div
      className={cn(
        'px-2.5 py-2 rounded-md cursor-pointer mb-0.5 transition-colors',
        'hover:bg-bg-tertiary',
        isActive && 'bg-bg-tertiary ring-1 ring-cyan/40',
      )}
      onClick={() => onSelect(run.id)}
    >
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5">
          <StatusIcon status={run.status} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <span
              className={cn(
                'text-[11px] font-medium px-1.5 py-0.5 rounded-sm',
                (run.command === 'plan' || run.command === 'adopt') && 'bg-purple/15 text-purple',
                run.command === 'build' && 'bg-blue/15 text-blue',
                run.command === 'run' && 'bg-cyan/15 text-cyan',
              )}
            >
              {run.command}
            </span>
            <span className="text-[11px] text-text-dim">{relative}</span>
          </div>
          {!compact && (
            <div className="flex items-center justify-between gap-2 mt-1">
              <span className="text-[11px] text-text-dim truncate">{run.planSet}</span>
              <span className="text-[11px] text-text-dim whitespace-nowrap">{duration}</span>
            </div>
          )}
          {compact && (
            <div className="flex items-center justify-end mt-1">
              <span className="text-[11px] text-text-dim whitespace-nowrap">{duration}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
