import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, stat, realpath } from 'node:fs/promises';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, extname, join, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const execAsync = promisify(execFile);
import type { MonitorDB } from './db.js';
import type { EforgeConfig, PartialEforgeConfig } from '@eforge-build/engine/config';
import type {
  BuildStageSpec,
  ReviewProfileConfig,
  QueueItem,
  AutoBuildState,
  ExtensionDiagnostic,
  ExtensionEntry,
  ExtensionListResponse,
  ExtensionNewRequest,
  ExtensionReloadWatcherMetadata,
  ExtensionRegistrationSummary,
} from '@eforge-build/client';
import { API_ROUTES, DAEMON_API_VERSION, safeParseEforgeEvent, parseWithSchema } from '@eforge-build/client';
import type { SchedulerInputEvent } from '@eforge-build/engine/eforge';
import type { EforgeEvent } from '@eforge-build/engine/events';
// --- eforge:region plan-01-fix-recovery-ux ---
import { recoveryVerdictSchema } from '@eforge-build/engine/schemas';
import {
  applyRecoveryRetry,
  applyRecoverySplit,
  applyRecoveryAbandon,
  applyRecoveryManual,
} from '@eforge-build/engine/recovery/apply';
// --- eforge:endregion plan-01-fix-recovery-ux ---
// --- eforge:region plan-01-handshake-primitive-additive ---
import { writeHello } from './sse-handshake.js';
// --- eforge:endregion plan-01-handshake-primitive-additive ---

/** Replaced at build time by tsup `define` with the daemon bundle's package version. */
declare const EFORGE_VERSION: string;

// Derived prefix constants for parameterised routes (used in startsWith checks)
const CANCEL_BASE = API_ROUTES.cancel.slice(0, API_ROUTES.cancel.indexOf('/:'));
const PROFILE_BASE = API_ROUTES.profileDelete.slice(0, API_ROUTES.profileDelete.indexOf('/:'));
const EVENTS_BASE = API_ROUTES.events.slice(0, API_ROUTES.events.indexOf('/:'));
const RUN_SUMMARY_BASE = API_ROUTES.runSummary.slice(0, API_ROUTES.runSummary.indexOf('/:'));
const RUN_STATE_BASE = API_ROUTES.runState.slice(0, API_ROUTES.runState.indexOf('/:'));
const PLANS_BASE = API_ROUTES.plans.slice(0, API_ROUTES.plans.indexOf('/:'));
const DIFF_BASE = API_ROUTES.diff.slice(0, API_ROUTES.diff.indexOf('/:'));
// --- eforge:region plan-03-daemon-mcp-pi ---
const RECOVERY_SIDECAR_BASE = API_ROUTES.readRecoverySidecar;

/**
 * Validate a path segment (setName / prdId) used as a filesystem path component.
 * Rejects values that could be used for path traversal.
 */
function isValidPathSegment(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('..') &&
    !value.includes('\0')
  );
}

/**
 * Assert that a resolved path is within the expected base directory.
 * Returns false if the path escapes the base directory.
 */
function isWithinDir(resolvedPath: string, baseDir: string): boolean {
  const base = resolve(baseDir) + sep;
  return resolvedPath.startsWith(base);
}
// --- eforge:endregion plan-03-daemon-mcp-pi ---

/**
 * Emit a `queue:mutation` event onto the active QueueScheduler's bus so it
 * immediately re-scans the queue directory and launches newly-ready PRDs.
 * No-op when the watcher is not running or the inject handle is unavailable.
 */
function emitMutation(
  state: DaemonState | undefined,
  reason: 'enqueue' | 'playbook-enqueue' | 'apply-recovery' | 'external',
): void {
  state?.injectSchedulerEvent?.({
    type: 'queue:mutation',
    reason,
    timestamp: new Date().toISOString(),
  });
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = resolve(__dirname, 'monitor-ui');

/**
 * Parse and validate a DB event row into an EforgeEvent.
 *
 * Applies backward-compat field patching (injecting timestamp and type from DB
 * columns when missing from the JSON payload) before Zod validation, preserving
 * the behavior of the previous hydrateEventData helper.
 *
 * Returns the parsed EforgeEvent on success, or null on parse/validation failure.
 * Failures are logged to stderr with row id, payload prefix, and Zod error path
 * (log-and-skip — callers must filter nulls).
 */
function parseEventRow(
  eventData: string,
  dbTimestamp: string,
  dbType: string,
  rowId?: number,
): EforgeEvent | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(eventData) as Record<string, unknown>;
  } catch {
    const prefix = eventData.length > 80 ? eventData.slice(0, 80) + '...' : eventData;
    process.stderr.write(
      `[parseEventRow] unparseable JSON${rowId !== undefined ? ` id=${rowId}` : ''}: ${prefix}\n`,
    );
    return null;
  }

  // Back-compat field patching: legacy rows may lack timestamp or type in the
  // JSON payload (they were stored only in DB columns). Inject from DB columns
  // before Zod validation so old rows still parse correctly.
  if (!parsed.timestamp) {
    parsed.timestamp = dbTimestamp;
  }
  if (!parsed.type && dbType) {
    parsed.type = dbType;
  }

  const result = safeParseEforgeEvent(parsed);
  if (!result.success) {
    const errorPath = result.error.errors.map((e) => e.path).join(', ');
    const prefix = eventData.length > 80 ? eventData.slice(0, 80) + '...' : eventData;
    process.stderr.write(
      `[parseEventRow] invalid event${rowId !== undefined ? ` id=${rowId}` : ''}: ${errorPath} — ${prefix}\n`,
    );
    return null;
  }

  return result.data;
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
  spawnWorker(command: string, args: string[], onExit?: () => void): { sessionId: string; pid: number };
  cancelWorker(sessionId: string): boolean;
}

export interface DaemonState {
  autoBuild: boolean;
  /** True when auto-build was paused due to a build failure; cleared on re-enable. */
  autoBuildPaused: boolean;
  watcher: {
    running: boolean;
    pid: number | null;
    sessionId: string | null;
  };
  /** Callback to spawn the watcher — set by server-main.ts */
  onSpawnWatcher?: () => void;
  /** Callback to kill the watcher — set by server-main.ts */
  onKillWatcher?: () => void;
  // --- eforge:region plan-01-extension-management-api ---
  /** Callback to reload extension discovery and restart the active watcher — set by server-main.ts */
  onReloadExtensions?: () => Promise<ExtensionReloadWatcherMetadata>;
  // --- eforge:endregion plan-01-extension-management-api ---
  /** Callback to trigger graceful daemon shutdown — set by server-main.ts */
  onShutdown?: () => void;
  /**
   * Injects a scheduler event directly onto the QueueScheduler's bus.
   * Set by server-main.ts via `onInjectEventRegister` when the watcher starts,
   * and cleared when the watcher stops. HTTP routes call `emitMutation()` which
   * delegates here, so the scheduler can react without relying on fs.watch.
   */
  injectSchedulerEvent?: (event: SchedulerInputEvent) => void;
  /**
   * Emit a daemon-scoped event to persistent storage.
   * Set by server-main.ts so the HTTP layer can trigger daemon events without
   * coupling server.ts to the DB write logic or the daemon session id.
   */
  onDaemonEvent?: (event: EforgeEvent) => void;
}

interface SSESubscriber {
  res: ServerResponse;
  sessionId: string;
  lastSeenId: number;
}

interface DaemonSSESubscriber {
  res: ServerResponse;
  lastSeenId: number;
}

export async function startServer(
  db: MonitorDB,
  preferredPort = 4567,
  options?: { strictPort?: boolean; cwd?: string; queueDir?: string; planOutputDir?: string; workerTracker?: WorkerTracker; daemonState?: DaemonState; config?: Pick<EforgeConfig, 'monitor' | 'agents' | 'prdQueue'> },
): Promise<MonitorServer> {
  const subscribers = new Set<SSESubscriber>();
  const daemonSubscribers = new Set<DaemonSSESubscriber>();

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

    // --- eforge:region plan-01-handshake-primitive-additive ---
    // stream:hello: per-session snapshot as the first frame on every connection.
    // cursor = max event id for this session at connect time.
    const allSessionEvents = db.getEventsBySession(sessionId);
    const sessionCursor =
      allSessionEvents.length > 0 ? allSessionEvents[allSessionEvents.length - 1].id : 0;
    const sessionRuns = db.getSessionRuns(sessionId);
    let sessionStatus: 'pending' | 'running' | 'completed' | 'failed';
    if (sessionRuns.length === 0) {
      sessionStatus = 'pending';
    } else if (sessionRuns.some((r) => r.status === 'running')) {
      sessionStatus = 'running';
    } else if (sessionRuns.some((r) => r.status === 'failed')) {
      sessionStatus = 'failed';
    } else {
      sessionStatus = 'completed';
    }
    const sessionSnapshot = {
      status: sessionStatus,
      events: allSessionEvents.map((evt) => ({ id: evt.id, data: evt.data })),
    };
    writeHello(res, sessionCursor, sessionSnapshot);
    // --- eforge:endregion plan-01-handshake-primitive-additive ---

    // Terminal sessions: close after stream:hello. The snapshot carries the full
    // event history; no live subscription is needed.
    if (sessionStatus === 'completed' || sessionStatus === 'failed') {
      res.end();
      return;
    }

    const rawLastEventId = req.headers['last-event-id']
      ? parseInt(req.headers['last-event-id'] as string, 10)
      : undefined;
    // Guard against malformed / non-finite / negative ids. Event ids are
    // monotonic non-negative integers; a negative value would be interpreted
    // by SQL as `id > -1` and replay every event ever stored.
    const lastEventId =
      rawLastEventId !== undefined &&
      Number.isInteger(rawLastEventId) &&
      rawLastEventId >= 0
        ? rawLastEventId
        : undefined;

    let lastSeenId: number;

    if (lastEventId !== undefined) {
      // Last-Event-ID present: replay events the client missed while disconnected.
      // This is the only per-session replay path — the client already has a
      // snapshot-seeded state and just needs to catch up on deltas.
      const historicalEvents = db.getEventsBySession(sessionId, lastEventId);
      lastSeenId = lastEventId;
      for (const event of historicalEvents) {
        const parsed = parseEventRow(event.data, event.timestamp, event.type, event.id);
        if (!parsed) continue;
        const serialized = JSON.stringify(parsed);
        const dataLines = serialized.split('\n').map((l: string) => `data: ${l}`).join('\n');
        res.write(`id: ${event.id}\n${dataLines}\n\n`);
        if (event.id > lastSeenId) {
          lastSeenId = event.id;
        }
      }
    } else {
      // No Last-Event-ID: initial connect. Skip historical replay — the snapshot
      // already carries all session events. Set lastSeenId to the cursor so
      // subsequent reconnects (with Last-Event-ID) replay only truly new events.
      lastSeenId = sessionCursor;
    }

    // Register for poll-based live updates
    const subscriber: SSESubscriber = { res, sessionId, lastSeenId };
    subscribers.add(subscriber);

    req.on('close', () => {
      subscribers.delete(subscriber);
    });
  }

  /**
   * Build the canonical `AutoBuildState` wire object from daemon state.
   * Used by `GET /api/auto-build`, `POST /api/auto-build` response, and the
   * `stream:hello` snapshot — the single source of this JSON shape.
   */
  function autoBuildStateToWire(state: DaemonState | undefined): AutoBuildState {
    return {
      enabled: state?.autoBuild ?? false,
      watcher: state?.watcher ?? { running: false, pid: null, sessionId: null },
    };
  }

  function serveDaemonEventsSSE(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    // --- eforge:region plan-01-handshake-primitive-additive ---
    // stream:hello: daemon-events snapshot as the first frame on every connection.
    // cursor = max daemon-wide event id at connect time.
    const helloCursor = db.getMaxDaemonEventId();
    const recentActivityRows = db.getDaemonEventsAfter(Math.max(0, helloCursor - 20));
    const recentActivity = recentActivityRows
      .map((row) => {
        const event = parseEventRow(row.data, row.timestamp, row.type, row.id);
        return event !== null ? { id: row.id, event } : null;
      })
      // Trim to id <= helloCursor: the two DB reads are unsynchronized, so rows
      // written between them would otherwise appear in recentActivity with
      // id > helloCursor and be re-delivered when the live stream catches up.
      .filter((x): x is { id: number; event: EforgeEvent } => x !== null && x.id <= helloCursor);
    const snapshotCwd = options?.cwd;
    const snapshotQueueDir = snapshotCwd ? resolve(snapshotCwd, options?.queueDir ?? 'eforge/queue') : '';
    const snapshotLockDir = snapshotCwd ? resolve(snapshotCwd, '.eforge', 'queue-locks') : '';
    const daemonSnapshot = {
      liveness: buildHeartbeatObject(),
      recentActivity,
      runs: db.getRuns(),
      queue: snapshotCwd ? loadQueueItemsSync(snapshotQueueDir, snapshotLockDir) : [],
      sessionMetadata: db.getSessionMetadataBatch(),
      autoBuild: autoBuildStateToWire(options?.daemonState),
    };
    writeHello(res, helloCursor, daemonSnapshot);
    // --- eforge:endregion plan-01-handshake-primitive-additive ---

    const rawLastEventId = req.headers['last-event-id']
      ? parseInt(req.headers['last-event-id'] as string, 10)
      : undefined;
    // Guard against malformed / non-finite / negative ids. parseInt returns NaN
    // for garbage which would otherwise leave `lastSeenId = NaN` (id > NaN is
    // always false in SQL, silently dropping every subsequent event); a negative
    // value would be interpreted as `id > -1` and replay every event ever stored.
    const lastEventId =
      rawLastEventId !== undefined &&
      Number.isInteger(rawLastEventId) &&
      rawLastEventId >= 0
        ? rawLastEventId
        : undefined;

    let lastSeenId: number;

    if (lastEventId !== undefined) {
      // Last-Event-ID present: replay events the client missed while disconnected.
      // This is the only path that replays history — the client already has a
      // snapshot-seeded state and just needs to catch up on deltas.
      const historicalEvents = db.getDaemonEventsAfter(lastEventId);
      lastSeenId = lastEventId;
      for (const event of historicalEvents) {
        const parsed = parseEventRow(event.data, event.timestamp, event.type, event.id);
        if (!parsed) continue;
        const serialized = JSON.stringify(parsed);
        const dataLines = serialized.split('\n').map((l: string) => `data: ${l}`).join('\n');
        res.write(`id: ${event.id}\n${dataLines}\n\n`);
        if (event.id > lastSeenId) {
          lastSeenId = event.id;
        }
      }
    } else {
      // No Last-Event-ID: initial connect. Skip historical replay — the snapshot
      // already carries recentActivity for seeding. Set lastSeenId to helloCursor
      // so delta replay via Last-Event-ID starts from the correct position on reconnect.
      lastSeenId = helloCursor;
    }

    // Register for poll-based live updates
    const subscriber: DaemonSSESubscriber = { res, lastSeenId };
    daemonSubscribers.add(subscriber);

    req.on('close', () => {
      daemonSubscribers.delete(subscriber);
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
          const parsed = parseEventRow(event.data, event.timestamp, event.type, event.id);
          if (!parsed) continue;
          const serialized = JSON.stringify(parsed);
          const dataLines = serialized.split('\n').map((l: string) => `data: ${l}`).join('\n');
          subscriber.res.write(`id: ${event.id}\n${dataLines}\n\n`);
          if (event.id > subscriber.lastSeenId) {
            subscriber.lastSeenId = event.id;
          }
        }
      } catch {
        // Subscriber may have disconnected
      }
    }

    for (const subscriber of daemonSubscribers) {
      try {
        const newEvents = db.getDaemonEventsAfter(subscriber.lastSeenId);
        for (const event of newEvents) {
          const parsed = parseEventRow(event.data, event.timestamp, event.type, event.id);
          if (!parsed) continue;
          const serialized = JSON.stringify(parsed);
          const dataLines = serialized.split('\n').map((l: string) => `data: ${l}`).join('\n');
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

  // --- eforge:region plan-01-types-and-daemon-emission ---
  // Heartbeat timer: pushes live-only daemon:heartbeat events directly to active SSE
  // subscribers approximately every 10 seconds, bypassing the DB poll loop.
  // Heartbeats are stateless and historically uninteresting — omitting the SSE
  // `id:` field ensures they are skipped when a reconnecting client replays via
  // `last-event-id`. One timer per server instance; iterating the shared
  // `daemonSubscribers` set on each tick avoids leaked timers on subscriber churn.
  const instanceStartedAt = Date.now();
  const HEARTBEAT_INTERVAL_MS = 10_000;

  function buildHeartbeatObject(): object {
    const uptime = Date.now() - instanceStartedAt;

    let runningBuilds = 0;
    try {
      runningBuilds = db.getRunningRuns().length;
    } catch {
      // DB might be closed during shutdown — skip this tick
    }

    // Count pending queue items from the filesystem queue directory.
    let queueDepth = 0;
    if (options?.cwd) {
      try {
        const queuePath = resolve(options.cwd, options?.queueDir ?? 'eforge/queue');
        const entries = readdirSync(queuePath);
        queueDepth = entries.filter((f) => f.endsWith('.md')).length;
      } catch {
        // Queue dir may not exist yet
      }
    }

    return {
      type: 'daemon:heartbeat',
      timestamp: new Date().toISOString(),
      uptime,
      queueDepth,
      runningBuilds,
      autoBuild: {
        enabled: options?.daemonState?.autoBuild ?? false,
        paused: options?.daemonState?.autoBuildPaused ?? false,
      },
      subscribers: daemonSubscribers.size,
    };
  }

  function buildHeartbeatPayload(): string {
    return JSON.stringify(buildHeartbeatObject());
  }

  const heartbeatTimer = setInterval(() => {
    // No-op fast path: skip DB queries and iteration when no subscribers are connected.
    if (daemonSubscribers.size === 0) return;

    const heartbeatData = buildHeartbeatPayload();

    for (const subscriber of daemonSubscribers) {
      try {
        // Omit the SSE `id:` field so last-event-id replay ignores heartbeats.
        subscriber.res.write(`data: ${heartbeatData}\n\n`);
      } catch {
        // Subscriber may have disconnected
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();
  // --- eforge:endregion plan-01-types-and-daemon-emission ---

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

  // --- eforge:region plan-01-handshake-primitive-additive ---
  /**
   * Build a canonical `QueueItem` from parsed frontmatter and a resolved status.
   * Shared by `loadQueueItemsSync` and `loadQueueItems` so item-shaping is never
   * duplicated between the sync and async queue-reading paths.
   */
  function buildQueueItem(
    id: string,
    fm: Record<string, unknown>,
    status: string,
    recoveryVerdict?: QueueItem['recoveryVerdict'],
  ): QueueItem {
    const item: QueueItem = { id, title: fm.title as string, status };
    if (typeof fm.priority === 'number') item.priority = fm.priority;
    if (typeof fm.created === 'string') item.created = fm.created;
    if (Array.isArray(fm.depends_on)) item.dependsOn = fm.depends_on as string[];
    if (recoveryVerdict !== undefined) item.recoveryVerdict = recoveryVerdict;
    return item;
  }

  /**
   * Post-process a mutable `QueueItem[]` to filter `dependsOn` entries to only
   * live items, mirroring `resolveQueueOrder` runtime semantics.
   * Mutates the array in place.
   */
  function postProcessQueueDependsOn(items: QueueItem[]): void {
    const liveIds = new Set(
      items
        .filter((i) => i.status === 'pending' || i.status === 'running' || i.status === 'waiting')
        .map((i) => i.id),
    );
    for (const item of items) {
      if (item.status === 'failed' || item.status === 'skipped') {
        delete item.dependsOn;
      } else if (item.dependsOn) {
        const filtered = item.dependsOn.filter((dep) => liveIds.has(dep));
        if (filtered.length === 0) delete item.dependsOn;
        else item.dependsOn = filtered;
      }
    }
  }

  /**
   * Synchronously load queue items matching the shape of `GET /api/queue`.
   * Used by `serveDaemonEventsSSE` to embed queue state in the `stream:hello` frame.
   * Uses `readdirSync` / `readFileSync` to avoid making `serveDaemonEventsSSE` async.
   */
  function loadQueueItemsSync(queueDir: string, lockDir: string): QueueItem[] {
    const items: QueueItem[] = [];

    function loadDirSync(dir: string, derivedStatus: string): void {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      const mdFiles = entries.filter((f) => f.endsWith('.md')).sort();
      for (const file of mdFiles) {
        try {
          const content = readFileSync(resolve(dir, file), 'utf-8');
          const fm = parseQueueFrontmatter(content);
          if (!fm || typeof fm.title !== 'string') continue;
          const id = basename(file, '.md');

          let status = derivedStatus;
          if (derivedStatus === 'pending') {
            if (existsSync(resolve(lockDir, `${id}.lock`))) {
              status = 'running';
            }
          }

          let recoveryVerdict: QueueItem['recoveryVerdict'] | undefined;
          if (derivedStatus === 'failed') {
            try {
              const sidecarRaw = readFileSync(resolve(dir, `${id}.recovery.json`), 'utf-8');
              const sidecarData = JSON.parse(sidecarRaw) as Record<string, unknown>;
              if (sidecarData && typeof sidecarData.verdict === 'object' && sidecarData.verdict !== null) {
                const parsed = parseWithSchema(recoveryVerdictSchema, sidecarData.verdict);
                recoveryVerdict = { verdict: parsed.verdict, confidence: parsed.confidence };
              }
            } catch {
              // silently omit — missing or malformed sidecar is normal
            }
          }

          items.push(buildQueueItem(id, fm, status, recoveryVerdict));
        } catch {
          // skip unreadable files
        }
      }
    }

    loadDirSync(queueDir, 'pending');
    loadDirSync(resolve(queueDir, 'failed'), 'failed');
    loadDirSync(resolve(queueDir, 'skipped'), 'skipped');
    loadDirSync(resolve(queueDir, 'waiting'), 'waiting');

    postProcessQueueDependsOn(items);
    return items;
  }

  /**
   * Asynchronously load queue items matching the shape of `GET /api/queue`.
   * Used by `serveQueue`. Shares item-shaping with `loadQueueItemsSync` via
   * `buildQueueItem` and `postProcessQueueDependsOn`.
   */
  async function loadQueueItems(queueDir: string, lockDir: string): Promise<QueueItem[]> {
    const items: QueueItem[] = [];

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

          let status = derivedStatus;
          if (derivedStatus === 'pending') {
            try {
              await readFile(resolve(lockDir, `${id}.lock`));
              status = 'running';
            } catch {
              // No lock file — stays pending
            }
          }

          let recoveryVerdict: QueueItem['recoveryVerdict'] | undefined;
          // --- eforge:region plan-01-fix-recovery-ux ---
          if (derivedStatus === 'failed') {
            try {
              const sidecarPath = resolve(dir, `${id}.recovery.json`);
              const sidecarRaw = await readFile(sidecarPath, 'utf-8');
              const sidecarData = JSON.parse(sidecarRaw) as Record<string, unknown>;
              if (sidecarData && typeof sidecarData.verdict === 'object' && sidecarData.verdict !== null) {
                const parsed = parseWithSchema(recoveryVerdictSchema, sidecarData.verdict);
                recoveryVerdict = { verdict: parsed.verdict, confidence: parsed.confidence };
              }
            } catch {
              // silently omit — missing or malformed sidecar is normal (recovery pending)
            }
          }
          // --- eforge:endregion plan-01-fix-recovery-ux ---

          items.push(buildQueueItem(id, fm, status, recoveryVerdict));
        } catch {
          // skip unreadable files
        }
      }
    }

    await loadFromDir(queueDir, 'pending');
    await loadFromDir(resolve(queueDir, 'failed'), 'failed');
    await loadFromDir(resolve(queueDir, 'skipped'), 'skipped');
    // --- eforge:region plan-05-piggyback-and-queue-scheduling ---
    await loadFromDir(resolve(queueDir, 'waiting'), 'waiting');
    // --- eforge:endregion plan-05-piggyback-and-queue-scheduling ---

    postProcessQueueDependsOn(items);
    return items;
  }
  // --- eforge:endregion plan-01-handshake-primitive-additive ---

  async function serveQueue(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const cwd = options?.cwd;
    if (!cwd) {
      sendJson(res, []);
      return;
    }

    const queueDir = resolve(cwd, options?.queueDir ?? 'eforge/queue');
    const lockDir = resolve(cwd, '.eforge', 'queue-locks');
    const items = await loadQueueItems(queueDir, lockDir);
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

  // Extension scaffold/reload mutates local filesystem/runtime state. The
  // daemon is otherwise browser-reachable (CORS preflight is allowed globally),
  // so require these new mutation routes to originate from the local machine and
  // reject cross-origin browser requests.
  function rejectUnsafeExtensionMutationRequest(req: IncomingMessage, res: ServerResponse): boolean {
    const remoteAddress = req.socket.remoteAddress;
    const isLoopback = remoteAddress === undefined
      || remoteAddress === '::1'
      || remoteAddress === '::ffff:127.0.0.1'
      || remoteAddress.startsWith('127.');
    if (!isLoopback) {
      sendJsonError(res, 403, 'Extension management mutations must originate from the local machine');
      return true;
    }

    const originHeader = req.headers.origin;
    const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
    if (origin) {
      const host = req.headers.host;
      try {
        if (!host || new URL(origin).host !== host) {
          sendJsonError(res, 403, 'Cross-origin extension management mutations are not allowed');
          return true;
        }
      } catch {
        sendJsonError(res, 403, 'Cross-origin extension management mutations are not allowed');
        return true;
      }
    }

    return false;
  }

  /**
   * Extract the harness kind from a parsed profile object.
   * Supports both the new `agentRuntimes.<name>.harness` shape and the legacy
   * top-level `backend:` field. Returns undefined when neither is present.
   */
  function extractHarnessFromProfile(profile: unknown): 'claude-sdk' | 'pi' | undefined {
    if (!profile || typeof profile !== 'object') return undefined;
    const p = profile as Record<string, unknown>;
    // New shape: agentRuntimes.<name>.harness
    if (p.agentRuntimes && typeof p.agentRuntimes === 'object') {
      const runtimeKey = typeof p.defaultAgentRuntime === 'string' ? p.defaultAgentRuntime : 'main';
      const runtime = (p.agentRuntimes as Record<string, unknown>)[runtimeKey];
      if (runtime && typeof runtime === 'object') {
        const h = (runtime as Record<string, unknown>).harness;
        if (h === 'claude-sdk' || h === 'pi') return h;
      }
    }
    // Legacy shape fallback: top-level backend field
    if ('backend' in p) {
      const b = p.backend;
      if (b === 'claude-sdk' || b === 'pi') return b;
    }
    return undefined;
  }

  /**
   * Read and parse the project's `config.yaml` at the given config dir into
   * a partial config object. Returns {} on any failure (missing file, bad
   * YAML, etc.). Used by agent runtime profile endpoints to compute the team
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

  // --- eforge:region plan-02-extension-tooling-surfaces ---
  const EXTENSION_NAME_RE = /^[A-Za-z0-9._-]+$/;

  const EMPTY_EXTENSION_REGISTRATIONS: ExtensionRegistrationSummary = {
    eventHooks: 0,
    agentRunHooks: 0,
    policyGates: 0,
    profileRouters: 0,
    inputSources: 0,
    reviewerPerspectives: 0,
    validationProviders: 0,
    tools: 0,
  };

  function normalizeExtensionDiagnostic(diagnostic: unknown): ExtensionDiagnostic {
    const d = diagnostic as ExtensionDiagnostic;
    const result: ExtensionDiagnostic = {
      severity: d.severity,
      code: d.code,
      message: d.message,
    };
    if (d.name !== undefined) result.name = d.name;
    if (d.path !== undefined) result.path = d.path;
    if (d.scope !== undefined) result.scope = d.scope;
    if (d.source !== undefined) result.source = d.source;
    return result;
  }

  async function validateExtensionQueryPath(rawPath: string): Promise<string | null> {
    if (!cwd || rawPath.length === 0 || rawPath.includes('\0')) return null;
    const resolvedPath = resolve(cwd, rawPath);
    if (!isWithinDir(resolvedPath, cwd)) return null;
    try {
      const [realCwd, realResolvedPath] = await Promise.all([realpath(cwd), realpath(resolvedPath)]);
      return isWithinDir(realResolvedPath, realCwd) ? realResolvedPath : null;
    } catch {
      return null;
    }
  }

  function selectExtensionByName(extensions: ExtensionEntry[], name: string): ExtensionEntry | undefined {
    const matches = extensions.filter((entry) => entry.name === name);
    return matches.find((entry) => entry.status === 'loaded')
      ?? matches.find((entry) => entry.status !== 'shadowed')
      ?? matches[0];
  }

  // --- eforge:region plan-01-extension-management-api ---
  function extensionEntryEnabled(status: ExtensionEntry['status'], globalEnabled: boolean): boolean {
    return globalEnabled && status !== 'shadowed' && status !== 'excluded';
  }
  // --- eforge:endregion plan-01-extension-management-api ---

  async function loadExtensionResponse(opts: { path?: string } = {}): Promise<ExtensionListResponse> {
    if (!cwd) throw new Error('Working directory not configured');
    const { loadConfig, getConfigDir, getConventionalConfigDir } = await import('@eforge-build/engine/config');
    const { loadNativeExtensions, discoverNativeExtensions, projectExtensionRegistry } = await import('@eforge-build/engine/extensions/index');

    const { config, warnings } = await loadConfig(cwd);
    for (const warning of warnings) {
      process.stderr.write(`${warning}\n`);
    }
    const configDir = await getConfigDir(cwd) ?? getConventionalConfigDir(cwd);
    const extensionConfig = opts.path
      ? {
        enabled: true,
        trustProjectExtensions: config.extensions.trustProjectExtensions,
        include: ['__eforge_no_auto_extensions__'],
        paths: [opts.path],
      }
      : config.extensions;

    // --- eforge:region plan-01-extension-management-api ---
    if (!opts.path && !config.extensions.enabled) {
      const discovery = await discoverNativeExtensions({
        cwd,
        configDir,
        config: {
          ...config.extensions,
          enabled: true,
        },
      });
      const extensions: ExtensionEntry[] = discovery.candidates.map((candidate) => ({
        name: candidate.name,
        path: candidate.path,
        ...(candidate.entrypoint !== undefined && { entrypoint: candidate.entrypoint }),
        scope: candidate.scope as ExtensionEntry['scope'],
        source: candidate.source,
        status: candidate.status,
        enabled: false,
        trust: candidate.trust,
        ...(candidate.format !== undefined && { format: candidate.format }),
        ...(candidate.layout !== undefined && { layout: candidate.layout }),
        shadows: candidate.shadows.map((shadow) => ({
          name: shadow.name,
          path: shadow.path,
          ...(shadow.entrypoint !== undefined && { entrypoint: shadow.entrypoint }),
          scope: shadow.scope,
          ...(shadow.format !== undefined && { format: shadow.format }),
          ...(shadow.layout !== undefined && { layout: shadow.layout }),
        })),
        registrations: { ...EMPTY_EXTENSION_REGISTRATIONS },
        diagnostics: candidate.diagnostics.map(normalizeExtensionDiagnostic),
      }));
      extensions.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
      return {
        extensions,
        diagnostics: discovery.diagnostics.map(normalizeExtensionDiagnostic),
        totals: { ...EMPTY_EXTENSION_REGISTRATIONS },
      };
    }
    // --- eforge:endregion plan-01-extension-management-api ---

    const loadResult = await loadNativeExtensions({ cwd, configDir, config: extensionConfig });
    const projection = projectExtensionRegistry(loadResult.registry);
    const loadedByKey = new Map(projection.extensions.map((extension) => [`${extension.name}\0${extension.path}`, extension]));

    const extensions: ExtensionEntry[] = loadResult.candidates.map((candidate) => {
      const loaded = loadedByKey.get(`${candidate.name}\0${candidate.path}`);
      return {
        name: candidate.name,
        path: candidate.path,
        ...(candidate.entrypoint !== undefined && { entrypoint: candidate.entrypoint }),
        scope: candidate.scope as ExtensionEntry['scope'],
        source: candidate.source,
        status: candidate.status,
        // --- eforge:region plan-01-extension-management-api ---
        enabled: extensionEntryEnabled(candidate.status, extensionConfig.enabled),
        // --- eforge:endregion plan-01-extension-management-api ---
        trust: candidate.trust,
        ...(candidate.format !== undefined && { format: candidate.format }),
        ...(candidate.layout !== undefined && { layout: candidate.layout }),
        ...(loaded?.strategy !== undefined && { strategy: loaded.strategy }),
        shadows: candidate.shadows.map((shadow) => ({
          name: shadow.name,
          path: shadow.path,
          ...(shadow.entrypoint !== undefined && { entrypoint: shadow.entrypoint }),
          scope: shadow.scope,
          ...(shadow.format !== undefined && { format: shadow.format }),
          ...(shadow.layout !== undefined && { layout: shadow.layout }),
        })),
        registrations: (loaded?.registrations as ExtensionRegistrationSummary | undefined) ?? { ...EMPTY_EXTENSION_REGISTRATIONS },
        diagnostics: candidate.diagnostics.map(normalizeExtensionDiagnostic),
      };
    });

    if (!opts.path && config.extensions.enabled && (config.extensions.include || config.extensions.exclude)) {
      const discoveredAll = await discoverNativeExtensions({
        cwd,
        configDir,
        config: {
          enabled: true,
          trustProjectExtensions: config.extensions.trustProjectExtensions,
          paths: [],
        },
      });
      const configuredPaths = new Set(loadResult.candidates.map((candidate) => candidate.path));
      for (const candidate of discoveredAll.candidates) {
        if (candidate.source !== 'auto' || configuredPaths.has(candidate.path)) continue;
        extensions.push({
          name: candidate.name,
          path: candidate.path,
          ...(candidate.entrypoint !== undefined && { entrypoint: candidate.entrypoint }),
          scope: candidate.scope as ExtensionEntry['scope'],
          source: candidate.source,
          status: 'excluded',
          // --- eforge:region plan-01-extension-management-api ---
          enabled: false,
          // --- eforge:endregion plan-01-extension-management-api ---
          trust: candidate.trust,
          ...(candidate.format !== undefined && { format: candidate.format }),
          ...(candidate.layout !== undefined && { layout: candidate.layout }),
          shadows: candidate.shadows.map((shadow) => ({
            name: shadow.name,
            path: shadow.path,
            ...(shadow.entrypoint !== undefined && { entrypoint: shadow.entrypoint }),
            scope: shadow.scope,
            ...(shadow.format !== undefined && { format: shadow.format }),
            ...(shadow.layout !== undefined && { layout: shadow.layout }),
          })),
          registrations: { ...EMPTY_EXTENSION_REGISTRATIONS },
          diagnostics: [],
        });
      }
    }

    extensions.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
    return {
      extensions,
      diagnostics: loadResult.diagnostics.map(normalizeExtensionDiagnostic),
      totals: projection.totals as ExtensionRegistrationSummary,
    };
  }
  // --- eforge:endregion plan-02-extension-tooling-surfaces ---

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
      if (options.config && (!options.config.agents?.tiers || Object.keys(options.config.agents.tiers).length === 0)) {
        sendJsonError(res, 422, 'No agent tiers configured. Add agents.tiers entries (each with harness + model + effort) to eforge/config.yaml');
        return;
      }
      try {
        const body = await parseJsonBody(req) as { source?: string; flags?: string[]; profile?: string };
        if (!body.source || typeof body.source !== 'string') {
          sendJsonError(res, 400, 'Missing required field: source');
          return;
        }
        // --- eforge:region plan-01-per-build-profile-override ---
        // Validate profile override before spawning any worker.
        if (body.profile && typeof body.profile === 'string') {
          const profileName = body.profile;
          const { getConfigDir, getConventionalConfigDir, loadProfile } = await import('@eforge-build/engine/config');
          const discoveredConfigDir = await getConfigDir(cwd);
          const configDir = discoveredConfigDir ?? getConventionalConfigDir(cwd);
          const profileResult = await loadProfile(configDir, profileName, cwd);
          if (!profileResult) {
            sendJsonError(res, 400, `Profile '${profileName}' not found`);
            return;
          }
        }
        // --- eforge:endregion plan-01-per-build-profile-override ---
        // --- eforge:region plan-04-daemon-cli-wiring ---
        // When source is a session-plan file (.eforge/session-plans/*.md), read
        // and normalize it to ordinary build source before spawning the enqueue
        // worker. Non-session-plan file paths and inline content pass through
        // unchanged. Session-plan parse failures are surfaced as 400 errors.
        let enqueueSource = body.source;
        if (cwd) {
          let resolvedSourcePath: string | undefined;
          let rawSourceContent: string | undefined;
          try {
            resolvedSourcePath = resolve(cwd, body.source);
            const sourceFileStat = await stat(resolvedSourcePath);
            if (sourceFileStat.isFile()) {
              rawSourceContent = await readFile(resolvedSourcePath, 'utf-8');
            }
          } catch {
            // Source is inline content or the file is not accessible — no-op.
          }
          if (resolvedSourcePath !== undefined && rawSourceContent !== undefined) {
            try {
              const { normalizeBuildSource } = await import('@eforge-build/input');
              const normalized = normalizeBuildSource({ sourcePath: resolvedSourcePath, content: rawSourceContent });
              // normalized.content differs from rawSourceContent only for session
              // plan files; regular PRD file content is returned unchanged.
              if (normalized.content !== rawSourceContent) {
                enqueueSource = normalized.content;
              }
            } catch (parseErr) {
              // Session-plan parse failure — surface as a client error.
              sendJsonError(res, 400, parseErr instanceof Error ? parseErr.message : 'Failed to parse source');
              return;
            }
          }
        }
        const args = [enqueueSource, ...(body.flags ?? [])];
        if (body.profile && typeof body.profile === 'string') {
          args.push('--profile', body.profile);
        }
        // --- eforge:endregion plan-04-daemon-cli-wiring ---
        const result = options.workerTracker.spawnWorker('enqueue', args, () => {
          emitMutation(options.daemonState, 'enqueue');
        });
        // --- eforge:region plan-02-daemon-routes ---
        // After successful spawn, if source is a session-plan file under THIS
        // project's .eforge/session-plans/ directory, mark it submitted.
        // Failures must not fail the enqueue — log and continue.
        if (cwd) {
          const sessionPlansDir = resolve(cwd, '.eforge', 'session-plans');
          const absSource = resolve(cwd, body.source);
          // Constrain to our cwd's session-plans dir so an absolute path to a
          // session-plan file in a *different* project (which would happen to
          // share a basename with one of ours) cannot trigger us to mutate
          // the wrong file.
          if (isWithinDir(absSource, sessionPlansDir) && absSource.endsWith('.md')) {
            const sessionId = basename(absSource, '.md');
            // Defense-in-depth: only operate on session ids that match the
            // canonical YYYY-MM-DD-{slug} shape. resolveSessionPlanPath will
            // reject obvious traversal attempts, but this guard rejects any
            // unexpected character set (control chars, unicode, etc.) before
            // we ever touch the filesystem.
            if (/^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(sessionId)) {
              try {
                const { loadSessionPlan, setSessionPlanStatus, writeSessionPlan } = await import('@eforge-build/input');
                const plan = await loadSessionPlan({ cwd, session: sessionId });
                const updated = setSessionPlanStatus(plan, 'submitted', { eforge_session: result.sessionId });
                await writeSessionPlan({ cwd, plan: updated });
              } catch (autoSubmitErr) {
                process.stderr.write(`[eforge] Failed to auto-submit session plan: ${autoSubmitErr instanceof Error ? autoSubmitErr.message : String(autoSubmitErr)}\n`);
              }
            }
          }
        }
        // --- eforge:endregion plan-02-daemon-routes ---
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

    // --- eforge:region plan-03-daemon-mcp-pi ---
    if (req.method === 'POST' && url === API_ROUTES.recover) {
      if (!options?.workerTracker) {
        sendJsonError(res, 503, 'Daemon mode not active');
        return;
      }
      let body: { setName?: unknown; prdId?: unknown };
      try {
        body = await parseJsonBody(req) as { setName?: unknown; prdId?: unknown };
      } catch {
        sendJsonError(res, 400, 'Invalid JSON body');
        return;
      }
      if (!body.setName || typeof body.setName !== 'string') {
        sendJsonError(res, 400, 'Missing required field: setName');
        return;
      }
      if (!body.prdId || typeof body.prdId !== 'string') {
        sendJsonError(res, 400, 'Missing required field: prdId');
        return;
      }
      if (!isValidPathSegment(body.setName) || !isValidPathSegment(body.prdId)) {
        sendJsonError(res, 400, 'Invalid setName or prdId: must not contain path separators or traversal sequences');
        return;
      }
      // NOTE: The daemon's recovery polling loop (which called broadcast('recovery:start', ...))
      // was intentionally removed in favour of inline recovery in the queue parent. The monitor
      // UI's onNamedEvent handler (packages/monitor-ui/src/hooks/use-eforge-events.ts) only
      // processes 'monitor:shutdown-pending' and 'monitor:shutdown-cancelled' named SSE events;
      // it does not consume 'recovery:start' broadcasts. No migration to phase:end is needed.
      // Recovery results are surfaced via the sidecar polling in queue-section.tsx.
      try {
        const result = options.workerTracker.spawnWorker(
          'recover',
          [body.setName, body.prdId],
        );
        sendJson(res, { sessionId: result.sessionId, pid: result.pid });
      } catch (err) {
        sendJsonError(res, 500, err instanceof Error ? err.message : 'Failed to spawn recovery worker');
      }
      return;
    }
    // --- eforge:endregion plan-03-daemon-mcp-pi ---

    // --- eforge:region plan-01-fix-recovery-ux ---
    if (req.method === 'POST' && url === API_ROUTES.applyRecovery) {
      if (!options?.daemonState) {
        sendJsonError(res, 503, 'Daemon mode not active');
        return;
      }
      const cwd = options?.cwd;
      if (!cwd) {
        sendJsonError(res, 503, 'No working directory configured');
        return;
      }
      let body: { prdId?: unknown };
      try {
        body = await parseJsonBody(req) as { prdId?: unknown };
      } catch {
        sendJsonError(res, 400, 'Invalid JSON body');
        return;
      }
      if (!body.prdId || typeof body.prdId !== 'string') {
        sendJsonError(res, 400, 'Missing required field: prdId');
        return;
      }
      if (!isValidPathSegment(body.prdId)) {
        sendJsonError(res, 400, 'Invalid prdId: must not contain path separators or traversal sequences');
        return;
      }
      const prdId = body.prdId;
      const queueDir = resolve(cwd, options?.queueDir ?? 'eforge/queue');
      const failedDir = resolve(queueDir, 'failed');
      const sidecarJsonPath = resolve(failedDir, `${prdId}.recovery.json`);

      // Read and validate the recovery sidecar
      let verdictData: ReturnType<typeof recoveryVerdictSchema.parse>;
      try {
        let sidecarRaw: string;
        try {
          sidecarRaw = await readFile(sidecarJsonPath, 'utf-8');
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            sendJsonError(res, 404, `No recovery sidecar found for ${prdId}`);
          } else {
            sendJsonError(res, 400, `Failed to read recovery sidecar for ${prdId}: ${err instanceof Error ? err.message : String(err)}`);
          }
          return;
        }

        let sidecarJson: unknown;
        try {
          sidecarJson = JSON.parse(sidecarRaw);
        } catch {
          sendJsonError(res, 400, `Malformed recovery sidecar JSON for ${prdId}`);
          return;
        }

        if (typeof sidecarJson !== 'object' || sidecarJson === null || !('verdict' in sidecarJson)) {
          sendJsonError(res, 400, `Recovery sidecar for ${prdId} is missing the verdict field`);
          return;
        }

        try {
          verdictData = parseWithSchema(recoveryVerdictSchema, (sidecarJson as Record<string, unknown>).verdict);
        } catch (err) {
          sendJsonError(res, 400, `Invalid recovery verdict in sidecar for ${prdId}: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
      } catch (err) {
        sendJsonError(res, 500, err instanceof Error ? err.message : 'Unexpected error reading sidecar');
        return;
      }

      const helperOptions = { cwd, prdId, queueDir };

      try {
        let responseBody: { verdict: string; commitSha?: string; successorPrdId?: string; noAction?: boolean };

        switch (verdictData.verdict) {
          case 'retry': {
            const result = await applyRecoveryRetry(helperOptions);
            responseBody = { verdict: 'retry', commitSha: result.commitSha, noAction: false };
            break;
          }
          case 'split': {
            const result = await applyRecoverySplit(helperOptions, verdictData);
            responseBody = { verdict: 'split', commitSha: result.commitSha, successorPrdId: result.successorPrdId, noAction: false };
            break;
          }
          case 'abandon': {
            const result = await applyRecoveryAbandon(helperOptions);
            responseBody = { verdict: 'abandon', commitSha: result.commitSha, noAction: false };
            break;
          }
          case 'manual': {
            const result = await applyRecoveryManual(helperOptions);
            responseBody = { verdict: 'manual', noAction: result.noAction };
            break;
          }
          default: {
            throw new Error(`Unknown verdict: ${(verdictData as { verdict: string }).verdict}`);
          }
        }

        emitMutation(options.daemonState, 'apply-recovery');
        sendJson(res, responseBody);
      } catch (err) {
        sendJsonError(res, 500, err instanceof Error ? err.message : 'Failed to apply recovery verdict');
      }
      return;
    }
    // --- eforge:endregion plan-01-fix-recovery-ux ---

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
      sendJson(res, autoBuildStateToWire(options.daemonState));
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
          // --- eforge:region plan-01-types-and-daemon-emission ---
          // Emit enabled or resumed based on whether this follows a failure-triggered pause.
          const wasPaused = options.daemonState.autoBuildPaused;
          options.daemonState.autoBuildPaused = false;
          if (wasPaused) {
            options.daemonState.onDaemonEvent?.({
              type: 'daemon:auto-build:resumed',
              timestamp: new Date().toISOString(),
            } as EforgeEvent);
          } else {
            options.daemonState.onDaemonEvent?.({
              type: 'daemon:auto-build:enabled',
              timestamp: new Date().toISOString(),
            } as EforgeEvent);
          }
          // --- eforge:endregion plan-01-types-and-daemon-emission ---
        } else {
          // Toggle OFF — SIGTERM the watcher. Its abort handler stops new PRD
          // discovery and startReadyPrds short-circuits on the abort signal,
          // so in-flight builds drain and the watcher exits without pulling
          // the next PRD.
          options.daemonState.onKillWatcher?.();
        }
        sendJson(res, autoBuildStateToWire(options.daemonState));
      } catch {
        sendJsonError(res, 400, 'Invalid JSON body');
      }
      return;
    }

    // --- Scheduler kick route ---
    if (req.method === 'POST' && url === API_ROUTES.schedulerKick) {
      if (!options?.daemonState) {
        sendJsonError(res, 503, 'Daemon mode not active');
        return;
      }
      emitMutation(options.daemonState, 'external');
      sendJson(res, { ok: true });
      return;
    }

    // --- Agent runtime profile management ---
    if (req.method === 'GET' && (url === API_ROUTES.profileList || url.startsWith(`${API_ROUTES.profileList}?`))) {
      try {
        const { getConfigDir, getConventionalConfigDir, listProfiles, resolveActiveProfileName, loadUserConfig } =
          await import('@eforge-build/engine/config');
        const queryString = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
        const params = new URLSearchParams(queryString);
        const scopeParam = params.get('scope') as 'local' | 'project' | 'user' | 'all' | null;
        const discoveredConfigDir = await getConfigDir(options?.cwd);
        // Listing profiles is useful during init before eforge/config.yaml exists.
        // When no config is discovered, synthesize the conventional project
        // config dir so local (.eforge/profiles) and project (eforge/profiles)
        // profiles can still be discovered from the daemon cwd.
        const configDir = discoveredConfigDir ?? getConventionalConfigDir(options?.cwd);
        let profiles = await listProfiles(configDir, options?.cwd);
        if (scopeParam === 'local' || scopeParam === 'project' || scopeParam === 'user') {
          profiles = profiles.filter((p) => p.scope === scopeParam);
        }
        const projectConfig = discoveredConfigDir ? await loadProjectPartialConfig(configDir) : {};
        const userConfig = await loadUserConfig();
        const { name, source, warnings } = await resolveActiveProfileName(
          configDir,
          projectConfig as Parameters<typeof resolveActiveProfileName>[1],
          userConfig as Parameters<typeof resolveActiveProfileName>[2],
          options?.cwd,
        );
        for (const warning of warnings) {
          process.stderr.write(`${warning}\n`);
        }
        sendJson(res, { profiles, active: name, source });
      } catch (err) {
        sendJsonError(res, 500, err instanceof Error ? err.message : 'Failed to list agent runtime profiles');
      }
      return;
    }

    if (req.method === 'GET' && url === API_ROUTES.profileShow) {
      try {
        const { getConfigDir, loadProfile, loadUserProfile, resolveActiveProfileName, resolveUserActiveProfile, loadUserConfig, extractProfileMetadata } =
          await import('@eforge-build/engine/config');
        const configDir = await getConfigDir(options?.cwd);
        if (!configDir) {
          const { name, source, warnings: resolveWarnings } = await resolveUserActiveProfile();
          for (const warning of resolveWarnings) {
            process.stderr.write(`${warning}\n`);
          }
          if (name === null) {
            sendJson(res, { active: null, source: 'none', resolved: { harness: undefined, profile: null } });
            return;
          }
          const result = await loadUserProfile(name);
          const harness = result ? extractHarnessFromProfile(result.profile) : undefined;
          const profile = result ? result.profile : null;
          const metadata = profile ? extractProfileMetadata(profile) : undefined;
          sendJson(res, { active: name, source: 'user-local', resolved: { harness, profile, scope: 'user', metadata } });
          return;
        }
        const projectConfig = await loadProjectPartialConfig(configDir);
        const userConfig = await loadUserConfig();
        const { name, source, warnings: resolveWarnings } = await resolveActiveProfileName(
          configDir,
          projectConfig as Parameters<typeof resolveActiveProfileName>[1],
          userConfig as Parameters<typeof resolveActiveProfileName>[2],
          options?.cwd,
        );
        for (const warning of resolveWarnings) {
          process.stderr.write(`${warning}\n`);
        }
        let profile: unknown = null;
        let harness: 'claude-sdk' | 'pi' | undefined;
        let profileScope: 'local' | 'project' | 'user' | undefined;
        let profileMetadata: ReturnType<typeof extractProfileMetadata>;
        if (name) {
          const result = await loadProfile(configDir, name, options?.cwd);
          if (result) {
            profile = result.profile;
            profileScope = result.scope;
            harness = extractHarnessFromProfile(result.profile);
            profileMetadata = extractProfileMetadata(result.profile);
          }
        }
        sendJson(res, { active: name, source, resolved: { harness, profile, scope: profileScope, metadata: profileMetadata } });
      } catch (err) {
        sendJsonError(res, 500, err instanceof Error ? err.message : 'Failed to show agent runtime profile');
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
        const scopeVal = body.scope === 'local' || body.scope === 'project' || body.scope === 'user' ? body.scope : undefined;
        const { getConfigDir, setActiveProfile } =
          await import('@eforge-build/engine/config');
        const configDir = await getConfigDir(options?.cwd);
        if (!configDir) {
          sendJsonError(res, 404, 'No eforge config directory found');
          return;
        }
        try {
          await setActiveProfile(configDir, body.name, scopeVal ? { scope: scopeVal } : undefined, options?.cwd);
          sendJson(res, { active: body.name });
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Failed to set active profile';
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
          agents?: unknown;
          metadata?: unknown;
          overwrite?: unknown;
          scope?: unknown;
        };
        if (!body.name || typeof body.name !== 'string') {
          sendJsonError(res, 400, 'Missing required field: name (string)');
          return;
        }
        const scopeVal = body.scope === 'local' || body.scope === 'project' || body.scope === 'user' ? body.scope : undefined;
        const { getConfigDir, createAgentRuntimeProfile } =
          await import('@eforge-build/engine/config');
        const configDir = await getConfigDir(options?.cwd);
        if (!configDir) {
          sendJsonError(res, 404, 'No eforge config directory found');
          return;
        }
        try {
          // Single shape: profile carries `agents` (with tier recipes under
          // agents.tiers) plus optional non-agent overrides. Tier recipes are
          // self-contained — there is no separate harness / agentRuntimes field.
          // Optional `metadata` (description, whenToUse, tags) is forwarded as-is;
          // the engine validates field shapes and throws ConfigValidationError on failure.
          const result = await createAgentRuntimeProfile(configDir, {
            name: body.name,
            agents: body.agents as PartialEforgeConfig['agents'],
            metadata: body.metadata as import('@eforge-build/engine/config').ProfileMetadata | undefined,
            overwrite: body.overwrite === true,
            scope: scopeVal,
          }, options?.cwd);
          sendJson(res, { path: result.path });
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Failed to create agent runtime profile';
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
        sendJsonError(res, 400, 'Invalid agent runtime profile name');
        return;
      }
      try {
        let force = false;
        let scopeVal: 'local' | 'project' | 'user' | undefined;
        try {
          const body = await parseJsonBody(req) as { force?: unknown; scope?: unknown };
          force = body.force === true;
          if (body.scope === 'local' || body.scope === 'project' || body.scope === 'user') {
            scopeVal = body.scope;
          }
        } catch {
          // empty body — force defaults to false, scope defaults to undefined
        }
        const { getConfigDir, deleteAgentRuntimeProfile } =
          await import('@eforge-build/engine/config');
        const configDir = await getConfigDir(options?.cwd);
        if (!configDir) {
          sendJsonError(res, 404, 'No eforge config directory found');
          return;
        }
        try {
          await deleteAgentRuntimeProfile(configDir, name, force, scopeVal, options?.cwd);
          sendJson(res, { deleted: name });
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Failed to delete agent runtime profile';
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
        sendJsonError(res, 500, err instanceof Error ? err.message : 'Failed to delete agent runtime profile');
      }
      return;
    }

    // --- eforge:region plan-02-extension-tooling-surfaces ---
    // --- eforge:region plan-01-extension-management-api ---
    if (req.method === 'POST' && url === API_ROUTES.extensionNew) {
      if (rejectUnsafeExtensionMutationRequest(req, res)) return;
      if (!cwd) {
        sendJsonError(res, 503, 'Working directory not configured');
        return;
      }
      let body: ExtensionNewRequest;
      try {
        const bodyRaw = await parseJsonBody(req);
        if (typeof bodyRaw !== 'object' || bodyRaw === null || Array.isArray(bodyRaw)) {
          sendJsonError(res, 400, 'Invalid JSON body');
          return;
        }
        body = bodyRaw as ExtensionNewRequest;
      } catch {
        sendJsonError(res, 400, 'Invalid JSON body');
        return;
      }
      if (!body.name || typeof body.name !== 'string') {
        sendJsonError(res, 400, 'Missing required field: name');
        return;
      }
      if (body.scope !== undefined && body.scope !== 'local' && body.scope !== 'project' && body.scope !== 'user') {
        sendJsonError(res, 400, 'Invalid extension scope. Supported scopes: local, project, user');
        return;
      }
      if (body.template !== undefined && body.template !== 'event-logger' && body.template !== 'blank') {
        sendJsonError(res, 400, 'Unknown extension template. Supported templates: event-logger, blank');
        return;
      }
      if (body.force !== undefined && typeof body.force !== 'boolean') {
        sendJsonError(res, 400, 'Invalid field: force must be boolean');
        return;
      }
      try {
        const { scaffoldNativeExtension } = await import('@eforge-build/engine/extensions/index');
        const result = await scaffoldNativeExtension({
          cwd,
          name: body.name,
          ...(body.scope !== undefined && { scope: body.scope }),
          ...(body.template !== undefined && { template: body.template }),
          force: body.force === true,
        });
        sendJson(res, result);
      } catch (err) {
        const status = err instanceof Error && err.name === 'ScaffoldNativeExtensionError'
          ? ((err as { status?: number }).status ?? 400)
          : 500;
        sendJsonError(res, status, err instanceof Error ? err.message : 'Failed to scaffold extension');
      }
      return;
    }

    if (req.method === 'POST' && url === API_ROUTES.extensionReload) {
      if (rejectUnsafeExtensionMutationRequest(req, res)) return;
      try {
        const data = await loadExtensionResponse();
        const currentWatcher = options?.daemonState?.watcher;
        const watcher = options?.daemonState?.onReloadExtensions
          ? await options.daemonState.onReloadExtensions()
          : {
            wasRunning: currentWatcher?.running ?? false,
            restarted: false,
            running: currentWatcher?.running ?? false,
            previousSessionId: currentWatcher?.sessionId ?? null,
            sessionId: currentWatcher?.sessionId ?? null,
            message: 'Extension discovery refreshed; no runtime watcher was restarted.',
          } satisfies ExtensionReloadWatcherMetadata;
        sendJson(res, { ...data, ...watcher, watcher });
      } catch (err) {
        sendJsonError(res, cwd ? 500 : 503, err instanceof Error ? err.message : 'Failed to reload extensions');
      }
      return;
    }
    // --- eforge:endregion plan-01-extension-management-api ---

    if (req.method === 'GET' && (url === API_ROUTES.extensionList || url.startsWith(`${API_ROUTES.extensionList}?`))) {
      try {
        const data = await loadExtensionResponse();
        sendJson(res, data);
      } catch (err) {
        sendJsonError(res, cwd ? 500 : 503, err instanceof Error ? err.message : 'Failed to list extensions');
      }
      return;
    }

    if (req.method === 'GET' && (url === API_ROUTES.extensionShow || url.startsWith(`${API_ROUTES.extensionShow}?`))) {
      const queryString = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
      const qParams = new URLSearchParams(queryString);
      const name = qParams.get('name');
      if (!name) {
        sendJsonError(res, 400, 'Missing required query param: name');
        return;
      }
      if (!EXTENSION_NAME_RE.test(name)) {
        sendJsonError(res, 400, 'Invalid extension name');
        return;
      }
      try {
        const data = await loadExtensionResponse();
        const extension = selectExtensionByName(data.extensions, name);
        if (!extension) {
          sendJsonError(res, 404, `Extension not found: ${name}`);
          return;
        }
        sendJson(res, { extension });
      } catch (err) {
        sendJsonError(res, cwd ? 500 : 503, err instanceof Error ? err.message : 'Failed to show extension');
      }
      return;
    }

    if (req.method === 'GET' && (url === API_ROUTES.extensionValidate || url.startsWith(`${API_ROUTES.extensionValidate}?`))) {
      const queryString = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
      const qParams = new URLSearchParams(queryString);
      const hasName = qParams.has('name');
      const hasPath = qParams.has('path');
      const name = hasName ? qParams.get('name') ?? '' : undefined;
      const rawPath = hasPath ? qParams.get('path') ?? '' : undefined;
      if (hasName && hasPath) {
        sendJsonError(res, 400, 'Specify only one of name or path');
        return;
      }
      if (hasName && (!name || !EXTENSION_NAME_RE.test(name))) {
        sendJsonError(res, 400, 'Invalid extension name');
        return;
      }
      const validatedPath = hasPath ? await validateExtensionQueryPath(rawPath ?? '') : undefined;
      if (hasPath && !validatedPath) {
        sendJsonError(res, 400, 'Invalid extension path');
        return;
      }
      try {
        const data = await loadExtensionResponse(validatedPath ? { path: validatedPath } : undefined);
        const extensions = name ? data.extensions.filter((entry) => entry.name === name) : data.extensions;
        if (name && extensions.length === 0) {
          sendJsonError(res, 404, `Extension not found: ${name}`);
          return;
        }
        const selectedKeys = name
          ? new Set(extensions.flatMap((entry) => [entry.name, entry.path]))
          : undefined;
        const diagnosticEntries = [
          ...data.diagnostics.filter((diagnostic) => !selectedKeys || selectedKeys.has(diagnostic.name ?? '') || selectedKeys.has(diagnostic.path ?? '')),
          ...extensions.flatMap((entry) => entry.diagnostics),
        ].filter((diagnostic) => diagnostic.severity === 'error');
        const diagnostics = [...new Map(
          diagnosticEntries.map((diagnostic) => [
            `${diagnostic.code}\0${diagnostic.path ?? ''}\0${diagnostic.message}`,
            diagnostic,
          ]),
        ).values()];
        sendJson(res, {
          valid: extensions.every((entry) => entry.status !== 'error') && diagnostics.length === 0,
          extensions,
          diagnostics,
        });
      } catch (err) {
        sendJsonError(res, cwd ? 500 : 503, err instanceof Error ? err.message : 'Failed to validate extensions');
      }
      return;
    }
    // --- eforge:endregion plan-02-extension-tooling-surfaces ---

    // --- eforge:region plan-02-daemon-http-and-mcp-tool ---
    // Playbook names must be kebab-case (mirrors `playbookFrontmatterSchema.name`).
    // The route `name` parameter is interpolated into a filesystem path by
    // `loadSetArtifact`/`movePlaybook`, so anything outside this character class
    // would permit path traversal (e.g. `name=../../etc/passwd`). Validate at the
    // edge before passing to the engine.
    const PLAYBOOK_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
    if (req.method === 'GET' && (url === API_ROUTES.playbookList || url.startsWith(`${API_ROUTES.playbookList}?`))) {
      if (!cwd) {
        sendJsonError(res, 503, 'Working directory not configured');
        return;
      }
      try {
        const { getConfigDir } = await import('@eforge-build/engine/config');
        const { listPlaybooks } = await import('@eforge-build/input');
        const configDir = await getConfigDir(cwd);
        const result = await listPlaybooks({ configDir: configDir ?? cwd, cwd });
        for (const warning of result.warnings) {
          process.stderr.write(`${warning}\n`);
        }
        sendJson(res, result);
      } catch (err) {
        sendJsonError(res, 500, err instanceof Error ? err.message : 'Failed to list playbooks');
      }
      return;
    }

    if (req.method === 'GET' && (url === API_ROUTES.playbookShow || url.startsWith(`${API_ROUTES.playbookShow}?`))) {
      if (!cwd) {
        sendJsonError(res, 503, 'Working directory not configured');
        return;
      }
      const queryString = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
      const qParams = new URLSearchParams(queryString);
      const name = qParams.get('name');
      if (!name) {
        sendJsonError(res, 400, 'Missing required query param: name');
        return;
      }
      if (!PLAYBOOK_NAME_RE.test(name)) {
        sendJsonError(res, 400, 'Invalid playbook name (must be kebab-case)');
        return;
      }
      try {
        const { getConfigDir } = await import('@eforge-build/engine/config');
        const { loadPlaybook } = await import('@eforge-build/input');
        const configDir = await getConfigDir(cwd);
        if (!configDir) {
          sendJsonError(res, 404, 'No eforge config directory found');
          return;
        }
        const result = await loadPlaybook({ configDir, cwd, name });
        sendJson(res, result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to load playbook';
        if (/not found/i.test(msg)) {
          sendJsonError(res, 404, msg);
        } else {
          sendJsonError(res, 500, msg);
        }
      }
      return;
    }

    if (req.method === 'POST' && url === API_ROUTES.playbookSave) {
      if (!cwd) {
        sendJsonError(res, 503, 'Working directory not configured');
        return;
      }
      let body: { scope?: unknown; playbook?: { frontmatter?: unknown; body?: unknown } };
      try {
        body = await parseJsonBody(req) as typeof body;
      } catch {
        sendJsonError(res, 400, 'Invalid JSON body');
        return;
      }
      if (body.scope !== 'user' && body.scope !== 'project-team' && body.scope !== 'project-local') {
        sendJsonError(res, 400, 'Missing or invalid field: scope (must be "user", "project-team", or "project-local")');
        return;
      }
      if (!body.playbook || typeof body.playbook !== 'object') {
        sendJsonError(res, 400, 'Missing required field: playbook');
        return;
      }
      try {
        const { getConfigDir } = await import('@eforge-build/engine/config');
        const { writePlaybook, playbookFrontmatterSchema } = await import('@eforge-build/input');
        const fm = body.playbook.frontmatter;
        const bd = body.playbook.body;
        // Validate frontmatter
        const fmResult = playbookFrontmatterSchema.safeParse(fm);
        if (!fmResult.success) {
          const errors = fmResult.error.issues.map((i) => {
            const path = i.path.length > 0 ? i.path.join('.') + ': ' : '';
            return path + i.message;
          });
          res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ error: 'Playbook validation failed', errors }));
          return;
        }
        // Validate body
        if (!bd || typeof (bd as Record<string, unknown>).goal !== 'string' || !(bd as Record<string, unknown>).goal) {
          res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ error: 'Playbook validation failed', errors: ['Missing required section: ## Goal'] }));
          return;
        }
        const bdTyped = bd as { goal?: string; outOfScope?: string; acceptanceCriteria?: string; plannerNotes?: string };
        const playbook = {
          ...fmResult.data,
          goal: bdTyped.goal ?? '',
          outOfScope: bdTyped.outOfScope ?? '',
          acceptanceCriteria: bdTyped.acceptanceCriteria ?? '',
          plannerNotes: bdTyped.plannerNotes ?? '',
        };
        const configDir = await getConfigDir(cwd);
        const result = await writePlaybook({ configDir: configDir ?? cwd, cwd, scope: body.scope, playbook });
        sendJson(res, { path: result.path });
      } catch (err) {
        sendJsonError(res, 500, err instanceof Error ? err.message : 'Failed to save playbook');
      }
      return;
    }

    if (req.method === 'POST' && url === API_ROUTES.playbookEnqueue) {
      if (!cwd) {
        sendJsonError(res, 503, 'Working directory not configured');
        return;
      }
      let body: { name?: unknown; afterQueueId?: unknown };
      try {
        body = await parseJsonBody(req) as typeof body;
      } catch {
        sendJsonError(res, 400, 'Invalid JSON body');
        return;
      }
      if (!body.name || typeof body.name !== 'string') {
        sendJsonError(res, 400, 'Missing required field: name (string)');
        return;
      }
      if (!PLAYBOOK_NAME_RE.test(body.name)) {
        sendJsonError(res, 400, 'Invalid playbook name (must be kebab-case)');
        return;
      }
      const afterQueueId = typeof body.afterQueueId === 'string' ? body.afterQueueId : undefined;
      try {
        const { getConfigDir } = await import('@eforge-build/engine/config');
        const { loadPlaybook, playbookToSessionPlan } = await import('@eforge-build/input');
        // --- eforge:region plan-05-piggyback-and-queue-scheduling ---
        const { enqueuePrd, inferTitle, validateDependsOnExists, commitEnqueuedPrd } = await import('@eforge-build/engine/prd-queue');
        // --- eforge:endregion plan-05-piggyback-and-queue-scheduling ---
        const configDir = await getConfigDir(cwd);
        if (!configDir) {
          sendJsonError(res, 404, 'No eforge config directory found');
          return;
        }
        const { playbook } = await loadPlaybook({ configDir, cwd, name: body.name });
        const plan = playbookToSessionPlan(playbook);
        const queueDir = options?.queueDir ?? 'eforge/queue';
        const title = inferTitle(plan.source, plan.name);

        // --- eforge:region plan-05-piggyback-and-queue-scheduling ---
        // Validate upstream exists before enqueueing; reject with 404 if not found.
        if (afterQueueId) {
          try {
            await validateDependsOnExists([afterQueueId], queueDir, cwd);
          } catch (validationErr) {
            const msg = validationErr instanceof Error ? validationErr.message : 'Invalid afterQueueId';
            sendJsonError(res, 404, msg);
            return;
          }
        }
        // --- eforge:endregion plan-05-piggyback-and-queue-scheduling ---

        const result = await enqueuePrd({
          body: plan.source,
          title,
          queueDir,
          cwd,
          depends_on: afterQueueId ? [afterQueueId] : undefined,
          // --- eforge:region plan-05-piggyback-and-queue-scheduling ---
          intoWaiting: afterQueueId ? true : false,
          // --- eforge:endregion plan-05-piggyback-and-queue-scheduling ---
          postMerge: plan.postMerge,
        });
        await commitEnqueuedPrd(result.filePath, result.id, title, cwd);
        emitMutation(options.daemonState, 'playbook-enqueue');
        sendJson(res, { id: result.id });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to enqueue playbook';
        if (/not found/i.test(msg)) {
          sendJsonError(res, 404, msg);
        } else {
          sendJsonError(res, 500, msg);
        }
      }
      return;
    }

    if (req.method === 'POST' && url === API_ROUTES.playbookPromote) {
      if (!cwd) {
        sendJsonError(res, 503, 'Working directory not configured');
        return;
      }
      let body: { name?: unknown };
      try {
        body = await parseJsonBody(req) as typeof body;
      } catch {
        sendJsonError(res, 400, 'Invalid JSON body');
        return;
      }
      if (!body.name || typeof body.name !== 'string') {
        sendJsonError(res, 400, 'Missing required field: name (string)');
        return;
      }
      if (!PLAYBOOK_NAME_RE.test(body.name)) {
        sendJsonError(res, 400, 'Invalid playbook name (must be kebab-case)');
        return;
      }
      try {
        const { getConfigDir } = await import('@eforge-build/engine/config');
        const { movePlaybook } = await import('@eforge-build/input');
        const configDir = await getConfigDir(cwd);
        if (!configDir) {
          sendJsonError(res, 404, 'No eforge config directory found');
          return;
        }
        const result = await movePlaybook({ configDir, cwd, name: body.name, fromScope: 'project-local', toScope: 'project-team' });
        sendJson(res, { path: result.path });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to promote playbook';
        if (/not found/i.test(msg) || /enoent/i.test(msg)) {
          sendJsonError(res, 404, msg);
        } else {
          sendJsonError(res, 500, msg);
        }
      }
      return;
    }

    if (req.method === 'POST' && url === API_ROUTES.playbookDemote) {
      if (!cwd) {
        sendJsonError(res, 503, 'Working directory not configured');
        return;
      }
      let body: { name?: unknown };
      try {
        body = await parseJsonBody(req) as typeof body;
      } catch {
        sendJsonError(res, 400, 'Invalid JSON body');
        return;
      }
      if (!body.name || typeof body.name !== 'string') {
        sendJsonError(res, 400, 'Missing required field: name (string)');
        return;
      }
      if (!PLAYBOOK_NAME_RE.test(body.name)) {
        sendJsonError(res, 400, 'Invalid playbook name (must be kebab-case)');
        return;
      }
      try {
        const { getConfigDir } = await import('@eforge-build/engine/config');
        const { movePlaybook } = await import('@eforge-build/input');
        const configDir = await getConfigDir(cwd);
        if (!configDir) {
          sendJsonError(res, 404, 'No eforge config directory found');
          return;
        }
        const result = await movePlaybook({ configDir, cwd, name: body.name, fromScope: 'project-team', toScope: 'project-local' });
        sendJson(res, { path: result.path });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to demote playbook';
        if (/not found/i.test(msg) || /enoent/i.test(msg)) {
          sendJsonError(res, 404, msg);
        } else {
          sendJsonError(res, 500, msg);
        }
      }
      return;
    }

    if (req.method === 'POST' && url === API_ROUTES.playbookValidate) {
      let body: { raw?: unknown };
      try {
        body = await parseJsonBody(req) as typeof body;
      } catch {
        sendJsonError(res, 400, 'Invalid JSON body');
        return;
      }
      if (!body.raw || typeof body.raw !== 'string') {
        sendJsonError(res, 400, 'Missing required field: raw (string)');
        return;
      }
      try {
        const { validatePlaybook } = await import('@eforge-build/input');
        const result = validatePlaybook(body.raw);
        if (result.ok) {
          sendJson(res, { ok: true });
        } else {
          sendJson(res, { ok: false, errors: result.errors });
        }
      } catch (err) {
        sendJsonError(res, 500, err instanceof Error ? err.message : 'Failed to validate playbook');
      }
      return;
    }

    if (req.method === 'POST' && url === API_ROUTES.playbookCopy) {
      if (!cwd) {
        sendJsonError(res, 503, 'Working directory not configured');
        return;
      }
      let body: { name?: unknown; targetScope?: unknown };
      try {
        body = await parseJsonBody(req) as typeof body;
      } catch {
        sendJsonError(res, 400, 'Invalid JSON body');
        return;
      }
      if (!body.name || typeof body.name !== 'string') {
        sendJsonError(res, 400, 'Missing required field: name (string)');
        return;
      }
      if (!PLAYBOOK_NAME_RE.test(body.name)) {
        sendJsonError(res, 400, 'Invalid playbook name (must be kebab-case)');
        return;
      }
      const validScopes = ['project-local', 'project-team', 'user'] as const;
      if (!body.targetScope || !validScopes.includes(body.targetScope as typeof validScopes[number])) {
        sendJsonError(res, 400, 'Missing or invalid field: targetScope (must be "project-local", "project-team", or "user")');
        return;
      }
      try {
        const { getConfigDir } = await import('@eforge-build/engine/config');
        const { copyPlaybookToScope } = await import('@eforge-build/input');
        const configDir = await getConfigDir(cwd);
        if (!configDir) {
          sendJsonError(res, 404, 'No eforge config directory found');
          return;
        }
        const result = await copyPlaybookToScope({
          configDir,
          cwd,
          name: body.name,
          targetScope: body.targetScope as 'project-local' | 'project-team' | 'user',
        });
        sendJson(res, { sourcePath: result.sourcePath, targetPath: result.targetPath, targetScope: result.targetScope });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to copy playbook';
        if (/not found/i.test(msg)) {
          sendJsonError(res, 404, msg);
        } else {
          sendJsonError(res, 500, msg);
        }
      }
      return;
    }
    // --- eforge:endregion plan-02-daemon-http-and-mcp-tool ---

    // --- eforge:region plan-02-daemon-routes ---
    // Session plan ids follow the YYYY-MM-DD-{slug} shape. Validate to prevent
    // path traversal attempts via the `session` parameter.
    const SESSION_PLAN_ID_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/;

    if (req.method === 'GET' && (url === API_ROUTES.sessionPlanList || url.startsWith(`${API_ROUTES.sessionPlanList}?`))) {
      if (!cwd) {
        sendJsonError(res, 503, 'Working directory not configured');
        return;
      }
      try {
        const { listActiveSessionPlans, loadSessionPlan, getReadinessDetail } = await import('@eforge-build/input');
        const entries = await listActiveSessionPlans({ cwd });
        const plans = await Promise.all(
          entries.map(async (entry) => {
            try {
              const plan = await loadSessionPlan({ cwd, session: entry.session });
              const readiness = getReadinessDetail(plan);
              return {
                session: entry.session,
                topic: entry.topic,
                status: entry.status,
                path: entry.path,
                ready: readiness.ready,
                missingDimensions: readiness.missingDimensions,
              };
            } catch {
              return {
                session: entry.session,
                topic: entry.topic,
                status: entry.status,
                path: entry.path,
                ready: false,
                missingDimensions: [],
              };
            }
          }),
        );
        sendJson(res, { plans });
      } catch (err) {
        sendJsonError(res, 500, err instanceof Error ? err.message : 'Failed to list session plans');
      }
      return;
    }

    if (req.method === 'GET' && (url === API_ROUTES.sessionPlanShow || url.startsWith(`${API_ROUTES.sessionPlanShow}?`))) {
      if (!cwd) {
        sendJsonError(res, 503, 'Working directory not configured');
        return;
      }
      const queryString = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
      const qParams = new URLSearchParams(queryString);
      const session = qParams.get('session');
      if (!session) {
        sendJsonError(res, 400, 'Missing required query param: session');
        return;
      }
      if (!SESSION_PLAN_ID_RE.test(session)) {
        sendJsonError(res, 400, 'Invalid session id (must match YYYY-MM-DD-slug)');
        return;
      }
      try {
        const { loadSessionPlan, getReadinessDetail, resolveSessionPlanPath } = await import('@eforge-build/input');
        const plan = await loadSessionPlan({ cwd, session });
        const readiness = getReadinessDetail(plan);
        const path = resolveSessionPlanPath({ cwd, session });
        const { body, sections: _sections, ...frontmatter } = plan as typeof plan & { sections: unknown };
        sendJson(res, { plan: { ...frontmatter, body }, readiness, path });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to load session plan';
        if (/not found/i.test(msg) || /enoent/i.test(msg)) {
          sendJsonError(res, 404, msg);
        } else {
          sendJsonError(res, 400, msg);
        }
      }
      return;
    }

    if (req.method === 'POST' && url === API_ROUTES.sessionPlanCreate) {
      if (!cwd) {
        sendJsonError(res, 503, 'Working directory not configured');
        return;
      }
      let body: { session?: unknown; topic?: unknown; planning_type?: unknown; planning_depth?: unknown; profile?: unknown };
      try {
        body = await parseJsonBody(req) as typeof body;
      } catch {
        sendJsonError(res, 400, 'Invalid JSON body');
        return;
      }
      if (!body.session || typeof body.session !== 'string') {
        sendJsonError(res, 400, 'Missing required field: session (string)');
        return;
      }
      if (!SESSION_PLAN_ID_RE.test(body.session)) {
        sendJsonError(res, 400, 'Invalid session id (must match YYYY-MM-DD-slug)');
        return;
      }
      if (!body.topic || typeof body.topic !== 'string') {
        sendJsonError(res, 400, 'Missing required field: topic (string)');
        return;
      }
      // Validate enum fields up-front: createSessionPlan does not validate
      // them, so an invalid value would otherwise be persisted to disk in a
      // file that subsequently fails to parse via parseSessionPlan.
      const VALID_PLANNING_TYPES = ['bugfix', 'feature', 'refactor', 'architecture', 'docs', 'maintenance', 'unknown'] as const;
      const VALID_PLANNING_DEPTHS = ['quick', 'focused', 'deep'] as const;
      const VALID_PROFILES = ['errand', 'excursion', 'expedition'] as const;
      if (body.planning_type !== undefined && (typeof body.planning_type !== 'string' || !VALID_PLANNING_TYPES.includes(body.planning_type as typeof VALID_PLANNING_TYPES[number]))) {
        sendJsonError(res, 400, `Invalid planning_type (must be one of: ${VALID_PLANNING_TYPES.join(', ')})`);
        return;
      }
      if (body.planning_depth !== undefined && (typeof body.planning_depth !== 'string' || !VALID_PLANNING_DEPTHS.includes(body.planning_depth as typeof VALID_PLANNING_DEPTHS[number]))) {
        sendJsonError(res, 400, `Invalid planning_depth (must be one of: ${VALID_PLANNING_DEPTHS.join(', ')})`);
        return;
      }
      if (body.profile !== undefined && body.profile !== null && (typeof body.profile !== 'string' || !VALID_PROFILES.includes(body.profile as typeof VALID_PROFILES[number]))) {
        sendJsonError(res, 400, `Invalid profile (must be null or one of: ${VALID_PROFILES.join(', ')})`);
        return;
      }
      try {
        const { createSessionPlan, writeSessionPlan, resolveSessionPlanPath } = await import('@eforge-build/input');
        const plan = createSessionPlan({
          session: body.session,
          topic: body.topic,
          planningType: body.planning_type as typeof VALID_PLANNING_TYPES[number] | undefined,
          planningDepth: body.planning_depth as typeof VALID_PLANNING_DEPTHS[number] | undefined,
          profile: body.profile as typeof VALID_PROFILES[number] | null | undefined,
        });
        await writeSessionPlan({ cwd, plan });
        const path = resolveSessionPlanPath({ cwd, session: body.session });
        sendJson(res, { session: body.session, path });
      } catch (err) {
        sendJsonError(res, 500, err instanceof Error ? err.message : 'Failed to create session plan');
      }
      return;
    }

    if (req.method === 'POST' && url === API_ROUTES.sessionPlanSetSection) {
      if (!cwd) {
        sendJsonError(res, 503, 'Working directory not configured');
        return;
      }
      let body: { session?: unknown; dimension?: unknown; content?: unknown };
      try {
        body = await parseJsonBody(req) as typeof body;
      } catch {
        sendJsonError(res, 400, 'Invalid JSON body');
        return;
      }
      if (!body.session || typeof body.session !== 'string') {
        sendJsonError(res, 400, 'Missing required field: session (string)');
        return;
      }
      if (!SESSION_PLAN_ID_RE.test(body.session)) {
        sendJsonError(res, 400, 'Invalid session id (must match YYYY-MM-DD-slug)');
        return;
      }
      if (!body.dimension || typeof body.dimension !== 'string') {
        sendJsonError(res, 400, 'Missing required field: dimension (string)');
        return;
      }
      if (typeof body.content !== 'string') {
        sendJsonError(res, 400, 'Missing required field: content (string)');
        return;
      }
      try {
        const { loadSessionPlan, setSessionPlanSection, writeSessionPlan, getReadinessDetail } = await import('@eforge-build/input');
        const plan = await loadSessionPlan({ cwd, session: body.session });
        const updated = setSessionPlanSection(plan, body.dimension, body.content);
        await writeSessionPlan({ cwd, plan: updated });
        const readiness = getReadinessDetail(updated);
        sendJson(res, { session: body.session, readiness });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to set session plan section';
        if (/not found/i.test(msg) || /enoent/i.test(msg)) {
          sendJsonError(res, 404, msg);
        } else if (/invalid/i.test(msg)) {
          sendJsonError(res, 400, msg);
        } else {
          sendJsonError(res, 500, msg);
        }
      }
      return;
    }

    if (req.method === 'POST' && url === API_ROUTES.sessionPlanSkipDimension) {
      if (!cwd) {
        sendJsonError(res, 503, 'Working directory not configured');
        return;
      }
      let body: { session?: unknown; dimension?: unknown; reason?: unknown };
      try {
        body = await parseJsonBody(req) as typeof body;
      } catch {
        sendJsonError(res, 400, 'Invalid JSON body');
        return;
      }
      if (!body.session || typeof body.session !== 'string') {
        sendJsonError(res, 400, 'Missing required field: session (string)');
        return;
      }
      if (!SESSION_PLAN_ID_RE.test(body.session)) {
        sendJsonError(res, 400, 'Invalid session id (must match YYYY-MM-DD-slug)');
        return;
      }
      if (!body.dimension || typeof body.dimension !== 'string') {
        sendJsonError(res, 400, 'Missing required field: dimension (string)');
        return;
      }
      if (!body.reason || typeof body.reason !== 'string') {
        sendJsonError(res, 400, 'Missing required field: reason (string)');
        return;
      }
      try {
        const { loadSessionPlan, skipDimension, writeSessionPlan, getReadinessDetail } = await import('@eforge-build/input');
        const plan = await loadSessionPlan({ cwd, session: body.session });
        const updated = skipDimension(plan, body.dimension, body.reason);
        await writeSessionPlan({ cwd, plan: updated });
        const readiness = getReadinessDetail(updated);
        sendJson(res, { session: body.session, readiness });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to skip session plan dimension';
        if (/not found/i.test(msg) || /enoent/i.test(msg)) {
          sendJsonError(res, 404, msg);
        } else {
          sendJsonError(res, 500, msg);
        }
      }
      return;
    }

    if (req.method === 'POST' && url === API_ROUTES.sessionPlanSetStatus) {
      if (!cwd) {
        sendJsonError(res, 503, 'Working directory not configured');
        return;
      }
      let body: { session?: unknown; status?: unknown; eforge_session?: unknown };
      try {
        body = await parseJsonBody(req) as typeof body;
      } catch {
        sendJsonError(res, 400, 'Invalid JSON body');
        return;
      }
      if (!body.session || typeof body.session !== 'string') {
        sendJsonError(res, 400, 'Missing required field: session (string)');
        return;
      }
      if (!SESSION_PLAN_ID_RE.test(body.session)) {
        sendJsonError(res, 400, 'Invalid session id (must match YYYY-MM-DD-slug)');
        return;
      }
      if (!body.status || typeof body.status !== 'string') {
        sendJsonError(res, 400, 'Missing required field: status (string)');
        return;
      }
      const validStatuses = ['planning', 'ready', 'abandoned', 'submitted'] as const;
      if (!validStatuses.includes(body.status as typeof validStatuses[number])) {
        sendJsonError(res, 400, 'Invalid status (must be "planning", "ready", "abandoned", or "submitted")');
        return;
      }
      if (body.status === 'submitted' && (!body.eforge_session || typeof body.eforge_session !== 'string')) {
        sendJsonError(res, 400, 'eforge_session is required when status is "submitted"');
        return;
      }
      try {
        const { loadSessionPlan, setSessionPlanStatus, writeSessionPlan } = await import('@eforge-build/input');
        const plan = await loadSessionPlan({ cwd, session: body.session });
        const updated = setSessionPlanStatus(
          plan,
          body.status as 'planning' | 'ready' | 'abandoned' | 'submitted',
          body.eforge_session ? { eforge_session: body.eforge_session as string } : undefined,
        );
        await writeSessionPlan({ cwd, plan: updated });
        sendJson(res, { session: body.session });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to set session plan status';
        if (/not found/i.test(msg) || /enoent/i.test(msg)) {
          sendJsonError(res, 404, msg);
        } else if (/required/i.test(msg)) {
          sendJsonError(res, 400, msg);
        } else {
          sendJsonError(res, 500, msg);
        }
      }
      return;
    }

    if (req.method === 'POST' && url === API_ROUTES.sessionPlanSelectDimensions) {
      if (!cwd) {
        sendJsonError(res, 503, 'Working directory not configured');
        return;
      }
      let body: { session?: unknown; planning_type?: unknown; planning_depth?: unknown; overwrite?: unknown };
      try {
        body = await parseJsonBody(req) as typeof body;
      } catch {
        sendJsonError(res, 400, 'Invalid JSON body');
        return;
      }
      if (!body.session || typeof body.session !== 'string') {
        sendJsonError(res, 400, 'Missing required field: session (string)');
        return;
      }
      if (!SESSION_PLAN_ID_RE.test(body.session)) {
        sendJsonError(res, 400, 'Invalid session id (must match YYYY-MM-DD-slug)');
        return;
      }
      // Validate enum fields up-front to keep invalid values out of disk.
      const SD_VALID_PLANNING_TYPES = ['bugfix', 'feature', 'refactor', 'architecture', 'docs', 'maintenance', 'unknown'] as const;
      const SD_VALID_PLANNING_DEPTHS = ['quick', 'focused', 'deep'] as const;
      if (body.planning_type !== undefined && (typeof body.planning_type !== 'string' || !SD_VALID_PLANNING_TYPES.includes(body.planning_type as typeof SD_VALID_PLANNING_TYPES[number]))) {
        sendJsonError(res, 400, `Invalid planning_type (must be one of: ${SD_VALID_PLANNING_TYPES.join(', ')})`);
        return;
      }
      if (body.planning_depth !== undefined && (typeof body.planning_depth !== 'string' || !SD_VALID_PLANNING_DEPTHS.includes(body.planning_depth as typeof SD_VALID_PLANNING_DEPTHS[number]))) {
        sendJsonError(res, 400, `Invalid planning_depth (must be one of: ${SD_VALID_PLANNING_DEPTHS.join(', ')})`);
        return;
      }
      try {
        const { loadSessionPlan, setSessionPlanDimensions, writeSessionPlan, getReadinessDetail } = await import('@eforge-build/input');
        const plan = await loadSessionPlan({ cwd, session: body.session });
        const updated = setSessionPlanDimensions(plan, {
          planningType: body.planning_type as typeof SD_VALID_PLANNING_TYPES[number] | undefined,
          planningDepth: body.planning_depth as typeof SD_VALID_PLANNING_DEPTHS[number] | undefined,
          overwrite: typeof body.overwrite === 'boolean' ? body.overwrite : undefined,
        });
        await writeSessionPlan({ cwd, plan: updated });
        const readiness = getReadinessDetail(updated);
        sendJson(res, {
          session: body.session,
          required_dimensions: updated.required_dimensions,
          optional_dimensions: updated.optional_dimensions,
          readiness,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to select session plan dimensions';
        if (/not found/i.test(msg) || /enoent/i.test(msg)) {
          sendJsonError(res, 404, msg);
        } else {
          sendJsonError(res, 500, msg);
        }
      }
      return;
    }

    if (req.method === 'GET' && (url === API_ROUTES.sessionPlanReadiness || url.startsWith(`${API_ROUTES.sessionPlanReadiness}?`))) {
      if (!cwd) {
        sendJsonError(res, 503, 'Working directory not configured');
        return;
      }
      const queryString = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
      const qParams = new URLSearchParams(queryString);
      const session = qParams.get('session');
      if (!session) {
        sendJsonError(res, 400, 'Missing required query param: session');
        return;
      }
      if (!SESSION_PLAN_ID_RE.test(session)) {
        sendJsonError(res, 400, 'Invalid session id (must match YYYY-MM-DD-slug)');
        return;
      }
      try {
        const { loadSessionPlan, getReadinessDetail } = await import('@eforge-build/input');
        const plan = await loadSessionPlan({ cwd, session });
        const readiness = getReadinessDetail(plan);
        sendJson(res, readiness);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to get session plan readiness';
        if (/not found/i.test(msg) || /enoent/i.test(msg)) {
          sendJsonError(res, 404, msg);
        } else {
          sendJsonError(res, 400, msg);
        }
      }
      return;
    }

    if (req.method === 'POST' && url === API_ROUTES.sessionPlanMigrateLegacy) {
      if (!cwd) {
        sendJsonError(res, 503, 'Working directory not configured');
        return;
      }
      let body: { session?: unknown };
      try {
        body = await parseJsonBody(req) as typeof body;
      } catch {
        sendJsonError(res, 400, 'Invalid JSON body');
        return;
      }
      if (!body.session || typeof body.session !== 'string') {
        sendJsonError(res, 400, 'Missing required field: session (string)');
        return;
      }
      if (!SESSION_PLAN_ID_RE.test(body.session)) {
        sendJsonError(res, 400, 'Invalid session id (must match YYYY-MM-DD-slug)');
        return;
      }
      try {
        const { loadSessionPlan, migrateBooleanDimensions, writeSessionPlan } = await import('@eforge-build/input');
        const plan = await loadSessionPlan({ cwd, session: body.session });
        const migrated = migrateBooleanDimensions(plan);
        const wasMigrated = migrated !== plan;
        if (wasMigrated) {
          await writeSessionPlan({ cwd, plan: migrated });
        }
        sendJson(res, { session: body.session, migrated: wasMigrated });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to migrate session plan';
        if (/not found/i.test(msg) || /enoent/i.test(msg)) {
          sendJsonError(res, 404, msg);
        } else {
          sendJsonError(res, 500, msg);
        }
      }
      return;
    }
    // --- eforge:endregion plan-02-daemon-routes ---

    if (req.method === 'GET' && url.startsWith(API_ROUTES.modelProviders)) {
      const queryString = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
      const params = new URLSearchParams(queryString);
      const harness = params.get('harness');
      if (harness !== 'pi' && harness !== 'claude-sdk') {
        sendJsonError(res, 400, 'Missing or invalid query param: harness (must be "pi" or "claude-sdk")');
        return;
      }
      try {
        const { listProviders } = await import('@eforge-build/engine/models');
        const providers = await listProviders(harness);
        sendJson(res, { providers });
      } catch (err) {
        sendJsonError(res, 500, err instanceof Error ? err.message : 'Failed to list providers');
      }
      return;
    }

    if (req.method === 'GET' && url.startsWith(API_ROUTES.modelList)) {
      const queryString = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
      const params = new URLSearchParams(queryString);
      const harness = params.get('harness');
      const provider = params.get('provider') ?? undefined;
      if (harness !== 'pi' && harness !== 'claude-sdk') {
        sendJsonError(res, 400, 'Missing or invalid query param: harness (must be "pi" or "claude-sdk")');
        return;
      }
      try {
        const { listModels } = await import('@eforge-build/engine/models');
        const models = await listModels(harness, provider);
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
      sendJson(res, { version: DAEMON_API_VERSION, eforgeVersion: EFORGE_VERSION });
    } else if (url === API_ROUTES.configShow || (req.method === 'GET' && url.startsWith(`${API_ROUTES.configShow}?`))) {
      try {
        const queryString = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
        const qParams = new URLSearchParams(queryString);
        const verboseVal = qParams.get('verbose');
        const verbose = verboseVal === '1' || verboseVal === 'true';
        const { loadConfig, findConfigFile, getUserConfigPath } = await import('@eforge-build/engine/config');
        const { config: resolved, warnings } = await loadConfig(options?.cwd);
        for (const warning of warnings) { process.stderr.write(`${warning}\n`); }
        if (verbose) {
          const { access: fsAccess } = await import('node:fs/promises');
          const { resolve: pathResolve, dirname: pathDirname } = await import('node:path');
          // Mirror loadConfig's startDir fallback so the verbose contract is honored
          // whether or not the daemon was started with options.cwd set.
          const effectiveCwd = options?.cwd ?? process.cwd();
          const configPath = await findConfigFile(effectiveCwd);
          // Anchor `.eforge/` to the resolved project root (parent of the eforge/
          // dir that holds config.yaml) so subdirectory invocations report the
          // same path that loadConfig actually reads from. Falls back to the
          // request cwd when no project config exists.
          const projectRoot = configPath ? pathDirname(pathDirname(configPath)) : effectiveCwd;
          const localPath = pathResolve(projectRoot, '.eforge', 'config.yaml');
          const projectPath = configPath ?? null;
          const userPath = getUserConfigPath();
          const [localExists, projectExists, userExists] = await Promise.all([
            fsAccess(localPath).then(() => true).catch(() => false),
            projectPath ? fsAccess(projectPath).then(() => true).catch(() => false) : Promise.resolve(false),
            fsAccess(userPath).then(() => true).catch(() => false),
          ]);
          sendJson(res, {
            resolved,
            sources: {
              local: { path: localPath, found: localExists },
              project: { path: projectPath, found: projectExists },
              user: { path: userPath, found: userExists },
            },
          });
        } else {
          sendJson(res, resolved);
        }
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
    // --- eforge:region plan-03-daemon-mcp-pi ---
    } else if (req.method === 'GET' && url.startsWith(RECOVERY_SIDECAR_BASE)) {
      if (!cwd) {
        sendJsonError(res, 503, 'Working directory not configured');
        return;
      }
      const prdQueueDir = options?.config?.prdQueue?.dir ?? 'eforge/queue';
      const failedPrdDir = resolve(cwd, prdQueueDir, 'failed');
      const queryString = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
      const params = new URLSearchParams(queryString);
      const prdId = params.get('prdId');
      if (!prdId) {
        sendJsonError(res, 400, 'Missing required query param: prdId');
        return;
      }
      if (!isValidPathSegment(prdId)) {
        sendJsonError(res, 400, 'Invalid prdId: must not contain path separators or traversal sequences');
        return;
      }
      const mdPath = resolve(failedPrdDir, `${prdId}.recovery.md`);
      const jsonPath = resolve(failedPrdDir, `${prdId}.recovery.json`);
      if (!isWithinDir(mdPath, failedPrdDir) || !isWithinDir(jsonPath, failedPrdDir)) {
        sendJsonError(res, 400, 'Invalid prdId: resolved path escapes failed PRD directory');
        return;
      }
      let mdContent: string;
      let jsonContent: string;
      try {
        [mdContent, jsonContent] = await Promise.all([
          readFile(mdPath, 'utf-8'),
          readFile(jsonPath, 'utf-8'),
        ]);
      } catch {
        sendJsonError(res, 404, 'Recovery sidecar not found');
        return;
      }
      try {
        sendJson(res, { markdown: mdContent, json: JSON.parse(jsonContent) });
      } catch (err) {
        sendJsonError(res, 500, `Recovery sidecar JSON is malformed: ${err instanceof Error ? err.message : String(err)} (file: ${jsonPath})`);
      }
    // --- eforge:endregion plan-03-daemon-mcp-pi ---
    } else if (url === API_ROUTES.queue) {
      await serveQueue(req, res);
    } else if (url === API_ROUTES.sessionMetadata) {
      const metadata = db.getSessionMetadataBatch();
      sendJson(res, metadata);
    } else if (url === API_ROUTES.runs) {
      serveRuns(req, res);
    } else if (url === API_ROUTES.daemonEvents) {
      serveDaemonEventsSSE(req, res);
    } else if (url.startsWith(`${EVENTS_BASE}/`)) {
      const runId = url.slice(`${EVENTS_BASE}/`.length);
      if (!runId || !/^[\w-]+$/.test(runId)) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Invalid runId');
        return;
      }
      serveSSE(req, res, runId);
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
      const hydratedEvents = events.flatMap((evt) => {
        const parsed = parseEventRow(evt.data, evt.timestamp, evt.type, evt.id);
        if (!parsed) return [];
        return [{ ...evt, data: JSON.stringify(parsed) }];
      });
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
      return subscribers.size + daemonSubscribers.size;
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
      // --- eforge:region plan-01-types-and-daemon-emission ---
      clearInterval(heartbeatTimer);
      // --- eforge:endregion plan-01-types-and-daemon-emission ---
      return new Promise((resolveStop) => {
        // Close all per-session SSE connections
        for (const subscriber of subscribers) {
          subscriber.res.end();
        }
        subscribers.clear();
        // Close all daemon-events SSE connections
        for (const subscriber of daemonSubscribers) {
          subscriber.res.end();
        }
        daemonSubscribers.clear();
        server.closeAllConnections();
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
        const addr = server.address();
        const actualPort = (addr && typeof addr === 'object') ? addr.port : p;
        resolve(actualPort);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(p, '0.0.0.0');
    }

    tryListen(port);
  });
}
