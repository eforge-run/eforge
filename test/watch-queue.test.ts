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

  it('emits queue:watch:cycle instead of queue:complete per cycle', async () => {
    const { engine } = await createTestEngine();
    const controller = new AbortController();

    // Abort after the first cycle completes (after first queue:watch:waiting)
    const events: EforgeEvent[] = [];
    for await (const event of engine.watchQueue({ abortController: controller, pollIntervalMs: 50 })) {
      events.push(event);
      if (event.type === 'queue:watch:waiting') {
        controller.abort();
      }
    }

    const types = events.map((e) => e.type);

    // Should have queue:start, queue:watch:cycle, queue:watch:waiting, then final queue:complete
    expect(types).toContain('queue:start');
    expect(types).toContain('queue:watch:cycle');
    expect(types).toContain('queue:watch:waiting');
    expect(types[types.length - 1]).toBe('queue:complete');

    // Should NOT have queue:complete mid-cycle (only at the end)
    const queueCompleteIndices = types
      .map((t, i) => (t === 'queue:complete' ? i : -1))
      .filter((i) => i >= 0);
    expect(queueCompleteIndices).toHaveLength(1);
    expect(queueCompleteIndices[0]).toBe(types.length - 1);
  });

  it('emits queue:watch:waiting before sleeping and queue:watch:poll after', async () => {
    const { engine } = await createTestEngine();
    const controller = new AbortController();

    // Let it do 2 cycles, abort during second cycle's waiting phase
    let waitingCount = 0;
    const events: EforgeEvent[] = [];
    for await (const event of engine.watchQueue({ abortController: controller, pollIntervalMs: 50 })) {
      events.push(event);
      if (event.type === 'queue:watch:waiting') {
        waitingCount++;
        if (waitingCount >= 2) {
          controller.abort();
        }
      }
    }

    const types = events.map((e) => e.type);

    // After first cycle: queue:watch:cycle, queue:watch:waiting, then poll
    const firstWaitingIdx = types.indexOf('queue:watch:waiting');
    expect(firstWaitingIdx).toBeGreaterThan(-1);

    // queue:watch:poll should appear after the first waiting (before the second cycle)
    const firstPollIdx = types.indexOf('queue:watch:poll');
    expect(firstPollIdx).toBeGreaterThan(firstWaitingIdx);
  });

  it('emits final queue:complete after watch loop exits', async () => {
    const { engine } = await createTestEngine();
    const controller = new AbortController();

    const events: EforgeEvent[] = [];
    for await (const event of engine.watchQueue({ abortController: controller, pollIntervalMs: 50 })) {
      events.push(event);
      if (event.type === 'queue:watch:waiting') {
        controller.abort();
      }
    }

    const lastEvent = events[events.length - 1];
    expect(lastEvent.type).toBe('queue:complete');
  });

  it('aborting during idle sleep causes the loop to exit with queue:complete', async () => {
    const { engine } = await createTestEngine();
    const controller = new AbortController();

    // Abort 20ms into the sleep (poll interval is 50ms)
    const events: EforgeEvent[] = [];
    for await (const event of engine.watchQueue({ abortController: controller, pollIntervalMs: 200 })) {
      events.push(event);
      if (event.type === 'queue:watch:waiting') {
        // Abort during the sleep phase
        setTimeout(() => controller.abort(), 20);
      }
    }

    const types = events.map((e) => e.type);

    // Should NOT have queue:watch:poll (abort happened during sleep before poll)
    expect(types).not.toContain('queue:watch:poll');

    // Should end with queue:complete
    expect(types[types.length - 1]).toBe('queue:complete');
  });
});
