import { describe, it, expect, vi } from 'vitest';
import { maybePauseOnFailure, type PauseOnFailureCtx } from '@eforge-build/monitor/server-main';
import { AutoBuildSupervisor } from '@eforge-build/monitor/auto-build-supervisor';
import type { EforgeEvent } from '@eforge-build/engine/events';
import type { DaemonState } from '@eforge-build/monitor/server';

function makeDaemonState(pauseScheduler: () => void): { daemonState: DaemonState; pauseEvents: EforgeEvent[] } {
  const pauseEvents: EforgeEvent[] = [];
  const controller = new AutoBuildSupervisor({
    initialState: {
      desired: 'enabled',
      mode: 'running',
      watcher: { running: true, pid: null, sessionId: 'watcher-session' },
      scheduler: { alive: true, paused: false },
    },
    effects: {
      getWatcher: () => ({ running: true, pid: null, sessionId: 'watcher-session' }),
      isSchedulerAlive: () => true,
      pauseScheduler,
      emitEvent: (event) => pauseEvents.push(event),
    },
  });
  return { daemonState: { autoBuildController: controller }, pauseEvents };
}

function makeFailedEvent(prdId: string): EforgeEvent {
  return {
    type: 'queue:prd:complete',
    prdId,
    status: 'failed',
    timestamp: new Date().toISOString(),
  } as unknown as EforgeEvent;
}

describe('maybePauseOnFailure', () => {
  it('pauses auto-build on the first failed queue:prd:complete via the supervisor', () => {
    const prdId = 'sample-prd';
    const pauseScheduler = vi.fn();
    const { daemonState, pauseEvents } = makeDaemonState(pauseScheduler);

    const ctx: PauseOnFailureCtx = {
      isActiveController: () => true,
      daemonState,
    };

    maybePauseOnFailure(makeFailedEvent(prdId), ctx);

    const snapshot = daemonState.autoBuildController.getSnapshot();
    expect(snapshot.enabled).toBe(false);
    expect(snapshot.desired).toBe('enabled');
    expect(snapshot.mode).toBe('paused');
    expect(pauseScheduler).toHaveBeenCalledTimes(1);
    expect(pauseEvents).toContainEqual(expect.objectContaining({
      type: 'daemon:auto-build:paused',
      reason: `Build failed: ${prdId}`,
    }));
  });

  it('does not re-pause when the supervisor is already paused', () => {
    const pauseScheduler = vi.fn();
    const { daemonState, pauseEvents } = makeDaemonState(pauseScheduler);
    const ctx: PauseOnFailureCtx = {
      isActiveController: () => true,
      daemonState,
    };
    const failedEvent = makeFailedEvent('sample-prd');

    maybePauseOnFailure(failedEvent, ctx);
    maybePauseOnFailure(failedEvent, ctx);

    expect(pauseScheduler).toHaveBeenCalledTimes(1);
    expect(pauseEvents.filter((event) => event.type === 'daemon:auto-build:paused')).toHaveLength(1);
  });

  it('does not pause when controller is not the active one', () => {
    const pauseScheduler = vi.fn();
    const { daemonState, pauseEvents } = makeDaemonState(pauseScheduler);
    const ctx: PauseOnFailureCtx = {
      isActiveController: () => false,
      daemonState,
    };

    maybePauseOnFailure(makeFailedEvent('sample-prd'), ctx);

    expect(daemonState.autoBuildController.getSnapshot().mode).toBe('running');
    expect(pauseScheduler).not.toHaveBeenCalled();
    expect(pauseEvents).toHaveLength(0);
  });

  it('does not pause on queue:prd:complete with status completed', () => {
    const pauseScheduler = vi.fn();
    const { daemonState, pauseEvents } = makeDaemonState(pauseScheduler);
    const ctx: PauseOnFailureCtx = {
      isActiveController: () => true,
      daemonState,
    };

    const completedEvent = {
      type: 'queue:prd:complete',
      prdId: 'sample-prd',
      status: 'completed',
      timestamp: new Date().toISOString(),
    } as unknown as EforgeEvent;

    maybePauseOnFailure(completedEvent, ctx);

    expect(daemonState.autoBuildController.getSnapshot().mode).toBe('running');
    expect(pauseScheduler).not.toHaveBeenCalled();
    expect(pauseEvents).toHaveLength(0);
  });
});
