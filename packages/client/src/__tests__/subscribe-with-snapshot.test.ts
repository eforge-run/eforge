/**
 * Generator semantics tests for subscribeWithSnapshot.
 *
 * Covers:
 * (1) snapshot is the first yielded frame on initial connect.
 * (2) snapshot re-fires after server-initiated reconnect.
 * (3) abort propagates as iterator-thrown AbortError.
 * (4) named events (non stream:hello) route to kind:'named'.
 * (5) stream:hello is NOT surfaced as kind:'named'.
 * (6) regular JSON events route to kind:'event'.
 *
 * Uses the same fake-SSE-server pattern as test/session-stream.test.ts.
 * Follows AGENTS.md conventions: no mocks, real HTTP, inputs inline.
 */

import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { subscribeWithSnapshot } from '../session-stream.js';
import type { SubscribeWithSnapshotFrame, DaemonStreamEvent } from '../session-stream.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestServer {
  server: Server;
  baseUrl: string;
  requestCount: () => number;
  close: () => Promise<void>;
}

type SseHandler = (req: IncomingMessage, res: ServerResponse, requestIndex: number) => void;

async function startTestServer(handler: SseHandler): Promise<TestServer> {
  let requestIndex = 0;
  const server = createServer((req, res) => {
    const idx = requestIndex++;
    handler(req, res, idx);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    requestCount: () => requestIndex,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Write an SSE frame with an `event:` field (named event). */
function writeNamedEvent(res: ServerResponse, name: string, data: string): void {
  res.write(`event: ${name}\ndata: ${data}\n\n`);
}

/** Write an SSE frame with no `event:` field (regular JSON event). */
function writeJsonEvent(res: ServerResponse, data: object, id?: number): void {
  if (id !== undefined) res.write(`id: ${id}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/** Write the stream:hello handshake frame. */
function writeHelloFrame(res: ServerResponse, cursor: number, extra?: object): void {
  const payload = JSON.stringify({ cursor, ...extra });
  res.write(`event: stream:hello\ndata: ${payload}\n\n`);
}

function sseHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
}

/** Collect N frames from a subscribeWithSnapshot generator, then abort. */
async function collectFrames<S = unknown>(
  url: string,
  count: number,
  signal?: AbortSignal,
): Promise<Array<SubscribeWithSnapshotFrame<S, DaemonStreamEvent>>> {
  const frames: Array<SubscribeWithSnapshotFrame<S, DaemonStreamEvent>> = [];
  const ac = new AbortController();
  const combinedSignal = signal ?? ac.signal;

  const gen = subscribeWithSnapshot<S, DaemonStreamEvent>(url, { signal: combinedSignal, maxReconnects: 3 });
  try {
    for await (const frame of gen) {
      frames.push(frame);
      if (frames.length >= count) {
        ac.abort();
        break;
      }
    }
  } catch (err) {
    if ((err as Error).name !== 'AbortError') throw err;
  }
  return frames;
}

// ---------------------------------------------------------------------------
// (1) snapshot is the first yielded frame
// ---------------------------------------------------------------------------

describe('subscribeWithSnapshot — snapshot is first frame', () => {
  it('yields kind:snapshot before kind:event frames', async () => {
    const test = await startTestServer((_req, res) => {
      sseHeaders(res);
      writeHelloFrame(res, 5, { status: 'running' });
      writeJsonEvent(res, { type: 'phase:start', timestamp: '2024-01-01T00:00:00.000Z' }, 6);
      setTimeout(() => res.end(), 20);
    });

    try {
      const frames = await collectFrames<{ cursor: number; status: string }>(
        `${test.baseUrl}/sse`,
        2,
      );

      expect(frames).toHaveLength(2);
      expect(frames[0].kind).toBe('snapshot');
      expect((frames[0] as { kind: 'snapshot'; snapshot: { cursor: number; status: string } }).snapshot.cursor).toBe(5);
      expect((frames[0] as { kind: 'snapshot'; snapshot: { cursor: number; status: string } }).snapshot.status).toBe('running');
      expect(frames[1].kind).toBe('event');
      expect((frames[1] as { kind: 'event'; event: DaemonStreamEvent }).event.type).toBe('phase:start');
    } finally {
      await test.close();
    }
  });
});

// ---------------------------------------------------------------------------
// (2) snapshot re-fires on reconnect
// ---------------------------------------------------------------------------

describe('subscribeWithSnapshot — snapshot re-fires on reconnect', () => {
  it('yields a fresh snapshot after server-initiated reconnect', async () => {
    const test = await startTestServer((_req, res, idx) => {
      sseHeaders(res);
      if (idx === 0) {
        // First connection: send hello + one event then close.
        writeHelloFrame(res, 10, { connectIndex: 0 });
        writeJsonEvent(res, { type: 'session:start', timestamp: '2024-01-01T00:00:00.000Z' }, 10);
        setTimeout(() => res.end(), 20);
      } else {
        // Reconnect: send a fresh hello + one event.
        writeHelloFrame(res, 11, { connectIndex: 1 });
        writeJsonEvent(res, { type: 'phase:start', timestamp: '2024-01-01T00:00:00.000Z' }, 11);
        setTimeout(() => res.end(), 20);
      }
    });

    try {
      // Collect 4 frames: snapshot1, event1, snapshot2, event2
      const frames = await collectFrames<{ cursor: number; connectIndex: number }>(
        `${test.baseUrl}/sse`,
        4,
      );

      const snapshots = frames.filter((f) => f.kind === 'snapshot');
      expect(snapshots.length).toBeGreaterThanOrEqual(2);

      // First snapshot has cursor=10
      const snap0 = (snapshots[0] as { kind: 'snapshot'; snapshot: { cursor: number; connectIndex: number } }).snapshot;
      expect(snap0.cursor).toBe(10);
      expect(snap0.connectIndex).toBe(0);

      // Second snapshot has cursor=11
      const snap1 = (snapshots[1] as { kind: 'snapshot'; snapshot: { cursor: number; connectIndex: number } }).snapshot;
      expect(snap1.cursor).toBe(11);
      expect(snap1.connectIndex).toBe(1);
    } finally {
      await test.close();
    }
  }, 15_000);
});

// ---------------------------------------------------------------------------
// (2b) cursor-capture rule: stream:hello cursor sets Last-Event-ID on reconnect
// ---------------------------------------------------------------------------

describe('subscribeWithSnapshot — cursor capture rule', () => {
  it('uses the stream:hello cursor as Last-Event-ID on reconnect (no JSON events between hellos)', async () => {
    // Captures the last-event-id header on each connect to verify the cursor
    // from the previous stream:hello is propagated to the next request.
    const observedLastEventIds: Array<string | undefined> = [];

    const test = await startTestServer((req, res, idx) => {
      observedLastEventIds.push(
        typeof req.headers['last-event-id'] === 'string'
          ? (req.headers['last-event-id'] as string)
          : undefined,
      );
      sseHeaders(res);
      if (idx === 0) {
        // First connection: only emit hello with cursor=42 — NO JSON events.
        // Without cursor capture, lastEventId would remain undefined and the
        // reconnect would not send a last-event-id header.
        writeHelloFrame(res, 42);
        setTimeout(() => res.end(), 20);
      } else {
        // Second connection: another hello so the iterator yields, then close.
        writeHelloFrame(res, 99);
        setTimeout(() => res.end(), 20);
      }
    });

    try {
      // Collect 2 frames: snapshot1 (cursor=42), snapshot2 (cursor=99)
      await collectFrames(`${test.baseUrl}/sse`, 2);

      // Two requests must have been made (initial + 1 reconnect).
      expect(observedLastEventIds.length).toBeGreaterThanOrEqual(2);

      // First request: no last-event-id header (initial connect).
      expect(observedLastEventIds[0]).toBeUndefined();

      // Second request: must carry last-event-id matching the cursor from
      // the first hello (42), proving the cursor-capture rule is wired.
      expect(observedLastEventIds[1]).toBe('42');
    } finally {
      await test.close();
    }
  }, 15_000);
});

// ---------------------------------------------------------------------------
// (3) abort propagates as iterator-thrown AbortError
// ---------------------------------------------------------------------------

describe('subscribeWithSnapshot — abort propagates', () => {
  it('iterator throws AbortError when signal fires', async () => {
    const test = await startTestServer((_req, res) => {
      sseHeaders(res);
      writeHelloFrame(res, 0);
      // Keep the connection open indefinitely
    });

    try {
      const ac = new AbortController();
      const gen = subscribeWithSnapshot(`${test.baseUrl}/sse`, { signal: ac.signal, maxReconnects: 0 });

      // Consume first frame (snapshot), then abort.
      const first = await gen.next();
      expect(first.done).toBe(false);
      expect(first.value.kind).toBe('snapshot');

      ac.abort();

      // Next iteration should throw AbortError
      let thrownError: Error | undefined;
      try {
        await gen.next();
      } catch (err) {
        thrownError = err as Error;
      }
      expect(thrownError).toBeDefined();
      expect(thrownError?.name).toBe('AbortError');
    } finally {
      await test.close();
    }
  });

  it('throws immediately when signal is already aborted', async () => {
    const test = await startTestServer((_req, res) => {
      sseHeaders(res);
    });

    try {
      const ac = new AbortController();
      ac.abort();

      const gen = subscribeWithSnapshot(`${test.baseUrl}/sse`, { signal: ac.signal });

      let thrownError: Error | undefined;
      try {
        await gen.next();
      } catch (err) {
        thrownError = err as Error;
      }
      expect(thrownError?.name).toBe('AbortError');
    } finally {
      await test.close();
    }
  });
});

// ---------------------------------------------------------------------------
// (4) named events route to kind:'named'
// ---------------------------------------------------------------------------

describe('subscribeWithSnapshot — named events', () => {
  it('yields monitor:shutdown-pending as kind:named', async () => {
    const test = await startTestServer((_req, res) => {
      sseHeaders(res);
      writeHelloFrame(res, 0);
      writeNamedEvent(res, 'monitor:shutdown-pending', JSON.stringify({ secondsRemaining: 30 }));
      setTimeout(() => res.end(), 20);
    });

    try {
      const frames = await collectFrames(`${test.baseUrl}/sse`, 2);

      const namedFrames = frames.filter((f) => f.kind === 'named');
      expect(namedFrames.length).toBeGreaterThanOrEqual(1);
      const named = namedFrames[0] as { kind: 'named'; name: string; data: string };
      expect(named.name).toBe('monitor:shutdown-pending');
    } finally {
      await test.close();
    }
  });

  it('yields monitor:shutdown-cancelled as kind:named', async () => {
    const test = await startTestServer((_req, res) => {
      sseHeaders(res);
      writeHelloFrame(res, 0);
      writeNamedEvent(res, 'monitor:shutdown-cancelled', '{}');
      setTimeout(() => res.end(), 20);
    });

    try {
      const frames = await collectFrames(`${test.baseUrl}/sse`, 2);

      const namedFrames = frames.filter((f) => f.kind === 'named');
      expect(namedFrames.length).toBeGreaterThanOrEqual(1);
      const named = namedFrames[0] as { kind: 'named'; name: string; data: string };
      expect(named.name).toBe('monitor:shutdown-cancelled');
    } finally {
      await test.close();
    }
  });
});

// ---------------------------------------------------------------------------
// (5) stream:hello does NOT appear as kind:'named'
// ---------------------------------------------------------------------------

describe('subscribeWithSnapshot — stream:hello interception', () => {
  it('does not yield stream:hello as kind:named', async () => {
    const test = await startTestServer((_req, res) => {
      sseHeaders(res);
      writeHelloFrame(res, 42, { extra: 'field' });
      setTimeout(() => res.end(), 20);
    });

    try {
      const frames = await collectFrames(`${test.baseUrl}/sse`, 1);

      // Only snapshot frame should appear — no named frame for stream:hello
      const namedFrames = frames.filter((f) => f.kind === 'named');
      expect(namedFrames).toHaveLength(0);

      const snapshotFrames = frames.filter((f) => f.kind === 'snapshot');
      expect(snapshotFrames.length).toBeGreaterThanOrEqual(1);
    } finally {
      await test.close();
    }
  });
});

// ---------------------------------------------------------------------------
// (6) regular JSON events route to kind:'event'
// ---------------------------------------------------------------------------

describe('subscribeWithSnapshot — event frames', () => {
  it('yields JSON events as kind:event with eventId', async () => {
    const test = await startTestServer((_req, res) => {
      sseHeaders(res);
      writeHelloFrame(res, 5);
      writeJsonEvent(res, { type: 'queue:start', timestamp: '2024-01-01T00:00:00.000Z', prdCount: 1, dir: '/q' }, 6);
      setTimeout(() => res.end(), 20);
    });

    try {
      const frames = await collectFrames(`${test.baseUrl}/sse`, 2);

      const eventFrames = frames.filter((f) => f.kind === 'event');
      expect(eventFrames.length).toBeGreaterThanOrEqual(1);
      const ev = eventFrames[0] as { kind: 'event'; event: { type: string }; eventId?: string };
      expect(ev.event.type).toBe('queue:start');
      expect(ev.eventId).toBe('6');
    } finally {
      await test.close();
    }
  });
});
