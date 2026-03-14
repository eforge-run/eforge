import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ForgeEvent } from '../engine/events.js';
import type { MonitorDB } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = resolve(__dirname, 'monitor-ui');

export interface MonitorServer {
  readonly port: number;
  readonly url: string;
  pushEvent(event: ForgeEvent, eventId: number): void;
  stop(): Promise<void>;
}

interface SSESubscriber {
  res: ServerResponse;
  runId: string;
}

export async function startServer(
  db: MonitorDB,
  preferredPort = 4567,
): Promise<MonitorServer> {
  const subscribers = new Set<SSESubscriber>();
  let htmlCache: string | undefined;

  async function serveHTML(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!htmlCache) {
      htmlCache = await readFile(resolve(UI_DIR, 'index.html'), 'utf-8');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(htmlCache);
  }

  function serveRuns(_req: IncomingMessage, res: ServerResponse): void {
    const runs = db.getRuns();
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(runs));
  }

  function serveSSE(req: IncomingMessage, res: ServerResponse, runId: string): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    // Replay historical events
    const lastEventId = req.headers['last-event-id']
      ? parseInt(req.headers['last-event-id'] as string, 10)
      : undefined;
    const historicalEvents = db.getEvents(runId, lastEventId);
    for (const event of historicalEvents) {
      const dataLines = event.data.split('\n').map((l: string) => `data: ${l}`).join('\n');
      res.write(`id: ${event.id}\n${dataLines}\n\n`);
    }

    // Register for live updates
    const subscriber: SSESubscriber = { res, runId };
    subscribers.add(subscriber);

    req.on('close', () => {
      subscribers.delete(subscriber);
    });
  }

  function serveLatestRunId(_req: IncomingMessage, res: ServerResponse): void {
    const runId = db.getLatestRunId();
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ runId: runId ?? null }));
  }

  const server = createServer(async (req, res) => {
    const url = req.url ?? '/';

    if (url === '/' || url === '/index.html') {
      await serveHTML(req, res);
    } else if (url === '/api/runs') {
      serveRuns(req, res);
    } else if (url === '/api/latest-run') {
      serveLatestRunId(req, res);
    } else if (url.startsWith('/api/events/')) {
      const runId = url.slice('/api/events/'.length);
      if (!runId || !/^[\w-]+$/.test(runId)) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Invalid runId');
        return;
      }
      serveSSE(req, res, runId);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  });

  const port = await listen(server, preferredPort);

  return {
    port,
    url: `http://localhost:${port}`,

    pushEvent(event: ForgeEvent, eventId: number): void {
      const data = JSON.stringify(event);
      // Determine which runId this event belongs to
      const runId = 'runId' in event ? (event as { runId: string }).runId : undefined;

      for (const subscriber of subscribers) {
        // Push to subscribers watching this run, or all subscribers if run is unknown
        if (!runId || subscriber.runId === runId) {
          const dataLines = data.split('\n').map((l: string) => `data: ${l}`).join('\n');
          subscriber.res.write(`id: ${eventId}\n${dataLines}\n\n`);
        }
      }
    },

    stop(): Promise<void> {
      return new Promise((resolve) => {
        // Close all SSE connections
        for (const subscriber of subscribers) {
          subscriber.res.end();
        }
        subscribers.clear();
        server.close(() => resolve());
      });
    },
  };
}

function listen(server: Server, port: number, maxRetries = 10): Promise<number> {
  return new Promise((resolve, reject) => {
    let attempts = 0;

    function tryListen(p: number): void {
      const onError = (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && attempts < maxRetries) {
          attempts++;
          tryListen(p + 1);
        } else {
          reject(err);
        }
      };
      server.once('error', onError);
      server.listen(p, '127.0.0.1', () => {
        server.removeListener('error', onError);
        resolve(p);
      });
    }

    tryListen(port);
  });
}
