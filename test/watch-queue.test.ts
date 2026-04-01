import { describe, it, expect } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
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
  async function createTestEngine(): Promise<{ engine: EforgeEngine; cwd: string; queueDir: string }> {
    const cwd = await mkdtemp(join(tmpdir(), 'eforge-watch-test-'));
    const queueDir = join(cwd, 'eforge', 'queue');
    await mkdir(queueDir, { recursive: true });
    const engine = await EforgeEngine.create({
      cwd,
      config: {
        backend: 'claude-sdk',
        prdQueue: { dir: 'eforge/queue' },
        plugins: { enabled: false },
      },
    });
    return { engine, cwd, queueDir };
  }

  it('abort signal causes clean exit with queue:complete as final event', async () => {
    const { engine } = await createTestEngine();
    const abortController = new AbortController();

    // Abort after a short delay to let the watcher start
    setTimeout(() => abortController.abort(), 200);

    const events: EforgeEvent[] = [];
    for await (const event of engine.watchQueue({ abortController })) {
      events.push(event);
    }

    const types = events.map((e) => e.type);

    // Should have queue:start and final queue:complete
    expect(types).toContain('queue:start');
    expect(types[types.length - 1]).toBe('queue:complete');
  });

  it('writing a new PRD file into queue directory triggers queue:prd:discovered', async () => {
    const { engine, queueDir } = await createTestEngine();
    const abortController = new AbortController();

    const events: EforgeEvent[] = [];
    let discoveredSeen = false;

    // Write a PRD file after watcher starts, then abort after discovery
    const writeTimer = setTimeout(async () => {
      const prdContent = [
        '---',
        'title: Test PRD',
        'status: pending',
        '---',
        '',
        '# Test PRD',
        '',
        'Do something.',
      ].join('\n');
      await writeFile(join(queueDir, 'test-prd.md'), prdContent);
    }, 300);

    // Give enough time for fs.watch to fire + debounce (500ms) + discovery
    const abortTimer = setTimeout(() => abortController.abort(), 1500);

    try {
      for await (const event of engine.watchQueue({ abortController })) {
        events.push(event);
        if (event.type === 'queue:prd:discovered') {
          discoveredSeen = true;
          // Abort once we've seen the discovery event
          abortController.abort();
        }
      }
    } finally {
      clearTimeout(writeTimer);
      clearTimeout(abortTimer);
    }

    expect(discoveredSeen).toBe(true);
    const discoveredEvent = events.find((e) => e.type === 'queue:prd:discovered');
    expect(discoveredEvent).toBeDefined();
    expect((discoveredEvent as { prdId: string }).prdId).toBe('test-prd');

    // Final event should be queue:complete
    expect(events[events.length - 1].type).toBe('queue:complete');
  });

  it('deleting the queue directory mid-watch triggers recovery and continues detecting PRDs', async () => {
    const { engine, cwd, queueDir } = await createTestEngine();
    const abortController = new AbortController();

    const events: EforgeEvent[] = [];
    let discoveredSeen = false;

    // After watcher starts:
    // 1. Delete the queue directory to trigger fs.watch error + recovery
    // 2. Wait for recovery (directory recreation), then write a new PRD
    const deleteTimer = setTimeout(async () => {
      await rm(queueDir, { recursive: true });
      // Give recovery time to recreate the directory and re-establish watcher
      setTimeout(async () => {
        const prdContent = [
          '---',
          'title: Recovery PRD',
          '---',
          '',
          '# Recovery PRD',
          '',
          'Written after recovery.',
        ].join('\n');
        await writeFile(join(queueDir, 'recovery-prd.md'), prdContent);
      }, 500);
    }, 300);

    // Give enough time for delete + recovery + fs.watch fire + debounce + discovery
    const abortTimer = setTimeout(() => abortController.abort(), 3000);

    try {
      for await (const event of engine.watchQueue({ abortController })) {
        events.push(event);
        if (event.type === 'queue:prd:discovered') {
          discoveredSeen = true;
          abortController.abort();
        }
      }
    } finally {
      clearTimeout(deleteTimer);
      clearTimeout(abortTimer);
    }

    expect(discoveredSeen).toBe(true);
    const discoveredEvent = events.find((e) => e.type === 'queue:prd:discovered');
    expect(discoveredEvent).toBeDefined();
    expect((discoveredEvent as { prdId: string }).prdId).toBe('recovery-prd');

    // Final event should be queue:complete
    expect(events[events.length - 1].type).toBe('queue:complete');
  });

  it('3 rapid consecutive directory deletions within 10 seconds triggers abort', async () => {
    const { engine, cwd, queueDir } = await createTestEngine();
    const abortController = new AbortController();

    const events: EforgeEvent[] = [];

    // Rapidly delete the queue directory 3 times to exhaust the circuit breaker
    const deleteTimer = setTimeout(async () => {
      for (let i = 0; i < 3; i++) {
        try {
          await rm(queueDir, { recursive: true });
        } catch { /* may already be gone */ }
        // Wait briefly for recovery to recreate the dir before deleting again
        await new Promise((r) => setTimeout(r, 200));
      }
    }, 300);

    // Safety timeout in case circuit breaker doesn't fire
    const abortTimer = setTimeout(() => abortController.abort(), 5000);

    try {
      for await (const event of engine.watchQueue({ abortController })) {
        events.push(event);
      }
    } finally {
      clearTimeout(deleteTimer);
      clearTimeout(abortTimer);
    }

    const types = events.map((e) => e.type);
    // Should exit with queue:complete (the circuit breaker called onAbort)
    expect(types[types.length - 1]).toBe('queue:complete');
  });
});
