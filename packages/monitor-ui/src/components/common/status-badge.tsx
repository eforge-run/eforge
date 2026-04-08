import { cn } from '@/lib/utils';

interface StatusBadgeProps {
  status: string;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  return (
    <span
      className={cn(
        'inline-block px-1.5 py-px rounded-full text-[10px] font-semibold uppercase tracking-wide',
        status === 'running' && 'bg-blue/15 text-blue',
        status === 'completed' && 'bg-green/15 text-green',
        status === 'failed' && 'bg-red/15 text-red',
      )}
    >
      {status}
    </span>
  );
}
