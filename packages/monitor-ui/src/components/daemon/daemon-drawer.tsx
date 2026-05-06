/**
 * DaemonDrawer — slide-over panel showing daemon health and activity.
 *
 * Two regions:
 *  1. Latest heartbeat metrics panel (uptime, queue depth, running builds,
 *     auto-build state, subscriber count). Empty-state copy when no heartbeat.
 *  2. Scrollable activity feed with a filter chip that toggles between
 *     "daemon-only" (default) and "all cross-build events".
 */
import { useState } from 'react';
import { SheetContent } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import type { DaemonActivityEntry, HeartbeatPayload } from '@/lib/daemon-reducer';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function humanizeUptime(ms: number): string {
  const totalSecs = Math.floor(ms / 1000);
  const days = Math.floor(totalSecs / 86400);
  const hours = Math.floor((totalSecs % 86400) / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

function formatRelativeTime(ageMs: number): string {
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1000)}s ago`;
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m ago`;
  return `${Math.floor(ageMs / 3_600_000)}h ago`;
}

/** Derive a display label and color family from an event type string. */
function getEventMeta(type: string): { label: string; colorClass: string } {
  if (type.startsWith('daemon:')) {
    return { label: type.slice('daemon:'.length), colorClass: 'text-blue' };
  }
  if (type.startsWith('queue:')) {
    return { label: type, colorClass: 'text-yellow' };
  }
  if (type.startsWith('enqueue:')) {
    return { label: type, colorClass: 'text-purple' };
  }
  if (type.startsWith('session:')) {
    return { label: type, colorClass: 'text-green' };
  }
  return { label: type, colorClass: 'text-text-dim' };
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function MetricsRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-text-dim">{label}</span>
      <span className="text-text-bright font-medium">{value}</span>
    </div>
  );
}

function HeartbeatPanel({
  latestHeartbeat,
}: {
  latestHeartbeat: { at: number; payload: HeartbeatPayload } | null;
}) {
  if (!latestHeartbeat) {
    return (
      <div className="px-4 py-6 text-center text-text-dim text-xs">
        No heartbeat received yet. Waiting for the daemon to check in...
      </div>
    );
  }

  const { payload } = latestHeartbeat;
  const autoBuildLabel = payload.autoBuild.paused
    ? 'paused'
    : payload.autoBuild.enabled
      ? 'enabled'
      : 'disabled';

  return (
    <div className="px-4 py-3 divide-y divide-border text-xs">
      <MetricsRow label="Uptime" value={humanizeUptime(payload.uptime)} />
      <MetricsRow label="Queue depth" value={String(payload.queueDepth)} />
      <MetricsRow label="Running builds" value={String(payload.runningBuilds)} />
      <MetricsRow label="Auto-build" value={autoBuildLabel} />
      <MetricsRow label="Subscribers" value={String(payload.subscribers)} />
    </div>
  );
}

type FilterMode = 'daemon-only' | 'all';

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'px-2 py-0.5 rounded text-[11px] border transition-colors',
        active
          ? 'bg-primary/20 border-primary/50 text-primary'
          : 'border-border text-text-dim hover:border-border hover:text-text-bright',
      )}
    >
      {children}
    </button>
  );
}

function ActivityFeed({
  entries,
  filter,
  now,
}: {
  entries: DaemonActivityEntry[];
  filter: FilterMode;
  now: number;
}) {
  const visible =
    filter === 'daemon-only'
      ? entries.filter((e) => e.event.type.startsWith('daemon:'))
      : entries;

  // Newest first
  const reversed = [...visible].reverse();

  if (reversed.length === 0) {
    return (
      <div className="px-4 py-6 text-center text-text-dim text-xs">
        {filter === 'daemon-only'
          ? 'No daemon events in the activity buffer yet.'
          : 'No events in the activity buffer yet.'}
      </div>
    );
  }

  return (
    <ul className="divide-y divide-border">
      {reversed.map((entry) => {
        const { label, colorClass } = getEventMeta(entry.event.type);
        const age = now - entry.receivedAt;
        return (
          <li key={entry.id || entry.receivedAt} className="px-4 py-2 flex items-center gap-2">
            <span className={cn('font-mono text-[11px] flex-1 truncate', colorClass)}>{label}</span>
            <span className="text-text-dim text-[11px] flex-shrink-0">
              {formatRelativeTime(age)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// DaemonDrawer
// ---------------------------------------------------------------------------

interface DaemonDrawerProps {
  open: boolean;
  onClose: () => void;
  latestHeartbeat: { at: number; payload: HeartbeatPayload } | null;
  activity: DaemonActivityEntry[];
  now: number;
}

export function DaemonDrawer({
  open,
  onClose,
  latestHeartbeat,
  activity,
  now,
}: DaemonDrawerProps) {
  const [filter, setFilter] = useState<FilterMode>('daemon-only');

  return (
    <SheetContent
      open={open}
      onClose={onClose}
      title="Daemon Activity"
      description="Live daemon health and event stream"
    >
      {/* Heartbeat metrics */}
      <div className="border-b border-border">
        <div className="px-4 pt-3 pb-1">
          <h3 className="text-[11px] font-semibold text-text-dim uppercase tracking-wider">
            Latest Heartbeat
          </h3>
        </div>
        <HeartbeatPanel latestHeartbeat={latestHeartbeat} />
      </div>

      {/* Activity feed */}
      <div className="flex flex-col flex-1 min-h-0">
        <div className="px-4 pt-3 pb-2 flex items-center justify-between flex-shrink-0">
          <h3 className="text-[11px] font-semibold text-text-dim uppercase tracking-wider">
            Activity
          </h3>
          <div className="flex items-center gap-1">
            <FilterChip
              active={filter === 'daemon-only'}
              onClick={() => setFilter('daemon-only')}
            >
              daemon-only
            </FilterChip>
            <FilterChip active={filter === 'all'} onClick={() => setFilter('all')}>
              all events
            </FilterChip>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          <ActivityFeed entries={activity} filter={filter} now={now} />
        </div>
      </div>
    </SheetContent>
  );
}
