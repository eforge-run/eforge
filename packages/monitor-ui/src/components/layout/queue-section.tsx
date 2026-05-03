import { useEffect, useMemo, useRef, useState } from 'react';
import * as Collapsible from '@radix-ui/react-collapsible';
import { ChevronRight, CornerDownRight } from 'lucide-react';
import type { QueueItem } from '@/lib/types';
import { useApi } from '@/hooks/use-api';
import { fetchRecoverySidecar } from '@/lib/api';
import { cn } from '@/lib/utils';
import { API_ROUTES } from '@eforge-build/client/browser';
import type { ReadSidecarResponse } from '@eforge-build/client/browser';
import {
  RecoveryVerdictChip,
  type RecoveryVerdictValue,
  type RecoveryConfidenceValue,
} from '@/components/recovery/verdict-chip';
import { RecoverySidecarSheet } from '@/components/recovery/sidecar-sheet';

const STATUS_ORDER: Record<string, number> = {
  running: 0,
  pending: 1,
  // --- eforge:region plan-05-piggyback-and-queue-scheduling ---
  waiting: 2,
  // --- eforge:endregion plan-05-piggyback-and-queue-scheduling ---
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
    // --- eforge:region plan-05-piggyback-and-queue-scheduling ---
    case 'waiting':
      return 'bg-text-dim/50';
    // --- eforge:endregion plan-05-piggyback-and-queue-scheduling ---
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

  // --- eforge:region plan-04-monitor-ui ---
  // Sidecar data per prdId: undefined = not yet fetched, null = fetched but
  // no sidecar found (recovery pending), ReadSidecarResponse = sidecar present.
  const [sidecarData, setSidecarData] = useState<Record<string, ReadSidecarResponse | null>>({});
  // Tracks prdId keys that have already been fetched to avoid
  // redundant requests on the 5s polling interval.
  const fetchedKeysRef = useRef<Set<string>>(new Set());
  // --- eforge:endregion plan-04-monitor-ui ---

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

  // --- eforge:region plan-04-monitor-ui ---
  // Fetch sidecars for failed items that haven't been fetched yet.
  // Piggybacked on the queue polling cadence (items changes every 5s).
  useEffect(() => {
    if (!items) return;
    const failedItems = items.filter((i) => i.status === 'failed');
    if (failedItems.length === 0) return;

    let cancelled = false;

    failedItems.forEach((item) => {
      const key = item.id;
      if (fetchedKeysRef.current.has(key)) return;
      // Do NOT pre-emptively add the key — only mark done when a sidecar is
      // actually retrieved, so null (404) results are retried on the next poll.

      fetchRecoverySidecar(item.id).then((result) => {
        if (cancelled) return;
        if (result) {
          // Sidecar found — mark as done so we don't re-fetch next poll.
          fetchedKeysRef.current.add(key);
        }
        setSidecarData((prev) => ({ ...prev, [item.id]: result }));
      });
    });

    return () => {
      cancelled = true;
    };
  }, [items]);
  // --- eforge:endregion plan-04-monitor-ui ---

  const pendingItems = useMemo(
    () => (items ?? []).filter((i) => i.status !== 'running'),
    [items],
  );
  const sorted = useMemo(() => sortQueueItems(pendingItems), [pendingItems]);
  const pendingCount = pendingItems.length;

  // --- eforge:region plan-05-piggyback-and-queue-scheduling ---
  // Build parent-child map for nested rendering: childId -> parentId
  const childOf = useMemo(() => {
    const itemIds = new Set(sorted.map((i) => i.id));
    const map = new Map<string, string>();
    for (const item of sorted) {
      if (item.dependsOn) {
        for (const dep of item.dependsOn) {
          if (itemIds.has(dep)) {
            map.set(item.id, dep);
            break; // use first matching parent
          }
        }
      }
    }
    return map;
  }, [sorted]);
  // --- eforge:endregion plan-05-piggyback-and-queue-scheduling ---

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
        {sorted.map((item) => {
          // --- eforge:region plan-04-monitor-ui ---
          const sidecar = item.status === 'failed' ? sidecarData[item.id] : undefined;
          const sidecarVerdict =
            sidecar != null
              ? sidecar.json.verdict
              : null;
          // undefined = not yet fetched; null = fetched but no sidecar (recovery pending)
          // Both cases result in sidecarVerdict == null → show the "recovery pending" indicator.
          const isRecoveryPending = item.status === 'failed' && sidecarVerdict == null;
          // --- eforge:endregion plan-04-monitor-ui ---

          // --- eforge:region plan-05-piggyback-and-queue-scheduling ---
          const isChild = childOf.has(item.id);
          // --- eforge:endregion plan-05-piggyback-and-queue-scheduling ---

          return (
            <div
              key={item.id}
              // --- eforge:region plan-05-piggyback-and-queue-scheduling ---
              className={cn('py-1.5 rounded-md mb-0.5', isChild ? 'pl-5 pr-2.5' : 'px-2.5')}
              // --- eforge:endregion plan-05-piggyback-and-queue-scheduling ---
            >
              <div className="flex items-center gap-2">
                {/* --- eforge:region plan-05-piggyback-and-queue-scheduling --- */}
                {isChild && (
                  <CornerDownRight className="h-3 w-3 text-text-dim/60 flex-shrink-0 shrink-0" />
                )}
                {/* --- eforge:endregion plan-05-piggyback-and-queue-scheduling --- */}
                <span
                  className={cn('w-2 h-2 rounded-full flex-shrink-0', statusDotClass(item.status))}
                />
                <span className="text-[11px] text-foreground truncate flex-1">
                  {item.title}
                </span>
                {/* --- eforge:region plan-04-monitor-ui --- */}
                {sidecarVerdict != null && (
                  <RecoveryVerdictChip
                    verdict={sidecarVerdict.verdict}
                    confidence={sidecarVerdict.confidence}
                  />
                )}
                {isRecoveryPending && (
                  <span className="text-[10px] text-text-dim/60 italic">recovery pending</span>
                )}
                {/* --- eforge:endregion plan-04-monitor-ui --- */}
                {item.priority !== undefined && sidecarVerdict == null && (
                  <span className="text-[10px] text-text-dim">
                    p{item.priority}
                  </span>
                )}
                {/* --- eforge:region plan-05-piggyback-and-queue-scheduling --- */}
                {item.status === 'waiting' && (
                  <span className="text-[10px] text-text-dim/60 italic">waiting</span>
                )}
                {/* --- eforge:endregion plan-05-piggyback-and-queue-scheduling --- */}
              </div>
              {/* --- eforge:region plan-04-monitor-ui --- */}
              {sidecar != null && sidecarVerdict != null && (
                <div className="pl-[calc(8px+0.5rem)] mt-0.5">
                  <RecoverySidecarSheet sidecar={sidecar} prdId={item.id} />
                </div>
              )}
              {/* --- eforge:endregion plan-04-monitor-ui --- */}
              {item.dependsOn && item.dependsOn.length > 0 && (
                <div className="pl-[calc(8px+0.5rem)] text-[11px] text-text-dim truncate">
                  {/* --- eforge:region plan-05-piggyback-and-queue-scheduling --- */}
                  {item.status === 'waiting' ? 'waiting for: ' : 'blocked by: '}
                  {/* --- eforge:endregion plan-05-piggyback-and-queue-scheduling --- */}
                  {item.dependsOn.join(', ')}
                </div>
              )}
            </div>
          );
        })}
      </Collapsible.Content>
    </Collapsible.Root>
  );
}
