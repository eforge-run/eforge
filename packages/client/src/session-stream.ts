/**
 * SSE stream subscription primitives for the eforge daemon.
 *
 * The sole public entry point is `subscribeWithSnapshot` — an async generator
 * that wraps any eforge SSE endpoint. It yields:
 *
 *   - `{ kind: 'snapshot' }` — the `stream:hello` payload on every (re)connect.
 *   - `{ kind: 'event' }` — a regular JSON event from the SSE `data:` field.
 *   - `{ kind: 'named' }` — other named SSE events (e.g. `monitor:shutdown-pending`).
 *
 * `stream:hello` is intercepted and surfaced as `snapshot` frames; it never
 * appears as a `named` frame.
 *
 * `parseSseChunk` is exported for test and internal use.
 *
 * ## Transport selection
 *
 * The internal `subscribeToStream` core branches on `typeof EventSource !== 'undefined'`:
 *   - **Browser runtime**: uses `fetch` + `ReadableStream` for manual SSE
 *     parsing. Pass a same-origin relative URL (e.g. `/api/daemon-events`).
 *   - **Node runtime**: uses `node:http`. Requires an absolute URL.
 *
 * Both paths share the same reconnect/backoff counters, `Last-Event-ID` capture
 * (including the cursor from `stream:hello`), and abort propagation.
 */

import type { DaemonStreamSnapshot, SessionStreamSnapshot } from './events.schemas.js';

export type { DaemonStreamSnapshot, SessionStreamSnapshot };

/** Initial reconnect delay, doubled on each failure up to `MAX_RECONNECT_MS`. */
const INITIAL_RECONNECT_MS = 1000;
/** Maximum backoff between reconnect attempts. */
const MAX_RECONNECT_MS = 30_000;
/** Default hard cap on reconnect attempts before rejecting. */
const DEFAULT_MAX_RECONNECTS = 10;

/**
 * Minimal structural shape for events streamed over SSE. The helper only
 * inspects `type` (and a few known fields during aggregation). Callers
 * parameterize `subscribeWithSnapshot<S, EforgeEvent>()` to get full typing on
 * their event frames — this module does not depend on the engine.
 */
// Serialized form of EforgeEvent - keep in sync with event-to-progress.ts
export interface DaemonStreamEvent {
  type: string;
  sessionId?: string;
  timestamp?: string;
  [key: string]: unknown;
}

/**
 * Lifecycle summary for a session. Composed from the engine's `EforgeResult`
 * plus aggregates computed from the event stream. Built by
 * `aggregateSessionSummary` in `aggregate-session-summary.ts`.
 */
export interface SessionSummary {
  sessionId: string;
  /** Terminal status from the `session:end` event's `EforgeResult`. */
  status: 'completed' | 'failed';
  /** Human-readable summary from the `session:end` event. */
  summary: string;
  /** `http://127.0.0.1:{port}` pointing at the monitor/daemon. */
  monitorUrl: string;
  /** Total number of events observed (including the terminal `session:end`). */
  eventCount: number;
  /** Number of `phase:start` events observed. */
  phaseCount: number;
  /** Sum of `files.length` across all `build:files_changed` events. */
  filesChanged: number;
  /** Count of events whose type ends in `:error` or `:failed`. */
  errorCount: number;
}

export interface SubscribeOptions<E extends DaemonStreamEvent = DaemonStreamEvent> {
  /**
   * Called for every event received, including the terminal `session:end`.
   * The second `meta` argument carries the SSE event id so consumers can
   * store it alongside the event (e.g. for `ADD_EVENT` dispatches that
   * require a stable eventId). Invocations are synchronous with SSE data
   * parsing - do not throw.
   */
  onEvent: (event: E, meta: { eventId?: string }) => void;
  /** Optional convenience hook invoked with the final summary on `session:end`. */
  onEnd?: (summary: SessionSummary) => void;
  /** Aborts the subscription. Rejects the returned promise with `AbortError`. */
  signal?: AbortSignal;
  /**
   * Explicit daemon base URL (e.g. `http://127.0.0.1:3737`). Takes precedence
   * over `cwd`. Pass `''` to use same-origin relative URLs — browser runtimes
   * only (see transport selection in the module JSDoc).
   */
  baseUrl?: string;
  /**
   * When `baseUrl` is omitted, the helper resolves the daemon port from the
   * lockfile at this `cwd`.
   */
  cwd?: string;
  /** Hard cap on reconnect attempts. Default 10. */
  maxReconnects?: number;
  /**
   * Called for named SSE events — those with an `event:` field in the SSE
   * wire format (e.g. `monitor:shutdown-pending`, `monitor:shutdown-cancelled`).
   * These are distinct from the JSON `EforgeEvent` messages delivered via
   * `onEvent`. `name` is the value of the SSE `event:` field; `data` is the
   * raw `data:` payload string. Do not throw from this callback.
   */
  onNamedEvent?: (name: string, data: string) => void;
  /**
   * Called once after a successful reconnect, just before the first valid event
   * from the new connection is delivered to `onEvent`. Not invoked on the
   * initial open — only fires on reconnects (`reconnectCount > 0`).
   *
   * Intended for snapshot re-seeding: callers should re-fetch REST snapshots
   * and dispatch a `BATCH_SEED` so the reducer heals across daemon restarts
   * without requiring a browser refresh.
   *
   * Exceptions thrown from this callback are swallowed so they cannot disrupt
   * the stream.
   */
  onReconnect?: () => void;
}

/** One parsed SSE block: a single `data:` payload with optional `id:` and `event:`. */
export interface ParsedSseBlock {
  id?: string;
  data?: string;
  /** The SSE `event:` field value, if present. */
  event?: string;
}

/**
 * Parse an SSE wire chunk into discrete `{ id, data, event }` blocks. Supports
 * `\r\n`, `\r`, and `\n` line terminators per the SSE spec.
 *
 * Exported for reuse by `mcp-proxy.ts` (rewired in plan-02). Only blocks
 * with at least one `data:` line are returned.
 */
export function parseSseChunk(chunk: string): ParsedSseBlock[] {
  const events: ParsedSseBlock[] = [];
  const normalized = chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const blocks = normalized.split('\n\n');
  for (const block of blocks) {
    if (!block.trim()) continue;
    let id: string | undefined;
    let eventType: string | undefined;
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('id:')) {
        const idVal = line.slice(3);
        id = idVal.startsWith(' ') ? idVal.slice(1) : idVal;
      } else if (line.startsWith('data:')) {
        const dataVal = line.slice(5);
        dataLines.push(dataVal.startsWith(' ') ? dataVal.slice(1) : dataVal);
      } else if (line.startsWith('event:')) {
        const eventVal = line.slice(6);
        eventType = eventVal.startsWith(' ') ? eventVal.slice(1) : eventVal;
      }
    }
    if (dataLines.length > 0) {
      events.push({ id, data: dataLines.join('\n'), event: eventType });
    }
  }
  return events;
}

/**
 * Internal SSE stream subscription core with reconnect/backoff and Last-Event-ID.
 *
 * Not exported directly — used internally by `subscribeWithSnapshot`.
 *
 * Handles SSE parsing, reconnect scheduling, abort signal wiring, and delegates
 * per-event semantics to the `onParsedEvent` callback. The promise settles when:
 *   - `settle.resolve(value)` is called inside `onParsedEvent`
 *   - The abort signal fires → rejects with AbortError
 *   - Reconnects exhausted → rejects
 *   - 404/410 response → rejects (terminal, no reconnect)
 */
function subscribeToStream<R>(
  url: string,
  opts: {
    signal?: AbortSignal;
    maxReconnects?: number;
    onNamedEvent?: (name: string, data: string) => void;
    onReconnect?: () => void;
  },
  onParsedEvent: (
    parsed: DaemonStreamEvent,
    eventId: string | undefined,
    settle: { resolve: (v: R) => void; reject: (err: Error) => void },
  ) => void,
  errorStrings: {
    abort: string;
    maxReconnects: (count: number) => string;
    nonRetryStatus: (status: number) => string;
  },
): Promise<R> {
  const maxReconnects = opts.maxReconnects ?? DEFAULT_MAX_RECONNECTS;

  return new Promise<R>((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let request: any | null = null;
    let browserReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectDelay = INITIAL_RECONNECT_MS;
    let reconnectCount = 0;
    let hasReceivedValidEvent = false;
    let lastEventId: string | undefined;
    let settled = false;

    function cleanup(): void {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (request) {
        request.destroy();
        request = null;
      }
      if (browserReader) {
        browserReader.cancel().catch(() => {});
        browserReader = null;
      }
      if (opts.signal) {
        opts.signal.removeEventListener('abort', onAbort);
      }
    }

    const settle = {
      resolve(v: R): void {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(v);
      },
      reject(err: Error): void {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      },
    };

    function onAbort(): void {
      const reason = opts.signal?.reason;
      // Use the reason directly only when it is already an AbortError (or DOMException);
      // otherwise wrap it as `cause` so we never mutate the caller's object.
      let err: Error;
      if (reason instanceof Error && (reason.name === 'AbortError' || reason instanceof DOMException)) {
        err = reason;
      } else {
        err = Object.assign(
          new Error(errorStrings.abort, reason !== undefined ? { cause: reason } : undefined),
          { name: 'AbortError' },
        );
      }
      settle.reject(err);
    }

    if (opts.signal) {
      if (opts.signal.aborted) {
        // Defer to preserve Promise semantics
        queueMicrotask(() => onAbort());
        return;
      }
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    function processDataRaw(raw: string, currentEventId: string | undefined): void {
      let parsed: DaemonStreamEvent;
      try {
        parsed = JSON.parse(raw) as DaemonStreamEvent;
      } catch {
        return;
      }
      if (!parsed || typeof parsed.type !== 'string') return;

      // Reset backoff/reconnect counters only after the stream has produced
      // at least one valid event. This prevents a misbehaving daemon that
      // accepts the connection but immediately closes it (without emitting
      // any data) from resetting the counter on every 2xx open and thereby
      // escaping `maxReconnects`.
      if (!hasReceivedValidEvent) {
        hasReceivedValidEvent = true;
        reconnectDelay = INITIAL_RECONNECT_MS;
        // Capture before resetting: fire onReconnect only when this is a
        // reconnect (count > 0), not on the initial open.
        const prevReconnectCount = reconnectCount;
        reconnectCount = 0;
        if (prevReconnectCount > 0) {
          try {
            opts.onReconnect?.();
          } catch {
            // Callback exceptions must not disrupt the stream
          }
        }
      }

      try {
        onParsedEvent(parsed, currentEventId, settle);
      } catch {
        // Callback exceptions must not disrupt the stream
      }
    }

    function scheduleReconnect(): void {
      if (settled) return;
      reconnectCount += 1;
      if (reconnectCount > maxReconnects) {
        settle.reject(new Error(errorStrings.maxReconnects(maxReconnects)));
        return;
      }
      const delay = reconnectDelay;
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_MS);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    }

    /**
     * Browser transport path: uses `fetch` + `ReadableStream` for manual SSE
     * parsing. This mirrors the node path's chunk-buffering loop but works in
     * browser contexts where `node:http` is unavailable. Using `fetch` instead
     * of native `EventSource` gives us access to the raw SSE wire text so we
     * can parse the `event:` field and route named events to `onNamedEvent`.
     */
    function connectBrowser(): void {
      if (settled) return;
      const fetchHeaders: Record<string, string> = { accept: 'text/event-stream' };
      if (lastEventId !== undefined) {
        fetchHeaders['last-event-id'] = lastEventId;
      }

      fetch(url, { headers: fetchHeaders, signal: opts.signal })
        .then(async (response) => {
          if (!response.ok) {
            // 404/410 are terminal: the stream does not exist or was dropped.
            if (response.status === 404 || response.status === 410) {
              settle.reject(new Error(errorStrings.nonRetryStatus(response.status)));
              return;
            }
            scheduleReconnect();
            return;
          }

          if (!response.body) {
            scheduleReconnect();
            return;
          }

          const reader = response.body.getReader();
          browserReader = reader;
          const decoder = new TextDecoder();
          let buffer = '';

          try {
            while (!settled) {
              const { done, value } = await reader.read();
              if (done) break;

              buffer += decoder.decode(value, { stream: true });

              // SSE event boundaries may be either LF (`\n\n`) or CRLF (`\r\n\r\n`)
              // per the spec. Find the last boundary so we process only complete blocks.
              const boundaryRegex = /\r?\n\r?\n/g;
              let lastBoundaryEnd = -1;
              let match: RegExpExecArray | null;
              while ((match = boundaryRegex.exec(buffer)) !== null) {
                lastBoundaryEnd = match.index + match[0].length;
              }
              if (lastBoundaryEnd === -1) continue;
              const complete = buffer.slice(0, lastBoundaryEnd);
              buffer = buffer.slice(lastBoundaryEnd);

              const blocks = parseSseChunk(complete);
              for (const block of blocks) {
                if (block.id !== undefined) lastEventId = block.id;
                if (block.event !== undefined && block.data !== undefined) {
                  // Cursor-capture rule: stream:hello carries the authoritative cursor
                  // for Last-Event-ID on reconnect. Capture before surfacing to onNamedEvent.
                  if (block.event === 'stream:hello') {
                    try {
                      const helloData = JSON.parse(block.data) as { cursor?: unknown };
                      if (typeof helloData.cursor === 'number') {
                        lastEventId = String(helloData.cursor);
                      }
                    } catch {
                      // Ignore parse errors
                    }
                  }
                  // Named SSE event (has an `event:` field) — route to onNamedEvent
                  try {
                    opts.onNamedEvent?.(block.event, block.data);
                  } catch {
                    // Callback exceptions must not disrupt the stream
                  }
                } else if (block.data !== undefined) {
                  processDataRaw(block.data, lastEventId);
                }
                if (settled) return;
              }
            }
          } catch {
            // Reader errors (including cancellation via cleanup)
          } finally {
            browserReader = null;
          }

          if (!settled) scheduleReconnect();
        })
        .catch((err: unknown) => {
          browserReader = null;
          if (settled) return;
          // AbortError from fetch means the signal fired; onAbort handles settlement
          if (err instanceof Error && err.name === 'AbortError') return;
          scheduleReconnect();
        });
    }

    function connect(): void {
      if (settled) return;

      // Reset per-connection: the `!hasReceivedValidEvent` gate inside
      // processDataRaw must fire once for each new connection attempt so that
      // (a) `reconnectCount` resets only after a successful event-receiving
      // reconnect (preserving consecutive-failure semantics for maxReconnects),
      // and (b) `onReconnect` fires on every reconnect that produces a valid
      // event, not just on the first event ever observed by this subscription.
      hasReceivedValidEvent = false;

      // Browser path: use fetch + ReadableStream for full SSE text parsing,
      // supporting named events (event: field) and Last-Event-ID replay.
      if (typeof EventSource !== 'undefined') {
        connectBrowser();
        return;
      }

      // Node path (lazy-loads node:http to avoid bundler errors in browser contexts)
      const headers: Record<string, string> = { accept: 'text/event-stream' };
      if (lastEventId !== undefined) {
        headers['last-event-id'] = lastEventId;
      }

      void import('node:http').then((http) => {
        if (settled) return;

        const req = http.default.get(url, { headers }, (res: any) => {
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            res.resume();
            // 404/410 are terminal: the stream does not exist or was dropped.
            if (res.statusCode === 404 || res.statusCode === 410) {
              settle.reject(new Error(errorStrings.nonRetryStatus(res.statusCode)));
              return;
            }
            scheduleReconnect();
            return;
          }

          // Note: backoff and reconnect counter are intentionally NOT reset on
          // 2xx open. They are reset inside `processDataRaw()` only after at least
          // one valid event has been parsed.

          let buffer = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            buffer += chunk;
            // SSE event boundaries may be either LF (`\n\n`) or CRLF (`\r\n\r\n`)
            // per the spec, and `parseSseChunk` documents CRLF support. Find the
            // last boundary using a regex that matches either form so the
            // streaming path stays consistent with the parser.
            const boundaryRegex = /\r?\n\r?\n/g;
            let lastBoundaryEnd = -1;
            let match: RegExpExecArray | null;
            while ((match = boundaryRegex.exec(buffer)) !== null) {
              lastBoundaryEnd = match.index + match[0].length;
            }
            if (lastBoundaryEnd === -1) return;
            const complete = buffer.slice(0, lastBoundaryEnd);
            buffer = buffer.slice(lastBoundaryEnd);

            const blocks = parseSseChunk(complete);
            for (const block of blocks) {
              if (block.id !== undefined) lastEventId = block.id;
              if (block.event !== undefined && block.data !== undefined) {
                // Cursor-capture rule: stream:hello carries the authoritative cursor
                // for Last-Event-ID on reconnect. Capture before surfacing to onNamedEvent.
                if (block.event === 'stream:hello') {
                  try {
                    const helloData = JSON.parse(block.data) as { cursor?: unknown };
                    if (typeof helloData.cursor === 'number') {
                      lastEventId = String(helloData.cursor);
                    }
                  } catch {
                    // Ignore parse errors
                  }
                }
                // Named SSE event (has an `event:` field) — route to onNamedEvent
                try {
                  opts.onNamedEvent?.(block.event, block.data);
                } catch {
                  // Callback exceptions must not disrupt the stream
                }
              } else if (block.data !== undefined) {
                processDataRaw(block.data, lastEventId);
              }
              if (settled) return;
            }
          });
          res.on('end', () => {
            request = null;
            if (!settled) scheduleReconnect();
          });
          res.on('error', () => {
            request = null;
            if (!settled) scheduleReconnect();
          });
        });

        req.on('error', () => {
          request = null;
          if (!settled) scheduleReconnect();
        });

        request = req;
      }).catch(() => {
        if (!settled) scheduleReconnect();
      });
    }

    connect();
  });
}

// ---------------------------------------------------------------------------
// subscribeWithSnapshot — async generator on top of subscribeToStream
// ---------------------------------------------------------------------------

/**
 * A single frame yielded by `subscribeWithSnapshot`.
 *
 * - `snapshot` — carries the `stream:hello` payload (first frame on every
 *   (re)connect). `stream:hello` is intercepted by the library and never
 *   appears as a `named` frame.
 * - `event` — a regular JSON event from the SSE data field.
 * - `named` — a named SSE event (e.g. `monitor:shutdown-pending`), excluding
 *   `stream:hello` which is surfaced as `snapshot`.
 */
export type SubscribeWithSnapshotFrame<S, E> =
  | { kind: 'snapshot'; snapshot: S }
  | { kind: 'event'; event: E; eventId?: string }
  | { kind: 'named'; name: string; data: string };

/**
 * Subscribe to an SSE stream and yield frames as an async generator.
 *
 * The first frame on every (re)connect is `{ kind: 'snapshot' }` carrying the
 * `stream:hello` payload. Subsequent frames are `{ kind: 'event' }` for JSON
 * events and `{ kind: 'named' }` for other named SSE events (e.g.
 * `monitor:shutdown-pending`). `stream:hello` is intercepted and never yielded
 * as `{ kind: 'named' }`.
 *
 * The generator throws `AbortError` when the supplied `AbortSignal` fires.
 *
 * Implementation: in-memory queue + promise-resolver bridge on top of the
 * existing `subscribeToStream` callback core. The core handles transport
 * selection, `Last-Event-ID` capture (including the cursor from `stream:hello`),
 * reconnect/backoff, and abort propagation. The queue is unbounded — slow
 * consumers may grow it; backpressure is the consumer's responsibility.
 *
 * @param url   Full SSE endpoint URL (e.g. `http://127.0.0.1:4567/api/daemon-events`).
 * @param opts  Options: `signal` to abort, `maxReconnects` cap.
 */
export async function* subscribeWithSnapshot<
  S = unknown,
  E extends DaemonStreamEvent = DaemonStreamEvent,
>(
  url: string,
  opts: { signal?: AbortSignal; maxReconnects?: number } = {},
): AsyncGenerator<SubscribeWithSnapshotFrame<S, E>> {
  // In-memory queue + promise-resolver bridge.
  // subscribeToStream callbacks push frames here; the generator drains them.
  // Note: the queue is unbounded — a slow consumer may grow it without limit.
  const queue: Array<SubscribeWithSnapshotFrame<S, E>> = [];
  let wakeResolver: (() => void) | null = null;
  let completed = false;
  let streamError: Error | null = null;

  function enqueue(frame: SubscribeWithSnapshotFrame<S, E>): void {
    queue.push(frame);
    if (wakeResolver) {
      const r = wakeResolver;
      wakeResolver = null;
      r();
    }
  }

  function waitForQueue(): Promise<void> {
    return new Promise<void>((resolve) => {
      wakeResolver = resolve;
    });
  }

  // Forward abort from the caller to the inner subscription.
  const innerAbort = new AbortController();
  if (opts.signal) {
    const signal = opts.signal;
    if (signal.aborted) {
      innerAbort.abort(signal.reason);
    } else {
      signal.addEventListener(
        'abort',
        () => { innerAbort.abort(signal.reason); },
        { once: true },
      );
    }
  }

  // Start the inner subscription in the background.
  const innerPromise = subscribeToStream<void>(
    url,
    {
      signal: innerAbort.signal,
      maxReconnects: opts.maxReconnects,
      onNamedEvent: (name: string, data: string) => {
        if (name === 'stream:hello') {
          // Intercepted: surface as snapshot frame, NOT as 'named'.
          try {
            const parsed = JSON.parse(data) as S;
            enqueue({ kind: 'snapshot', snapshot: parsed });
          } catch {
            // Ignore malformed hello data
          }
          return;
        }
        enqueue({ kind: 'named', name, data });
      },
    },
    (parsed: DaemonStreamEvent, eventId: string | undefined, _settle) => {
      enqueue({ kind: 'event', event: parsed as E, eventId });
    },
    {
      abort: 'subscribeWithSnapshot aborted',
      maxReconnects: (count: number) =>
        `subscribeWithSnapshot: exceeded max reconnects (${count})`,
      nonRetryStatus: (status: number) =>
        `subscribeWithSnapshot: stream returned ${status}`,
    },
  );

  // When the inner subscription settles, wake the generator so it can exit.
  innerPromise.then(
    () => {
      completed = true;
      if (wakeResolver) { const r = wakeResolver; wakeResolver = null; r(); }
    },
    (err: Error) => {
      completed = true;
      streamError = err;
      if (wakeResolver) { const r = wakeResolver; wakeResolver = null; r(); }
    },
  );

  try {
    while (!completed || queue.length > 0) {
      // Drain all queued frames before awaiting more.
      while (queue.length > 0) {
        yield queue.shift()!;
      }
      // If the stream is still open and the queue is empty, wait for more.
      if (!completed) {
        await waitForQueue();
      }
    }
    // Re-throw any terminal error (AbortError, max-reconnects, etc.).
    if (streamError) throw streamError;
  } finally {
    // Abort the inner subscription when the generator is abandoned (return/throw).
    innerAbort.abort();
  }
}
