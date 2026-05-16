// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DaemonDrawer } from '../daemon-drawer';
import type { AutoBuildState } from '@/lib/api';
import type { DaemonActivityEntry, HeartbeatPayload } from '@/lib/daemon-reducer';
import type { EforgeEvent } from '@/lib/types';

// Static/type-level tests for the daemon drawer scheduler FSM card.
// These verify wiring contracts without depending on a browser renderer.

const __dirname = dirname(fileURLToPath(import.meta.url));
const drawerSource = readFileSync(resolve(__dirname, '../daemon-drawer.tsx'), 'utf-8');
const drawerSourceStripped = drawerSource
  .split('\n')
  .filter((line) => {
    const trimmed = line.trim();
    return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
  })
  .join('\n');

type DaemonDrawerProps = ComponentProps<typeof DaemonDrawer>;
type RequiresAutoBuildProp = 'autoBuild' extends keyof DaemonDrawerProps ? true : never;

const _requiresAutoBuildProp: RequiresAutoBuildProp = true;
const _minimalProps: Pick<DaemonDrawerProps, 'autoBuild' | 'latestHeartbeat'> = {
  autoBuild: null,
  latestHeartbeat: null,
};

afterEach(cleanup);

function renderDrawer(overrides: Partial<DaemonDrawerProps> = {}) {
  return render(
    <DaemonDrawer
      open={true}
      onClose={() => {}}
      autoBuild={null}
      latestHeartbeat={null}
      activity={[]}
      now={1_000_000}
      {...overrides}
    />,
  );
}

function makeHeartbeat(overrides: Partial<HeartbeatPayload> = {}): { at: number; payload: HeartbeatPayload } {
  return {
    at: 999_000,
    payload: {
      uptime: 60_000,
      queueDepth: 7,
      runningBuilds: 2,
      autoBuild: { enabled: true, paused: false },
      subscribers: 1,
      ...overrides,
    },
  };
}

function makeActivity(id: string, event: Partial<EforgeEvent> & { type: string }): DaemonActivityEntry {
  return {
    id,
    event: {
      timestamp: '2024-01-15T10:00:00.000Z',
      ...event,
    } as unknown as EforgeEvent,
    receivedAt: 999_000,
  };
}

describe('DaemonDrawer scheduler FSM card contract', () => {
  it('accepts canonical autoBuild snapshots as an explicit prop', () => {
    expect(_requiresAutoBuildProp).toBe(true);
    expect(_minimalProps.autoBuild).toBeNull();
  });

  it('renders snapshot-only FSM fields from autoBuild props', () => {
    expect(drawerSourceStripped).toContain('SchedulerStatusCard');
    expect(drawerSourceStripped).toContain('autoBuild?.desired');
    expect(drawerSourceStripped).toContain('autoBuild?.mode');
    expect(drawerSourceStripped).toContain('autoBuild?.scheduler');
    expect(drawerSourceStripped).toContain('autoBuild?.watcher.sessionId');
    expect(drawerSourceStripped).toContain('autoBuild?.lastTransition');
  });

  it('uses heartbeat only for queue depth and running build count in the FSM card', () => {
    expect(drawerSourceStripped).toContain('latestHeartbeat.payload.queueDepth');
    expect(drawerSourceStripped).toContain('latestHeartbeat.payload.runningBuilds');
    expect(drawerSourceStripped).toContain('formatSchedulerCapacity(autoBuild)');
  });

  it('renders legacy snapshot fallbacks instead of inferring runtime mode from history', () => {
    expect(drawerSourceStripped).toContain("mode ?? 'unknown'");
    expect(drawerSourceStripped).toContain("'not reported'");
    expect(drawerSourceStripped).not.toContain('daemonActivity');
    expect(drawerSourceStripped).not.toContain('nextMode ??');
  });

  it('defines distinct visual treatments for every supervisor mode family', () => {
    for (const mode of ['running', 'paused', 'starting', 'stopping', 'restarting', 'disabled', 'faulted']) {
      expect(drawerSourceStripped).toContain(`case '${mode}'`);
    }
  });

  it('provides a scheduler activity filter covering auto-build, scheduler, errors, and queue progress', () => {
    expect(drawerSourceStripped).toContain("type.startsWith('daemon:auto-build:')");
    expect(drawerSourceStripped).toContain("type.startsWith('daemon:scheduler:')");
    expect(drawerSourceStripped).toContain("type === 'daemon:error'");
    expect(drawerSourceStripped).toContain("source === 'scheduler' || source === 'auto-build'");
    expect(drawerSourceStripped).toContain("type.startsWith('queue:')");
    expect(drawerSourceStripped).toContain("filter === 'scheduler'");
  });

  it('renders legacy snapshots with fallback copy and heartbeat-owned counts', () => {
    renderDrawer({
      autoBuild: {
        enabled: true,
        watcher: { running: true, pid: null, sessionId: null },
      },
      latestHeartbeat: makeHeartbeat({ queueDepth: 7, runningBuilds: 2 }),
    });

    expect(screen.getByText('Scheduler FSM')).toBeTruthy();
    expect(screen.getByText('Runtime mode')).toBeTruthy();
    expect(screen.getAllByText('unknown').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Watcher session')).toBeTruthy();
    expect(screen.getAllByText('not reported').length).toBeGreaterThanOrEqual(3);
    expect(screen.getAllByText('7').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('2').length).toBeGreaterThanOrEqual(1);
  });

  it('renders supplied scheduler capacity and last transition details from the snapshot', () => {
    const autoBuild = {
      enabled: true,
      watcher: { running: true, pid: 123, sessionId: 'watcher-session-1' },
      desired: 'enabled',
      mode: 'running',
      scheduler: {
        alive: true,
        paused: false,
        lastMutationReason: 'enqueue',
        runningCount: 2,
        limit: 4,
      },
      lastTransition: {
        at: '2024-01-15T09:59:00.000Z',
        previousMode: 'starting',
        nextMode: 'running',
        desired: 'enabled',
        reason: 'watcher ready',
        source: 'scheduler',
      },
      reason: 'watcher ready',
    } as unknown as AutoBuildState;

    renderDrawer({ autoBuild, latestHeartbeat: makeHeartbeat() });

    expect(screen.getByText('watcher-session-1')).toBeTruthy();
    expect(screen.getByText('2/4')).toBeTruthy();
    expect(screen.getByText(/starting → running · watcher ready · scheduler/)).toBeTruthy();
    expect(screen.getAllByText('watcher ready').length).toBeGreaterThanOrEqual(1);
  });

  it('scheduler activity filter includes only scheduler-relevant activity', () => {
    renderDrawer({
      activity: [
        makeActivity('auto', { type: 'daemon:auto-build:transition' }),
        makeActivity('scheduler', { type: 'daemon:scheduler:dequeued' }),
        makeActivity('queue', { type: 'queue:prd:discovered' }),
        makeActivity('scheduler-error', { type: 'daemon:error', source: 'scheduler', message: 'scheduler failed' }),
        makeActivity('db-error', { type: 'daemon:error', source: 'db', message: 'db failed' }),
        makeActivity('lifecycle', { type: 'daemon:lifecycle:ready' }),
      ],
    });

    fireEvent.click(screen.getByRole('button', { name: 'scheduler' }));

    expect(screen.getByText('auto-build:transition')).toBeTruthy();
    expect(screen.getByText('scheduler:dequeued')).toBeTruthy();
    expect(screen.getByText('queue:prd:discovered')).toBeTruthy();
    expect(screen.getAllByText('error')).toHaveLength(1);
    expect(screen.queryByText('lifecycle:ready')).toBeNull();
  });
});
