import { describe, it, expect } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { abortableSleep, EforgeEngine } from '@eforge-build/engine/eforge';
import type { EforgeEvent } from '@eforge-build/engine/events';
import type { SchedulerInputEvent } from '@eforge-build/engine/eforge';
import { StubHarness } from './stub-harness.js';

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
      // Use StubHarness so inline recovery (called when a PRD fails) completes
      // immediately without making real API calls. Tests here exercise queue
      // watch/discovery, not recovery behavior.
      agentRuntimes: new StubHarness([]),
      config: {
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

  it('injecting a queue:mutation event triggers queue:prd:discovered for a new PRD', async () => {
    const { engine, queueDir } = await createTestEngine();
    const abortController = new AbortController();

    let capturedInject: ((event: SchedulerInputEvent) => void) | null = null;
    const events: EforgeEvent[] = [];
    let discoveredSeen = false;

    const abortTimer = setTimeout(() => abortController.abort(), 5000);

    try {
      for await (const event of engine.watchQueue({
        abortController,
        onInjectEventRegister: (inject) => {
          capturedInject = inject;
        },
      })) {
        events.push(event);

        // After queue:start, write a PRD and inject a mutation event
        if (event.type === 'queue:start' && capturedInject && !discoveredSeen) {
          const prdContent = [
            '---',
            'title: Inject Test PRD',
            'status: pending',
            '---',
            '',
            '# Inject Test PRD',
            '',
            'Do something.',
          ].join('\n');
          await writeFile(join(queueDir, 'inject-test-prd.md'), prdContent);
          capturedInject({
            type: 'queue:mutation',
            reason: 'external',
            timestamp: new Date().toISOString(),
          });
        }

        if (event.type === 'queue:prd:discovered') {
          discoveredSeen = true;
          abortController.abort();
        }
      }
    } finally {
      clearTimeout(abortTimer);
    }

    expect(discoveredSeen).toBe(true);
    const discoveredEvent = events.find((e) => e.type === 'queue:prd:discovered');
    expect(discoveredEvent).toBeDefined();
    expect((discoveredEvent as { prdId: string }).prdId).toBe('inject-test-prd');

    // Final event should be queue:complete
    expect(events[events.length - 1].type).toBe('queue:complete');
  });

  it('re-queued PRD that was previously failed is re-discovered after inject', async () => {
    const { engine, queueDir } = await createTestEngine();
    const abortController = new AbortController();

    // Pre-write a PRD so it's discovered on initial start
    const prdContent = [
      '---',
      'title: Requeue PRD',
      'status: pending',
      '---',
      '',
      '# Requeue PRD',
      '',
      'Do something.',
    ].join('\n');
    await writeFile(join(queueDir, 'requeue-prd.md'), prdContent);

    let capturedInject: ((event: SchedulerInputEvent) => void) | null = null;
    const events: EforgeEvent[] = [];
    let discoveredCount = 0;
    let sawComplete = false;

    const abortTimer = setTimeout(() => abortController.abort(), 15000);

    try {
      for await (const event of engine.watchQueue({
        abortController,
        onInjectEventRegister: (inject) => {
          capturedInject = inject;
        },
      })) {
        events.push(event);

        if (event.type === 'queue:prd:discovered') {
          discoveredCount++;
          if (discoveredCount >= 2) {
            // Second discovery means the re-queue logic worked
            abortController.abort();
          }
        }

        if (event.type === 'queue:prd:complete' && !sawComplete && capturedInject) {
          sawComplete = true;
          // PRD failed — write it back to queue/ and inject a mutation event
          setTimeout(async () => {
            await writeFile(join(queueDir, 'requeue-prd.md'), prdContent + '\n');
            capturedInject!({
              type: 'queue:mutation',
              reason: 'enqueue',
              timestamp: new Date().toISOString(),
            });
          }, 200);
        }
      }
    } finally {
      clearTimeout(abortTimer);
    }

    // Should have been discovered twice: once initially, once after re-queue
    expect(discoveredCount).toBeGreaterThanOrEqual(2);
    const discoveredEvents = events.filter((e) => e.type === 'queue:prd:discovered');
    expect(discoveredEvents.length).toBeGreaterThanOrEqual(2);
    expect((discoveredEvents[0] as { prdId: string }).prdId).toBe('requeue-prd');
    expect((discoveredEvents[1] as { prdId: string }).prdId).toBe('requeue-prd');
  }, 20_000);

  it('inject is a no-op after the watcher is aborted', async () => {
    const { engine } = await createTestEngine();
    const abortController = new AbortController();

    let capturedInject: ((event: SchedulerInputEvent) => void) | null = null;
    const events: EforgeEvent[] = [];

    // Abort after a short delay
    setTimeout(() => abortController.abort(), 200);

    for await (const event of engine.watchQueue({
      abortController,
      onInjectEventRegister: (inject) => {
        capturedInject = inject;
      },
    })) {
      events.push(event);
    }

    // Generator has finished — capturedInject should now be a no-op
    expect(capturedInject).not.toBeNull();

    // Calling inject after abort must not throw and must produce no further events
    expect(() => {
      capturedInject!({
        type: 'queue:mutation',
        reason: 'external',
        timestamp: new Date().toISOString(),
      });
    }).not.toThrow();

    // No events were added after the generator completed
    const types = events.map((e) => e.type);
    expect(types[types.length - 1]).toBe('queue:complete');
  });
});
