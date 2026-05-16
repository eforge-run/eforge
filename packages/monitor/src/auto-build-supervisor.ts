import type {
  AutoBuildDesired,
  AutoBuildRuntimeMode,
  AutoBuildSchedulerState,
  AutoBuildState,
  AutoBuildTransitionDetail,
} from '@eforge-build/client';
import type { EforgeEvent } from '@eforge-build/client/events';

export type AutoBuildSupervisorSource =
  | 'startup'
  | 'http'
  | 'watcher'
  | 'scheduler'
  | 'queue'
  | 'extension'
  | 'shutdown'
  | 'test';

export type AutoBuildQueueMutationReason =
  | 'enqueue'
  | 'playbook-enqueue'
  | 'apply-recovery'
  | 'external';

export interface AutoBuildWatcherState {
  running: boolean;
  pid: number | null;
  sessionId: string | null;
}

export interface AutoBuildSupervisorState {
  desired: AutoBuildDesired;
  mode: AutoBuildRuntimeMode;
  watcher: AutoBuildWatcherState;
  scheduler: AutoBuildSchedulerState;
  lastTransition?: AutoBuildTransitionDetail;
  reason?: string;
}

export type AutoBuildSupervisorAction =
  | { type: 'enable'; source: AutoBuildSupervisorSource; reason?: string; at?: string }
  | { type: 'disable'; source: AutoBuildSupervisorSource; reason?: string; at?: string }
  | { type: 'started'; source: AutoBuildSupervisorSource; reason?: string; at?: string; watcher?: AutoBuildWatcherState }
  | { type: 'stopped'; source: AutoBuildSupervisorSource; reason?: string; at?: string; watcher?: AutoBuildWatcherState }
  | { type: 'fault'; source: AutoBuildSupervisorSource; reason: string; at?: string }
  | { type: 'pause-on-failure'; source: AutoBuildSupervisorSource; reason: string; at?: string }
  | { type: 'queue-mutation'; source: AutoBuildSupervisorSource; reason?: AutoBuildQueueMutationReason | string; at?: string }
  | { type: 'scheduler-paused'; source: AutoBuildSupervisorSource; reason?: string; at?: string }
  | { type: 'scheduler-resumed'; source: AutoBuildSupervisorSource; reason?: string; at?: string }
  | { type: 'shutdown'; source: AutoBuildSupervisorSource; reason?: string; at?: string };

export interface AutoBuildReducerResult {
  state: AutoBuildSupervisorState;
  transition?: AutoBuildTransitionDetail;
}

export interface AutoBuildController {
  getSnapshot(): AutoBuildState;
  enable(reason?: string): AutoBuildState;
  disable(reason?: string): AutoBuildState;
  notifyQueueMutation(reason?: AutoBuildQueueMutationReason): AutoBuildState;
  pauseOnFailure(reason: string): AutoBuildState;
  shutdown(reason?: string): AutoBuildState;
  reloadExtensions?(): AutoBuildState;
}

export interface AutoBuildSupervisorEffects {
  spawnWatcher?: () => void;
  stopWatcher?: () => void;
  restartWatcher?: () => void;
  pauseScheduler?: () => void;
  resumeScheduler?: () => void;
  isSchedulerAlive?: () => boolean;
  emitSchedulerMutation?: (reason: AutoBuildQueueMutationReason) => void;
  reloadExtensions?: () => void;
  getWatcher?: () => AutoBuildWatcherState;
  emitEvent?: (event: EforgeEvent) => void;
  now?: () => string;
}

export interface AutoBuildSupervisorOptions {
  initialState?: Partial<AutoBuildSupervisorState>;
  effects?: AutoBuildSupervisorEffects;
  source?: AutoBuildSupervisorSource;
}

const DEFAULT_WATCHER: AutoBuildWatcherState = Object.freeze({
  running: false,
  pid: null,
  sessionId: null,
});

const DEFAULT_SCHEDULER: AutoBuildSchedulerState = Object.freeze({
  alive: false,
  paused: false,
});

const DEFAULT_AT = '1970-01-01T00:00:00.000Z';

function cloneWatcher(watcher: AutoBuildWatcherState): AutoBuildWatcherState {
  return { ...watcher };
}

function cloneScheduler(scheduler: AutoBuildSchedulerState): AutoBuildSchedulerState {
  return { ...scheduler };
}

function cloneTransition(transition: AutoBuildTransitionDetail | undefined): AutoBuildTransitionDetail | undefined {
  return transition ? { ...transition } : undefined;
}

export function createAutoBuildSupervisorState(
  partial: Partial<AutoBuildSupervisorState> = {},
): AutoBuildSupervisorState {
  return {
    desired: partial.desired ?? 'disabled',
    mode: partial.mode ?? 'disabled',
    watcher: cloneWatcher(partial.watcher ?? DEFAULT_WATCHER),
    scheduler: cloneScheduler(partial.scheduler ?? DEFAULT_SCHEDULER),
    lastTransition: cloneTransition(partial.lastTransition),
    reason: partial.reason,
  };
}

export const initialAutoBuildSupervisorState = createAutoBuildSupervisorState();

function legacyEnabled(mode: AutoBuildRuntimeMode, desired: AutoBuildDesired): boolean {
  return desired === 'enabled' && (mode === 'starting' || mode === 'running' || mode === 'restarting');
}

function transitionTo(
  state: AutoBuildSupervisorState,
  nextMode: AutoBuildRuntimeMode,
  desired: AutoBuildDesired,
  source: AutoBuildSupervisorSource,
  reason: string | undefined,
  at: string | undefined,
  patch: Partial<AutoBuildSupervisorState> = {},
): AutoBuildReducerResult {
  if (state.mode === nextMode && state.desired === desired && state.reason === reason) {
    const unchanged = { ...state, ...patch };
    return { state: unchanged };
  }

  const transition: AutoBuildTransitionDetail = {
    at: at ?? DEFAULT_AT,
    previousMode: state.mode,
    nextMode,
    desired,
    source,
    reason,
  };

  return {
    state: {
      ...state,
      ...patch,
      desired,
      mode: nextMode,
      lastTransition: transition,
      reason,
    },
    transition,
  };
}

export function reduceAutoBuildSupervisor(
  state: AutoBuildSupervisorState,
  action: AutoBuildSupervisorAction,
): AutoBuildReducerResult {
  switch (action.type) {
    case 'enable': {
      if (state.mode === 'running' && state.desired === 'enabled') return { state };
      if (state.mode === 'paused') {
        return transitionTo(state, 'running', 'enabled', action.source, action.reason ?? 'resumed', action.at, {
          scheduler: { ...state.scheduler, alive: true, paused: false },
        });
      }
      if (state.mode === 'stopping') {
        return transitionTo(state, 'restarting', 'enabled', action.source, action.reason ?? 'enable requested while stopping', action.at);
      }
      if (state.mode === 'faulted') {
        return transitionTo(state, 'starting', 'enabled', action.source, action.reason ?? 'restart after fault', action.at);
      }
      return transitionTo(state, 'starting', 'enabled', action.source, action.reason ?? 'enabled', action.at);
    }

    case 'disable': {
      if (state.mode === 'disabled' && state.desired === 'disabled') return { state };
      return transitionTo(state, 'stopping', 'disabled', action.source, action.reason ?? 'disabled', action.at, {
        scheduler: { ...state.scheduler, paused: true },
      });
    }

    case 'started': {
      return transitionTo(state, 'running', 'enabled', action.source, action.reason ?? 'watcher running', action.at, {
        watcher: cloneWatcher(action.watcher ?? state.watcher),
        scheduler: { ...state.scheduler, alive: true, paused: false },
      });
    }

    case 'stopped': {
      const watcher = cloneWatcher(action.watcher ?? DEFAULT_WATCHER);
      if (state.desired === 'enabled') {
        return transitionTo(state, 'starting', 'enabled', action.source, action.reason ?? 'watcher stopped; restarting', action.at, {
          watcher,
          scheduler: { ...state.scheduler, alive: false, paused: false },
        });
      }
      return transitionTo(state, 'disabled', 'disabled', action.source, action.reason ?? 'watcher stopped', action.at, {
        watcher,
        scheduler: { ...state.scheduler, alive: false, paused: false },
      });
    }

    case 'fault': {
      return transitionTo(state, 'faulted', state.desired, action.source, action.reason, action.at, {
        scheduler: { ...state.scheduler, alive: false, paused: false },
      });
    }

    case 'pause-on-failure': {
      if (state.desired !== 'enabled') return { state };
      return transitionTo(state, 'paused', 'enabled', action.source, action.reason, action.at, {
        scheduler: { ...state.scheduler, paused: true },
      });
    }

    case 'queue-mutation': {
      if (state.desired !== 'enabled') return { state };
      if (state.mode === 'running') {
        return {
          state: {
            ...state,
            scheduler: { ...state.scheduler, lastMutationReason: action.reason },
          },
        };
      }
      return transitionTo(state, 'starting', 'enabled', action.source, action.reason ?? 'queue mutation', action.at, {
        scheduler: { ...state.scheduler, lastMutationReason: action.reason, paused: false },
      });
    }

    case 'scheduler-paused': {
      return transitionTo(state, 'paused', state.desired, action.source, action.reason ?? 'scheduler paused', action.at, {
        scheduler: { ...state.scheduler, paused: true },
      });
    }

    case 'scheduler-resumed': {
      return transitionTo(state, 'running', 'enabled', action.source, action.reason ?? 'scheduler resumed', action.at, {
        scheduler: { ...state.scheduler, alive: true, paused: false },
      });
    }

    case 'shutdown': {
      if (state.mode === 'disabled' && state.desired === 'disabled') return { state };
      return transitionTo(state, 'stopping', 'disabled', action.source, action.reason ?? 'daemon shutdown', action.at, {
        scheduler: { ...state.scheduler, paused: true },
      });
    }
  }
}

export function autoBuildSnapshotFromSupervisor(state: AutoBuildSupervisorState): AutoBuildState {
  return {
    enabled: legacyEnabled(state.mode, state.desired),
    watcher: cloneWatcher(state.watcher),
    desired: state.desired,
    mode: state.mode,
    scheduler: cloneScheduler(state.scheduler),
    lastTransition: cloneTransition(state.lastTransition),
    reason: state.reason,
  };
}

export class AutoBuildSupervisor implements AutoBuildController {
  private state: AutoBuildSupervisorState;
  private readonly effects: AutoBuildSupervisorEffects;
  private readonly source: AutoBuildSupervisorSource;

  constructor(options: AutoBuildSupervisorOptions = {}) {
    this.state = createAutoBuildSupervisorState(options.initialState);
    this.effects = options.effects ?? {};
    this.source = options.source ?? 'http';
  }

  getSnapshot(): AutoBuildState {
    this.refreshRuntimeDetails();
    return autoBuildSnapshotFromSupervisor(this.state);
  }

  enable(reason = 'enabled'): AutoBuildState {
    const previousMode = this.state.mode;
    this.apply({ type: 'enable', source: this.source, reason, at: this.now() });

    if (this.state.mode === 'restarting') {
      if (this.effects.restartWatcher) {
        this.effects.restartWatcher();
      } else {
        this.effects.stopWatcher?.();
        this.effects.spawnWatcher?.();
      }
      this.apply({ type: 'started', source: 'watcher', reason: 'watcher restarted', at: this.now(), watcher: this.readWatcher() });
    } else if (this.state.mode === 'starting') {
      this.effects.spawnWatcher?.();
      this.apply({ type: 'started', source: 'watcher', reason: previousMode === 'faulted' ? 'watcher restarted after fault' : 'watcher started', at: this.now(), watcher: this.readWatcher() });
    } else if (this.state.mode === 'running') {
      this.effects.resumeScheduler?.();
      this.emitCompatibilityEvent('daemon:auto-build:resumed');
    }

    this.emitCompatibilityEvent('daemon:auto-build:enabled');
    return this.getSnapshot();
  }

  disable(reason = 'disabled'): AutoBuildState {
    this.apply({ type: 'disable', source: this.source, reason, at: this.now() });
    if (this.state.mode === 'stopping') {
      this.effects.pauseScheduler?.();
      this.effects.stopWatcher?.();
      this.apply({ type: 'stopped', source: 'watcher', reason: 'watcher stopped', at: this.now(), watcher: this.readWatcher() });
    }
    this.emitCompatibilityEvent('daemon:auto-build:disabled');
    return this.getSnapshot();
  }

  notifyQueueMutation(reason: AutoBuildQueueMutationReason = 'external'): AutoBuildState {
    const beforeMode = this.state.mode;
    if (this.state.desired === 'enabled') this.effects.emitSchedulerMutation?.(reason);
    this.apply({ type: 'queue-mutation', source: 'queue', reason, at: this.now() });

    const shouldRepairStoppedSupervisor =
      this.state.mode === 'starting' &&
      beforeMode !== 'running' &&
      beforeMode !== 'starting' &&
      beforeMode !== 'restarting';

    if (shouldRepairStoppedSupervisor) {
      if (this.effects.isSchedulerAlive?.()) {
        this.effects.resumeScheduler?.();
      } else {
        this.effects.spawnWatcher?.();
      }
      this.apply({ type: 'started', source: 'watcher', reason: 'queue mutation wake', at: this.now(), watcher: this.readWatcher() });
    }

    return this.getSnapshot();
  }

  pauseOnFailure(reason: string): AutoBuildState {
    if (this.state.desired !== 'enabled') return this.getSnapshot();

    this.effects.pauseScheduler?.();
    this.apply({ type: 'pause-on-failure', source: 'watcher', reason, at: this.now() });
    this.effects.emitEvent?.({
      type: 'daemon:auto-build:paused',
      timestamp: this.now(),
      reason,
    });
    return this.getSnapshot();
  }

  shutdown(reason = 'daemon shutdown'): AutoBuildState {
    this.apply({ type: 'shutdown', source: 'shutdown', reason, at: this.now() });
    if (this.state.mode === 'stopping') {
      this.effects.pauseScheduler?.();
      this.effects.stopWatcher?.();
      this.apply({ type: 'stopped', source: 'watcher', reason: 'watcher stopped', at: this.now(), watcher: this.readWatcher() });
    }
    return this.getSnapshot();
  }

  reloadExtensions(): AutoBuildState {
    this.effects.reloadExtensions?.();
    if (this.state.desired === 'enabled') {
      if (this.effects.restartWatcher) {
        this.apply({ type: 'enable', source: 'extension', reason: 'extension reload', at: this.now() });
        this.effects.restartWatcher();
        this.apply({ type: 'started', source: 'watcher', reason: 'watcher restarted after extension reload', at: this.now(), watcher: this.readWatcher() });
      } else {
        this.notifyQueueMutation('external');
      }
    }
    return this.getSnapshot();
  }

  private apply(action: AutoBuildSupervisorAction): void {
    const result = reduceAutoBuildSupervisor(this.state, action);
    this.state = result.state;
    if (result.transition) this.emitTransition(result.transition);
  }

  private emitTransition(transition: AutoBuildTransitionDetail): void {
    this.effects.emitEvent?.({
      type: 'daemon:auto-build:transition',
      timestamp: transition.at,
      previousMode: transition.previousMode,
      nextMode: transition.nextMode,
      desired: transition.desired,
      reason: transition.reason,
      source: transition.source,
    });
  }

  private emitCompatibilityEvent(type: 'daemon:auto-build:enabled' | 'daemon:auto-build:disabled' | 'daemon:auto-build:resumed'): void {
    this.effects.emitEvent?.({ type, timestamp: this.now() });
  }

  private refreshRuntimeDetails(): void {
    const watcher = this.readWatcher();
    const alive = this.effects.isSchedulerAlive?.() ?? this.state.scheduler.alive;
    this.state = {
      ...this.state,
      watcher: cloneWatcher(watcher),
      scheduler: { ...this.state.scheduler, alive },
    };
  }

  private readWatcher(): AutoBuildWatcherState {
    return cloneWatcher(this.effects.getWatcher?.() ?? this.state.watcher);
  }

  private now(): string {
    return this.effects.now?.() ?? new Date().toISOString();
  }
}
