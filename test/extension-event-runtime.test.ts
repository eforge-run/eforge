import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withNativeEventHooks, type EventHookContext } from '@eforge-build/engine/extensions';
import type { EforgeEvent } from '@eforge-build/engine/events';
import type { EventHookRegistration, NativeExtensionRegistry } from '@eforge-build/engine/extensions';
import { collectEvents, filterEvents, findEvent } from './test-events.js';

type Handler = (event: EforgeEvent, ctx: EventHookContext) => unknown;

function hook(pattern: string, handler: Handler, extensionName = 'audit-log'): EventHookRegistration {
  return {
    kind: 'eventHook',
    extensionName,
    extensionPath: `/extensions/${extensionName}.js`,
    value: { pattern, handler: handler as never },
  };
}

function registry(eventHooks: EventHookRegistration[]): Pick<NativeExtensionRegistry, 'eventHooks'> {
  return { eventHooks };
}

async function* asyncIterableFrom(events: EforgeEvent[]): AsyncGenerator<EforgeEvent> {
  for (const event of events) yield event;
}

function event(type: EforgeEvent['type'], extra: Record<string, unknown> = {}): EforgeEvent {
  return { type, timestamp: '2025-01-01T00:00:00.000Z', ...extra } as EforgeEvent;
}

async function eventuallyNotRunning(pid: number): Promise<boolean> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 25));
    } catch {
      return true;
    }
  }
  return false;
}

describe('withNativeEventHooks', () => {
  it('yields the original event object before a deferred handler resolves', async () => {
    let release!: () => void;
    const deferred = new Promise<void>((resolve) => { release = resolve; });
    const input = event('plan:build:failed', { planId: 'plan-01', error: 'boom' });
    const gen = withNativeEventHooks(
      asyncIterableFrom([input]),
      registry([hook('plan:build:failed', async () => { await deferred; })]),
      { timeoutMs: 1000 },
    );

    const first = await gen.next();
    expect(first.done).toBe(false);
    expect(first.value).toBe(input);
    release();
    await gen.return(undefined as never);
  });

  it('matches exact and glob patterns with shell-hook parity', async () => {
    const calls: string[] = [];
    const events = [
      event('plan:build:failed', { planId: 'plan-01', error: 'boom' }),
      event('plan:build:complete', { planId: 'plan-01' }),
      event('queue:complete', { processed: 1, skipped: 0 }),
    ];
    const output = await collectEvents(withNativeEventHooks(
      asyncIterableFrom(events),
      registry([
        hook('plan:build:failed', () => calls.push('exact')),
        hook('plan:build:*', () => calls.push('plan-glob')),
        hook('*:complete', () => calls.push('complete-glob')),
        hook('*', () => calls.push('star')),
      ]),
      { timeoutMs: 1000 },
    ));

    expect(output).toEqual(events);
    expect(calls).toEqual([
      'exact', 'plan-glob', 'star',
      'plan-glob', 'complete-glob', 'star',
      'complete-glob', 'star',
    ]);
  });

  it('does not invoke non-matching hooks or add diagnostics', async () => {
    const handler = vi.fn();
    const input = event('planning:start', { source: 'cli' });
    const output = await collectEvents(withNativeEventHooks(
      asyncIterableFrom([input]),
      registry([hook('plan:build:*', handler)]),
      { timeoutMs: 1000 },
    ));

    expect(handler).not.toHaveBeenCalled();
    expect(output).toEqual([input]);
  });

  it('converts a throwing handler into a failed diagnostic without throwing the generator', async () => {
    const input = event('plan:build:failed', {
      sessionId: 'sess-1',
      runId: 'run-1',
      planId: 'plan-01',
      error: 'build failed',
    });
    const output = await collectEvents(withNativeEventHooks(
      asyncIterableFrom([input]),
      registry([hook('plan:build:failed', () => { throw new Error('handler boom'); }, 'broken')]),
      { timeoutMs: 1000 },
    ));

    expect(output[0]).toBe(input);
    expect(output).toHaveLength(2);
    const failures = filterEvents(output, 'extension:event-handler:failed');
    expect(failures).toHaveLength(1);
    expect(filterEvents(output, 'extension:event-handler:timeout')).toEqual([]);
    const failed = failures[0];
    expect(failed).toMatchObject({
      extensionName: 'broken',
      extensionPath: '/extensions/broken.js',
      pattern: 'plan:build:failed',
      triggeringEventType: 'plan:build:failed',
      message: 'handler boom',
      sessionId: 'sess-1',
      runId: 'run-1',
    });
    expect(failed?.stack).toContain('handler boom');
  });

  it('converts an undefined rejection into a string failed diagnostic message', async () => {
    const input = event('plan:build:failed', { planId: 'plan-01', error: 'build failed' });
    const output = await collectEvents(withNativeEventHooks(
      asyncIterableFrom([input]),
      registry([hook('plan:build:failed', () => Promise.reject(undefined), 'broken')]),
      { timeoutMs: 1000 },
    ));

    expect(output).toHaveLength(2);
    const failures = filterEvents(output, 'extension:event-handler:failed');
    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toBe('undefined');
  });

  it('emits a timeout diagnostic for a non-settling handler without waiting for it', async () => {
    const started = Date.now();
    let abortObserved = false;
    const input = event('plan:build:complete', { sessionId: 'sess-1', runId: 'run-1', planId: 'plan-01' });
    const output = await collectEvents(withNativeEventHooks(
      asyncIterableFrom([input]),
      registry([hook('*', (_evt, ctx) => {
        ctx.signal.addEventListener('abort', () => { abortObserved = true; }, { once: true });
        return new Promise(() => undefined);
      }, 'slow')]),
      { timeoutMs: 25 },
    ));

    expect(Date.now() - started).toBeLessThan(500);
    expect(output[0]).toBe(input);
    expect(output).toHaveLength(2);
    expect(abortObserved).toBe(true);
    const timeouts = filterEvents(output, 'extension:event-handler:timeout');
    expect(timeouts).toHaveLength(1);
    expect(filterEvents(output, 'extension:event-handler:failed')).toEqual([]);
    const timeout = timeouts[0];
    expect(timeout).toMatchObject({
      extensionName: 'slow',
      extensionPath: '/extensions/slow.js',
      pattern: '*',
      triggeringEventType: 'plan:build:complete',
      timeoutMs: 25,
      sessionId: 'sess-1',
      runId: 'run-1',
    });
  });

  it('drains in-flight handlers after upstream ends and yields diagnostics', async () => {
    const input = event('plan:build:complete', { planId: 'plan-01' });
    const output = await collectEvents(withNativeEventHooks(
      asyncIterableFrom([input]),
      registry([hook('*', async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        throw new Error('late failure');
      })]),
      { timeoutMs: 1000, drainTimeoutMs: 1000 },
    ));

    expect(output[0]).toBe(input);
    expect(output).toHaveLength(2);
    const failures = filterEvents(output, 'extension:event-handler:failed');
    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toBe('late failure');
  });

  it('passes the same event object and extension metadata in handler context', async () => {
    const input = event('plan:build:complete', { planId: 'plan-01' });
    let firstArg: EforgeEvent | undefined;
    let ctxEvent: EforgeEvent | undefined;
    let ctxFields: { extensionName: string; extensionPath: string; pattern: string; signalAborted: boolean } | undefined;
    await collectEvents(withNativeEventHooks(
      asyncIterableFrom([input]),
      registry([hook('plan:build:*', (evt, ctx) => {
        firstArg = evt;
        ctxEvent = ctx.event;
        ctxFields = {
          extensionName: ctx.extensionName,
          extensionPath: ctx.extensionPath,
          pattern: ctx.pattern,
          signalAborted: ctx.signal.aborted,
        };
      }, 'metadata')]),
      { timeoutMs: 1000 },
    ));

    expect(firstArg).toBe(input);
    expect(ctxEvent).toBe(input);
    expect(ctxFields).toEqual({
      extensionName: 'metadata',
      extensionPath: '/extensions/metadata.js',
      pattern: 'plan:build:*',
      signalAborted: false,
    });
  });

  it('writes prefixed logger output to stderr', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    try {
      const input = event('plan:build:complete', { planId: 'plan-01' });
      await collectEvents(withNativeEventHooks(
        asyncIterableFrom([input]),
        registry([hook('plan:build:*', (_evt, ctx) => ctx.logger.warn('x'), 'logger')]),
        { timeoutMs: 1000 },
      ));
      const line = String(write.mock.calls[0]?.[0] ?? '');
      expect(line).toContain('logger');
      expect(line).toContain('plan:build:*');
      expect(line).toContain('plan:build:complete');
      expect(line).toContain('warn');
      expect(line).toContain('x');
    } finally {
      write.mockRestore();
    }
  });

  it('exec.run direct-spawns a command and returns stdout, stderr, and exitCode', async () => {
    let result: Awaited<ReturnType<EventHookContext['exec']['run']>> | undefined;
    await collectEvents(withNativeEventHooks(
      asyncIterableFrom([event('plan:build:complete', { planId: 'plan-01' })]),
      registry([hook('*', async (_evt, ctx) => {
        result = await ctx.exec.run(process.execPath, [
          '-e',
          'console.log("out"); console.error("err"); process.exit(7);',
        ]);
      })]),
      { timeoutMs: 1000 },
    ));

    expect(result?.stdout).toBe('out\n');
    expect(result?.stderr).toBe('err\n');
    expect(result?.exitCode).toBe(7);
  });

  it('aborts ctx.exec.run subprocess trees when the handler times out', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'eforge-extension-runtime-'));
    const pidFile = join(tmp, 'child.pid');
    try {
      const script = `
        require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
        setInterval(() => {}, 1000);
      `;
      const output = await collectEvents(withNativeEventHooks(
        asyncIterableFrom([event('plan:build:complete', { planId: 'plan-01' })]),
        registry([hook('*', async (_evt, ctx) => {
          await ctx.exec.run(process.execPath, ['-e', script]);
        }, 'killer')]),
        { timeoutMs: 100 },
      ));

      expect(findEvent(output, 'extension:event-handler:timeout')).toMatchObject({ extensionName: 'killer', timeoutMs: 100 });
      const pid = Number(await readFile(pidFile, 'utf-8'));
      expect(Number.isFinite(pid)).toBe(true);
      expect(await eventuallyNotRunning(pid)).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('passes events through unchanged for empty or undefined registries', async () => {
    const events = [
      event('planning:start', { source: 'cli' }),
      event('planning:complete', { plans: [] }),
    ];

    const emptyRegistryOutput = await collectEvents(withNativeEventHooks(asyncIterableFrom(events), registry([])));
    const undefinedRegistryOutput = await collectEvents(withNativeEventHooks(asyncIterableFrom(events), undefined));

    expect(emptyRegistryOutput).toEqual(events);
    expect(undefinedRegistryOutput).toEqual(events);
    expect(filterEvents(emptyRegistryOutput, 'extension:event-handler:failed')).toEqual([]);
    expect(filterEvents(undefinedRegistryOutput, 'extension:event-handler:failed')).toEqual([]);
  });
});
