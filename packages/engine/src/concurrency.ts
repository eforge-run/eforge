/**
 * Concurrency primitives for orchestration.
 * Semaphore limits parallel plan execution; AsyncEventQueue multiplexes
 * EforgeEvents from concurrent producers into a single async iterable.
 */

import { availableParallelism } from 'node:os';

/**
 * Counting semaphore — Promise-based acquire/release.
 * Limits concurrent operations to the specified number of permits.
 */
export class Semaphore {
  private permits: number;
  private waitQueue: Array<() => void> = [];

  constructor(permits: number) {
    if (permits < 1) throw new Error('Semaphore requires at least 1 permit');
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);
    });
  }

  release(): void {
    const next = this.waitQueue.shift();
    if (next) {
      next();
    } else {
      this.permits++;
    }
  }
}

/**
 * Multi-producer, single-consumer async event queue.
 * Concurrent plan runners push events; the orchestrator's consumer
 * iterates them in temporal order. Terminates when all producers finish.
 */
export class AsyncEventQueue<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private waiting: ((value: IteratorResult<T>) => void) | null = null;
  private producers = 0;
  private done = false;

  addProducer(): void {
    this.producers++;
    this.done = false;
  }

  removeProducer(): void {
    this.producers--;
    if (this.producers <= 0) {
      this.done = true;
      if (this.waiting) {
        this.waiting({ value: undefined as unknown as T, done: true });
        this.waiting = null;
      }
    }
  }

  push(event: T): void {
    if (this.done) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }

  /**
   * Drain all currently-buffered events without blocking.
   * Returns events that were queued but not yet consumed.
   * Does NOT wait for new events — returns empty array if queue is empty.
   */
  drainAvailable(): T[] {
    const items = this.queue.splice(0);
    return items;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift()!, done: false });
        }
        if (this.done) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}

/**
 * A single unit of work for `runParallel`.
 * Each task has a unique id and a `run()` generator that yields events.
 */
export interface ParallelTask<T> {
  id: string;
  run(): AsyncGenerator<T>;
}

export interface RunParallelOptions {
  /** Maximum number of concurrent tasks. Defaults to `availableParallelism()`. */
  parallelism?: number;
}

/**
 * Run N tasks concurrently with semaphore-limited parallelism, multiplexing
 * all yielded events through a single async generator. Individual task failures
 * are caught and do not block other tasks — callers should emit domain-specific
 * error events from within their `run()` generators.
 */
export async function* runParallel<T>(
  tasks: ParallelTask<T>[],
  options?: RunParallelOptions,
): AsyncGenerator<T> {
  if (tasks.length === 0) return;

  const parallelism = options?.parallelism ?? availableParallelism();
  const semaphore = new Semaphore(parallelism);
  const eventQueue = new AsyncEventQueue<T>();

  const taskPromises = tasks.map(async (task) => {
    eventQueue.addProducer();
    let acquired = false;
    try {
      await semaphore.acquire();
      acquired = true;

      for await (const event of task.run()) {
        eventQueue.push(event);
      }
    } catch {
      // Individual task failures are non-fatal — swallowed here.
      // Callers wrap their run() generators to emit domain-specific error events.
    } finally {
      if (acquired) semaphore.release();
      eventQueue.removeProducer();
    }
  });

  // Consume multiplexed events from all concurrent tasks
  for await (const event of eventQueue) {
    yield event;
  }

  // All producers finished — promises should be settled
  await Promise.allSettled(taskPromises);
}
