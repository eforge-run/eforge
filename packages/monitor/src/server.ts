import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, dirname, extname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const execAsync = promisify(execFile);
import type { MonitorDB } from './db.js';
import type { EforgeConfig, PartialEforgeConfig } from '@eforge-build/engine/config';
import type { BuildStageSpec, ReviewProfileConfig } from '@eforge-build/client';
import { API_ROUTES, DAEMON_API_VERSION } from '@eforge-build/client';

// Derived prefix constants for parameterised routes (used in startsWith checks)
const CANCEL_BASE = API_ROUTES.cancel.slice(0, API_ROUTES.cancel.indexOf('/:'));
const PROFILE_BASE = API_ROUTES.profileDelete.slice(0, API_ROUTES.profileDelete.indexOf('/:'));
const EVENTS_BASE = API_ROUTES.events.slice(0, API_ROUTES.events.indexOf('/:'));
const ORCHESTRATION_BASE = API_ROUTES.orchestration.slice(0, API_ROUTES.orchestration.indexOf('/:'));
const RUN_SUMMARY_BASE = API_ROUTES.runSummary.slice(0, API_ROUTES.runSummary.indexOf('/:'));
const RUN_STATE_BASE = API_ROUTES.runState.slice(0, API_ROUTES.runState.indexOf('/:'));
const PLANS_BASE = API_ROUTES.plans.slice(0, API_ROUTES.plans.indexOf('/:'));
const DIFF_BASE = API_ROUTES.diff.slice(0, API_ROUTES.diff.indexOf('/:'));

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = resolve(__dirname, 'monitor-ui');

/**
 * Hydrate timestamp into event JSON for backward compatibility.
 * Legacy events stored without a JSON-embedded timestamp get the DB
 * `timestamp` column injected, avoiding a SQLite migration.
 */
function hydrateEventData(eventData: string, dbTimestamp: string, dbType: string): string {
  try {
    const parsed = JSON.parse(eventData);
    let mutated = false;
    if (!parsed.timestamp) {
      parsed.timestamp = dbTimestamp;
      mutated = true;
    }
    // Some historical emission sites stringified the payload without the
    // `type` field (it was only ever on the DB column). The client reads
    // `.type` off the parsed payload and crashes if it's missing, so merge
    // the column value in whenever the payload lacks one.
    if (!parsed.type && dbType) {
      parsed.type = dbType;
      mutated = true;
    }
    if (mutated) return JSON.stringify(parsed);
  } catch {
    // unparseable — return as-is
  }
  return eventData;
}

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
  '.wasm': 'application/wasm',
};

export interface MonitorServer {
  readonly port: number;
  readonly url: string;
  readonly subscriberCount: number;
  broadcast(eventName: string, data: string): void;
  onKeepAlive: (() => void) | null;
  stop(): Promise<void>;
}

export interface WorkerTracker {
  spawnWorker(command: string, args: string[]): { sessionId: string; pid: number };
  cancelWorker(sessionId: string): boolean;
}

export interface DaemonState {
  autoBuild: boolean;
  watcher: {
    running: boolean;
    pid: number | null;
    sessionId: string | null;
  };
  /** Callback to spawn the watcher — set by server-main.ts */
  onSpawnWatcher?: () => void;
  /** Callback to kill the watcher — set by server-main.ts */
  onKillWatcher?: () => void;
  /** Callback to trigger graceful daemon shutdown — set by server-main.ts */
  onShutdown?: () => void;
}

interface SSESubscriber {
  res: ServerResponse;
  sessionId: string;
  lastSeenId: number;
}

export async function startServer(
  db: MonitorDB,
  preferredPort = 4567,
  options?: { strictPort?: boolean; cwd?: string; queueDir?: string; planOutputDir?: string; workerTracker?: WorkerTracker; daemonState?: DaemonState; config?: Pick<EforgeConfig, 'monitor' | 'agentRuntimes' | 'defaultAgentRuntime'> },
): Promise<MonitorServer> {
  const subscribers = new Set<SSESubscriber>();

  // Resolve git remote once at startup
  const cwd = options?.cwd;
  let cachedGitRemote: string | null = null;
  if (cwd) {
    try {
      const { stdout } = await execAsync('git', ['remote', 'get-url', 'origin'], { cwd });
      cachedGitRemote = stdout.trim() || null;
    } catch {
      cachedGitRemote = null;
    }
  }

  // Retention cleanup on startup
  {
    const retentionCount = options?.config?.monitor?.retentionCount ?? 20;
    try {
      db.cleanupOldSessions(retentionCount);
    } catch {
      // Best-effort cleanup — don't fail startup
    }
  }

  function serveProjectContext(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ cwd: cwd ?? null, gitRemote: cachedGitRemote }));
  }

  function resolveSessionId(id: string): string {
    const run = db.getRun(id);
    return run?.sessionId ?? id;
  }

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
        if (urlPath.startsWith('/assets/')) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
          return;
        }
        // SPA fallback: serve index.html for non-file paths
        filePath = join(UI_DIR, 'index.html');
      }
    } catch {
      if (urlPath.startsWith('/assets/')) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }
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

  function serveSSE(req: IncomingMessage, res: ServerResponse, id: string): void {
    const sessionId = resolveSessionId(id);

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
    const historicalEvents = db.getEventsBySession(sessionId, lastEventId);
    let lastSeenId = lastEventId ?? 0;
    for (const event of historicalEvents) {
      const hydrated = hydrateEventData(event.data, event.timestamp, event.type);
      const dataLines = hydrated.split('\n').map((l: string) => `data: ${l}`).join('\n');
      res.write(`id: ${event.id}\n${dataLines}\n\n`);
      if (event.id > lastSeenId) {
        lastSeenId = event.id;
      }
    }

    // Register for poll-based live updates
    const subscriber: SSESubscriber = { res, sessionId, lastSeenId };
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
        const newEvents = db.getEventsBySession(subscriber.sessionId, subscriber.lastSeenId);
        for (const event of newEvents) {
          const hydrated = hydrateEventData(event.data, event.timestamp, event.type);
          const dataLines = hydrated.split('\n').map((l: string) => `data: ${l}`).join('\n');
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
    const sessionId = db.getLatestSessionId();
    const runId = db.getLatestRunId();
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ sessionId: sessionId ?? null, runId: runId ?? null }));
  }

  async function serveOrchestration(_req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const sessionId = resolveSessionId(id);
    const events = db.getEventsByTypeForSession(sessionId, 'planning:complete');
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

      // Enrich plan entries with build/review config from orchestration.yaml
      const buildConfigMap = await readBuildConfigFromOrchestration(sessionId);
      if (buildConfigMap) {
        for (const plan of orchestration.plans) {
          const config = buildConfigMap.get(plan.id);
          if (config) {
            (plan as Record<string, unknown>).build = config.build;
            (plan as Record<string, unknown>).review = config.review;
          }
        }
      }

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

  type PlanResponse = { id: string; name: string; body: string; dependsOn: string[]; type: 'architecture' | 'module' | 'plan'; build?: BuildStageSpec[]; review?: ReviewProfileConfig };

  /**
   * Return candidate paths for orchestration.yaml: main repo first, merge worktree fallback second.
   */
  function candidateOrchestrationPaths(
    repoCwd: string,
    planBase: string,
    planSet: string,
  ): Array<{ path: string; base: string }> {
    const mainPath = resolve(repoCwd, planBase, planSet, 'orchestration.yaml');
    const mainBase = resolve(repoCwd, planBase);
    const worktreeBase = resolve(repoCwd, '..', `${basename(repoCwd)}-${planSet}-worktrees`, '__merge__');
    const wtPath = resolve(worktreeBase, planBase, planSet, 'orchestration.yaml');
    const wtBase = resolve(worktreeBase, planBase);
    return [
      { path: mainPath, base: mainBase },
      { path: wtPath, base: wtBase },
    ];
  }

  /**
   * Return candidate plan directories: main repo first, merge worktree fallback second.
   */
  function candidatePlanDirs(
    repoCwd: string,
    planBase: string,
    planSet: string,
  ): Array<{ dir: string; base: string }> {
    const mainDir = resolve(repoCwd, planBase, planSet);
    const mainBase = resolve(repoCwd, planBase);
    const worktreeBase = resolve(repoCwd, '..', `${basename(repoCwd)}-${planSet}-worktrees`, '__merge__');
    const wtDir = resolve(worktreeBase, planBase, planSet);
    const wtBase = resolve(worktreeBase, planBase);
    return [
      { dir: mainDir, base: mainBase },
      { dir: wtDir, base: wtBase },
    ];
  }

  async function readExpeditionFiles(
    planDir: string,
    moduleMap: Map<string, { id: string; description: string; dependsOn: string[] }>,
  ): Promise<PlanResponse[]> {
    const files: PlanResponse[] = [];

    // Read architecture.md
    try {
      const archBody = await readFile(resolve(planDir, 'architecture.md'), 'utf-8');
      files.push({
        id: '__architecture__',
        name: 'Architecture',
        body: archBody,
        dependsOn: [],
        type: 'architecture',
      });
    } catch {
      // file may not exist yet
    }

    // Read module plan files — only include files that match known modules
    try {
      const moduleFiles = await readdir(resolve(planDir, 'modules'));
      for (const file of moduleFiles.sort()) {
        if (!file.endsWith('.md')) continue;
        const moduleId = basename(file, '.md');
        if (moduleMap.size > 0 && !moduleMap.has(moduleId)) continue;
        try {
          const body = await readFile(resolve(planDir, 'modules', file), 'utf-8');
          const meta = moduleMap.get(moduleId);
          files.push({
            id: `__module__${moduleId}`,
            name: meta?.description ?? moduleId,
            body,
            dependsOn: meta?.dependsOn ?? [],
            type: 'module',
          });
        } catch {
          // skip unreadable files
        }
      }
    } catch {
      // modules directory may not exist yet
    }

    return files;
  }

  async function readBuildConfigFromOrchestration(
    sessionId: string,
  ): Promise<Map<string, { build?: BuildStageSpec[]; review?: ReviewProfileConfig }> | null> {
    const sessionRuns = db.getSessionRuns(sessionId);
    const run = [...sessionRuns].reverse().find((r) => r.cwd && r.planSet);
    if (!run) return null;

    try {
      const planBase = options?.planOutputDir ?? 'eforge/plans';
      const candidates = candidateOrchestrationPaths(run.cwd, planBase, run.planSet);

      let content: string | null = null;
      for (const candidate of candidates) {
        if (!candidate.path.startsWith(candidate.base + '/')) continue;
        try {
          content = await readFile(candidate.path, 'utf-8');
          break;
        } catch {
          // try next candidate
        }
      }
      if (!content) return null;

      const orch = parseYaml(content);
      if (!orch?.plans || !Array.isArray(orch.plans)) return null;

      const map = new Map<string, { build?: BuildStageSpec[]; review?: ReviewProfileConfig }>();
      for (const plan of orch.plans) {
        if (!plan.id) continue;
        const entry: { build?: BuildStageSpec[]; review?: ReviewProfileConfig } = {};
        if (Array.isArray(plan.build)) entry.build = plan.build;
        if (plan.review && typeof plan.review === 'object' && !Array.isArray(plan.review)) entry.review = plan.review;
        if (entry.build || entry.review) {
          map.set(plan.id, entry);
        }
      }
      return map.size > 0 ? map : null;
    } catch {
      return null;
    }
  }

  async function servePlans(_req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const sessionId = resolveSessionId(id);

    // Compiled plans from planning:complete event
    const planEvents = db.getEventsByTypeForSession(sessionId, 'planning:complete');
    let compiledPlans: PlanResponse[] = [];

    if (planEvents.length > 0) {
      try {
        const data = JSON.parse(planEvents[0].data);
        compiledPlans = (data.plans || []).map((p: { id: string; name: string; body: string; dependsOn?: string[] }) => ({
          id: p.id,
          name: p.name,
          body: p.body,
          dependsOn: p.dependsOn || [],
          type: 'plan' as const,
        }));
      } catch {
        // ignore parse errors
      }
    }

    // Check for expedition files (architecture + module plans)
    let expeditionFiles: PlanResponse[] = [];
    const archEvents = db.getEventsByTypeForSession(sessionId, 'expedition:architecture:complete');

    if (archEvents.length > 0) {
      const sessionRuns = db.getSessionRuns(sessionId);
      const compileRun = [...sessionRuns].reverse().find((r) => r.command === 'compile');

      if (compileRun) {
        const { cwd: runCwd, planSet } = compileRun;
        const planBase = options?.planOutputDir ?? 'eforge/plans';
        const candidates = candidatePlanDirs(runCwd, planBase, planSet);

        let resolvedPlanDir: string | null = null;
        for (const candidate of candidates) {
          if (!candidate.dir.startsWith(candidate.base + '/')) continue;
          try {
            await stat(candidate.dir);
            resolvedPlanDir = candidate.dir;
            break;
          } catch {
            // try next candidate
          }
        }

        if (!resolvedPlanDir) {
          sendJson(res, compiledPlans);
          return;
        }

        // Parse module metadata from the architecture event
        let modules: Array<{ id: string; description: string; dependsOn: string[] }> = [];
        try {
          const archData = JSON.parse(archEvents[0].data);
          modules = archData.modules || [];
        } catch {
          // ignore
        }

        expeditionFiles = await readExpeditionFiles(resolvedPlanDir, new Map(modules.map((m) => [m.id, m])));
      }
    }

    // Gap-close plan from gap_close:plan_ready event
    const gapCloseEvents = db.getEventsByTypeForSession(sessionId, 'gap_close:plan_ready');
    let gapClosePlans: PlanResponse[] = [];
    if (gapCloseEvents.length > 0) {
      try {
        const data = JSON.parse(gapCloseEvents[gapCloseEvents.length - 1].data);
        gapClosePlans = [{
          id: 'gap-close',
          name: 'PRD Gap Close',
          body: data.planBody,
          dependsOn: [],
          type: 'plan' as const,
        }];
      } catch {
        // ignore parse errors
      }
    }

    const allPlans = [...expeditionFiles, ...compiledPlans, ...gapClosePlans];

    // Enrich plans with per-plan build/review config from orchestration.yaml
    const buildConfigMap = await readBuildConfigFromOrchestration(sessionId);
    if (buildConfigMap) {
      for (const plan of allPlans) {
        const config = buildConfigMap.get(plan.id);
        if (config) {
          plan.build = config.build;
          plan.review = config.review;
        }
      }
    }

    sendJson(res, allPlans);
  }

  function parseQueueFrontmatter(content: string): Record<string, unknown> | null {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return null;

    const lines = match[1].split('\n');
    const result: Record<string, unknown> = {};

    for (const line of lines) {
      const kvMatch = line.match(/^(\w[\w_]*)\s*:\s*(.*)/);
      if (!kvMatch) continue;
      const [, key, rawValue] = kvMatch;
      const value = rawValue.trim();

      if (value.startsWith('[') && value.endsWith(']')) {
        const inner = value.slice(1, -1).trim();
        result[key] = inner ? inner.split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')) : [];
      } else if (/^-?\d+$/.test(value)) {
        result[key] = parseInt(value, 10);
      } else if (value === 'true' || value === 'false') {
        result[key] = value === 'true';
      } else if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        result[key] = value.slice(1, -1);
      } else {
        result[key] = value;
      }
    }

    return result;
  }

  async function serveQueue(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const cwd = options?.cwd;
    if (!cwd) {
      sendJson(res, []);
      return;
    }

    const queueDir = resolve(cwd, options?.queueDir ?? 'eforge/queue');
    const lockDir = resolve(cwd, '.eforge', 'queue-locks');

    type QueueItem = {
      id: string;
      title: string;
      status: string;
      priority?: number;
      created?: string;
      dependsOn?: string[];
    };
    const items: QueueItem[] = [];

    // Helper: load PRDs from a directory with a given derived status
    async function loadFromDir(dir: string, derivedStatus: string): Promise<void> {
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        return;
      }

      const mdFiles = entries.filter((f) => f.endsWith('.md')).sort();
      for (const file of mdFiles) {
        try {
          const content = await readFile(resolve(dir, file), 'utf-8');
          const fm = parseQueueFrontmatter(content);
          if (!fm || typeof fm.title !== 'string') continue;

          const id = basename(file, '.md');

          // For PRDs in the main queue dir, check lock files to determine running vs pending
          let status = derivedStatus;
          if (derivedStatus === 'pending') {
            try {
              await readFile(resolve(lockDir, `${id}.lock`));
              status = 'running';
            } catch {
              // No lock file — stays pending
            }
          }

          const item: QueueItem = { id, title: fm.title, status };
          if (typeof fm.priority === 'number') item.priority = fm.priority;
          if (typeof fm.created === 'string') item.created = fm.created;
          if (Array.isArray(fm.depends_on)) item.dependsOn = fm.depends_on as string[];

          items.push(item);
        } catch {
          // skip unreadable files
        }
      }
    }

    // Scan main queue dir (pending/running) and subdirectories (failed, skipped)
    await Promise.all([
      loadFromDir(queueDir, 'pending'),
      loadFromDir(resolve(queueDir, 'failed'), 'failed'),
      loadFromDir(resolve(queueDir, 'skipped'), 'skipped'),
    ]);

    sendJson(res, items);
  }

  function serveDiff(_req: IncomingMessage, res: ServerResponse, sessionId: string, planId: string, file?: string): void {
    if (file) {
      // Single-file diff from DB
      const record = db.getFileDiff(sessionId, planId, file);
      sendJson(res, { diff: record?.diffText ?? null });
    } else {
      // Bulk: all files for the plan from DB
      const records = db.getFileDiffs(sessionId, planId);
      sendJson(res, { files: records.map((r) => ({ path: r.filePath, diff: r.diffText })) });
    }
  }

  const MAX_BODY_SIZE = 1024 * 1024; // 1MB

  function parseJsonBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalSize = 0;
      req.on('data', (chunk: Buffer) => {
        totalSize += chunk.length;
        if (totalSize > MAX_BODY_SIZE) {
          req.destroy();
          reject(new Error('Request body too large'));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf-8');
          resolve(body ? JSON.parse(body) : {});
        } catch (err) {
          reject(err);
        }
      });
      req.on('error', reject);
    });
  }

  function sendJsonError(res: ServerResponse, status: number, error: string): void {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ error }));
  }

  function sendJson(res: ServerResponse, data: unknown): void {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(data));
  }

  /**
   * Read and parse the project's `config.yaml` at the given config dir into
   * a partial config object. Returns {} on any failure (missing file, bad
   * YAML, etc.). Used by backend-profile endpoints to compute the team
   * default fallback for `resolveActiveProfileName`.
   */
  async function loadProjectPartialConfig(configDir: string): Promise<Record<string, unknown>> {
    try {
      const cfgPath = resolve(configDir, 'config.yaml');
      const raw = await readFile(cfgPath, 'utf-8');
      const data = parseYaml(raw);
      if (data && typeof data === 'object') {
        return data as Record<string, unknown>;
      }
    } catch {
      // missing or malformed — empty partial
    }
    return {};
  }

  let keepAliveCallback: (() => void) | null = null;

  function broadcast(eventName: string, data: string): void {
    for (const subscriber of subscribers) {
      try {
        subscriber.res.write(`event: ${eventName}\ndata: ${data}\n\n`);
      } catch {
        // Subscriber may have disconnected
      }
    }
  }

  const server = createServer(async (req, res) => {
    const url = req.url ?? '/';

    // Handle CORS preflight for all POST endpoints
    if (req.method === 'OPTIONS' && url.startsWith('/api/')) {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    if (req.method === 'POST' && url === API_ROUTES.keepAlive) {
      if (keepAliveCallback) keepAliveCallback();
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    // --- Control-plane POST routes (daemon mode) ---
    if (req.method === 'POST' && url === API_ROUTES.enqueue) {
      if (!options?.workerTracker) {
        sendJsonError(res, 503, 'Daemon mode not active');
        return;
      }
      if (options.config && (!options.config.agentRuntimes || Object.keys(options.config.agentRuntimes).length === 0)) {
        sendJsonError(res, 422, 'No agentRuntimes configured. Add agentRuntimes and defaultAgentRuntime to eforge/config.yaml');
        return;
      }
      try {
        const body = await parseJsonBody(req) as { source?: string; flags?: string[] };
        if (!body.source || typeof body.source !== 'string') {
          sendJsonError(res, 400, 'Missing required field: source');
          return;
        }
        const args = [body.source, ...(body.flags ?? [])];
        const result = options.workerTracker.spawnWorker('enqueue', args);
        sendJson(res, {
          sessionId: result.sessionId,
          pid: result.pid,
          autoBuild: options.daemonState?.autoBuild ?? false,
        });
      } catch {
        sendJsonError(res, 400, 'Invalid JSON body');
      }
      return;
    }

    if (req.method === 'POST' && url.startsWith(`${CANCEL_BASE}/`)) {
      if (!options?.workerTracker) {
        sendJsonError(res, 503, 'Daemon mode not active');
        return;
      }
      const sessionId = url.slice(`${CANCEL_BASE}/`.length);
      if (!sessionId || !/^[\w-]+$/.test(sessionId)) {
        sendJsonError(res, 400, 'Invalid sessionId');
        return;
      }
      const cancelled = options.workerTracker.cancelWorker(sessionId);
      if (cancelled) {
        sendJson(res, { status: 'cancelled', sessionId });
      } else {
        sendJsonError(res, 404, `No active worker found for sessionId: ${sessionId}`);
      }
      return;
    }

    // --- Auto-build API routes ---
    if (req.method === 'POST' && url === API_ROUTES.daemonStop) {
      if (!options?.daemonState) {
        sendJsonError(res, 503, 'Daemon mode not active');
        return;
      }
      try {
        const body = await parseJsonBody(req) as { force?: boolean };
        const force = body.force === true;
        if (!options.daemonState.onShutdown) {
          sendJsonError(res, 500, 'Shutdown handler not configured');
          return;
        }
        sendJson(res, { status: 'stopping', force });
        // Trigger shutdown asynchronously after responding
        setImmediate(() => options.daemonState!.onShutdown!());
      } catch {
        sendJsonError(res, 400, 'Invalid JSON body');
      }
      return;
    }

    if (req.method === 'GET' && url === API_ROUTES.autoBuildGet) {
      if (!options?.daemonState) {
        sendJsonError(res, 503, 'Daemon mode not active');
        return;
      }
      sendJson(res, {
        enabled: options.daemonState.autoBuild,
        watcher: options.daemonState.watcher,
      });
      return;
    }

    if (req.method === 'POST' && url === API_ROUTES.autoBuildSet) {
      if (!options?.daemonState) {
        sendJsonError(res, 503, 'Daemon mode not active');
        return;
      }
      try {
        const body = await parseJsonBody(req) as { enabled?: boolean };
        if (typeof body.enabled !== 'boolean') {
          sendJsonError(res, 400, 'Missing required field: enabled (boolean)');
          return;
        }
        options.daemonState.autoBuild = body.enabled;
        if (body.enabled) {
          // Spawn watcher if not already running
          if (!options.daemonState.watcher.running && options.daemonState.onSpawnWatcher) {
            options.daemonState.onSpawnWatcher();
          }
        } else {
          // Toggle OFF — SIGTERM the watcher. Its abort handler stops new PRD
          // discovery and startReadyPrds short-circuits on the abort signal,
          // so in-flight builds drain and the watcher exits without pulling
          // the next PRD.
          options.daemonState.onKillWatcher?.();
        }
        sendJson(res, {
          enabled: options.daemonState.autoBuild,
          watcher: options.daemonState.watcher,
        });
      } catch {
        sendJsonError(res, 400, 'Invalid JSON body');
      }
      return;
    }

    // --- Backend profile management ---
    if (req.method === 'GET' && (url === API_ROUTES.profileList || url.startsWith(`${API_ROUTES.profileList}?`))) {
      try {
        const { getConfigDir, listProfiles, resolveActiveProfileName, loadUserConfig } =
          await import('@eforge-build/engine/config');
        const configDir = await getConfigDir(options?.cwd);
        if (!configDir) {
          sendJson(res, { profiles: [], active: null, source: 'none' });
          return;
        }
        const queryString = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
        const params = new URLSearchParams(queryString);
        const scopeParam = params.get('scope') as 'project' | 'user' | 'all' | null;
        let profiles = await listProfiles(configDir);
        if (scopeParam === 'project' || scopeParam === 'user') {
          profiles = profiles.filter((p) => p.scope === scopeParam);
        }
        const projectConfig = await loadProjectPartialConfig(configDir);
        const userConfig = await loadUserConfig();
        const { name, source, warnings } = await resolveActiveProfileName(
          configDir,
          projectConfig as Parameters<typeof resolveActiveProfileName>[1],
          userConfig as Parameters<typeof resolveActiveProfileName>[2],
        );
        for (const warning of warnings) {
          process.stderr.write(`${warning}\n`);
        }
        sendJson(res, { profiles, active: name, source });
      } catch (err) {
        sendJsonError(res, 500, err instanceof Error ? err.message : 'Failed to list backend profiles');
      }
      return;
    }

    if (req.method === 'GET' && url === API_ROUTES.profileShow) {
      try {
        const { getConfigDir, loadProfile, resolveActiveProfileName, loadUserConfig } =
          await import('@eforge-build/engine/config');
        const configDir = await getConfigDir(options?.cwd);
        if (!configDir) {
          sendJson(res, { active: null, source: 'none', resolved: { backend: undefined, profile: null } });
          return;
        }
        const projectConfig = await loadProjectPartialConfig(configDir);
        const userConfig = await loadUserConfig();
        const { name, source, warnings: resolveWarnings } = await resolveActiveProfileName(
          configDir,
          projectConfig as Parameters<typeof resolveActiveProfileName>[1],
          userConfig as Parameters<typeof resolveActiveProfileName>[2],
        );
        for (const warning of resolveWarnings) {
          process.stderr.write(`${warning}\n`);
        }
        let profile: unknown = null;
        let backend: 'claude-sdk' | 'pi' | undefined;
        let profileScope: 'project' | 'user' | undefined;
        if (name) {
          const result = await loadProfile(configDir, name);
          if (result) {
            profile = result.profile;
            profileScope = result.scope;
            if (result.profile && typeof result.profile === 'object' && 'backend' in result.profile) {
              const b = (result.profile as { backend?: unknown }).backend;
              if (b === 'claude-sdk' || b === 'pi') backend = b;
            }
          }
        }
        sendJson(res, { active: name, source, resolved: { backend, profile, scope: profileScope } });
      } catch (err) {
        sendJsonError(res, 500, err instanceof Error ? err.message : 'Failed to show backend profile');
      }
      return;
    }

    if (req.method === 'POST' && url === API_ROUTES.profileUse) {
      try {
        const body = await parseJsonBody(req) as { name?: unknown; scope?: unknown };
        if (!body.name || typeof body.name !== 'string') {
          sendJsonError(res, 400, 'Missing required field: name (string)');
          return;
        }
        const scopeVal = body.scope === 'project' || body.scope === 'user' ? body.scope : undefined;
        const { getConfigDir, setActiveProfile } =
          await import('@eforge-build/engine/config');
        const configDir = await getConfigDir(options?.cwd);
        if (!configDir) {
          sendJsonError(res, 404, 'No eforge config directory found');
          return;
        }
        try {
          await setActiveProfile(configDir, body.name, scopeVal ? { scope: scopeVal } : undefined);
          sendJson(res, { active: body.name });
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Failed to set active backend';
          if (/not found/i.test(msg)) {
            sendJsonError(res, 404, msg);
          } else {
            sendJsonError(res, 400, msg);
          }
        }
      } catch {
        sendJsonError(res, 400, 'Invalid JSON body');
      }
      return;
    }

    if (req.method === 'POST' && url === API_ROUTES.profileCreate) {
      try {
        const body = await parseJsonBody(req) as {
          name?: unknown;
          backend?: unknown;
          pi?: unknown;
          agents?: unknown;
          overwrite?: unknown;
          scope?: unknown;
        };
        if (!body.name || typeof body.name !== 'string') {
          sendJsonError(res, 400, 'Missing required field: name (string)');
          return;
        }
        if (body.backend !== 'claude-sdk' && body.backend !== 'pi') {
          sendJsonError(res, 400, 'Invalid field: backend (must be "claude-sdk" or "pi")');
          return;
        }
        const scopeVal = body.scope === 'project' || body.scope === 'user' ? body.scope : undefined;
        const { getConfigDir, createBackendProfile } =
          await import('@eforge-build/engine/config');
        const configDir = await getConfigDir(options?.cwd);
        if (!configDir) {
          sendJsonError(res, 404, 'No eforge config directory found');
          return;
        }
        try {
          const result = await createBackendProfile(configDir, {
            name: body.name,
            harness: body.backend as 'claude-sdk' | 'pi',
            pi: body.pi as PartialEforgeConfig['pi'],
            agents: body.agents as PartialEforgeConfig['agents'],
            overwrite: body.overwrite === true,
            scope: scopeVal,
          });
          sendJson(res, { path: result.path });
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Failed to create backend profile';
          if (/already exists/i.test(msg)) {
            sendJsonError(res, 409, msg);
          } else {
            sendJsonError(res, 400, msg);
          }
        }
      } catch {
        sendJsonError(res, 400, 'Invalid JSON body');
      }
      return;
    }

    if (req.method === 'DELETE' && url.startsWith(`${PROFILE_BASE}/`)) {
      const name = url.slice(`${PROFILE_BASE}/`.length);
      if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) {
        sendJsonError(res, 400, 'Invalid backend profile name');
        return;
      }
      try {
        let force = false;
        let scopeVal: 'project' | 'user' | undefined;
        try {
          const body = await parseJsonBody(req) as { force?: unknown; scope?: unknown };
          force = body.force === true;
          if (body.scope === 'project' || body.scope === 'user') {
            scopeVal = body.scope;
          }
        } catch {
          // empty body — force defaults to false, scope defaults to undefined
        }
        const { getConfigDir, deleteBackendProfile } =
          await import('@eforge-build/engine/config');
        const configDir = await getConfigDir(options?.cwd);
        if (!configDir) {
          sendJsonError(res, 404, 'No eforge config directory found');
          return;
        }
        try {
          await deleteBackendProfile(configDir, name, force, scopeVal);
          sendJson(res, { deleted: name });
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Failed to delete backend profile';
          if (/currently active/i.test(msg)) {
            sendJsonError(res, 409, msg);
          } else if (/not found/i.test(msg)) {
            sendJsonError(res, 404, msg);
          } else if (/ambiguous/i.test(msg)) {
            sendJsonError(res, 409, msg);
          } else {
            sendJsonError(res, 400, msg);
          }
        }
      } catch (err) {
        sendJsonError(res, 500, err instanceof Error ? err.message : 'Failed to delete backend profile');
      }
      return;
    }

    if (req.method === 'GET' && url.startsWith(API_ROUTES.modelProviders)) {
      const queryString = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
      const params = new URLSearchParams(queryString);
      const backend = params.get('backend');
      if (backend !== 'pi' && backend !== 'claude-sdk') {
        sendJsonError(res, 400, 'Missing or invalid query param: backend (must be "pi" or "claude-sdk")');
        return;
      }
      try {
        const { listProviders } = await import('@eforge-build/engine/models');
        const providers = await listProviders(backend);
        sendJson(res, { providers });
      } catch (err) {
        sendJsonError(res, 500, err instanceof Error ? err.message : 'Failed to list providers');
      }
      return;
    }

    if (req.method === 'GET' && url.startsWith(API_ROUTES.modelList)) {
      const queryString = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
      const params = new URLSearchParams(queryString);
      const backend = params.get('backend');
      const provider = params.get('provider') ?? undefined;
      if (backend !== 'pi' && backend !== 'claude-sdk') {
        sendJsonError(res, 400, 'Missing or invalid query param: backend (must be "pi" or "claude-sdk")');
        return;
      }
      try {
        const { listModels } = await import('@eforge-build/engine/models');
        const models = await listModels(backend, provider);
        sendJson(res, { models });
      } catch (err) {
        sendJsonError(res, 500, err instanceof Error ? err.message : 'Failed to list models');
      }
      return;
    }

    if (url === API_ROUTES.projectContext) {
      serveProjectContext(req, res);
    } else if (url === API_ROUTES.health) {
      serveHealth(req, res);
    } else if (req.method === 'GET' && url === API_ROUTES.version) {
      sendJson(res, { version: DAEMON_API_VERSION });
    } else if (url === API_ROUTES.configShow) {
      try {
        const { loadConfig } = await import('@eforge-build/engine/config');
        const { config: resolved, warnings } = await loadConfig(options?.cwd);
        for (const warning of warnings) { process.stderr.write(`${warning}\n`); }
        sendJson(res, resolved);
      } catch (err) {
        sendJsonError(res, 500, err instanceof Error ? err.message : 'Failed to load config');
      }
    } else if (url === API_ROUTES.configValidate) {
      try {
        const { validateConfigFile } = await import('@eforge-build/engine/config');
        const result = await validateConfigFile(options?.cwd);
        sendJson(res, result);
      } catch (err) {
        sendJsonError(res, 500, err instanceof Error ? err.message : 'Failed to validate config');
      }
    } else if (url === API_ROUTES.queue) {
      await serveQueue(req, res);
    } else if (url === API_ROUTES.sessionMetadata) {
      const metadata = db.getSessionMetadataBatch();
      sendJson(res, metadata);
    } else if (url === API_ROUTES.runs) {
      serveRuns(req, res);
    } else if (url === API_ROUTES.latestRun) {
      serveLatestRunId(req, res);
    } else if (url.startsWith(`${EVENTS_BASE}/`)) {
      const runId = url.slice(`${EVENTS_BASE}/`.length);
      if (!runId || !/^[\w-]+$/.test(runId)) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Invalid runId');
        return;
      }
      serveSSE(req, res, runId);
    } else if (url.startsWith(`${ORCHESTRATION_BASE}/`)) {
      const runId = url.slice(`${ORCHESTRATION_BASE}/`.length);
      if (!runId || !/^[\w-]+$/.test(runId)) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Invalid runId');
        return;
      }
      await serveOrchestration(req, res, runId);
    } else if (url.startsWith(`${RUN_SUMMARY_BASE}/`)) {
      const id = url.slice(`${RUN_SUMMARY_BASE}/`.length);
      if (!id || !/^[\w-]+$/.test(id)) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Invalid id');
        return;
      }
      const sessionId = resolveSessionId(id);
      const sessionRuns = db.getSessionRuns(sessionId);

      // Compute session-level status
      let status: string;
      if (sessionRuns.length === 0) {
        status = 'unknown';
      } else if (sessionRuns.some((r) => r.status === 'running')) {
        status = 'running';
      } else if (sessionRuns.some((r) => r.status === 'failed')) {
        status = 'failed';
      } else {
        status = 'completed';
      }

      // Build runs array
      const runs = sessionRuns.map((r) => ({
        id: r.id,
        command: r.command,
        status: r.status,
        startedAt: r.startedAt,
        completedAt: r.completedAt ?? null,
      }));

      // Extract plan progress from build events
      const buildStartEvents = db.getEventsByTypeForSession(sessionId, 'plan:build:start');
      const buildCompleteEvents = db.getEventsByTypeForSession(sessionId, 'plan:build:complete');
      const buildFailedEvents = db.getEventsByTypeForSession(sessionId, 'plan:build:failed');

      const planStatusMap = new Map<string, { id: string; status: string; branch: string | null; dependsOn: string[] }>();
      for (const evt of buildStartEvents) {
        try {
          const data = JSON.parse(evt.data);
          if (data.planId) {
            planStatusMap.set(data.planId, {
              id: data.planId,
              status: 'running',
              branch: data.branch ?? null,
              dependsOn: data.dependsOn ?? [],
            });
          }
        } catch { /* skip */ }
      }
      for (const evt of buildCompleteEvents) {
        try {
          const data = JSON.parse(evt.data);
          if (data.planId && planStatusMap.has(data.planId)) {
            planStatusMap.get(data.planId)!.status = 'completed';
          }
        } catch { /* skip */ }
      }
      for (const evt of buildFailedEvents) {
        try {
          const data = JSON.parse(evt.data);
          if (data.planId && planStatusMap.has(data.planId)) {
            planStatusMap.get(data.planId)!.status = 'failed';
          }
        } catch { /* skip */ }
      }
      const plans = Array.from(planStatusMap.values());

      // Current phase from latest phase:start
      const phaseStartEvents = db.getEventsByTypeForSession(sessionId, 'phase:start');
      let currentPhase: string | null = null;
      if (phaseStartEvents.length > 0) {
        try {
          const data = JSON.parse(phaseStartEvents[phaseStartEvents.length - 1].data);
          currentPhase = data.phase ?? null;
        } catch { /* skip */ }
      }

      // Current agent from latest agent:start without matching agent:stop
      const agentStartEvents = db.getEventsByTypeForSession(sessionId, 'agent:start');
      const agentStopEvents = db.getEventsByTypeForSession(sessionId, 'agent:stop');
      const stoppedAgentIds = new Set<string>();
      for (const evt of agentStopEvents) {
        try {
          const data = JSON.parse(evt.data);
          if (data.agentId) stoppedAgentIds.add(data.agentId);
        } catch { /* skip */ }
      }
      let currentAgent: string | null = null;
      for (let i = agentStartEvents.length - 1; i >= 0; i--) {
        try {
          const data = JSON.parse(agentStartEvents[i].data);
          if (data.agentId && !stoppedAgentIds.has(data.agentId)) {
            currentAgent = data.agent ?? data.agentId;
            break;
          }
        } catch { /* skip */ }
      }

      // Event counts
      const allEvents = db.getEventsBySession(sessionId);
      const totalEvents = allEvents.length;
      let errorCount = 0;
      for (const evt of allEvents) {
        if (evt.type.endsWith(':failed') || evt.type.endsWith(':error')) {
          errorCount++;
        }
      }

      // Duration
      let duration: { startedAt: string | null; completedAt: string | null; seconds: number | null } = {
        startedAt: null,
        completedAt: null,
        seconds: null,
      };
      if (sessionRuns.length > 0) {
        const startedAt = sessionRuns[0].startedAt;
        const lastRun = sessionRuns[sessionRuns.length - 1];
        const completedAt = lastRun.completedAt ?? null;
        duration = {
          startedAt,
          completedAt,
          seconds: completedAt
            ? Math.round((new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 1000)
            : Math.round((Date.now() - new Date(startedAt).getTime()) / 1000),
        };
      }

      sendJson(res, {
        sessionId,
        status,
        runs,
        plans,
        currentPhase,
        currentAgent,
        eventCounts: { total: totalEvents, errors: errorCount },
        duration,
      });
    } else if (url.startsWith(`${RUN_STATE_BASE}/`)) {
      const id = url.slice(`${RUN_STATE_BASE}/`.length);
      if (!id || !/^[\w-]+$/.test(id)) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Invalid id');
        return;
      }
      const sessionId = resolveSessionId(id);
      const events = db.getEventsBySession(sessionId);
      const sessionRuns = db.getSessionRuns(sessionId);
      // Compute session-level status
      let status: string;
      if (sessionRuns.length === 0) {
        status = 'unknown';
      } else if (sessionRuns.some((r) => r.status === 'running')) {
        status = 'running';
      } else if (sessionRuns.some((r) => r.status === 'failed')) {
        status = 'failed';
      } else {
        status = 'completed';
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      const hydratedEvents = events.map((evt) => ({
        ...evt,
        data: hydrateEventData(evt.data, evt.timestamp, evt.type),
      }));
      res.end(JSON.stringify({ status, events: hydratedEvents }));
    } else if (url.startsWith(`${PLANS_BASE}/`)) {
      const runId = url.slice(`${PLANS_BASE}/`.length).split('?')[0];
      if (!runId || !/^[\w-]+$/.test(runId)) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Invalid runId');
        return;
      }
      await servePlans(req, res, runId);
    } else if (url.startsWith(`${DIFF_BASE}/`)) {
      // Route: /api/diff/:sessionId/:planId?file=path
      const pathPart = url.slice(`${DIFF_BASE}/`.length);
      const [routePath, queryString] = pathPart.split('?');
      const segments = routePath.split('/');
      const sessionIdParam = segments[0];
      const planIdParam = segments[1];

      if (!sessionIdParam || !planIdParam || !/^[\w-]+$/.test(sessionIdParam) || !/^[\w-]+$/.test(planIdParam)) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'Invalid sessionId or planId' }));
        return;
      }

      const resolvedSessionId = resolveSessionId(sessionIdParam);
      const fileParam = queryString
        ? new URLSearchParams(queryString).get('file') ?? undefined
        : undefined;

      serveDiff(req, res, resolvedSessionId, planIdParam, fileParam);
    } else {
      // Serve static files (SPA)
      await serveStaticFile(req, res, url);
    }
  });

  const port = await listen(server, preferredPort, options?.strictPort ? 0 : 10);

  const monitorServer: MonitorServer = {
    port,
    url: `http://localhost:${port}`,

    get subscriberCount(): number {
      return subscribers.size;
    },

    broadcast(eventName: string, data: string): void {
      broadcast(eventName, data);
    },

    get onKeepAlive(): (() => void) | null {
      return keepAliveCallback;
    },
    set onKeepAlive(cb: (() => void) | null) {
      keepAliveCallback = cb;
    },

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

  return monitorServer;
}

function listen(server: Server, port: number, maxRetries = 10): Promise<number> {
  return new Promise((resolve, reject) => {
    let attempts = 0;

    function tryListen(p: number): void {
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener('listening', onListening);
        if (err.code === 'EADDRINUSE' && attempts < maxRetries) {
          attempts++;
          tryListen(p + 1);
        } else {
          reject(err);
        }
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(p);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(p, '0.0.0.0');
    }

    tryListen(port);
  });
}
