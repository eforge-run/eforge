import { spawn } from 'node:child_process';
import { compilePattern } from '../hooks.js';
import type { EforgeEvent } from '../events.js';
import type { EventHookRegistration, NativeExtensionRegistry } from './types.js';

export const DEFAULT_NATIVE_EVENT_HOOK_TIMEOUT_MS = 5000;
export const DEFAULT_EVENT_HOOK_DRAIN_GRACE_MS = 1000;
export const DEFAULT_EVENT_HOOK_EXEC_OUTPUT_LIMIT_BYTES = 1024 * 1024;

export interface NativeEventHookRuntimeOptions {
  timeoutMs?: number;
  drainTimeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface EventHookExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

export interface EventHookExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface EventHookContext {
  event: EforgeEvent;
  extensionName: string;
  extensionPath: string;
  pattern: string;
  signal: AbortSignal;
  logger: {
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
  exec: {
    run(command: string, args?: readonly string[], options?: EventHookExecOptions): Promise<EventHookExecResult>;
  };
}

type DiagnosticEvent = Extract<
  EforgeEvent,
  { type: 'extension:event-handler:failed' | 'extension:event-handler:timeout' }
>;
type DiagnosticEventEnvelope = Pick<DiagnosticEvent, 'timestamp' | 'sessionId' | 'runId'>;
type FailedDiagnosticEvent = Extract<DiagnosticEvent, { type: 'extension:event-handler:failed' }>;
type TimeoutDiagnosticEvent = Extract<DiagnosticEvent, { type: 'extension:event-handler:timeout' }>;

type EventHookHandler = (event: EforgeEvent, ctx: EventHookContext) => unknown;

type RuntimeHook = {
  registration: EventHookRegistration;
  regex: RegExp;
};

function withTriggerEnvelope<T extends DiagnosticEvent>(
  event: EforgeEvent,
  diagnostic: Omit<T, keyof DiagnosticEventEnvelope>,
): T {
  return {
    ...diagnostic,
    timestamp: new Date().toISOString(),
    ...(event.sessionId ? { sessionId: event.sessionId } : {}),
    ...(event.runId ? { runId: event.runId } : {}),
  } as T;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

function errorStack(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : undefined;
}

function createLogger(registration: EventHookRegistration, event: EforgeEvent) {
  const prefix = `[eforge extension:${registration.extensionName} pattern:${registration.value.pattern} event:${event.type}]`;
  const write = (level: string, message: string): void => {
    process.stderr.write(`${prefix} ${level}: ${message}\n`);
  };
  return {
    debug: (message: string) => write('debug', message),
    info: (message: string) => write('info', message),
    warn: (message: string) => write('warn', message),
    error: (message: string) => write('error', message),
  };
}

function createContext(
  registration: EventHookRegistration,
  event: EforgeEvent,
  controller: AbortController,
  options: Required<Pick<NativeEventHookRuntimeOptions, 'cwd' | 'env'>>,
): EventHookContext {
  return {
    event,
    extensionName: registration.extensionName,
    extensionPath: registration.extensionPath,
    pattern: registration.value.pattern,
    signal: controller.signal,
    logger: createLogger(registration, event),
    exec: {
      run: (command, args = [], execOptions = {}) => runExec(command, args, {
        cwd: execOptions.cwd ?? options.cwd,
        env: execOptions.env ? { ...options.env, ...execOptions.env } : options.env,
        timeoutMs: execOptions.timeoutMs,
        maxOutputBytes: execOptions.maxOutputBytes,
        signal: execOptions.signal
          ? AbortSignal.any([controller.signal, execOptions.signal])
          : controller.signal,
      }),
    },
  };
}

function executeHandler(
  registration: EventHookRegistration,
  event: EforgeEvent,
  timeoutMs: number,
  options: Required<Pick<NativeEventHookRuntimeOptions, 'cwd' | 'env'>>,
): Promise<DiagnosticEvent | undefined> {
  const controller = new AbortController();
  const ctx = createContext(registration, event, controller, options);
  const handler = registration.value.handler as unknown as EventHookHandler;
  let timedOut = false;

  const handlerPromise = Promise.resolve()
    .then(() => handler(event, ctx))
    .then(
      (): DiagnosticEvent | undefined => undefined,
      (error): DiagnosticEvent | undefined => {
        if (timedOut) return undefined;
        const failed = withTriggerEnvelope<FailedDiagnosticEvent>(event, {
          type: 'extension:event-handler:failed',
          extensionName: registration.extensionName,
          extensionPath: registration.extensionPath,
          pattern: registration.value.pattern,
          triggeringEventType: event.type,
          message: errorMessage(error),
          ...(errorStack(error) ? { stack: errorStack(error) } : {}),
        });
        return failed;
      },
    );

  // Ensure a late rejection after timeout never becomes an unhandled rejection.
  handlerPromise.catch(() => undefined);

  return new Promise<DiagnosticEvent | undefined>((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      resolve(withTriggerEnvelope<TimeoutDiagnosticEvent>(event, {
        type: 'extension:event-handler:timeout',
        extensionName: registration.extensionName,
        extensionPath: registration.extensionPath,
        pattern: registration.value.pattern,
        triggeringEventType: event.type,
        timeoutMs,
      }));
    }, timeoutMs);
    timer.unref();

    handlerPromise.then((diagnostic) => {
      if (timedOut) return;
      clearTimeout(timer);
      resolve(diagnostic);
    });
  });
}

function flushDiagnostics(queue: DiagnosticEvent[]): DiagnosticEvent[] {
  if (queue.length === 0) return [];
  return queue.splice(0, queue.length);
}

async function waitForNextInflight(
  inflight: Set<Promise<void>>,
  deadline: number,
): Promise<void> {
  const remaining = deadline - Date.now();
  if (remaining <= 0 || inflight.size === 0) return;
  await Promise.race([
    Promise.race([...inflight]),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, remaining);
      timer.unref();
    }),
  ]);
}

/**
 * Async-generator middleware for native extension event hooks.
 *
 * Original events are yielded unchanged and before matching handlers settle.
 * Handler failures and timeouts are converted into typed diagnostic events.
 */
export async function* withNativeEventHooks(
  events: AsyncGenerator<EforgeEvent>,
  registry?: Pick<NativeExtensionRegistry, 'eventHooks'> | null,
  options: NativeEventHookRuntimeOptions = {},
): AsyncGenerator<EforgeEvent> {
  const hooks = registry?.eventHooks ?? [];
  if (hooks.length === 0) {
    yield* events;
    return;
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_NATIVE_EVENT_HOOK_TIMEOUT_MS;
  const runtimeOptions = {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
  };
  const drainTimeoutMs = options.drainTimeoutMs ?? timeoutMs + DEFAULT_EVENT_HOOK_DRAIN_GRACE_MS;
  const compiled: RuntimeHook[] = hooks.map((registration) => ({
    registration,
    regex: compilePattern(registration.value.pattern),
  }));
  const diagnostics: DiagnosticEvent[] = [];
  const inflight = new Set<Promise<void>>();
  let notifyDiagnostic: (() => void) | undefined;

  function pushDiagnostic(diagnostic: DiagnosticEvent): void {
    diagnostics.push(diagnostic);
    notifyDiagnostic?.();
  }

  function waitForDiagnostic(): Promise<{ kind: 'diagnostic' }> {
    if (diagnostics.length > 0) return Promise.resolve({ kind: 'diagnostic' });
    return new Promise((resolve) => {
      notifyDiagnostic = () => {
        notifyDiagnostic = undefined;
        resolve({ kind: 'diagnostic' });
      };
    });
  }

  function start(registration: EventHookRegistration, event: EforgeEvent): void {
    const promise = executeHandler(registration, event, timeoutMs, runtimeOptions)
      .then((diagnostic) => {
        if (diagnostic) pushDiagnostic(diagnostic);
      })
      .finally(() => {
        inflight.delete(promise);
      });
    inflight.add(promise);
  }

  const iterator = events[Symbol.asyncIterator]();
  let upstreamDone = false;
  let nextEvent = iterator.next();

  try {
    while (!upstreamDone) {
      const next = diagnostics.length > 0
        ? { kind: 'diagnostic' as const }
        : await Promise.race([
          nextEvent.then((result) => ({ kind: 'event' as const, result })),
          waitForDiagnostic(),
        ]);

      if (next.kind === 'diagnostic') {
        for (const diagnostic of flushDiagnostics(diagnostics)) {
          yield diagnostic;
        }
        continue;
      }

      if (next.result.done) {
        upstreamDone = true;
        break;
      }

      const event = next.result.value;
      for (const { registration, regex } of compiled) {
        if (regex.test(event.type)) start(registration, event);
      }

      yield event;

      for (const diagnostic of flushDiagnostics(diagnostics)) {
        yield diagnostic;
      }

      nextEvent = iterator.next();
    }
  } finally {
    if (!upstreamDone) await iterator.return?.(undefined);
  }

  const deadline = Date.now() + drainTimeoutMs;
  while (inflight.size > 0 && Date.now() < deadline) {
    await waitForNextInflight(inflight, deadline);
    for (const diagnostic of flushDiagnostics(diagnostics)) {
      yield diagnostic;
    }
  }

  for (const diagnostic of flushDiagnostics(diagnostics)) {
    yield diagnostic;
  }
}

async function runExec(
  command: string,
  args: readonly string[],
  options: Required<Pick<EventHookExecOptions, 'cwd' | 'env'>> & Omit<EventHookExecOptions, 'cwd' | 'env'>,
): Promise<EventHookExecResult> {
  const isWindows = process.platform === 'win32';
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_EVENT_HOOK_EXEC_OUTPUT_LIMIT_BYTES;

  if (options.signal?.aborted) {
    return { stdout: '', stderr: 'aborted', exitCode: 1 };
  }

  return new Promise<EventHookExecResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      detached: !isWindows,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const append = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
      const current = target === 'stdout' ? stdout : stderr;
      const next = current + chunk.toString();
      const capped = next.length > maxOutputBytes ? next.slice(0, maxOutputBytes) : next;
      if (target === 'stdout') stdout = capped;
      else stderr = capped;
    };

    const killTree = (): void => {
      const pid = child.pid;
      if (pid === undefined) return;
      if (isWindows) {
        try {
          const killer = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
          killer.unref();
        } catch {
          // best-effort process-tree termination
        }
        return;
      }
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        // already gone
      }
      killTimer = setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }, 1000);
      killTimer.unref();
    };

    const settle = (result: EventHookExecResult): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', onAbort);
      child.unref();
      resolve(result);
    };

    const onAbort = (): void => {
      killTree();
    };

    child.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk));

    child.on('error', (error) => {
      settle({ stdout, stderr: stderr || error.message, exitCode: 1 });
    });

    child.on('close', (code, signal) => {
      settle({ stdout, stderr, exitCode: code ?? (signal ? 1 : 0) });
    });

    if (options.timeoutMs !== undefined) {
      timeoutTimer = setTimeout(killTree, options.timeoutMs);
      timeoutTimer.unref();
    }

    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
