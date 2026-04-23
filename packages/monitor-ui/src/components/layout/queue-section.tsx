import { useEffect, useMemo, useState } from 'react';
import * as Collapsible from '@radix-ui/react-collapsible';
import { ChevronRight } from 'lucide-react';
import type { QueueItem } from '@/lib/types';
import { useApi } from '@/hooks/use-api';
import { cn } from '@/lib/utils';
import { API_ROUTES } from '@eforge-build/client';

const STATUS_ORDER: Record<string, number> = {
  running: 0,
  pending: 1,
};

function statusDotClass(status: string): string {
  switch (status) {
    case 'pending':
      return 'bg-yellow';
    case 'running':
      return 'bg-blue animate-pulse';
    case 'completed':
      return 'bg-green';
    case 'failed':
      return 'bg-red';
    case 'skipped':
      return 'bg-text-dim';
    default:
      return 'bg-text-dim';
  }
}

function sortQueueItems(items: QueueItem[]): QueueItem[] {
  return [...items].sort((a, b) => {
    const aOrder = STATUS_ORDER[a.status] ?? 2;
    const bOrder = STATUS_ORDER[b.status] ?? 2;
    if (aOrder !== bOrder) return aOrder - bOrder;

    // Within same status group: priority descending (next-to-process at bottom), nulls last
    const aPri = a.priority;
    const bPri = b.priority;
    if (aPri !== undefined && bPri !== undefined) {
      if (aPri !== bPri) return bPri - aPri;
    } else if (aPri !== undefined) {
      return -1;
    } else if (bPri !== undefined) {
      return 1;
    }

    return 0;
  });
}

interface QueueSectionProps {
  refreshTrigger: number;
}

export function QueueSection({ refreshTrigger }: QueueSectionProps) {
  const [open, setOpen] = useState(true);
  const { data: items, refetch } = useApi<QueueItem[]>(API_ROUTES.queue);

  // Poll every 5 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      refetch();
    }, 5000);
    return () => clearInterval(interval);
  }, [refetch]);

  // Refetch on navigation
  useEffect(() => {
    if (refreshTrigger > 0) {
      refetch();
    }
  }, [refreshTrigger, refetch]);

  const pendingItems = useMemo(
    () => (items ?? []).filter((i) => i.status !== 'running'),
    [items],
  );
  const sorted = useMemo(() => sortQueueItems(pendingItems), [pendingItems]);
  const pendingCount = pendingItems.length;

  if (pendingCount === 0) return null;

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="mb-3">
      <Collapsible.Trigger className="flex items-center justify-between w-full px-2 py-1.5 group">
        <div className="flex items-center gap-1.5">
          <ChevronRight
            className={cn(
              'w-3 h-3 text-text-dim transition-transform',
              open && 'rotate-90',
            )}
          />
          <span className="text-[11px] uppercase tracking-wider text-text-dim">
            Queue
          </span>
        </div>
        <span className="text-[10px] text-text-dim/70 bg-bg-tertiary px-1.5 py-0.5 rounded-sm">
          {pendingCount}
        </span>
      </Collapsible.Trigger>
      <Collapsible.Content>
        {sorted.map((item) => (
          <div
            key={item.id}
            className="px-2.5 py-1.5 rounded-md mb-0.5"
          >
            <div className="flex items-center gap-2">
              <span
                className={cn('w-2 h-2 rounded-full flex-shrink-0', statusDotClass(item.status))}
              />
              <span className="text-[11px] text-foreground truncate flex-1">
                {item.title}
              </span>
              {item.priority !== undefined && (
                <span className="text-[10px] text-text-dim">
                  p{item.priority}
                </span>
              )}
            </div>
            {item.dependsOn && item.dependsOn.length > 0 && (
              <div className="pl-[calc(8px+0.5rem)] text-[11px] text-text-dim truncate">
                blocked by: {item.dependsOn.join(', ')}
              </div>
            )}
          </div>
        ))}
      </Collapsible.Content>
    </Collapsible.Root>
  );
}
