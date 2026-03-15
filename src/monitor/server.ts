import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MonitorDB } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = resolve(__dirname, 'monitor-ui');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.map': 'application/json',
};

export interface MonitorServer {
  readonly port: number;
  readonly url: string;
  stop(): Promise<void>;
}

interface SSESubscriber {
  res: ServerResponse;
  runId: string;
  lastSeenId: number;
}

export async function startServer(
  db: MonitorDB,
  preferredPort = 4567,
  options?: { strictPort?: boolean },
): Promise<MonitorServer> {
  const subscribers = new Set<SSESubscriber>();

  async function serveStaticFile(req: IncomingMessage, res: ServerResponse, urlPath: string): Promise<void> {
    // Determine the file path
    let filePath: string;
    if (urlPath === '/' || urlPath === '/index.html') {
      filePath = join(UI_DIR, 'index.html');
    } else {
      // Resolve and verify containment to prevent directory traversal
      filePath = resolve(UI_DIR, '.' + urlPath);
      if (!filePath.startsWith(UI_DIR + '/')) {
        filePath = join(UI_DIR, 'index.html');
      }
    }

    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) {
        // SPA fallback: serve index.html for non-file paths
        filePath = join(UI_DIR, 'index.html');
      }
    } catch {
      // File not found — SPA fallback to index.html
      filePath = join(UI_DIR, 'index.html');
    }

    try {
      const content = await readFile(filePath);
      const ext = extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';

      // Cache hashed assets (files in assets/ directory) for 1 year
      const cacheControl = urlPath.includes('/assets/')
        ? 'public, max-age=31536000, immutable'
        : 'no-cache';

      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': content.length,
        'Cache-Control': cacheControl,
      });
      res.end(content);
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
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
    let lastSeenId = lastEventId ?? 0;
    for (const event of historicalEvents) {
      const dataLines = event.data.split('\n').map((l: string) => `data: ${l}`).join('\n');
      res.write(`id: ${event.id}\n${dataLines}\n\n`);
      if (event.id > lastSeenId) {
        lastSeenId = event.id;
      }
    }

    // Register for poll-based live updates
    const subscriber: SSESubscriber = { res, runId, lastSeenId };
    subscribers.add(subscriber);

    req.on('close', () => {
      subscribers.delete(subscriber);
    });
  }

  function serveHealth(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ status: 'ok', pid: process.pid }));
  }

  // Poll loop: check DB for new events and push to SSE subscribers
  const POLL_INTERVAL_MS = 200;
  const pollTimer = setInterval(() => {
    for (const subscriber of subscribers) {
      try {
        const newEvents = db.getEvents(subscriber.runId, subscriber.lastSeenId);
        for (const event of newEvents) {
          const dataLines = event.data.split('\n').map((l: string) => `data: ${l}`).join('\n');
          subscriber.res.write(`id: ${event.id}\n${dataLines}\n\n`);
          if (event.id > subscriber.lastSeenId) {
            subscriber.lastSeenId = event.id;
          }
        }
      } catch {
        // Subscriber may have disconnected
      }
    }
  }, POLL_INTERVAL_MS);
  pollTimer.unref();

  function serveLatestRunId(_req: IncomingMessage, res: ServerResponse): void {
    const runId = db.getLatestRunId();
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ runId: runId ?? null }));
  }

  function serveOrchestration(_req: IncomingMessage, res: ServerResponse, runId: string): void {
    const events = db.getEventsByType(runId, 'plan:complete');
    if (events.length === 0) {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify(null));
      return;
    }

    try {
      const data = JSON.parse(events[0].data);
      const plans = data.plans || [];
      const orchestration = {
        plans: plans.map((p: { id: string; name: string; dependsOn: string[]; branch: string }) => ({
          id: p.id,
          name: p.name,
          dependsOn: p.dependsOn || [],
          branch: p.branch,
        })),
        mode: data.mode || null,
      };

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify(orchestration));
    } catch {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify(null));
    }
  }

  function servePlans(_req: IncomingMessage, res: ServerResponse, runId: string): void {
    const events = db.getEventsByType(runId, 'plan:complete');
    if (events.length === 0) {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify([]));
      return;
    }

    try {
      const data = JSON.parse(events[0].data);
      const plans = (data.plans || []).map((p: { id: string; name: string; body: string; dependsOn?: string[] }) => ({
        id: p.id,
        name: p.name,
        body: p.body,
        dependsOn: p.dependsOn || [],
      }));

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify(plans));
    } catch {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify([]));
    }
  }

  const server = createServer(async (req, res) => {
    const url = req.url ?? '/';

    if (url === '/api/health') {
      serveHealth(req, res);
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
    } else if (url.startsWith('/api/orchestration/')) {
      const runId = url.slice('/api/orchestration/'.length);
      if (!runId || !/^[\w-]+$/.test(runId)) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Invalid runId');
        return;
      }
      serveOrchestration(req, res, runId);
    } else if (url.startsWith('/api/run-state/')) {
      const runId = url.slice('/api/run-state/'.length);
      if (!runId || !/^[\w-]+$/.test(runId)) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Invalid runId');
        return;
      }
      const run = db.getRun(runId);
      const events = db.getEvents(runId);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ run: run ?? null, events }));
    } else if (url.startsWith('/api/plans/')) {
      const runId = url.slice('/api/plans/'.length);
      if (!runId || !/^[\w-]+$/.test(runId)) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Invalid runId');
        return;
      }
      servePlans(req, res, runId);
    } else {
      // Serve static files (SPA)
      await serveStaticFile(req, res, url);
    }
  });

  const port = await listen(server, preferredPort, options?.strictPort ? 0 : 10);

  return {
    port,
    url: `http://localhost:${port}`,

    stop(): Promise<void> {
      clearInterval(pollTimer);
      return new Promise((resolveStop) => {
        // Close all SSE connections
        for (const subscriber of subscribers) {
          subscriber.res.end();
        }
        subscribers.clear();
        server.close(() => resolveStop());
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
