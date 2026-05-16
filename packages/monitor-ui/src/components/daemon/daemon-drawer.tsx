/**
 * DaemonDrawer — slide-over panel showing daemon health and activity.
 *
 * Three regions:
 *  1. Canonical auto-build supervisor status card sourced from
 *     daemonState.autoBuild (never inferred from historical activity).
 *  2. Latest heartbeat metrics panel (uptime, queue depth, running builds,
 *     auto-build state, subscriber count). Empty-state copy when no heartbeat.
 *  3. Scrollable activity feed with filters for daemon-only, scheduler-focused,
 *     and all cross-build events.
 */
import { useState } from 'react';
import { SheetContent } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import type { DaemonActivityEntry, HeartbeatPayload } from '@/lib/daemon-reducer';
import type { AutoBuildState } from '@/lib/api';

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

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
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

// --- eforge:region plan-03-monitor-ui-fsm-card ---
type SchedulerWithCapacity = NonNullable<AutoBuildState['scheduler']> & {
  capacity?: number;
  capacityRemaining?: number;
  runningCount?: number;
  limit?: number;
  maxRunningBuilds?: number;
};

function formatSchedulerState(scheduler: AutoBuildState['scheduler'] | undefined): string {
  if (!scheduler) return 'not reported';
  if (!scheduler.alive) return scheduler.paused ? 'offline, paused' : 'offline';
  return scheduler.paused ? 'alive, paused' : 'alive';
}

function formatWatcherState(watcher: AutoBuildState['watcher'] | undefined): string {
  if (!watcher) return 'not reported';
  if (!watcher.running) return 'stopped';
  return watcher.pid === null ? 'running' : `running (pid ${watcher.pid})`;
}

function formatSchedulerCapacity(autoBuild: AutoBuildState | null): string {
  const scheduler = autoBuild?.scheduler as SchedulerWithCapacity | undefined;
  if (!scheduler) return 'not reported';
  if (typeof scheduler.runningCount === 'number' && typeof scheduler.limit === 'number') {
    return `${scheduler.runningCount}/${scheduler.limit}`;
  }
  if (typeof scheduler.capacityRemaining === 'number' && typeof scheduler.limit === 'number') {
    return `${scheduler.capacityRemaining} remaining of ${scheduler.limit}`;
  }
  if (typeof scheduler.capacityRemaining === 'number') {
    return `${scheduler.capacityRemaining} remaining`;
  }
  if (typeof scheduler.capacity === 'number') return String(scheduler.capacity);
  if (typeof scheduler.maxRunningBuilds === 'number') return String(scheduler.maxRunningBuilds);
  return 'not reported';
}

function formatLastTransition(lastTransition: AutoBuildState['lastTransition'] | undefined): string {
  if (!lastTransition) return 'not reported';
  const reason = lastTransition.reason ? ` · ${lastTransition.reason}` : '';
  return `${lastTransition.previousMode} → ${lastTransition.nextMode}${reason} · ${lastTransition.source} · ${formatTimestamp(lastTransition.at)}`;
}

function getModeChip(mode: AutoBuildState['mode'] | undefined): { label: string; className: string } {
  switch (mode) {
    case 'running':
      return { label: 'running', className: 'bg-green/15 text-green border-green/30' };
    case 'paused':
      return { label: 'paused', className: 'bg-yellow/15 text-yellow border-yellow/30' };
    case 'starting':
    case 'stopping':
    case 'restarting':
      return { label: mode, className: 'bg-blue/15 text-blue border-blue/30' };
    case 'disabled':
      return { label: 'disabled', className: 'bg-text-dim/10 text-text-dim border-border' };
    case 'faulted':
      return { label: 'faulted', className: 'bg-red/15 text-red border-red/30' };
    default:
      return { label: 'unknown', className: 'bg-text-dim/10 text-text-dim border-border' };
  }
}

function getEventSource(event: DaemonActivityEntry['event']): string | undefined {
  const source = (event as { source?: unknown }).source;
  return typeof source === 'string' ? source : undefined;
}

function isSchedulerActivity(entry: DaemonActivityEntry): boolean {
  const type = entry.event.type;
  if (type.startsWith('daemon:auto-build:')) return true;
  if (type.startsWith('daemon:scheduler:')) return true;
  if (type.startsWith('queue:')) return true;
  if (type === 'daemon:error') {
    const source = getEventSource(entry.event);
    return source === 'scheduler' || source === 'auto-build';
  }
  return false;
}
// --- eforge:endregion plan-03-monitor-ui-fsm-card ---

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function MetricsRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <span className="text-text-dim">{label}</span>
      <span className="text-text-bright font-medium text-right">{value}</span>
    </div>
  );
}

// --- eforge:region plan-03-monitor-ui-fsm-card ---
function StatusChip({ mode }: { mode: AutoBuildState['mode'] | undefined }) {
  const chip = getModeChip(mode);
  return (
    <span className={cn('px-2 py-0.5 rounded border text-[11px] font-semibold', chip.className)}>
      {chip.label}
    </span>
  );
}

function SchedulerStatusCard({
  autoBuild,
  latestHeartbeat,
}: {
  autoBuild: AutoBuildState | null;
  latestHeartbeat: { at: number; payload: HeartbeatPayload } | null;
}) {
  const desired = autoBuild?.desired ?? (autoBuild ? 'unknown' : 'not reported');
  const mode = autoBuild?.mode;
  const scheduler = autoBuild?.scheduler;
  const watcher = autoBuild?.watcher;
  const watcherSessionId = autoBuild?.watcher.sessionId ?? 'not reported';
  const queueDepth = latestHeartbeat ? String(latestHeartbeat.payload.queueDepth) : 'unknown';
  const runningBuilds = latestHeartbeat ? String(latestHeartbeat.payload.runningBuilds) : 'unknown';
  const lastTransition = autoBuild?.lastTransition;

  return (
    <div className="px-4 py-3 text-xs">
      <div className="rounded-lg border border-border bg-bg-secondary/40 p-3 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-[11px] font-semibold text-text-dim uppercase tracking-wider">
              Scheduler FSM
            </h3>
            <p className="text-[11px] text-text-dim mt-0.5">
              Canonical daemon auto-build supervisor snapshot
            </p>
          </div>
          <StatusChip mode={mode} />
        </div>
        <div className="divide-y divide-border">
          <MetricsRow label="Desired" value={desired} />
          <MetricsRow label="Runtime mode" value={mode ?? 'unknown'} />
          <MetricsRow label="Scheduler" value={formatSchedulerState(scheduler)} />
          <MetricsRow label="Scheduler injection" value={scheduler?.lastMutationReason ?? 'not reported'} />
          <MetricsRow label="Watcher" value={formatWatcherState(watcher)} />
          <MetricsRow label="Watcher session" value={watcherSessionId} />
          <MetricsRow label="Queue depth" value={queueDepth} />
          <MetricsRow label="Running builds" value={runningBuilds} />
          <MetricsRow label="Capacity" value={formatSchedulerCapacity(autoBuild)} />
          <MetricsRow label="Last transition" value={formatLastTransition(lastTransition)} />
          <MetricsRow label="Last transition reason" value={lastTransition?.reason ?? autoBuild?.reason ?? 'not reported'} />
        </div>
      </div>
    </div>
  );
}
// --- eforge:endregion plan-03-monitor-ui-fsm-card ---

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

type FilterMode = 'daemon-only' | 'scheduler' | 'all';

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
      : filter === 'scheduler'
        ? entries.filter(isSchedulerActivity)
        : entries;

  // Newest first
  const reversed = [...visible].reverse();

  if (reversed.length === 0) {
    return (
      <div className="px-4 py-6 text-center text-text-dim text-xs">
        {filter === 'daemon-only'
          ? 'No daemon events in the activity buffer yet.'
          : filter === 'scheduler'
            ? 'No scheduler activity in the activity buffer yet.'
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
  autoBuild: AutoBuildState | null;
  latestHeartbeat: { at: number; payload: HeartbeatPayload } | null;
  activity: DaemonActivityEntry[];
  now: number;
}

export function DaemonDrawer({
  open,
  onClose,
  autoBuild,
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
      {/* Scheduler FSM status */}
      <div className="border-b border-border">
        <SchedulerStatusCard autoBuild={autoBuild} latestHeartbeat={latestHeartbeat} />
      </div>

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
            <FilterChip active={filter === 'scheduler'} onClick={() => setFilter('scheduler')}>
              scheduler
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
