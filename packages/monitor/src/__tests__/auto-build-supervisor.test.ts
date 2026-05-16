import { describe, expect, it } from 'vitest';
import {
  AutoBuildSupervisor,
  createAutoBuildSupervisorState,
  reduceAutoBuildSupervisor,
  type AutoBuildSupervisorState,
  type AutoBuildWatcherState,
} from '../auto-build-supervisor.js';
import type { EforgeEvent } from '@eforge-build/client/events';

const at = '2025-01-01T00:00:00.000Z';

describe('reduceAutoBuildSupervisor', () => {
  it('transitions enable from disabled to starting with desired enabled', () => {
    const result = reduceAutoBuildSupervisor(createAutoBuildSupervisorState(), {
      type: 'enable',
      source: 'http',
      reason: 'user enabled',
      at,
    });

    expect(result.state.mode).toBe('starting');
    expect(result.state.desired).toBe('enabled');
    expect(result.transition).toMatchObject({
      previousMode: 'disabled',
      nextMode: 'starting',
      desired: 'enabled',
      reason: 'user enabled',
      source: 'http',
    });
  });

  it('transitions disable from running to stopping with desired disabled', () => {
    const result = reduceAutoBuildSupervisor(
      createAutoBuildSupervisorState({ desired: 'enabled', mode: 'running' }),
      { type: 'disable', source: 'http', reason: 'user disabled', at },
    );

    expect(result.state.mode).toBe('stopping');
    expect(result.state.desired).toBe('disabled');
    expect(result.state.scheduler.paused).toBe(true);
  });

  it('transitions enable while stopping to restarting', () => {
    const result = reduceAutoBuildSupervisor(
      createAutoBuildSupervisorState({ desired: 'disabled', mode: 'stopping' }),
      { type: 'enable', source: 'http', reason: 'user re-enabled', at },
    );

    expect(result.state.mode).toBe('restarting');
    expect(result.state.desired).toBe('enabled');
  });

  it('transitions fault then enable back to starting', () => {
    const faulted = reduceAutoBuildSupervisor(
      createAutoBuildSupervisorState({ desired: 'enabled', mode: 'running' }),
      { type: 'fault', source: 'watcher', reason: 'watcher crashed', at },
    ).state;

    expect(faulted.mode).toBe('faulted');

    const enabled = reduceAutoBuildSupervisor(faulted, {
      type: 'enable',
      source: 'http',
      reason: 'retry',
      at,
    }).state;

    expect(enabled.mode).toBe('starting');
    expect(enabled.desired).toBe('enabled');
  });

  it('wakes on queue mutation while desired enabled but not running', () => {
    const result = reduceAutoBuildSupervisor(
      createAutoBuildSupervisorState({ desired: 'enabled', mode: 'paused' }),
      { type: 'queue-mutation', source: 'queue', reason: 'enqueue', at },
    );

    expect(result.state.mode).toBe('starting');
    expect(result.state.desired).toBe('enabled');
    expect(result.state.scheduler.lastMutationReason).toBe('enqueue');
  });

  it('pauses on failure and resumes', () => {
    const paused = reduceAutoBuildSupervisor(
      createAutoBuildSupervisorState({ desired: 'enabled', mode: 'running' }),
      { type: 'pause-on-failure', source: 'watcher', reason: 'build failed', at },
    ).state;

    expect(paused.mode).toBe('paused');
    expect(paused.desired).toBe('enabled');
    expect(paused.scheduler.paused).toBe(true);

    const resumed = reduceAutoBuildSupervisor(paused, {
      type: 'enable',
      source: 'http',
      reason: 'resume',
      at,
    }).state;

    expect(resumed.mode).toBe('running');
    expect(resumed.scheduler.paused).toBe(false);
  });

  it('ignores stale failure pauses after auto-build is disabled', () => {
    const disabled = createAutoBuildSupervisorState({ desired: 'disabled', mode: 'disabled' });
    const result = reduceAutoBuildSupervisor(disabled, {
      type: 'pause-on-failure',
      source: 'watcher',
      reason: 'late failure',
      at,
    });

    expect(result.state).toBe(disabled);
    expect(result.transition).toBeUndefined();
  });
});

describe('AutoBuildSupervisor', () => {
  function makeController(
    initialWatcher: AutoBuildWatcherState = { running: false, pid: null, sessionId: null },
    initialState: Partial<AutoBuildSupervisorState> = {},
  ) {
    const calls: string[] = [];
    const events: EforgeEvent[] = [];
    let watcher = initialWatcher;
    let schedulerAlive = initialWatcher.running;
    let tick = 0;

    const controller = new AutoBuildSupervisor({
      initialState,
      effects: {
        now: () => `2025-01-01T00:00:0${tick++}.000Z`,
        getWatcher: () => watcher,
        isSchedulerAlive: () => schedulerAlive,
        spawnWatcher: () => {
          calls.push('spawn-watcher');
          watcher = { running: true, pid: 1234, sessionId: 'watcher-1' };
          schedulerAlive = true;
        },
        stopWatcher: () => {
          calls.push('stop-watcher');
          watcher = { running: false, pid: null, sessionId: null };
          schedulerAlive = false;
        },
        restartWatcher: () => {
          calls.push('restart-watcher');
          watcher = { running: true, pid: 5678, sessionId: 'watcher-restarted' };
          schedulerAlive = true;
        },
        pauseScheduler: () => calls.push('pause-scheduler'),
        resumeScheduler: () => {
          calls.push('resume-scheduler');
          schedulerAlive = true;
        },
        emitSchedulerMutation: (reason) => calls.push(`mutation:${reason}`),
        reloadExtensions: () => { calls.push('reload-extensions'); },
        emitEvent: (event) => events.push(event),
      },
    });

    return { controller, calls, events };
  }

  it('enable starts the watcher, records running snapshot, and emits transition events', () => {
    const { controller, calls, events } = makeController();
    const snapshot = controller.enable('user enabled');

    expect(calls).toContain('spawn-watcher');
    expect(snapshot).toMatchObject({
      enabled: true,
      desired: 'enabled',
      mode: 'running',
      watcher: { running: true, pid: 1234, sessionId: 'watcher-1' },
      scheduler: { alive: true, paused: false },
    });
    const transitions = events.filter((e) => e.type === 'daemon:auto-build:transition');
    expect(transitions).toMatchObject([
      {
        type: 'daemon:auto-build:transition',
        timestamp: '2025-01-01T00:00:00.000Z',
        previousMode: 'disabled',
        nextMode: 'starting',
        desired: 'enabled',
        reason: 'user enabled',
        source: 'http',
      },
      {
        type: 'daemon:auto-build:transition',
        timestamp: '2025-01-01T00:00:01.000Z',
        previousMode: 'starting',
        nextMode: 'running',
        desired: 'enabled',
        reason: 'watcher started',
        source: 'watcher',
      },
    ]);
    expect(events.some((e) => e.type === 'daemon:auto-build:enabled')).toBe(true);
  });

  it('disable stops the watcher and emits disabled compatibility event', () => {
    const { controller, calls, events } = makeController({ running: true, pid: 1234, sessionId: 'watcher-1' });
    controller.enable('already enabled');
    const snapshot = controller.disable('user disabled');

    expect(calls).toContain('stop-watcher');
    expect(snapshot).toMatchObject({
      enabled: false,
      desired: 'disabled',
      mode: 'disabled',
      watcher: { running: false, pid: null, sessionId: null },
    });
    expect(events.some((e) => e.type === 'daemon:auto-build:disabled')).toBe(true);
  });

  it('surfaces asynchronous watcher start failures as a faulted snapshot with a reason', async () => {
    const events: EforgeEvent[] = [];
    const controller = new AutoBuildSupervisor({
      effects: {
        now: () => '2025-01-01T00:00:00.000Z',
        getWatcher: () => ({ running: false, pid: null, sessionId: null }),
        isSchedulerAlive: () => false,
        spawnWatcher: async () => {
          throw new Error('spawn failed');
        },
        emitEvent: (event) => events.push(event),
      },
    });

    const starting = controller.enable('start');
    expect(starting).toMatchObject({ desired: 'enabled', mode: 'starting' });

    await Promise.resolve();
    await Promise.resolve();

    const faulted = controller.getSnapshot();
    expect(faulted).toMatchObject({
      enabled: false,
      desired: 'enabled',
      mode: 'faulted',
      reason: 'Watcher failed to start: spawn failed',
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'daemon:auto-build:transition',
      nextMode: 'faulted',
      reason: 'Watcher failed to start: spawn failed',
    }));
  });

  it('pauseOnFailure pauses scheduler and resume re-enables running mode', () => {
    const { controller, calls, events } = makeController();
    controller.enable('start');

    const paused = controller.pauseOnFailure('build failed');
    expect(calls).toContain('pause-scheduler');
    expect(paused.enabled).toBe(false);
    expect(paused.desired).toBe('enabled');
    expect(paused.mode).toBe('paused');
    expect(events.some((e) => e.type === 'daemon:auto-build:paused')).toBe(true);

    const resumed = controller.enable('resume');
    expect(calls).toContain('resume-scheduler');
    expect(resumed.enabled).toBe(true);
    expect(resumed.mode).toBe('running');
  });

  it('enable while stopping restarts the watcher before returning to running', () => {
    const initialWatcher = { running: true, pid: 1234, sessionId: 'watcher-1' };
    const { controller, calls, events } = makeController(initialWatcher, {
      desired: 'disabled',
      mode: 'stopping',
      watcher: initialWatcher,
      scheduler: { alive: true, paused: true },
    });

    const snapshot = controller.enable('user re-enabled');

    expect(calls).toContain('restart-watcher');
    expect(calls).not.toContain('spawn-watcher');
    expect(snapshot).toMatchObject({
      enabled: true,
      desired: 'enabled',
      mode: 'running',
      watcher: { running: true, pid: 5678, sessionId: 'watcher-restarted' },
      scheduler: { alive: true, paused: false },
    });
    expect(events.filter((e) => e.type === 'daemon:auto-build:transition')).toMatchObject([
      { previousMode: 'stopping', nextMode: 'restarting', desired: 'enabled', reason: 'user re-enabled', source: 'http' },
      { previousMode: 'restarting', nextMode: 'running', desired: 'enabled', reason: 'watcher restarted', source: 'watcher' },
    ]);
  });

  it('shutdown stops the watcher and returns a disabled snapshot', () => {
    const { controller, calls } = makeController();
    controller.enable('start');

    const snapshot = controller.shutdown('daemon exit');

    expect(calls).toContain('pause-scheduler');
    expect(calls).toContain('stop-watcher');
    expect(snapshot).toMatchObject({
      enabled: false,
      desired: 'disabled',
      mode: 'disabled',
      watcher: { running: false, pid: null, sessionId: null },
      scheduler: { alive: false, paused: false },
    });
  });

  it('queue mutation is injected into a live scheduler', () => {
    const { controller, calls } = makeController();
    controller.enable('start');
    calls.length = 0;

    const snapshot = controller.notifyQueueMutation('enqueue');
    expect(calls).toContain('mutation:enqueue');
    expect(snapshot.mode).toBe('running');
    expect(snapshot.scheduler?.lastMutationReason).toBe('enqueue');
  });

  it('queue mutation repairs an enabled supervisor that is not running', () => {
    const { controller, calls } = makeController();
    controller.enable('start');
    controller.pauseOnFailure('build failed');
    calls.length = 0;

    const snapshot = controller.notifyQueueMutation('enqueue');
    expect(calls).not.toContain('mutation:enqueue');
    expect(calls).toContain('resume-scheduler');
    expect(snapshot.mode).toBe('running');
    expect(snapshot.scheduler?.lastMutationReason).toBe('enqueue');
  });

  it('does not spawn a duplicate watcher when queue mutates while startup is already in progress', () => {
    const { controller, calls } = makeController({ running: false, pid: null, sessionId: null }, {
      desired: 'enabled',
      mode: 'starting',
      scheduler: { alive: false, paused: false },
    });

    const snapshot = controller.notifyQueueMutation('enqueue');
    expect(calls).not.toContain('mutation:enqueue');
    expect(calls).not.toContain('spawn-watcher');
    expect(snapshot.mode).toBe('starting');
    expect(snapshot.scheduler?.lastMutationReason).toBe('enqueue');
  });

  it('does not wake the scheduler when queue mutates while auto-build is disabled', () => {
    const { controller, calls } = makeController();

    const snapshot = controller.notifyQueueMutation('enqueue');
    expect(calls).not.toContain('mutation:enqueue');
    expect(snapshot.enabled).toBe(false);
    expect(snapshot.desired).toBe('disabled');
    expect(snapshot.mode).toBe('disabled');
  });

  it('ignores stale controller pause requests after auto-build is disabled', () => {
    const { controller, calls, events } = makeController();

    const snapshot = controller.pauseOnFailure('late failure');
    expect(calls).not.toContain('pause-scheduler');
    expect(events.some((e) => e.type === 'daemon:auto-build:paused')).toBe(false);
    expect(snapshot.enabled).toBe(false);
    expect(snapshot.desired).toBe('disabled');
    expect(snapshot.mode).toBe('disabled');
  });

  it('reloadExtensions restarts the watcher when auto-build is enabled', async () => {
    const { controller, calls } = makeController();
    controller.enable('start');
    calls.length = 0;

    const snapshot = await controller.reloadExtensions();

    expect(calls).toEqual(['reload-extensions', 'restart-watcher']);
    expect(snapshot).toMatchObject({
      enabled: true,
      desired: 'enabled',
      mode: 'running',
      watcher: { running: true, pid: 5678, sessionId: 'watcher-restarted' },
    });
  });

  it('reloadExtensions does not start the watcher when auto-build is disabled', async () => {
    const { controller, calls } = makeController();

    const snapshot = await controller.reloadExtensions();

    expect(calls).toEqual(['reload-extensions']);
    expect(snapshot).toMatchObject({
      enabled: false,
      desired: 'disabled',
      mode: 'disabled',
      watcher: { running: false, pid: null, sessionId: null },
    });
  });

  it('does not let callers mutate supervisor state through snapshots', () => {
    const { controller } = makeController();
    const snapshot = controller.enable('start');
    snapshot.watcher.running = false;
    if (snapshot.scheduler) snapshot.scheduler.alive = false;
    if (snapshot.lastTransition) snapshot.lastTransition.nextMode = 'disabled';

    const freshSnapshot = controller.getSnapshot();
    expect(freshSnapshot.watcher.running).toBe(true);
    expect(freshSnapshot.scheduler?.alive).toBe(true);
    expect(freshSnapshot.lastTransition?.nextMode).toBe('running');
  });
});
