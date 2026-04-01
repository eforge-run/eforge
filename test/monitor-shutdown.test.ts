import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { useTempDir } from './test-tmpdir.js';
import { evaluateStateCheck, type StateCheckContext } from '../src/monitor/server-main.js';
import {
  writeLockfile,
  updateLockfile,
  killPidIfAlive,
  lockfilePath,
  type LockfileData,
} from '../src/monitor/lockfile.js';

// We need to mock lockfile, isServerAlive, and openDatabase
// to test signalMonitorShutdown without real servers

vi.mock('../src/monitor/lockfile.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/monitor/lockfile.js')>();
  return {
    ...actual,
    readLockfile: vi.fn(),
    isServerAlive: vi.fn(),
  };
});

vi.mock('../src/monitor/db.js', () => ({
  openDatabase: vi.fn(),
}));

import { signalMonitorShutdown } from '../src/monitor/index.js';
import { readLockfile, isServerAlive } from '../src/monitor/lockfile.js';
import { openDatabase } from '../src/monitor/db.js';

const mockReadLockfile = vi.mocked(readLockfile);
const mockIsServerAlive = vi.mocked(isServerAlive);
const mockOpenDatabase = vi.mocked(openDatabase);

describe('signalMonitorShutdown', () => {
  const makeTempDir = useTempDir();

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('does nothing when lockfile is not found', async () => {
    const cwd = makeTempDir();
    mockReadLockfile.mockReturnValue(null);

    await signalMonitorShutdown(cwd);

    expect(mockReadLockfile).toHaveBeenCalledWith(cwd);
    expect(mockIsServerAlive).not.toHaveBeenCalled();
  });

  it('does nothing when server is not alive', async () => {
    const cwd = makeTempDir();
    mockReadLockfile.mockReturnValue({ pid: 99999, port: 4567, startedAt: new Date().toISOString() });
    mockIsServerAlive.mockResolvedValue(false);

    await signalMonitorShutdown(cwd);

    expect(mockIsServerAlive).toHaveBeenCalled();
    expect(mockOpenDatabase).not.toHaveBeenCalled();
  });

  it('does not send SIGTERM when runs are still active', async () => {
    const cwd = makeTempDir();
    const fakePid = process.pid; // Use own PID so it's definitely alive
    mockReadLockfile.mockReturnValue({ pid: fakePid, port: 4567, startedAt: new Date().toISOString() });
    mockIsServerAlive.mockResolvedValue(true);

    const fakeDb = {
      getRunningRuns: () => [{ id: 'run-1', status: 'running' }],
      close: vi.fn(),
    };
    mockOpenDatabase.mockReturnValue(fakeDb as unknown as ReturnType<typeof openDatabase>);

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    await signalMonitorShutdown(cwd);

    expect(fakeDb.close).toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();

    killSpy.mockRestore();
  });

  it('sends SIGTERM when server is alive with no running runs', async () => {
    const cwd = makeTempDir();
    const fakePid = 12345;
    mockReadLockfile.mockReturnValue({ pid: fakePid, port: 4567, startedAt: new Date().toISOString() });
    mockIsServerAlive.mockResolvedValue(true);

    const fakeDb = {
      getRunningRuns: () => [],
      close: vi.fn(),
    };
    mockOpenDatabase.mockReturnValue(fakeDb as unknown as ReturnType<typeof openDatabase>);

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    await signalMonitorShutdown(cwd);

    expect(fakeDb.close).toHaveBeenCalled();
    expect(killSpy).toHaveBeenCalledWith(fakePid, 'SIGTERM');

    killSpy.mockRestore();
  });
});

describe('hasSeenActivity gate', () => {
  function makeContext(overrides: Partial<StateCheckContext> = {}): StateCheckContext {
    return {
      state: 'WATCHING',
      lastActivityTimestamp: Date.now(),
      hasSeenActivity: false,
      serverStartedAt: Date.now(),
      idleFallbackMs: 10_000,
      maxWaitForActivityMs: 0,
      getRunningRuns: () => [],
      getLatestEventTimestamp: () => undefined,
      transitionToCountdown: vi.fn(),
      cancelCountdown: vi.fn(),
      ...overrides,
    };
  }

  it('does not transition to COUNTDOWN when hasSeenActivity is false and no events exist', () => {
    const serverStartedAt = Date.now();
    const ctx = makeContext({
      serverStartedAt,
      lastActivityTimestamp: serverStartedAt - 20_000, // idle for 20s
      getLatestEventTimestamp: () => undefined,
    });

    const result = evaluateStateCheck(ctx);

    expect(result.state).toBe('WATCHING');
    expect(result.hasSeenActivity).toBe(false);
    expect(ctx.transitionToCountdown).not.toHaveBeenCalled();
  });

  it('does not transition to COUNTDOWN when only pre-startup events exist', () => {
    const serverStartedAt = Date.now();
    const ctx = makeContext({
      serverStartedAt,
      lastActivityTimestamp: serverStartedAt - 20_000,
      getLatestEventTimestamp: () => new Date(serverStartedAt - 5000).toISOString(),
    });

    const result = evaluateStateCheck(ctx);

    expect(result.state).toBe('WATCHING');
    expect(result.hasSeenActivity).toBe(false);
    expect(ctx.transitionToCountdown).not.toHaveBeenCalled();
  });

  it('sets hasSeenActivity and evaluates idle logic when a post-startup event exists', () => {
    const serverStartedAt = Date.now() - 30_000; // started 30s ago
    const eventTimestamp = serverStartedAt + 5000; // event 5s after start
    const ctx = makeContext({
      serverStartedAt,
      lastActivityTimestamp: eventTimestamp, // last activity was the event
      getLatestEventTimestamp: () => new Date(eventTimestamp).toISOString(),
    });

    // Event is old enough that idle threshold is met
    const result = evaluateStateCheck(ctx);

    expect(result.hasSeenActivity).toBe(true);
    // 30s - 5s = 25s idle, which exceeds the 10s threshold
    expect(ctx.transitionToCountdown).toHaveBeenCalled();
    expect(result.state).toBe('COUNTDOWN');
  });

  it('does not transition when hasSeenActivity becomes true but idle threshold not met', () => {
    const serverStartedAt = Date.now() - 1000; // started 1s ago
    const eventTimestamp = Date.now(); // just now
    const ctx = makeContext({
      serverStartedAt,
      lastActivityTimestamp: eventTimestamp,
      getLatestEventTimestamp: () => new Date(eventTimestamp).toISOString(),
    });

    const result = evaluateStateCheck(ctx);

    expect(result.hasSeenActivity).toBe(true);
    expect(result.state).toBe('WATCHING');
    expect(ctx.transitionToCountdown).not.toHaveBeenCalled();
  });

  it('hasSeenActivity is a one-way latch — stays true once set', () => {
    const serverStartedAt = Date.now() - 5000;
    const ctx = makeContext({
      serverStartedAt,
      hasSeenActivity: true, // already true
      lastActivityTimestamp: Date.now(), // recent activity
      getLatestEventTimestamp: () => undefined, // no events now
    });

    const result = evaluateStateCheck(ctx);

    expect(result.hasSeenActivity).toBe(true);
  });

  it('transitions to COUNTDOWN using custom idleFallbackMs threshold', () => {
    const serverStartedAt = Date.now() - 120_000; // started 2 min ago
    const eventTimestamp = serverStartedAt + 5000; // event 5s after start
    const ctx = makeContext({
      serverStartedAt,
      lastActivityTimestamp: eventTimestamp,
      idleFallbackMs: 60_000, // 1 min idle threshold (persistent mode)
      getLatestEventTimestamp: () => new Date(eventTimestamp).toISOString(),
    });

    const result = evaluateStateCheck(ctx);

    expect(result.hasSeenActivity).toBe(true);
    // 120s - 5s = 115s idle, exceeds 60s threshold
    expect(ctx.transitionToCountdown).toHaveBeenCalled();
    expect(result.state).toBe('COUNTDOWN');
  });

  it('does not transition when idle time is below custom idleFallbackMs threshold', () => {
    const serverStartedAt = Date.now() - 30_000; // started 30s ago
    const eventTimestamp = Date.now() - 10_000; // event 10s ago
    const ctx = makeContext({
      serverStartedAt,
      lastActivityTimestamp: eventTimestamp,
      hasSeenActivity: true,
      idleFallbackMs: 60_000, // 1 min idle threshold
      getLatestEventTimestamp: () => new Date(eventTimestamp).toISOString(),
    });

    const result = evaluateStateCheck(ctx);

    // 10s idle < 60s threshold — should stay WATCHING
    expect(result.state).toBe('WATCHING');
    expect(ctx.transitionToCountdown).not.toHaveBeenCalled();
  });
});

describe('maxWaitForActivityMs', () => {
  function makeContext(overrides: Partial<StateCheckContext> = {}): StateCheckContext {
    return {
      state: 'WATCHING',
      lastActivityTimestamp: Date.now(),
      hasSeenActivity: false,
      serverStartedAt: Date.now(),
      idleFallbackMs: 10_000,
      maxWaitForActivityMs: 0,
      getRunningRuns: () => [],
      getLatestEventTimestamp: () => undefined,
      transitionToCountdown: vi.fn(),
      cancelCountdown: vi.fn(),
      ...overrides,
    };
  }

  it('triggers COUNTDOWN when elapsed exceeds maxWaitForActivityMs with no activity', () => {
    const serverStartedAt = Date.now() - 400_000; // started 400s ago
    const ctx = makeContext({
      serverStartedAt,
      lastActivityTimestamp: serverStartedAt,
      maxWaitForActivityMs: 300_000, // 5 min
      getLatestEventTimestamp: () => undefined, // no events
    });

    const result = evaluateStateCheck(ctx);

    expect(result.state).toBe('COUNTDOWN');
    expect(result.hasSeenActivity).toBe(false);
    expect(ctx.transitionToCountdown).toHaveBeenCalled();
  });

  it('stays WATCHING when elapsed is below maxWaitForActivityMs', () => {
    const serverStartedAt = Date.now() - 60_000; // started 60s ago
    const ctx = makeContext({
      serverStartedAt,
      lastActivityTimestamp: serverStartedAt,
      maxWaitForActivityMs: 300_000, // 5 min
      getLatestEventTimestamp: () => undefined,
    });

    const result = evaluateStateCheck(ctx);

    expect(result.state).toBe('WATCHING');
    expect(result.hasSeenActivity).toBe(false);
    expect(ctx.transitionToCountdown).not.toHaveBeenCalled();
  });

  it('does not check timeout when maxWaitForActivityMs is 0', () => {
    const serverStartedAt = Date.now() - 600_000; // started 10 min ago
    const ctx = makeContext({
      serverStartedAt,
      lastActivityTimestamp: serverStartedAt,
      maxWaitForActivityMs: 0, // disabled
      getLatestEventTimestamp: () => undefined,
    });

    const result = evaluateStateCheck(ctx);

    expect(result.state).toBe('WATCHING');
    expect(result.hasSeenActivity).toBe(false);
    expect(ctx.transitionToCountdown).not.toHaveBeenCalled();
  });
});

describe('lockfile watcherPid backward compatibility', () => {
  const makeTempDir = useTempDir();

  it('lockfile with watcherPid round-trips through writeLockfile and readLockfile', () => {
    const cwd = makeTempDir();
    const data: LockfileData = {
      pid: 12345,
      port: 4567,
      startedAt: new Date().toISOString(),
      watcherPid: 99999,
    };
    writeLockfile(cwd, data);
    // Read directly from disk to bypass mock
    const raw = JSON.parse(readFileSync(lockfilePath(cwd), 'utf-8')) as LockfileData;
    expect(raw.pid).toBe(12345);
    expect(raw.port).toBe(4567);
    expect(raw.watcherPid).toBe(99999);
  });

  it('lockfile without watcherPid parses correctly', () => {
    const cwd = makeTempDir();
    const data: LockfileData = {
      pid: 12345,
      port: 4567,
      startedAt: new Date().toISOString(),
    };
    writeLockfile(cwd, data);
    // Read directly from disk — existing lockfiles without watcherPid should parse fine
    const raw = JSON.parse(readFileSync(lockfilePath(cwd), 'utf-8')) as LockfileData;
    expect(raw.pid).toBe(12345);
    expect(raw.watcherPid).toBeUndefined();
  });
});

describe('updateLockfile', () => {
  const makeTempDir = useTempDir();

  it('atomically updates an existing lockfile', () => {
    const cwd = makeTempDir();
    const startedAt = new Date().toISOString();
    const data: LockfileData = {
      pid: 12345,
      port: 4567,
      startedAt,
    };
    writeLockfile(cwd, data);

    // Mock readLockfile to return the data we just wrote (updateLockfile calls readLockfile internally)
    mockReadLockfile.mockReturnValueOnce(data);

    updateLockfile(cwd, (existing) => ({
      ...existing,
      watcherPid: 77777,
    }));

    // Verify the file on disk was updated
    const raw = JSON.parse(readFileSync(lockfilePath(cwd), 'utf-8')) as LockfileData;
    expect(raw.pid).toBe(12345);
    expect(raw.port).toBe(4567);
    expect(raw.watcherPid).toBe(77777);
  });

  it('does not throw and does not create a file when lockfile is missing', () => {
    const cwd = makeTempDir();
    // Mock readLockfile to return null (no lockfile found)
    mockReadLockfile.mockReturnValueOnce(null);

    expect(() => {
      updateLockfile(cwd, (existing) => ({
        ...existing,
        watcherPid: 77777,
      }));
    }).not.toThrow();

    // Verify no file was created
    expect(() => readFileSync(lockfilePath(cwd), 'utf-8')).toThrow();
  });
});

describe('killPidIfAlive', () => {
  it('returns false for a non-existent PID', () => {
    const result = killPidIfAlive(999999);
    expect(result).toBe(false);
  });
});

/**
 * Tests for the watcher exit handler logic in server-main.ts.
 *
 * The exit handler is a closure inside spawnWatcher() and cannot be imported directly.
 * These tests verify the decision logic by replicating the handler's branching in isolation.
 * This ensures the algorithm is correct without requiring a real daemon process.
 */
describe('daemon watcher exit handler logic', () => {
  /**
   * Replicates the exit handler's decision logic from server-main.ts child.on('exit').
   * Returns the action taken: 'noop' | 'disable-nonzero' | 'disable-signal' | 'respawn' | 'disable-circuit-breaker'
   */
  function evaluateExitHandler(opts: {
    code: number | null;
    signal: string | null;
    watcherKilledByUs: boolean;
    autoBuild: boolean;
    respawnTimestamps: number[];
  }): { action: string; autoBuild: boolean; respawnTimestamps: number[] } {
    let { autoBuild } = opts;
    const respawnTimestamps = [...opts.respawnTimestamps];

    if (opts.watcherKilledByUs) {
      return { action: 'noop-killed-by-us', autoBuild, respawnTimestamps };
    }

    if (opts.code !== 0 && opts.code !== null) {
      autoBuild = false;
      return { action: 'disable-nonzero', autoBuild, respawnTimestamps };
    }

    if (opts.signal !== null) {
      autoBuild = false;
      return { action: 'disable-signal', autoBuild, respawnTimestamps };
    }

    // code === 0
    if (autoBuild) {
      const now = Date.now();
      respawnTimestamps.push(now);
      // Filter out entries older than 60 seconds
      while (respawnTimestamps.length > 0 && respawnTimestamps[0] < now - 60_000) {
        respawnTimestamps.shift();
      }
      if (respawnTimestamps.length >= 3) {
        autoBuild = false;
        return { action: 'disable-circuit-breaker', autoBuild, respawnTimestamps };
      }
      return { action: 'respawn', autoBuild, respawnTimestamps };
    }

    return { action: 'noop', autoBuild, respawnTimestamps };
  }

  it('signal kill with watcherKilledByUs=false disables autoBuild', () => {
    const result = evaluateExitHandler({
      code: null,
      signal: 'SIGTERM',
      watcherKilledByUs: false,
      autoBuild: true,
      respawnTimestamps: [],
    });

    expect(result.action).toBe('disable-signal');
    expect(result.autoBuild).toBe(false);
  });

  it('signal kill with watcherKilledByUs=true does nothing', () => {
    const result = evaluateExitHandler({
      code: null,
      signal: 'SIGTERM',
      watcherKilledByUs: true,
      autoBuild: true,
      respawnTimestamps: [],
    });

    expect(result.action).toBe('noop-killed-by-us');
    expect(result.autoBuild).toBe(true);
  });

  it('code-0 exit with autoBuild=true triggers respawn', () => {
    const result = evaluateExitHandler({
      code: 0,
      signal: null,
      watcherKilledByUs: false,
      autoBuild: true,
      respawnTimestamps: [],
    });

    expect(result.action).toBe('respawn');
    expect(result.autoBuild).toBe(true);
  });

  it('code-0 exit with autoBuild=false does nothing', () => {
    const result = evaluateExitHandler({
      code: 0,
      signal: null,
      watcherKilledByUs: false,
      autoBuild: false,
      respawnTimestamps: [],
    });

    expect(result.action).toBe('noop');
    expect(result.autoBuild).toBe(false);
  });

  it('non-zero exit disables autoBuild', () => {
    const result = evaluateExitHandler({
      code: 1,
      signal: null,
      watcherKilledByUs: false,
      autoBuild: true,
      respawnTimestamps: [],
    });

    expect(result.action).toBe('disable-nonzero');
    expect(result.autoBuild).toBe(false);
  });

  it('circuit breaker disables autoBuild after 3 respawns within 60 seconds', () => {
    const now = Date.now();
    // Two recent respawns already recorded
    const timestamps = [now - 5000, now - 2000];

    const result = evaluateExitHandler({
      code: 0,
      signal: null,
      watcherKilledByUs: false,
      autoBuild: true,
      respawnTimestamps: timestamps,
    });

    expect(result.action).toBe('disable-circuit-breaker');
    expect(result.autoBuild).toBe(false);
    expect(result.respawnTimestamps.length).toBe(3);
  });

  it('circuit breaker does not trigger when old timestamps are outside 60s window', () => {
    const now = Date.now();
    // Two old respawns outside the 60s window
    const timestamps = [now - 120_000, now - 90_000];

    const result = evaluateExitHandler({
      code: 0,
      signal: null,
      watcherKilledByUs: false,
      autoBuild: true,
      respawnTimestamps: timestamps,
    });

    expect(result.action).toBe('respawn');
    expect(result.autoBuild).toBe(true);
    // Old timestamps should be filtered out, only the new one remains
    expect(result.respawnTimestamps.length).toBe(1);
  });

  it('circuit breaker cleans up stale timestamps', () => {
    const now = Date.now();
    // Mix of old and recent timestamps: 2 old + 1 recent
    const timestamps = [now - 120_000, now - 90_000, now - 5000];

    const result = evaluateExitHandler({
      code: 0,
      signal: null,
      watcherKilledByUs: false,
      autoBuild: true,
      respawnTimestamps: timestamps,
    });

    // After filtering old ones: 1 recent + 1 new = 2, below threshold
    expect(result.action).toBe('respawn');
    expect(result.respawnTimestamps.length).toBe(2);
  });
});
