import { describe, it, expect } from 'vitest';
import { execWithTimeout } from '@eforge-build/engine/exec-with-timeout';

// Skip all tests on Windows — process-group kill semantics are POSIX-only.
const isWindows = process.platform === 'win32';
const itPosix = isWindows ? it.skip : it;

describe('execWithTimeout', () => {
  itPosix('completes normally when command finishes before timeout', async () => {
    const result = await execWithTimeout("echo 'hello world'", {
      cwd: process.cwd(),
      timeoutMs: 5000,
    });

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello world');
    expect(result.pid).toBeGreaterThan(0);
  });

  itPosix('sets timedOut:true and exitCode !== 0 when timeout fires', async () => {
    const result = await execWithTimeout('sleep 10', {
      cwd: process.cwd(),
      timeoutMs: 200,
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(result.pid).toBeGreaterThan(0);
  }, 5000);

  itPosix('kills nested backgrounded children when timeout fires', async () => {
    // Spawn a shell that backgrounds a sleep — the group kill should take out both.
    const result = await execWithTimeout("sleep 30 & sleep 30; wait", {
      cwd: process.cwd(),
      timeoutMs: 300,
      graceMs: 500,
    });

    expect(result.timedOut).toBe(true);

    // Wait a moment for cleanup to propagate, then verify the process group is gone.
    await new Promise((r) => setTimeout(r, 600));

    // Attempt to send signal 0 to the process group. ESRCH means no such group.
    let groupAlive = false;
    try {
      process.kill(-result.pid, 0);
      groupAlive = true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // ESRCH = no such process — the expected outcome
      if (code !== 'ESRCH') throw err;
    }

    expect(groupAlive).toBe(false);
  }, 5000);

  itPosix('kill via abort signal terminates the process', async () => {
    const ac = new AbortController();

    const resultPromise = execWithTimeout('sleep 30', {
      cwd: process.cwd(),
      timeoutMs: 10_000,
      signal: ac.signal,
    });

    // Abort after a short delay
    setTimeout(() => ac.abort(), 150);

    const result = await resultPromise;
    // aborted by signal — timedOut is false, but process is dead
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).not.toBe(0);
  }, 5000);

  itPosix('captures stdout and stderr from short-lived command', async () => {
    const result = await execWithTimeout(
      "echo stdout-line && echo stderr-line >&2",
      { cwd: process.cwd(), timeoutMs: 5000 },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('stdout-line');
    expect(result.stderr).toContain('stderr-line');
  });

  itPosix('returns non-zero exitCode for failing command', async () => {
    const result = await execWithTimeout('exit 42', {
      cwd: process.cwd(),
      timeoutMs: 5000,
    });

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(42);
  });
});
