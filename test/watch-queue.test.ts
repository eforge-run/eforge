import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { abortableSleep, EforgeEngine } from '../src/engine/eforge.js';
import type { EforgeEvent } from '../src/engine/events.js';

describe('abortableSleep', () => {
  it('returns false when timer completes normally', async () => {
    const result = await abortableSleep(10);
    expect(result).toBe(false);
  });

  it('returns true when aborted before timer fires', async () => {
    const controller = new AbortController();
    const start = Date.now();

    // Abort after 10ms, sleep for 5000ms
    setTimeout(() => controller.abort(), 10);
    const result = await abortableSleep(5000, controller.signal);
    const elapsed = Date.now() - start;

    expect(result).toBe(true);
    // Should resolve well before the 5000ms timer
    expect(elapsed).toBeLessThan(500);
  });

  it('returns true immediately if signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const start = Date.now();
    const result = await abortableSleep(5000, controller.signal);
    const elapsed = Date.now() - start;

    expect(result).toBe(true);
    expect(elapsed).toBeLessThan(50);
  });

  it('returns false with no signal provided', async () => {
    const result = await abortableSleep(10, undefined);
    expect(result).toBe(false);
  });
});

describe('watchQueue', () => {
  async function createTestEngine(): Promise<{ engine: EforgeEngine; cwd: string }> {
    const cwd = await mkdtemp(join(tmpdir(), 'eforge-watch-test-'));
    const engine = await EforgeEngine.create({
      cwd,
      config: {
        backend: 'claude-sdk',
        prdQueue: { dir: 'eforge/queue', autoRevise: false, watchPollIntervalMs: 50 },
        plugins: { enabled: false },
      },
    });
    return { engine, cwd };
  }

  it('delegates to runQueue and emits queue:start and queue:complete', async () => {
    const { engine } = await createTestEngine();

    const events: EforgeEvent[] = [];
    for await (const event of engine.watchQueue()) {
      events.push(event);
    }

    const types = events.map((e) => e.type);

    // Should have queue:start and final queue:complete
    expect(types).toContain('queue:start');
    expect(types[types.length - 1]).toBe('queue:complete');
  });

  it('emits final queue:complete after watch completes', async () => {
    const { engine } = await createTestEngine();

    const events: EforgeEvent[] = [];
    for await (const event of engine.watchQueue()) {
      events.push(event);
    }

    const lastEvent = events[events.length - 1];
    expect(lastEvent.type).toBe('queue:complete');
  });
});
