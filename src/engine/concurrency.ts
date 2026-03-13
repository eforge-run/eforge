/**
 * Concurrency primitives for orchestration.
 * Semaphore limits parallel plan execution; AsyncEventQueue multiplexes
 * ForgeEvents from concurrent producers into a single async iterable.
 */

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
