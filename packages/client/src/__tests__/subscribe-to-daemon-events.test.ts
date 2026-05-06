/**
 * Unit tests for subscribeToDaemonEvents.
 *
 * Uses the browser fetch transport path (stubs global `fetch` with a simple
 * SSE response) since it is easier to control in a vitest environment than
 * node:http.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { subscribeToDaemonEvents } from '../session-stream.js';
import type { DaemonStreamEvent } from '../session-stream.js';
import { API_ROUTES } from '../routes.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build an SSE wire string for a single JSON event with an id. */
function makeSseChunk(id: number, data: DaemonStreamEvent): string {
  return `id: ${id}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Create a minimal ReadableStream that emits a fixed sequence of SSE chunks
 * and then closes the stream.
 */
function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let idx = 0;
  return new ReadableStream({
    pull(controller) {
      if (idx < chunks.length) {
        controller.enqueue(encoder.encode(chunks[idx++]));
      } else {
        controller.close();
      }
    },
  });
}

/**
 * Stub the global `EventSource` to make session-stream.ts take the browser
 * path (it checks `typeof EventSource !== 'undefined'`).
 */
function stubEventSource(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).EventSource = class {};
}

function unstubEventSource(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).EventSource;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('subscribeToDaemonEvents', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    unstubEventSource();
  });

  it('calls onEvent with each parsed daemon-wide event', async () => {
    stubEventSource();

    const event1: DaemonStreamEvent = { type: 'queue:prd:start', prdId: 'my-prd' };
    const event2: DaemonStreamEvent = { type: 'enqueue:complete', id: 'prd-001' };

    const body = makeStream([makeSseChunk(1, event1), makeSseChunk(2, event2)]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      body,
    }));

    const received: DaemonStreamEvent[] = [];
    const ac = new AbortController();

    const promise = subscribeToDaemonEvents({
      baseUrl: 'http://127.0.0.1:9999',
      signal: ac.signal,
      onEvent: (event) => {
        received.push(event);
        if (received.length >= 2) {
          // Stop once we've seen both events
          ac.abort();
        }
      },
    });

    await promise.catch((err: Error) => {
      // AbortError is expected when we abort to stop the subscription
      if (err.name !== 'AbortError') throw err;
    });

    expect(received.length).toBe(2);
    expect(received[0].type).toBe('queue:prd:start');
    expect(received[1].type).toBe('enqueue:complete');
  });

  it('connects to the correct daemon-events URL', async () => {
    stubEventSource();

    const ac = new AbortController();
    const fetchMock = vi.fn().mockImplementation(() => {
      ac.abort(); // Immediately abort so the test doesn't hang
      return Promise.resolve({ ok: false, status: 503 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await subscribeToDaemonEvents({
      baseUrl: 'http://127.0.0.1:4567',
      signal: ac.signal,
      onEvent: () => {},
    }).catch(() => {});

    expect(fetchMock).toHaveBeenCalledWith(
      `http://127.0.0.1:4567${API_ROUTES.daemonEvents}`,
      expect.objectContaining({ headers: expect.objectContaining({ accept: 'text/event-stream' }) }),
    );
  });

  it('sends Last-Event-ID on reconnect', async () => {
    stubEventSource();

    const event1: DaemonStreamEvent = { type: 'session:start' };
    // First request: returns one event then closes (triggering reconnect)
    const body1 = makeStream([makeSseChunk(42, event1)]);

    let callCount = 0;
    const ac = new AbortController();

    const fetchMock = vi.fn().mockImplementation((_url: string, opts: RequestInit) => {
      callCount++;
      if (callCount === 1) {
        // First call: return one event, then close the stream
        return Promise.resolve({ ok: true, body: body1 });
      }
      // Second call (reconnect): verify Last-Event-ID header, then abort
      const headers = opts.headers as Record<string, string>;
      expect(headers['last-event-id']).toBe('42');
      ac.abort();
      return Promise.resolve({ ok: true, body: makeStream([]) });
    });
    vi.stubGlobal('fetch', fetchMock);

    const received: DaemonStreamEvent[] = [];
    await subscribeToDaemonEvents({
      baseUrl: 'http://127.0.0.1:4567',
      signal: ac.signal,
      onEvent: (event) => { received.push(event); },
    }).catch((err: Error) => {
      if (err.name !== 'AbortError') throw err;
    });

    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0].type).toBe('session:start');
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it('rejects with AbortError when signal is aborted', async () => {
    stubEventSource();

    const ac = new AbortController();
    ac.abort(); // Pre-abort

    vi.stubGlobal('fetch', vi.fn()); // Should not be called

    const err = await subscribeToDaemonEvents({
      baseUrl: 'http://127.0.0.1:4567',
      signal: ac.signal,
      onEvent: () => {},
    }).catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe('AbortError');
  });

  it('rejects with error when max reconnects are exhausted', async () => {
    stubEventSource();

    // Always return a non-retryable-looking response (503 → reconnect, not terminal)
    // but limit maxReconnects to 1 so it exhausts quickly
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
    }));

    const err = await subscribeToDaemonEvents({
      baseUrl: 'http://127.0.0.1:4567',
      onEvent: () => {},
      maxReconnects: 1,
    }).catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('subscribeToDaemonEvents');
    expect((err as Error).message).toContain('max reconnects');
  });
});
