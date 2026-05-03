/**
 * Single-session SSE subscriber for the eforge daemon.
 *
 * The daemon streams every `EforgeEvent` over `GET /api/events/{sessionId}`
 * as Server-Sent Events. `subscribeToSession()` connects to that endpoint,
 * invokes `onEvent` per event (including the terminal `session:end`), and
 * resolves with a `SessionSummary` once `session:end` arrives.
 *
 * Reconnect/backoff matches the pattern previously embedded in
 * `packages/eforge/src/cli/mcp-proxy.ts`: initial 1s delay, doubling to a
 * 30s cap, with a hard retry cap so unrecoverable failures surface instead
 * of looping forever. `Last-Event-ID` is sent on reconnect so the daemon's
 * historical replay does not redeliver events we have already aggregated.
 *
 * This module is intentionally zero-dep (Node core + `./lockfile.js` only)
 * to preserve the `@eforge-build/client` contract of "no engine deps".
 * Callers that want full `EforgeEvent` typing on the `onEvent` callback
 * parameterize the helper with the engine's `EforgeEvent` type at the call
 * site; this module defines only a minimal structural shape.
 *
 * ## Transport selection
 *
 * `connect()` branches on `typeof EventSource !== 'undefined'`:
 *   - **Browser runtime**: uses `fetch` + `ReadableStream` for manual SSE
 *     parsing. This gives full control over the `event:` field (enabling
 *     `onNamedEvent`), `Last-Event-ID` replay, and `AbortSignal` support.
 *     Pass `baseUrl: ''` to use same-origin relative URLs.
 *   - **Node runtime**: uses `node:http`. Requires an absolute `baseUrl` or
 *     a resolvable lockfile `cwd`. Passing `baseUrl: ''` in a non-browser
 *     runtime throws a clear error.
 *
 * Both paths share the same reconnect/backoff counters, aggregate counters,
 * `SessionSummary` construction, and settlement logic.
 */

import { readLockfile } from './lockfile.js';

/** Initial reconnect delay, doubled on each failure up to `MAX_RECONNECT_MS`. */
const INITIAL_RECONNECT_MS = 1000;
/** Maximum backoff between reconnect attempts. */
const MAX_RECONNECT_MS = 30_000;
/** Default hard cap on reconnect attempts before rejecting. */
const DEFAULT_MAX_RECONNECTS = 10;

/**
 * Minimal structural shape for events streamed over SSE. The helper only
 * inspects `type` (and a few known fields during aggregation). Callers
 * parameterize `subscribeToSession<EforgeEvent>()` to get full typing on
 * their `onEvent` callback - this module does not depend on the engine.
 */
// Serialized form of EforgeEvent - keep in sync with event-to-progress.ts
export interface DaemonStreamEvent {
  type: string;
  sessionId?: string;
  timestamp?: string;
  [key: string]: unknown;
}

/**
 * Lifecycle summary returned by `subscribeToSession()` once `session:end`
 * arrives. Composed from the engine's `EforgeResult` plus aggregates
 * computed as events stream through the helper.
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

function resolveBaseUrl(opts: { baseUrl?: string; cwd?: string }): string {
  // Explicit same-origin opt-in for browser runtimes
  if (opts.baseUrl === '') return '';
  if (opts.baseUrl) return opts.baseUrl.replace(/\/$/, '');
  if (!opts.cwd) {
    throw new Error('subscribeToSession: either `baseUrl` or `cwd` must be provided');
  }
  const lock = readLockfile(opts.cwd);
  if (!lock) {
    throw new Error(
      `subscribeToSession: daemon lockfile not found in ${opts.cwd}. Is the daemon running?`,
    );
  }
  return `http://127.0.0.1:${lock.port}`;
}

/**
 * Subscribe to the daemon's SSE event stream for a single session.
 *
 * Resolves with a `SessionSummary` when `session:end` arrives. Rejects if:
 *   - the caller's `AbortSignal` fires (rejects with an `AbortError`),
 *   - the daemon returns a non-2xx status that is not retryable (404/410),
 *   - the reconnect count exceeds `maxReconnects`.
 *
 * Reconnect policy: the `reconnectCount`/`reconnectDelay` counters are reset
 * only after at least one valid event has been parsed from the stream - not
 * on 2xx response open. This ensures a misbehaving daemon that accepts
 * connections but emits no data cannot escape the `maxReconnects` cap.
 *
 * `onEvent` is invoked for every event received, including `session:end`.
 * The second `meta` argument carries the SSE `id:` value for the message.
 */
export function subscribeToSession<E extends DaemonStreamEvent = DaemonStreamEvent>(
  sessionId: string,
  opts: SubscribeOptions<E>,
): Promise<SessionSummary> {
  const maxReconnects = opts.maxReconnects ?? DEFAULT_MAX_RECONNECTS;

  return new Promise<SessionSummary>((resolve, reject) => {
    let baseUrl: string;
    try {
      baseUrl = resolveBaseUrl(opts);
    } catch (err) {
      reject(err as Error);
      return;
    }

    // Guard: baseUrl: '' is only valid in browser runtimes
    if (baseUrl === '' && typeof EventSource === 'undefined') {
      reject(new Error(
        "subscribeToSession: baseUrl: '' is only supported in browser runtimes",
      ));
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let request: any | null = null;
    let browserReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectDelay = INITIAL_RECONNECT_MS;
    let reconnectCount = 0;
    let hasReceivedValidEvent = false;
    let lastEventId: string | undefined;
    let settled = false;

    // Aggregates
    let eventCount = 0;
    let phaseCount = 0;
    let filesChanged = 0;
    let errorCount = 0;

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

    function settleResolve(summary: SessionSummary): void {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        opts.onEnd?.(summary);
      } catch {
        // onEnd must not break resolution
      }
      resolve(summary);
    }

    function settleReject(err: Error): void {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    }

    function onAbort(): void {
      const reason = opts.signal?.reason;
      // Use the reason directly only when it is already an AbortError (or DOMException);
      // otherwise wrap it as `cause` so we never mutate the caller's object.
      let err: Error;
      if (reason instanceof Error && (reason.name === 'AbortError' || reason instanceof DOMException)) {
        err = reason;
      } else {
        err = Object.assign(
          new Error('subscribeToSession aborted', reason !== undefined ? { cause: reason } : undefined),
          { name: 'AbortError' },
        );
      }
      settleReject(err);
    }

    if (opts.signal) {
      if (opts.signal.aborted) {
        // Defer to preserve Promise semantics
        queueMicrotask(() => onAbort());
        return;
      }
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    function handleEvent(raw: string, currentEventId?: string): void {
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
        reconnectCount = 0;
      }

      eventCount += 1;
      if (parsed.type === 'phase:start') {
        phaseCount += 1;
      }
      if (parsed.type === 'plan:build:files_changed') {
        const files = (parsed as { files?: unknown }).files;
        if (Array.isArray(files)) {
          filesChanged += files.length;
        }
      }
      if (parsed.type.endsWith(':error') || parsed.type.endsWith(':failed')) {
        errorCount += 1;
      }

      try {
        opts.onEvent(parsed as E, { eventId: currentEventId });
      } catch {
        // Callback exceptions must not disrupt the stream
      }

      if (parsed.type === 'session:end') {
        const result = (parsed as { result?: { status?: string; summary?: string } }).result;
        const status = result?.status === 'completed' || result?.status === 'failed'
          ? result.status
          : 'failed';
        const summary: SessionSummary = {
          sessionId,
          status,
          summary: result?.summary ?? '',
          monitorUrl: baseUrl,
          eventCount,
          phaseCount,
          filesChanged,
          errorCount,
        };
        settleResolve(summary);
      }
    }

    function scheduleReconnect(): void {
      if (settled) return;
      reconnectCount += 1;
      if (reconnectCount > maxReconnects) {
        settleReject(new Error(
          `subscribeToSession: exceeded max reconnects (${maxReconnects}) for session ${sessionId}`,
        ));
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
      const url = `${baseUrl}/api/events/${encodeURIComponent(sessionId)}`;
      const fetchHeaders: Record<string, string> = { accept: 'text/event-stream' };
      if (lastEventId !== undefined) {
        fetchHeaders['last-event-id'] = lastEventId;
      }

      fetch(url, { headers: fetchHeaders, signal: opts.signal })
        .then(async (response) => {
          if (!response.ok) {
            // 404/410 are terminal: the session does not exist or was dropped.
            if (response.status === 404 || response.status === 410) {
              settleReject(new Error(
                `subscribeToSession: daemon returned ${response.status} for session ${sessionId}`,
              ));
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
                  // Named SSE event (has an `event:` field) — route to onNamedEvent
                  try {
                    opts.onNamedEvent?.(block.event, block.data);
                  } catch {
                    // Callback exceptions must not disrupt the stream
                  }
                } else if (block.data !== undefined) {
                  handleEvent(block.data, lastEventId);
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

      // Browser path: use fetch + ReadableStream for full SSE text parsing,
      // supporting named events (event: field) and Last-Event-ID replay.
      if (typeof EventSource !== 'undefined') {
        connectBrowser();
        return;
      }

      // Node path (lazy-loads node:http to avoid bundler errors in browser contexts)
      const url = `${baseUrl}/api/events/${encodeURIComponent(sessionId)}`;
      const headers: Record<string, string> = { accept: 'text/event-stream' };
      if (lastEventId !== undefined) {
        headers['last-event-id'] = lastEventId;
      }

      void import('node:http').then((http) => {
        if (settled) return;

        const req = http.default.get(url, { headers }, (res: any) => {
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            res.resume();
            // 404/410 are terminal: the session does not exist or was dropped.
            if (res.statusCode === 404 || res.statusCode === 410) {
              settleReject(new Error(
                `subscribeToSession: daemon returned ${res.statusCode} for session ${sessionId}`,
              ));
              return;
            }
            scheduleReconnect();
            return;
          }

          // Note: backoff and reconnect counter are intentionally NOT reset on
          // 2xx open. They are reset inside `handleEvent()` only after at least
          // one valid event has been parsed - see the JSDoc on this function.

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
                // Named SSE event (has an `event:` field) — route to onNamedEvent
                try {
                  opts.onNamedEvent?.(block.event, block.data);
                } catch {
                  // Callback exceptions must not disrupt the stream
                }
              } else if (block.data !== undefined) {
                handleEvent(block.data, lastEventId);
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
