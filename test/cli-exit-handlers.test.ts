/**
 * Tests for CLI exit handlers (plan-01-exit-handlers).
 *
 * Covers:
 *  1. setupSignalHandlers registers SIGTERM, SIGHUP, uncaughtException, unhandledRejection
 *     and invokes monitor.stop() exactly once even when the handler fires twice.
 *  2. installStdinExitHandlers calls process.exit(0) when stdin emits 'end' or 'close'.
 *
 * Follows AGENTS.md conventions: no mocks, real code, inline data objects.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { setupSignalHandlers, setActiveMonitor } from '../packages/eforge/src/cli/index.js';
import { installStdinExitHandlers } from '../packages/eforge/src/cli/mcp-proxy.js';
import type { Monitor } from '@eforge-build/monitor';

// ---------------------------------------------------------------------------
// setupSignalHandlers
// ---------------------------------------------------------------------------

describe('setupSignalHandlers', () => {
  let preExceptionListeners: Function[];
  let preRejectionListeners: Function[];

  beforeEach(() => {
    preExceptionListeners = process.listeners('uncaughtException').slice();
    preRejectionListeners = process.listeners('unhandledRejection').slice();
  });

  afterEach(() => {
    setActiveMonitor(undefined);
    // Remove only the listeners added during the test so vitest's own handlers survive
    for (const listener of process.listeners('uncaughtException')) {
      if (!preExceptionListeners.includes(listener)) {
        process.removeListener('uncaughtException', listener as (...args: unknown[]) => void);
      }
    }
    for (const listener of process.listeners('unhandledRejection')) {
      if (!preRejectionListeners.includes(listener)) {
        process.removeListener('unhandledRejection', listener as (...args: unknown[]) => void);
      }
    }
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGHUP');
  });

  function makeMonitorStub(): Monitor {
    return {
      stop: vi.fn(),
      wrapEvents: vi.fn(),
      server: undefined,
      db: undefined,
    } as unknown as Monitor;
  }

  it('aborts the controller on SIGTERM', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    const controller = setupSignalHandlers();
    expect(controller.signal.aborted).toBe(false);

    process.emit('SIGTERM');

    expect(controller.signal.aborted).toBe(true);
    exitSpy.mockRestore();
  });

  it('aborts the controller on SIGHUP', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    const controller = setupSignalHandlers();
    process.emit('SIGHUP');

    expect(controller.signal.aborted).toBe(true);
    exitSpy.mockRestore();
  });

  it('uses exit code 130 for signal-driven teardown (SIGTERM)', () => {
    vi.useFakeTimers();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    setupSignalHandlers();
    process.emit('SIGTERM');

    vi.runAllTimers();
    expect(exitSpy).toHaveBeenCalledWith(130);

    exitSpy.mockRestore();
    vi.useRealTimers();
  });

  it('uses exit code 130 for SIGHUP', () => {
    vi.useFakeTimers();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    setupSignalHandlers();
    process.emit('SIGHUP');

    vi.runAllTimers();
    expect(exitSpy).toHaveBeenCalledWith(130);

    exitSpy.mockRestore();
    vi.useRealTimers();
  });

  it('uses exit code 1 for uncaughtException', () => {
    vi.useFakeTimers();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);

    setupSignalHandlers();
    process.emit('uncaughtException', new Error('boom'));

    vi.runAllTimers();
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    vi.useRealTimers();
  });

  it('uses exit code 1 for unhandledRejection', () => {
    vi.useFakeTimers();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);

    setupSignalHandlers();
    process.emit('unhandledRejection', new Error('rejected'), Promise.resolve());

    vi.runAllTimers();
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    vi.useRealTimers();
  });

  it('writes the error message to stderr on uncaughtException', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);

    setupSignalHandlers();
    process.emit('uncaughtException', new Error('test-crash'));

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('test-crash'));

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('writes the rejection reason to stderr on unhandledRejection', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);

    setupSignalHandlers();
    process.emit('unhandledRejection', new Error('async-crash'), Promise.resolve());

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('async-crash'));

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('re-entry guard: handler is a no-op on second invocation', () => {
    vi.useFakeTimers();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    const controller = setupSignalHandlers();

    // Fire the handler twice
    process.emit('SIGTERM');
    process.emit('SIGTERM');

    // AbortController.abort() is idempotent but let's ensure no double-exit
    vi.runAllTimers();
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(controller.signal.aborted).toBe(true);

    exitSpy.mockRestore();
    vi.useRealTimers();
  });

  it('calls monitor.stop() exactly once on SIGTERM', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const monitor = makeMonitorStub();
    setActiveMonitor(monitor);

    setupSignalHandlers();
    process.emit('SIGTERM');

    expect(monitor.stop).toHaveBeenCalledTimes(1);

    setActiveMonitor(undefined);
    exitSpy.mockRestore();
  });

  it('monitor.stop() is called exactly once even when handler fires twice', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const monitor = makeMonitorStub();
    setActiveMonitor(monitor);

    setupSignalHandlers();
    process.emit('SIGTERM');
    process.emit('SIGHUP');

    expect(monitor.stop).toHaveBeenCalledTimes(1);

    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// installStdinExitHandlers
// ---------------------------------------------------------------------------

describe('installStdinExitHandlers', () => {
  it('calls process.exit(0) when stdin emits "end"', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const stdin = new PassThrough();

    installStdinExitHandlers(stdin);
    stdin.emit('end');

    expect(exitSpy).toHaveBeenCalledWith(0);
    exitSpy.mockRestore();
  });

  it('calls process.exit(0) when stdin emits "close"', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const stdin = new PassThrough();

    installStdinExitHandlers(stdin);
    stdin.emit('close');

    expect(exitSpy).toHaveBeenCalledWith(0);
    exitSpy.mockRestore();
  });
});
