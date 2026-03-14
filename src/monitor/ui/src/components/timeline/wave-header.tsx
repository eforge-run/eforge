import { cn } from '@/lib/utils';
import type { WaveStatus } from '@/lib/wave-utils';

interface WaveHeaderProps {
  waveNumber: number;
  planCount: number;
  completedCount: number;
  runningCount: number;
  failedCount: number;
  status: WaveStatus;
  isOpen: boolean;
}

const statusColors: Record<WaveStatus, string> = {
  pending: 'text-text-dim',
  running: 'text-blue',
  complete: 'text-green',
  failed: 'text-red',
};

const statusBadgeColors: Record<WaveStatus, string> = {
  pending: 'bg-muted-foreground/15 text-text-dim',
  running: 'bg-blue/15 text-blue',
  complete: 'bg-green/15 text-green',
  failed: 'bg-red/15 text-red',
};

function buildProgressText(
  completedCount: number,
  runningCount: number,
  failedCount: number,
  planCount: number,
): string {
  const parts: string[] = [];
  if (completedCount > 0) parts.push(`${completedCount}/${planCount} complete`);
  if (runningCount > 0) parts.push(`${runningCount} running`);
  if (failedCount > 0) parts.push(`${failedCount} failed`);
  if (parts.length === 0) return `${planCount} plan${planCount !== 1 ? 's' : ''} pending`;
  return parts.join(', ');
}

export function WaveHeader({
  waveNumber,
  planCount,
  completedCount,
  runningCount,
  failedCount,
  status,
  isOpen,
}: WaveHeaderProps) {
  const progressText = buildProgressText(completedCount, runningCount, failedCount, planCount);

  return (
    <div className="flex items-center gap-2.5 w-full cursor-pointer select-none py-2 px-3 rounded-md hover:bg-bg-tertiary/50 transition-colors">
      <span
        className={cn(
          'text-[10px] transition-transform duration-150',
          isOpen ? 'rotate-90' : 'rotate-0',
          statusColors[status],
        )}
      >
        ▶
      </span>
      <span className={cn('text-xs font-semibold', statusColors[status])}>
        Wave {waveNumber}
      </span>
      <span className={cn('text-[10px] px-1.5 py-px rounded-sm', statusBadgeColors[status])}>
        {status}
      </span>
      <span className="text-[11px] text-text-dim ml-auto">
        {progressText}
      </span>
    </div>
  );
}
