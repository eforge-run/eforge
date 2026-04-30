import { useEffect, useMemo, useRef, useState } from 'react';
import * as Collapsible from '@radix-ui/react-collapsible';
import { ChevronRight, CornerDownRight, RefreshCw } from 'lucide-react';
import type { QueueItem, RunInfo } from '@/lib/types';
import { useApi } from '@/hooks/use-api';
import { fetchRecoverySidecar, triggerRecover } from '@/lib/api';
import { cn } from '@/lib/utils';
import { API_ROUTES } from '@eforge-build/client';
import type { ReadSidecarResponse } from '@eforge-build/client';
import { Button } from '@/components/ui/button';
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
  const { data: runs } = useApi<RunInfo[]>(API_ROUTES.runs);
  // Tracks prdIds that have had triggerRecover called recently (debounce).
  const [triggeringIds, setTriggeringIds] = useState<Set<string>>(new Set());

  // --- eforge:region plan-04-monitor-ui ---
  // Sidecar data per prdId: undefined = not yet fetched, null = fetched but
  // no sidecar found (recovery pending), ReadSidecarResponse = sidecar present.
  const [sidecarData, setSidecarData] = useState<Record<string, ReadSidecarResponse | null>>({});
  // Tracks (setName/prdId) keys that have already been fetched to avoid
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
  // Derive the most recent run's planSet as the setName for sidecar lookups.
  // Failed queue items don't carry setName in their payload; the daemon stores
  // sidecars at eforge/plans/<setName>/<prdId>.recovery.json, so we need the
  // planSet from the run that built the PRD. Using the most-recent run is
  // the right heuristic for the typical single-active-planset scenario.
  const activeSetName = useMemo(() => {
    if (!runs || runs.length === 0) return null;
    const sorted = [...runs].sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    );
    return sorted[0]?.planSet ?? null;
  }, [runs]);

  // When setName changes (new run started), clear the fetch-dedup cache so
  // failed items are re-evaluated with the new setName.
  const prevSetNameRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevSetNameRef.current !== activeSetName) {
      fetchedKeysRef.current = new Set();
      prevSetNameRef.current = activeSetName;
    }
  }, [activeSetName]);

  // Fetch sidecars for failed items that haven't been fetched yet.
  // Piggybacked on the queue polling cadence (items changes every 5s).
  useEffect(() => {
    if (!activeSetName || !items) return;
    const failedItems = items.filter((i) => i.status === 'failed');
    if (failedItems.length === 0) return;

    let cancelled = false;

    failedItems.forEach((item) => {
      const key = `${activeSetName}/${item.id}`;
      if (fetchedKeysRef.current.has(key)) return;
      // Do NOT pre-emptively add the key — only mark done when a sidecar is
      // actually retrieved, so null (404) results are retried on the next poll.

      fetchRecoverySidecar(activeSetName, item.id).then((result) => {
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
  }, [items, activeSetName]);
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
          // RecoveryVerdictSidecar has [key: string]: unknown which causes index-signature
          // widening on named property access. Cast through unknown to recover the typed shape.
          type VerdictShape = { verdict: RecoveryVerdictValue; confidence: RecoveryConfidenceValue };
          const sidecarVerdict =
            sidecar != null
              ? (sidecar.json.verdict as unknown as VerdictShape)
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
                  <>
                    <span className="text-[10px] text-text-dim/60 italic">recovery pending</span>
                    {activeSetName && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-4 w-4 p-0"
                        disabled={triggeringIds.has(item.id)}
                        title="Run recovery analysis"
                        onClick={() => {
                          if (!activeSetName) return;
                          setTriggeringIds((prev) => new Set([...prev, item.id]));
                          triggerRecover(activeSetName, item.id).finally(() => {
                            setTimeout(() => {
                              setTriggeringIds((prev) => {
                                const next = new Set(prev);
                                next.delete(item.id);
                                return next;
                              });
                            }, 3000);
                          });
                        }}
                      >
                        <RefreshCw size={10} />
                      </Button>
                    )}
                  </>
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
                  <RecoverySidecarSheet sidecar={sidecar} prdId={item.id} setName={activeSetName ?? ''} />
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
