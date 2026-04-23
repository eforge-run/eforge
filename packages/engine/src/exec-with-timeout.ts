import { spawn } from 'node:child_process';

export interface ExecWithTimeoutOptions {
  cwd: string;
  timeoutMs: number;
  graceMs?: number;
  signal?: AbortSignal;
}

export interface ExecWithTimeoutResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  pid: number | undefined;
}

/**
 * Spawn a shell command with a wall-clock timeout and process-group kill.
 *
 * On POSIX: spawns with detached=true so the child becomes a process-group leader
 * (PGID === PID). On timeout: sends SIGTERM to the whole group (-pid), waits
 * graceMs (default 3000ms), then SIGKILL.
 *
 * On Windows: uses `taskkill /F /T /PID` for best-effort process-tree kill.
 *
 * Never throws — resolves with timedOut:true on timeout.
 * Honors signal?.aborted by running the same kill path immediately.
 */
export async function execWithTimeout(
  command: string,
  options: ExecWithTimeoutOptions,
): Promise<ExecWithTimeoutResult> {
  const { cwd, timeoutMs, graceMs = 3000, signal } = options;
  const isWindows = process.platform === 'win32';

  return new Promise<ExecWithTimeoutResult>((resolve) => {
    const child = spawn('sh', ['-c', command], {
      cwd,
      detached: !isWindows,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const pid = child.pid;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    function killGroup() {
      if (isWindows) {
        // Best-effort Windows: taskkill /F /T for whole tree
        if (pid === undefined) return;
        try {
          const killer = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
          killer.unref();
        } catch {
          // ignore — process may already be gone
        }
      } else {
        // POSIX: kill the entire process group (negative pid = PGID)
        if (pid === undefined) return;
        try {
          process.kill(-pid, 'SIGTERM');
        } catch {
          // process group may already be gone
        }
        graceTimer = setTimeout(() => {
          if (pid === undefined) return;
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            // already gone
          }
        }, graceMs);
        graceTimer.unref();
      }
    }

    function settle(result: ExecWithTimeoutResult) {
      if (settled) return;
      settled = true;
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      child.unref();
      resolve(result);
    }

    child.stdout.on('data', (chunk: Buffer) => { stdoutChunks.push(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderrChunks.push(chunk); });

    child.on('close', (code, signal) => {
      const stdout = Buffer.concat(stdoutChunks).toString();
      const stderr = Buffer.concat(stderrChunks).toString();
      settle({
        stdout,
        stderr,
        exitCode: code ?? ((timedOut || aborted || signal !== null) ? 1 : 0),
        timedOut,
        pid,
      });
    });

    child.on('error', (err) => {
      const stdout = Buffer.concat(stdoutChunks).toString();
      const stderrStr = Buffer.concat(stderrChunks).toString();
      settle({ stdout, stderr: stderrStr || err.message, exitCode: 1, timedOut: false, pid });
    });

    // Arm the wall-clock timeout
    killTimer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);
    killTimer.unref();

    // Honor abort signal
    if (signal) {
      if (signal.aborted) {
        aborted = true;
        killGroup();
      } else {
        signal.addEventListener('abort', () => { aborted = true; killGroup(); }, { once: true });
      }
    }
  });
}
