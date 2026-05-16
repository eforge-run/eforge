/**
 * DaemonStatusPill — persistent header indicator for daemon liveness.
 *
 * Shows a colour-coded dot and relative-time label:
 *   green  — fresh heartbeat (< 15 s ago)
 *   amber  — stale heartbeat (15–30 s ago)
 *   red    — dead / no heartbeat (> 30 s or null)
 *
 * Clicking the pill opens the DaemonDrawer slide-over for drill-down.
 */
import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import {
  selectDaemonActivity,
  selectHeartbeatStaleness,
  type DaemonState,
} from '@/lib/daemon-reducer';
import { DaemonDrawer } from './daemon-drawer';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelativeTime(ageMs: number): string {
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1000)}s ago`;
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m ago`;
  return `${Math.floor(ageMs / 3_600_000)}h ago`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface DaemonStatusPillProps {
  daemonState: DaemonState;
}

export function DaemonStatusPill({ daemonState }: DaemonStatusPillProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // Tick every second so the relative-time label and staleness colour stay fresh.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const staleness = selectHeartbeatStaleness(daemonState, now);
  const activity = selectDaemonActivity(daemonState);

  const dotColorClass =
    staleness === 'fresh'
      ? 'bg-green'
      : staleness === 'stale'
        ? 'bg-yellow'
        : 'bg-red';

  const label = daemonState.latestHeartbeat
    ? `alive ${formatRelativeTime(now - daemonState.latestHeartbeat.at)}`
    : 'daemon offline';
  const runtimeMode = daemonState.autoBuild?.mode;
  const title = runtimeMode
    ? `Open daemon activity drawer (auto-build mode: ${runtimeMode})`
    : 'Open daemon activity drawer';

  return (
    <>
      <button
        type="button"
        onClick={() => setDrawerOpen(true)}
        className={cn(
          'flex items-center gap-1.5 px-2 h-7 rounded text-xs text-text-dim',
          'hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer',
        )}
        title={title}
      >
        <span className={cn('w-2 h-2 rounded-full flex-shrink-0', dotColorClass)} />
        <span>{label}</span>
      </button>

      <DaemonDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        autoBuild={daemonState.autoBuild}
        latestHeartbeat={daemonState.latestHeartbeat}
        activity={activity}
        now={now}
      />
    </>
  );
}
