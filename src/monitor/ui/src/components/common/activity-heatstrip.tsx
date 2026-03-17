import { useMemo } from 'react';
import type { StoredEvent } from '@/lib/reducer';

interface ActivityHeatstripProps {
  events: StoredEvent[];
  startTime: number | null;
  endTime: number | null;
}

const BUCKET_MS = 30_000; // 30 seconds per bucket
const CELL_WIDTH = 4;
const CELL_HEIGHT = 16;
const LABEL_INTERVAL = 10; // every 10 buckets = 5 minutes

const DENSITY_COLORS = [
  'var(--color-bg-tertiary)',
  'var(--color-blue)',
  'var(--color-cyan)',
  'var(--color-yellow)',
  'var(--color-orange)',
];

function getDensityColor(count: number, maxCount: number): string {
  if (count === 0 || maxCount === 0) return DENSITY_COLORS[0];
  const ratio = count / maxCount;
  if (ratio < 0.25) return DENSITY_COLORS[1];
  if (ratio < 0.5) return DENSITY_COLORS[2];
  if (ratio < 0.75) return DENSITY_COLORS[3];
  return DENSITY_COLORS[4];
}

export function ActivityHeatstrip({ events, startTime, endTime }: ActivityHeatstripProps) {
  const buckets = useMemo(() => {
    if (!startTime || events.length === 0) return [];

    const end = endTime ?? Date.now();
    const totalBuckets = Math.max(1, Math.ceil((end - startTime) / BUCKET_MS));
    const counts = new Array(totalBuckets).fill(0);

    for (const { event } of events) {
      if ('timestamp' in event) {
        const t = new Date((event as { timestamp: string }).timestamp).getTime();
        const idx = Math.floor((t - startTime) / BUCKET_MS);
        if (idx >= 0 && idx < totalBuckets) {
          counts[idx]++;
        }
      }
    }

    const maxCount = Math.max(...counts, 1);
    return counts.map((count, i) => ({
      count,
      color: getDensityColor(count, maxCount),
      isLast: i === totalBuckets - 1,
      minutes: Math.floor((i * BUCKET_MS) / 60_000),
      showLabel: i % LABEL_INTERVAL === 0 && i > 0,
    }));
  }, [events, startTime, endTime]);

  if (buckets.length === 0) return null;

  return (
    <div className="bg-card border border-border rounded-lg px-4 py-2 shadow-sm shadow-black/20">
      <h3 className="text-[10px] uppercase tracking-wider text-text-dim mb-1.5">Activity</h3>
      <div className="relative">
        <div className="flex gap-px items-end overflow-x-auto">
          {buckets.map((bucket, i) => (
            <div key={i} className="flex flex-col items-center">
              <div
                style={{
                  width: CELL_WIDTH,
                  height: CELL_HEIGHT,
                  backgroundColor: bucket.color,
                  borderRadius: 1,
                  animation: bucket.isLast ? 'pulse-opacity 2s ease-in-out infinite' : undefined,
                }}
                title={`${bucket.count} events (${bucket.minutes}m)`}
              />
              {bucket.showLabel && (
                <span className="text-[8px] text-text-dim/50 mt-0.5">{bucket.minutes}m</span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
