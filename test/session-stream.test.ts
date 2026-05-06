import { describe, it, expect } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import {
  parseSseChunk,
  subscribeWithSnapshot,
  type DaemonStreamEvent,
  type SubscribeWithSnapshotFrame,
} from '@eforge-build/client';

// ---------------------------------------------------------------------------
// Test helpers
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

function writeSseEvent(res: ServerResponse, event: DaemonStreamEvent, id?: number): void {
  if (id !== undefined) {
    res.write(`id: ${id}\n`);
  }
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function writeHelloFrame(res: ServerResponse, cursor: number, extra?: object): void {
  const payload = JSON.stringify({ cursor, ...extra });
  res.write(`event: stream:hello\ndata: ${payload}\n\n`);
}

function ts(): string {
  return new Date().toISOString();
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

  const gen = subscribeWithSnapshot<S, DaemonStreamEvent>(url, {
    signal: combinedSignal,
    maxReconnects: 3,
  });
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
// parseSseChunk
// ---------------------------------------------------------------------------

describe('parseSseChunk', () => {
  it('parses a single id+data block', () => {
    const blocks = parseSseChunk('id: 1\ndata: {"type":"phase:start"}\n\n');
    expect(blocks).toEqual([{ id: '1', data: '{"type":"phase:start"}' }]);
  });

  it('parses multi-line data blocks', () => {
    const blocks = parseSseChunk('data: line1\ndata: line2\n\n');
    expect(blocks).toEqual([{ data: 'line1\nline2' }]);
  });

  it('handles CRLF line endings', () => {
    const blocks = parseSseChunk('id: 7\r\ndata: {"type":"x"}\r\n\r\n');
    expect(blocks).toEqual([{ id: '7', data: '{"type":"x"}' }]);
  });

  it('drops empty blocks', () => {
    const blocks = parseSseChunk('\n\n\n\n');
    expect(blocks).toEqual([]);
  });

  it('tolerates no space after the colon', () => {
    const blocks = parseSseChunk('id:42\ndata:{"type":"x"}\n\n');
    expect(blocks).toEqual([{ id: '42', data: '{"type":"x"}' }]);
  });
});

// ---------------------------------------------------------------------------
// subscribeWithSnapshot — basic frame routing
// ---------------------------------------------------------------------------

describe('subscribeWithSnapshot', () => {
  it('yields kind:snapshot first, then kind:event frames', async () => {
    const snapshot = { cursor: 5, status: 'running', events: [] };

    const test = await startTestServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      writeHelloFrame(res, snapshot.cursor, { status: snapshot.status, events: snapshot.events });
      writeSseEvent(res, { type: 'phase:start', timestamp: ts() }, 6);
      setTimeout(() => res.end(), 10);
    });

    try {
      const frames = await collectFrames<typeof snapshot>(`${test.baseUrl}/sse`, 2);
      expect(frames).toHaveLength(2);
      expect(frames[0].kind).toBe('snapshot');
      expect((frames[0] as { kind: 'snapshot'; snapshot: typeof snapshot }).snapshot.cursor).toBe(5);
      expect((frames[0] as { kind: 'snapshot'; snapshot: typeof snapshot }).snapshot.status).toBe('running');
      expect(frames[1].kind).toBe('event');
      expect((frames[1] as { kind: 'event'; event: DaemonStreamEvent }).event.type).toBe('phase:start');
    } finally {
      await test.close();
    }
  });

  it('yields a fresh snapshot on reconnect', async () => {
    const test = await startTestServer((_req, res, idx) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      if (idx === 0) {
        writeHelloFrame(res, 10, { connectIndex: 0 });
        writeSseEvent(res, { type: 'session:start', timestamp: ts() }, 10);
        setTimeout(() => res.end(), 10);
      } else {
        writeHelloFrame(res, 11, { connectIndex: 1 });
        writeSseEvent(res, { type: 'phase:start', timestamp: ts() }, 11);
        setTimeout(() => res.end(), 10);
      }
    });

    try {
      const frames = await collectFrames<{ cursor: number; connectIndex: number }>(
        `${test.baseUrl}/sse`,
        4,
      );

      const snapshots = frames.filter((f) => f.kind === 'snapshot');
      expect(snapshots.length).toBeGreaterThanOrEqual(2);

      const snap0 = (snapshots[0] as { kind: 'snapshot'; snapshot: { cursor: number; connectIndex: number } }).snapshot;
      const snap1 = (snapshots[1] as { kind: 'snapshot'; snapshot: { cursor: number; connectIndex: number } }).snapshot;
      expect(snap0.cursor).toBe(10);
      expect(snap0.connectIndex).toBe(0);
      expect(snap1.cursor).toBe(11);
      expect(snap1.connectIndex).toBe(1);
    } finally {
      await test.close();
    }
  });

  it('uses stream:hello cursor as Last-Event-ID on reconnect', async () => {
    const observedLastEventIds: Array<string | undefined> = [];

    const test = await startTestServer((req, res, idx) => {
      observedLastEventIds.push(
        typeof req.headers['last-event-id'] === 'string'
          ? (req.headers['last-event-id'] as string)
          : undefined,
      );
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      if (idx === 0) {
        writeHelloFrame(res, 42);
        setTimeout(() => res.end(), 10);
      } else {
        writeHelloFrame(res, 99);
        setTimeout(() => res.end(), 10);
      }
    });

    try {
      await collectFrames(`${test.baseUrl}/sse`, 2);
      expect(observedLastEventIds.length).toBeGreaterThanOrEqual(2);
      expect(observedLastEventIds[0]).toBeUndefined();
      expect(observedLastEventIds[1]).toBe('42');
    } finally {
      await test.close();
    }
  }, 15_000);

  it('throws AbortError when signal fires mid-stream', async () => {
    const test = await startTestServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      writeHelloFrame(res, 0);
      // Keep open indefinitely
    });

    try {
      const ac = new AbortController();
      const gen = subscribeWithSnapshot(`${test.baseUrl}/sse`, { signal: ac.signal, maxReconnects: 0 });

      const first = await gen.next();
      expect(first.done).toBe(false);
      expect(first.value.kind).toBe('snapshot');

      ac.abort();

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

  it('throws immediately when signal is already aborted', async () => {
    const test = await startTestServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
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

  it('rejects once reconnect cap is exceeded', async () => {
    const test = await startTestServer((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('nope');
    });

    try {
      const gen = subscribeWithSnapshot(`${test.baseUrl}/sse`, { maxReconnects: 2 });
      let thrownError: Error | undefined;
      try {
        for await (const _frame of gen) {
          // Should not yield any frames
        }
      } catch (err) {
        thrownError = err as Error;
      }
      expect(thrownError).toBeDefined();
      // Assert on the message — `name === 'Error'` is tautological for any
      // plain Error and would not catch a refactor that throws an unrelated
      // Error instance instead of the max-reconnects error.
      expect(thrownError?.message).toMatch(/max reconnects|exceeded/i);
    } finally {
      await test.close();
    }
  }, 15_000);

  it('rejects on 404 without reconnecting', async () => {
    let hits = 0;
    const test = await startTestServer((_req, res) => {
      hits++;
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    });

    try {
      let thrownError: Error | undefined;
      try {
        for await (const _frame of subscribeWithSnapshot(`${test.baseUrl}/sse`, { maxReconnects: 5 })) {
          // Should not yield
        }
      } catch (err) {
        thrownError = err as Error;
      }
      expect(thrownError?.message).toMatch(/404/);
      expect(hits).toBe(1);
    } finally {
      await test.close();
    }
  });

  it('yields kind:named for non-stream:hello named events', async () => {
    const test = await startTestServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      writeHelloFrame(res, 0);
      res.write(`event: monitor:shutdown-pending\ndata: {"countdown":30}\n\n`);
      setTimeout(() => res.end(), 10);
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

  it('does NOT yield stream:hello as kind:named', async () => {
    const test = await startTestServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      writeHelloFrame(res, 42, { extra: 'value' });
      setTimeout(() => res.end(), 10);
    });

    try {
      const frames = await collectFrames(`${test.baseUrl}/sse`, 1);
      const namedFrames = frames.filter((f) => f.kind === 'named');
      expect(namedFrames).toHaveLength(0);
      const snapshotFrames = frames.filter((f) => f.kind === 'snapshot');
      expect(snapshotFrames.length).toBeGreaterThanOrEqual(1);
    } finally {
      await test.close();
    }
  });

  it('carries eventId on kind:event frames', async () => {
    const test = await startTestServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      writeHelloFrame(res, 5);
      writeSseEvent(res, { type: 'queue:start', timestamp: ts() }, 6);
      setTimeout(() => res.end(), 10);
    });

    try {
      const frames = await collectFrames(`${test.baseUrl}/sse`, 2);
      const eventFrames = frames.filter((f) => f.kind === 'event');
      expect(eventFrames.length).toBeGreaterThanOrEqual(1);
      const ev = eventFrames[0] as { kind: 'event'; event: DaemonStreamEvent; eventId?: string };
      expect(ev.event.type).toBe('queue:start');
      expect(ev.eventId).toBe('6');
    } finally {
      await test.close();
    }
  });
});
