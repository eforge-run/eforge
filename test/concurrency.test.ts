import { describe, it, expect } from 'vitest';
import { Semaphore, AsyncEventQueue } from '../src/engine/concurrency.js';

describe('Semaphore', () => {
  it('rejects < 1 permits', () => {
    expect(() => new Semaphore(0)).toThrow();
    expect(() => new Semaphore(-1)).toThrow();
  });

  it('acquire within permits is immediate', async () => {
    const sem = new Semaphore(2);
    // Both should resolve immediately
    await sem.acquire();
    await sem.acquire();
  });

  it('acquire beyond permits blocks until release', async () => {
    const sem = new Semaphore(1);
    await sem.acquire();

    let acquired = false;
    const pending = sem.acquire().then(() => {
      acquired = true;
    });

    // Should not have resolved yet
    await Promise.resolve(); // flush microtasks
    expect(acquired).toBe(false);

    sem.release();
    await pending;
    expect(acquired).toBe(true);
  });

  it('maintains FIFO ordering', async () => {
    const sem = new Semaphore(1);
    await sem.acquire();

    const order: number[] = [];

    const p1 = sem.acquire().then(() => order.push(1));
    const p2 = sem.acquire().then(() => order.push(2));
    const p3 = sem.acquire().then(() => order.push(3));

    sem.release(); // unblocks p1
    await p1;

    sem.release(); // unblocks p2
    await p2;

    sem.release(); // unblocks p3
    await p3;

    expect(order).toEqual([1, 2, 3]);
  });
});

describe('AsyncEventQueue', () => {
  it('preserves push-then-iterate ordering', async () => {
    const queue = new AsyncEventQueue<number>();
    queue.addProducer();

    queue.push(1);
    queue.push(2);
    queue.push(3);
    queue.removeProducer();

    const items: number[] = [];
    for await (const item of queue) {
      items.push(item);
    }

    expect(items).toEqual([1, 2, 3]);
  });

  it('handles iterate-then-push (waiting consumer)', async () => {
    const queue = new AsyncEventQueue<string>();
    queue.addProducer();

    const collected: string[] = [];
    const consumer = (async () => {
      for await (const item of queue) {
        collected.push(item);
      }
    })();

    // Push after consumer starts waiting
    queue.push('a');
    queue.push('b');
    queue.removeProducer();

    await consumer;
    expect(collected).toEqual(['a', 'b']);
  });

  it('handles multiple producers', async () => {
    const queue = new AsyncEventQueue<string>();
    queue.addProducer();
    queue.addProducer();

    const collected: string[] = [];
    const consumer = (async () => {
      for await (const item of queue) {
        collected.push(item);
      }
    })();

    queue.push('from-1');
    queue.removeProducer();

    queue.push('from-2');
    queue.removeProducer();

    await consumer;
    expect(collected).toEqual(['from-1', 'from-2']);
  });

  it('push after done is a no-op', async () => {
    const queue = new AsyncEventQueue<number>();
    queue.addProducer();
    queue.push(1);
    queue.removeProducer();

    // Queue is now done; this push should be silently ignored
    queue.push(2);

    const items: number[] = [];
    for await (const item of queue) {
      items.push(item);
    }

    expect(items).toEqual([1]);
  });

  it('empty queue terminates immediately', async () => {
    const queue = new AsyncEventQueue<number>();
    queue.addProducer();
    queue.removeProducer();

    const items: number[] = [];
    for await (const item of queue) {
      items.push(item);
    }

    expect(items).toEqual([]);
  });
});
