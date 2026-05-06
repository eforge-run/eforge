import { useMemo, useState } from 'react';
import * as Collapsible from '@radix-ui/react-collapsible';
import { ChevronRight, CornerDownRight } from 'lucide-react';
import type { QueueItem } from '@/lib/types';
import { cn } from '@/lib/utils';
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

/**
 * Renders a single queue row for a failed item.
 *
 * Reads the recovery verdict directly from `item.recoveryVerdict`, which is
 * embedded by the daemon in the `/api/queue` payload for items in `failed/`.
 * No per-row SWR fetch is made — the full sidecar markdown is loaded lazily
 * inside `RecoverySidecarSheet` when the user opens it.
 *
 * Two-state contract:
 *   item.recoveryVerdict present  → show verdict chip + "view report" link
 *   item.recoveryVerdict absent   → show "recovery pending" indicator
 */
function RecoveryRow({ item, isChild }: { item: QueueItem; isChild: boolean }) {
  // --- eforge:region plan-01-fix-recovery-ux ---
  const rv = item.recoveryVerdict;
  const isRecoveryPending = item.status === 'failed' && !rv;
  // --- eforge:endregion plan-01-fix-recovery-ux ---

  return (
    <div
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
        {/* --- eforge:region plan-01-fix-recovery-ux --- */}
        {rv != null && (
          <RecoveryVerdictChip
            verdict={rv.verdict as RecoveryVerdictValue}
            confidence={rv.confidence as RecoveryConfidenceValue}
          />
        )}
        {isRecoveryPending && (
          <span className="text-[10px] text-text-dim/60 italic">recovery pending</span>
        )}
        {/* --- eforge:endregion plan-01-fix-recovery-ux --- */}
        {item.priority !== undefined && !rv && (
          <span className="text-[10px] text-text-dim">
            p{item.priority}
          </span>
        )}
      </div>
      {/* --- eforge:region plan-01-fix-recovery-ux --- */}
      {rv != null && (
        <div className="pl-[calc(8px+0.5rem)] mt-0.5">
          <RecoverySidecarSheet prdId={item.id} />
        </div>
      )}
      {/* --- eforge:endregion plan-01-fix-recovery-ux --- */}
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
}

interface QueueSectionProps {
  /** Queue items sourced from useDaemonEvents (replaces the SWR poll). */
  items: QueueItem[];
}

export function QueueSection({ items }: QueueSectionProps) {
  const [open, setOpen] = useState(true);

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
          // --- eforge:region plan-05-piggyback-and-queue-scheduling ---
          const isChild = childOf.has(item.id);
          // --- eforge:endregion plan-05-piggyback-and-queue-scheduling ---

          if (item.status === 'failed') {
            return <RecoveryRow key={item.id} item={item} isChild={isChild} />;
          }

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
                {item.priority !== undefined && (
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
