import { useMemo } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { StoredEvent } from '@/lib/reducer';

export const ACTIVITY_BUCKET_MS = 5_000; // 5 seconds per bucket

export const ACTIVITY_STREAMING_TYPES = new Set(['agent:message', 'agent:tool_use', 'agent:tool_result']);

export function getActivityOpacity(ratio: number): string {
  if (ratio < 0.25) return 'rgba(255, 255, 255, 0.05)';
  if (ratio < 0.50) return 'rgba(255, 255, 255, 0.12)';
  if (ratio < 0.75) return 'rgba(255, 255, 255, 0.20)';
  return 'rgba(255, 255, 255, 0.30)';
}

export function ActivityOverlay({ agentEvents, threadStart, threadEnd }: {
  agentEvents: StoredEvent[];
  threadStart: number;
  threadEnd: number;
}) {
  const buckets = useMemo(() => {
    const span = threadEnd - threadStart;
    if (span <= 0) return [];

    const totalBuckets = Math.max(1, Math.ceil(span / ACTIVITY_BUCKET_MS));
    const counts = new Array(totalBuckets).fill(0);

    for (const { event } of agentEvents) {
      if ('timestamp' in event) {
        const t = new Date((event as { timestamp: string }).timestamp).getTime();
        const idx = Math.floor((t - threadStart) / ACTIVITY_BUCKET_MS);
        if (idx >= 0 && idx < totalBuckets) {
          counts[idx]++;
        }
      }
    }

    const maxCount = Math.max(...counts, 1);
    return counts
      .map((count, i) => ({ count, index: i }))
      .filter(({ count }) => count > 0)
      .map(({ count, index }) => ({
        count,
        leftPercent: ((index * ACTIVITY_BUCKET_MS) / span) * 100,
        widthPercent: (ACTIVITY_BUCKET_MS / span) * 100,
        color: getActivityOpacity(count / maxCount),
      }));
  }, [agentEvents, threadStart, threadEnd]);

  if (buckets.length === 0) return null;

  return (
    <>
      {buckets.map((bucket, i) => (
        <Tooltip key={i}>
          <TooltipTrigger asChild>
            <div
              className="absolute inset-y-0 z-0"
              style={{
                left: `${bucket.leftPercent}%`,
                width: `${bucket.widthPercent}%`,
                backgroundColor: bucket.color,
              }}
            />
          </TooltipTrigger>
          <TooltipContent side="top">
            {bucket.count} events
          </TooltipContent>
        </Tooltip>
      ))}
    </>
  );
}
