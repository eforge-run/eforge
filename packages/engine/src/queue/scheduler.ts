/**
 * QueueScheduler — event-driven PRD scheduling for watchQueue.
 *
 * Replaces the fs.watch-based discovery loop with explicit `queue:mutation`
 * events emitted by every daemon HTTP route that mutates the queue directory,
 * plus `queue:prd:complete` events forwarded from the watcher's event pump.
 *
 * Inputs arrive via a Node EventEmitter bus:
 *   - `queue:mutation` — injected by HTTP routes (enqueue, playbook-enqueue, apply-recovery, kick)
 *   - `queue:prd:complete` — forwarded from the watcher pump after each build finishes
 *
 * Bus subscriptions are registered in `start()` so callers can attach listeners
 * after construction but before any spawn calls are made.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { loadQueue, resolveQueueOrder, propagateSkip, unblockWaiting } from '../prd-queue.js';
import { Semaphore, type AsyncEventQueue } from '../concurrency.js';
import type { EforgeEvent } from '../events.js';
import type { EforgeConfig } from '../config.js';
import type { QueuedPrd } from '../prd-queue.js';
import type { QueueOptions } from '../eforge.js';

// ---------------------------------------------------------------------------
// Scheduler input event types
// ---------------------------------------------------------------------------

/** Events the scheduler reacts to on the bus. */
export type SchedulerInputEvent =
  | { type: 'queue:mutation'; reason: 'enqueue' | 'playbook-enqueue' | 'apply-recovery' | 'external'; timestamp: string }
  | { type: 'queue:prd:complete'; prdId: string; status: 'completed' | 'failed' | 'skipped'; timestamp: string };

/**
 * Set of event type strings the scheduler subscribes to on the bus.
 * The watcher pump uses this set to decide which events to re-emit.
 */
export const SCHEDULER_INPUT_TYPES = new Set<string>(['queue:mutation', 'queue:prd:complete']);

// ---------------------------------------------------------------------------
// Internal state types
// ---------------------------------------------------------------------------

type PrdRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'blocked';

interface PrdRunState {
  status: PrdRunStatus;
  dependsOn: string[];
}

type ConfigProfile = {
  name: string | null;
  source: 'local' | 'project' | 'user-local' | 'missing' | 'none' | 'override';
  scope: 'local' | 'project' | 'user' | null;
  config: unknown | null;
};

// ---------------------------------------------------------------------------
// Constructor options
// ---------------------------------------------------------------------------

export interface QueueSchedulerOptions {
  /** EventEmitter bus used for scheduler ↔ pump communication. */
  bus: EventEmitter;
  /** Working directory. */
  cwd: string;
  /** Queue directory (relative to cwd). */
  queueDir: string;
  /** Resolved engine config. */
  config: EforgeConfig;
  /** Active agent runtime profile info (for session:profile events). */
  configProfile: ConfigProfile;
  /** Maximum number of concurrent builds. */
  parallelism: number;
  /** AbortController used to signal shutdown. */
  abortController: AbortController;
  /** Multiplexed event queue shared with the watcher pump. */
  eventQueue: AsyncEventQueue<EforgeEvent>;
  /** Callback that spawns a PRD child subprocess and returns its exit status. */
  spawnPrdChild: (prd: QueuedPrd, options: QueueOptions, prdSessionId: string) => Promise<'completed' | 'failed' | 'skipped'>;
  /** Full watchQueue options (auto, verbose, etc.) forwarded to spawnPrdChild. */
  options: QueueOptions;
  /** Pre-loaded initial PRD list (already ordered and name-filtered). */
  initialPrds: QueuedPrd[];
}

// ---------------------------------------------------------------------------
// QueueScheduler
// ---------------------------------------------------------------------------

export class QueueScheduler {
  private readonly bus: EventEmitter;
  private readonly cwd: string;
  private readonly queueDir: string;
  private readonly config: EforgeConfig;
  private readonly configProfile: ConfigProfile;
  private readonly abortController: AbortController;
  private readonly eventQueue: AsyncEventQueue<EforgeEvent>;
  private readonly _spawnPrdChild: QueueSchedulerOptions['spawnPrdChild'];
  private readonly options: QueueOptions;

  private readonly prdState = new Map<string, PrdRunState>();
  private orderedPrds: QueuedPrd[];
  private readonly semaphore: Semaphore;
  // --- eforge:region plan-02-scheduler-emission ---
  private readonly parallelism: number;
  // --- eforge:endregion plan-02-scheduler-emission ---
  private _processed = 0;
  private _skipped = 0;

  constructor(opts: QueueSchedulerOptions) {
    this.bus = opts.bus;
    this.cwd = opts.cwd;
    this.queueDir = opts.queueDir;
    this.config = opts.config;
    this.configProfile = opts.configProfile;
    this.abortController = opts.abortController;
    this.eventQueue = opts.eventQueue;
    this._spawnPrdChild = opts.spawnPrdChild;
    this.options = opts.options;
    this.orderedPrds = [...opts.initialPrds];
    this.semaphore = new Semaphore(opts.parallelism);
    // --- eforge:region plan-02-scheduler-emission ---
    this.parallelism = opts.parallelism;
    // --- eforge:endregion plan-02-scheduler-emission ---

    // Initialise prdState from the pre-loaded initial PRD list.
    for (const prd of opts.initialPrds) {
      const deps = (prd.frontmatter.depends_on ?? []).filter((dep) =>
        opts.initialPrds.some((p) => p.id === dep),
      );
      this.prdState.set(prd.id, { status: 'pending', dependsOn: deps });
    }
  }

  // ---------------------------------------------------------------------------
  // Public read-only accessors
  // ---------------------------------------------------------------------------

  get processed(): number {
    return this._processed;
  }

  get skipped(): number {
    return this._skipped;
  }

  /**
   * Scan prdState for blocked entries and add them to the skipped counter.
   * Call this once, just before reading the final `processed`/`skipped` counts
   * for the terminal `queue:complete` event.
   */
  finalizeBlockedAsSkipped(): void {
    for (const [, state] of this.prdState) {
      if (state.status === 'blocked') {
        this._skipped++;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Public lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Perform the initial scan, register bus subscriptions, and launch any
   * ready PRDs. Must be called exactly once, after the watcher producer has
   * been added to `eventQueue` but before the pump loop begins.
   */
  async start(): Promise<void> {
    // Subscribe to bus events before the initial scan so that any mutation
    // events injected during start() are not missed.
    this.bus.on('queue:mutation', (event: SchedulerInputEvent) => {
      void this.onMutation(event);
    });
    this.bus.on('queue:prd:complete', (event: SchedulerInputEvent) => {
      void this.onComplete(event as Extract<SchedulerInputEvent, { type: 'queue:prd:complete' }>);
    });

    // Discover PRDs added to the queue directory since the initial loadQueue call.
    await this.discoverNewPrds();
    // Launch any PRDs that are already ready.
    this.startReadyPrds();
  }

  // ---------------------------------------------------------------------------
  // Private scheduling helpers
  // ---------------------------------------------------------------------------

  private isReady(prdId: string): boolean {
    const state = this.prdState.get(prdId);
    if (!state || state.status !== 'pending') return false;
    return state.dependsOn.every((dep) => {
      const depState = this.prdState.get(dep);
      return depState && (depState.status === 'completed' || depState.status === 'skipped');
    });
  }

  private propagateBlocked(failedId: string): void {
    const queue = [failedId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const [id, state] of this.prdState) {
        if (state.status === 'pending' && state.dependsOn.includes(current)) {
          state.status = 'blocked';
          queue.push(id);
        }
      }
    }
  }

  /**
   * Re-scan the queue directory, discover new PRDs not yet in prdState,
   * and reset re-queued PRDs (failed/blocked → pending). Emits
   * `queue:prd:discovered` for each newly discovered or re-queued PRD.
   */
  private async discoverNewPrds(): Promise<void> {
    let freshPrds: Awaited<ReturnType<typeof loadQueue>>;
    try {
      freshPrds = await loadQueue(this.queueDir, this.cwd);
    } catch {
      return;
    }
    const freshOrdered = resolveQueueOrder(freshPrds);
    for (const prd of freshOrdered) {
      if (!this.prdState.has(prd.id)) {
        const deps = (prd.frontmatter.depends_on ?? []).filter((dep) =>
          this.prdState.has(dep) || freshOrdered.some((p) => p.id === dep),
        );
        this.prdState.set(prd.id, { status: 'pending', dependsOn: deps });
        this.orderedPrds.push(prd);
        this.eventQueue.push({
          timestamp: new Date().toISOString(),
          type: 'queue:prd:discovered',
          prdId: prd.id,
          title: prd.frontmatter.title ?? prd.id,
        } as EforgeEvent);
      } else {
        const existing = this.prdState.get(prd.id)!;
        if (existing.status === 'failed' || existing.status === 'blocked') {
          // Re-queued PRD: reset state to pending.
          const deps = (prd.frontmatter.depends_on ?? []).filter((dep) =>
            this.prdState.has(dep) || freshOrdered.some((p) => p.id === dep),
          );
          existing.status = 'pending';
          existing.dependsOn = deps;
          // Replace stale entry in orderedPrds with fresh PRD object.
          const idx = this.orderedPrds.findIndex((p) => p.id === prd.id);
          if (idx !== -1) {
            this.orderedPrds[idx] = prd;
          } else {
            this.orderedPrds.push(prd);
          }
          this.eventQueue.push({
            timestamp: new Date().toISOString(),
            type: 'queue:prd:discovered',
            prdId: prd.id,
            title: prd.frontmatter.title ?? prd.id,
          } as EforgeEvent);
        }
      }
    }
  }

  /**
   * Iterate `orderedPrds` and spawn a child subprocess for every PRD whose
   * dependencies are satisfied. Short-circuits when the abort signal fires.
   *
   * Each spawned build:
   *   1. Emits `session:start` + `session:profile` onto `eventQueue`.
   *   2. Acquires the semaphore, then calls `spawnPrdChild`.
   *   3. After the child exits, pushes `queue:prd:complete` onto `eventQueue`
   *      and releases the semaphore.
   *
   * The pump loop yields `queue:prd:complete` and re-emits it on the bus,
   * triggering `onComplete()` which updates state and re-triggers `tick()`.
   */
  private startReadyPrds(): void {
    // --- eforge:region plan-02-scheduler-emission ---
    // Per-tick dedup state: resets on every startReadyPrds() invocation.
    let runningCount = 0;
    for (const s of this.prdState.values()) {
      if (s.status === 'running') runningCount++;
    }
    let capacityBlockedEmittedThisTick = false;
    const dependencyBlockedEmitted = new Set<string>();
    // --- eforge:endregion plan-02-scheduler-emission ---

    for (const prd of this.orderedPrds) {
      if (this.abortController.signal.aborted) break;

      // --- eforge:region plan-02-scheduler-emission ---
      // Emit dependency-blocked once per (prdId, tick) for pending PRDs whose deps are unmet.
      const candidateState = this.prdState.get(prd.id);
      if (candidateState?.status === 'pending') {
        const unmetDeps = candidateState.dependsOn.filter((dep) => {
          const depState = this.prdState.get(dep);
          return !depState || (depState.status !== 'completed' && depState.status !== 'skipped');
        });
        if (unmetDeps.length > 0 && !dependencyBlockedEmitted.has(prd.id)) {
          dependencyBlockedEmitted.add(prd.id);
          this.eventQueue.push({
            timestamp: new Date().toISOString(),
            type: 'daemon:scheduler:dependency-blocked',
            prdId: prd.id,
            blockedBy: unmetDeps,
          } as EforgeEvent);
        }
      }
      // --- eforge:endregion plan-02-scheduler-emission ---

      if (!this.isReady(prd.id)) continue;

      // --- eforge:region plan-02-scheduler-emission ---
      // Emit capacity-blocked once per tick when the concurrency limit is reached.
      if (runningCount >= this.parallelism) {
        if (!capacityBlockedEmittedThisTick) {
          capacityBlockedEmittedThisTick = true;
          const queueDepth = [...this.prdState.values()].filter((s) => s.status === 'pending').length;
          this.eventQueue.push({
            timestamp: new Date().toISOString(),
            type: 'daemon:scheduler:capacity-blocked',
            queueDepth,
            runningCount,
            limit: this.parallelism,
          } as EforgeEvent);
        }
        continue;
      }
      // --- eforge:endregion plan-02-scheduler-emission ---

      const state = this.prdState.get(prd.id)!;
      state.status = 'running';
      // --- eforge:region plan-02-scheduler-emission ---
      runningCount++;
      const queueDepth = [...this.prdState.values()].filter((s) => s.status === 'pending').length;
      this.eventQueue.push({
        timestamp: new Date().toISOString(),
        type: 'daemon:scheduler:dequeued',
        prdId: prd.id,
        queueDepth,
        capacityRemaining: this.parallelism - runningCount,
      } as EforgeEvent);
      // --- eforge:endregion plan-02-scheduler-emission ---

      // Parent owns the sessionId: generate it here and emit session:start
      // immediately so the DB row exists before the child subprocess starts.
      const prdSessionId = randomUUID();
      this.eventQueue.push({
        type: 'session:start',
        sessionId: prdSessionId,
        timestamp: new Date().toISOString(),
      } as EforgeEvent);
      this.eventQueue.push({
        type: 'session:profile',
        sessionId: prdSessionId,
        profileName: this.configProfile.name,
        source: this.configProfile.source,
        scope: this.configProfile.scope,
        config: this.configProfile.config,
        timestamp: new Date().toISOString(),
      } as EforgeEvent);

      this.eventQueue.addProducer();

      void (async () => {
        let acquired = false;
        let status: 'completed' | 'failed' | 'skipped' = 'failed';
        try {
          await this.semaphore.acquire();
          acquired = true;

          status = await this._spawnPrdChild(prd, this.options, prdSessionId);

          this.eventQueue.push({
            timestamp: new Date().toISOString(),
            type: 'queue:prd:complete',
            prdId: prd.id,
            status,
          } as EforgeEvent);
        } catch {
          status = 'failed';
          this.eventQueue.push({
            timestamp: new Date().toISOString(),
            type: 'queue:prd:complete',
            prdId: prd.id,
            status: 'failed',
          } as EforgeEvent);
        } finally {
          if (acquired) this.semaphore.release();
          this.eventQueue.removeProducer();
        }
      })();
    }
  }

  private async tick(): Promise<void> {
    await this.discoverNewPrds();
    this.startReadyPrds();
  }

  // ---------------------------------------------------------------------------
  // Bus event handlers
  // ---------------------------------------------------------------------------

  /**
   * Handles `queue:prd:complete` forwarded from the pump.
   *
   * Ordering guarantee: the pump yields the event to downstream consumers
   * (SSE, hooks, persistence) BEFORE emitting it on the bus, so
   * `session:start` / spawn events pushed here appear after the completion
   * event in the outer consumer's view.
   */
  private async onComplete(event: Extract<SchedulerInputEvent, { type: 'queue:prd:complete' }>): Promise<void> {
    const { prdId, status } = event;

    // Update counters synchronously before any awaits.
    if (status === 'skipped') {
      this._skipped++;
    } else {
      this._processed++;
    }

    // Filesystem state transitions (preserving plan-05 semantics).
    // --- eforge:region plan-05-piggyback-and-queue-scheduling ---
    if (status === 'completed') {
      try { await unblockWaiting(this.queueDir, this.cwd, prdId); } catch { /* non-fatal */ }
    } else if (status === 'failed') {
      try { await propagateSkip(this.queueDir, this.cwd, prdId, 'failed'); } catch { /* non-fatal */ }
    } else if (status === 'skipped') {
      try { await propagateSkip(this.queueDir, this.cwd, prdId, 'cancelled'); } catch { /* non-fatal */ }
    }
    // --- eforge:endregion plan-05-piggyback-and-queue-scheduling ---

    // Update prdState synchronously — must happen before discoverNewPrds.
    const finalState = this.prdState.get(prdId);
    if (finalState && finalState.status === 'running') {
      finalState.status = status;
    }
    if (finalState?.status === 'failed') {
      this.propagateBlocked(prdId);
    }

    // Re-scan and launch any newly-ready PRDs.
    await this.discoverNewPrds();
    this.startReadyPrds();
  }

  /** Handles `queue:mutation` injected by HTTP routes. */
  private async onMutation(_event: SchedulerInputEvent): Promise<void> {
    await this.tick();
  }
}
