import { describe, it, expect } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import {
  subscribeToSession,
  parseSseChunk,
  type DaemonStreamEvent,
  type SessionSummary,
} from '@eforge-build/client';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface TestServer {
  server: Server;
  baseUrl: string;
  /** Index of requests the server has received (each is a handler invocation). */
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

function ts(): string {
  return new Date().toISOString();
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
// subscribeToSession
// ---------------------------------------------------------------------------

describe('subscribeToSession', () => {
  it('invokes onEvent per event and resolves on session:end with aggregates', async () => {
    const test = await startTestServer((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      writeSseEvent(res, { type: 'phase:start', timestamp: ts(), runId: 'r1', planSet: 'p', command: 'build' }, 1);
      writeSseEvent(res, { type: 'plan:build:files_changed', timestamp: ts(), planId: 'plan-a', files: ['a.ts', 'b.ts'] }, 2);
      writeSseEvent(res, { type: 'plan:build:failed', timestamp: ts(), planId: 'plan-a', error: 'boom' }, 3);
      writeSseEvent(res, {
        type: 'session:end',
        sessionId: 'sess-1',
        timestamp: ts(),
        result: { status: 'completed', summary: 'ok' },
      }, 4);
      // Keep the connection open briefly so the client drains buffered data
      // before `end` fires (otherwise some Node versions merge chunks).
      setTimeout(() => res.end(), 10);
    });

    try {
      const events: DaemonStreamEvent[] = [];
      let endSummary: SessionSummary | null = null;
      const summary = await subscribeToSession('sess-1', {
        baseUrl: test.baseUrl,
        onEvent: (event) => events.push(event),
        onEnd: (s) => { endSummary = s; },
      });

      expect(events).toHaveLength(4);
      expect(events.map((e) => e.type)).toEqual([
        'phase:start',
        'plan:build:files_changed',
        'plan:build:failed',
        'session:end',
      ]);
      expect(summary.status).toBe('completed');
      expect(summary.summary).toBe('ok');
      expect(summary.sessionId).toBe('sess-1');
      expect(summary.monitorUrl).toBe(test.baseUrl);
      expect(summary.eventCount).toBe(4);
      expect(summary.phaseCount).toBe(1);
      expect(summary.filesChanged).toBe(2);
      expect(summary.errorCount).toBe(1); // build:failed
      expect(endSummary).toEqual(summary);
    } finally {
      await test.close();
    }
  });

  it('rejects with AbortError when the signal fires mid-stream', async () => {
    const test = await startTestServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      writeSseEvent(res, { type: 'phase:start', timestamp: ts() }, 1);
      // Do not end: keep the stream open so the abort path is exercised.
    });

    try {
      const controller = new AbortController();
      let firstEventSeen = false;
      const started = Date.now();
      const promise = subscribeToSession('sess-abort', {
        baseUrl: test.baseUrl,
        signal: controller.signal,
        onEvent: () => {
          if (!firstEventSeen) {
            firstEventSeen = true;
            // Abort shortly after the first event to test mid-stream abort.
            setTimeout(() => controller.abort(), 5);
          }
        },
      });

      await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
      // Must settle quickly after abort fires.
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      await test.close();
    }
  });

  it('rejects immediately when signal is already aborted', async () => {
    const test = await startTestServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    });

    try {
      const controller = new AbortController();
      controller.abort();
      await expect(
        subscribeToSession('sess-preaborted', {
          baseUrl: test.baseUrl,
          signal: controller.signal,
          onEvent: () => { /* unreached */ },
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      await test.close();
    }
  });

  it('reconnects when the server closes mid-stream and resumes to session:end', async () => {
    const test = await startTestServer((_req, res, idx) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (idx === 0) {
        // First connection: send one event then close.
        writeSseEvent(res, { type: 'phase:start', timestamp: ts() }, 1);
        setTimeout(() => res.end(), 10);
      } else {
        // Second connection: send the terminal event.
        writeSseEvent(res, {
          type: 'session:end',
          sessionId: 'sess-rc',
          timestamp: ts(),
          result: { status: 'completed', summary: 'reconnected' },
        }, 2);
        setTimeout(() => res.end(), 10);
      }
    });

    try {
      const events: DaemonStreamEvent[] = [];
      const summary = await subscribeToSession('sess-rc', {
        baseUrl: test.baseUrl,
        onEvent: (e) => events.push(e),
        maxReconnects: 3,
      });
      expect(test.requestCount()).toBeGreaterThanOrEqual(2);
      expect(events.map((e) => e.type)).toEqual(['phase:start', 'session:end']);
      expect(summary.status).toBe('completed');
      expect(summary.summary).toBe('reconnected');
    } finally {
      await test.close();
    }
  }, 15_000);

  it('rejects once reconnect cap is exceeded', async () => {
    const test = await startTestServer((_req, res) => {
      // Always return 500 - non-retryable by content but we treat as retryable.
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('nope');
    });

    try {
      await expect(
        subscribeToSession('sess-fail', {
          baseUrl: test.baseUrl,
          onEvent: () => { /* unreached */ },
          maxReconnects: 2,
        }),
      ).rejects.toMatchObject({
        name: 'Error',
      });
    } finally {
      await test.close();
    }
  }, 15_000);

  it('rejects on 404 without reconnecting', async () => {
    let hits = 0;
    const test = await startTestServer((_req, res) => {
      hits++;
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('no such session');
    });

    try {
      await expect(
        subscribeToSession('sess-404', {
          baseUrl: test.baseUrl,
          onEvent: () => { /* unreached */ },
          maxReconnects: 5,
        }),
      ).rejects.toThrow(/404/);
      expect(hits).toBe(1);
    } finally {
      await test.close();
    }
  });

  it("rejects with clear error when baseUrl: '' is used in a non-browser (node) runtime", async () => {
    // In the Node.js test environment EventSource is not defined globally,
    // so passing baseUrl: '' must reject immediately with the documented error.
    await expect(
      subscribeToSession('sess-browser-only', {
        baseUrl: '',
        onEvent: () => { /* unreached */ },
      }),
    ).rejects.toThrow("subscribeToSession: baseUrl: '' is only supported in browser runtimes");
  });

  it('sends Last-Event-ID on reconnect to resume from the last observed id', async () => {
    const seenLastEventIds: Array<string | undefined> = [];
    const test = await startTestServer((req, res, idx) => {
      seenLastEventIds.push(req.headers['last-event-id'] as string | undefined);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (idx === 0) {
        writeSseEvent(res, { type: 'phase:start', timestamp: ts() }, 5);
        setTimeout(() => res.end(), 10);
      } else {
        writeSseEvent(res, {
          type: 'session:end',
          sessionId: 'sess-lei',
          timestamp: ts(),
          result: { status: 'completed', summary: 'done' },
        }, 6);
        setTimeout(() => res.end(), 10);
      }
    });

    try {
      await subscribeToSession('sess-lei', {
        baseUrl: test.baseUrl,
        onEvent: () => { /* noop */ },
        maxReconnects: 3,
      });
      expect(seenLastEventIds[0]).toBeUndefined();
      expect(seenLastEventIds[1]).toBe('5');
    } finally {
      await test.close();
    }
  }, 15_000);
});
