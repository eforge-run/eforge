/**
 * MCP stdio proxy server.
 *
 * Bridges MCP tool calls from Claude Code to the eforge daemon's HTTP API.
 * Auto-starts the daemon if not running. Called via `eforge mcp-proxy`.
 */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import http from 'node:http';
import { readFile, writeFile, access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDaemon, daemonRequest, daemonRequestIfRunning, sleep, DAEMON_POLL_INTERVAL_MS, readLockfile } from '@eforge-build/client';
import type { LatestRunResponse, EnqueueResponse, RunSummary, ConfigValidateResponse } from '@eforge-build/client';

declare const EFORGE_VERSION: string;

const ALLOWED_FLAGS = new Set([
  '--queue',
  '--watch',
  '--auto',
  '--verbose',
  '--dry-run',
  '--no-monitor',
  '--no-plugins',
  '--poll-interval',
]);

function sanitizeFlags(flags?: string[]): string[] | undefined {
  if (!flags) return undefined;
  const result: string[] = [];
  let skipNext = false;
  for (const flag of flags) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (ALLOWED_FLAGS.has(flag)) {
      result.push(flag);
    } else if (!flag.startsWith('-')) {
      result.push(flag);
    } else {
      skipNext = true;
    }
  }
  return result;
}

// Re-export for any consumers that imported from here
export { ensureDaemon, daemonRequest, daemonRequestIfRunning };

// --- SSE Subscriber ---

/** Events that trigger list_changed notifications */
const LIST_CHANGED_EVENTS = new Set([
  'phase:start',
  'phase:end',
  'build:complete',
  'build:error',
  'enqueue:complete',
  'session:start',
  'session:end',
]);

/** Events that trigger info-level logging notifications */
const INFO_EVENTS = new Set([
  'session:start',
  'phase:start',
  'phase:end',
  'build:complete',
  'plan:complete',
  'plan:skip',
]);

/** Events that trigger error-level logging notifications */
const ERROR_EVENTS = new Set([
  'build:error',
  'phase:error',
]);

const SESSION_POLL_INTERVAL_MS = 10_000;
const SSE_RECONNECT_MAX_MS = 30_000;

interface SseSubscriberState {
  currentSessionId: string | null;
  sseRequest: http.ClientRequest | null;
  sessionPollTimer: ReturnType<typeof setInterval> | null;
  reconnectDelay: number;
  stopped: boolean;
}

function parseSseChunk(chunk: string): Array<{ id?: string; data?: string }> {
  const events: Array<{ id?: string; data?: string }> = [];
  // Normalize line endings per SSE spec (supports \r\n, \r, and \n)
  const normalized = chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const blocks = normalized.split('\n\n');
  for (const block of blocks) {
    if (!block.trim()) continue;
    let id: string | undefined;
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('id:')) {
        const idVal = line.slice(3);
        id = idVal.startsWith(' ') ? idVal.slice(1) : idVal;
      } else if (line.startsWith('data:')) {
        const dataVal = line.slice(5);
        dataLines.push(dataVal.startsWith(' ') ? dataVal.slice(1) : dataVal);
      }
    }
    if (dataLines.length > 0) {
      events.push({ id, data: dataLines.join('\n') });
    }
  }
  return events;
}

function buildLoggingData(event: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (event.sessionId) result.sessionId = event.sessionId;
  if (event.planId) result.planId = event.planId;
  if (event.phase) result.phase = event.phase;
  // Build a human-readable message
  const eventType = event.type as string;
  if (event.message) {
    result.message = event.message;
  } else {
    result.message = eventType;
  }
  return result;
}

function startSseSubscriber(server: McpServer, cwd: string): SseSubscriberState {
  const state: SseSubscriberState = {
    currentSessionId: null,
    sseRequest: null,
    sessionPollTimer: null,
    reconnectDelay: 1000,
    stopped: false,
  };

  function closeSseConnection() {
    if (state.sseRequest) {
      state.sseRequest.destroy();
      state.sseRequest = null;
    }
  }

  function connectToSse(port: number, sessionId: string) {
    closeSseConnection();
    state.currentSessionId = sessionId;

    const url = `http://127.0.0.1:${port}/api/events/${encodeURIComponent(sessionId)}`;

    const req = http.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume(); // drain
        scheduleReconnect(port);
        return;
      }

      // Reset backoff on successful connection
      state.reconnectDelay = 1000;

      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        // Process complete SSE blocks (separated by double newlines)
        const lastDoubleNewline = buffer.lastIndexOf('\n\n');
        if (lastDoubleNewline === -1) return;
        const complete = buffer.slice(0, lastDoubleNewline + 2);
        buffer = buffer.slice(lastDoubleNewline + 2);

        const sseEvents = parseSseChunk(complete);
        for (const sseEvent of sseEvents) {
          if (!sseEvent.data) continue;
          try {
            const event = JSON.parse(sseEvent.data) as Record<string, unknown>;
            const eventType = event.type as string;
            if (!eventType) continue;

            // Send list_changed for lifecycle events
            if (LIST_CHANGED_EVENTS.has(eventType)) {
              try { server.sendResourceListChanged(); } catch { /* transport may be closed */ }
            }

            // Send logging notifications
            if (INFO_EVENTS.has(eventType)) {
              server.sendLoggingMessage({
                level: 'info',
                logger: 'eforge',
                data: buildLoggingData(event),
              }).catch(() => { /* client may not support logging */ });
            } else if (ERROR_EVENTS.has(eventType)) {
              server.sendLoggingMessage({
                level: 'error',
                logger: 'eforge',
                data: buildLoggingData(event),
              }).catch(() => {});
            } else if (eventType === 'review:issue') {
              const severity = event.severity as string | undefined;
              if (severity === 'high' || severity === 'critical') {
                server.sendLoggingMessage({
                  level: 'warning',
                  logger: 'eforge',
                  data: buildLoggingData(event),
                }).catch(() => {});
              }
            }
          } catch {
            // Ignore malformed SSE data
          }
        }
      });

      res.on('end', () => {
        state.sseRequest = null;
        if (!state.stopped) {
          scheduleReconnect(port);
        }
      });

      res.on('error', () => {
        state.sseRequest = null;
        if (!state.stopped) {
          scheduleReconnect(port);
        }
      });
    });

    req.on('error', () => {
      state.sseRequest = null;
      if (!state.stopped) {
        scheduleReconnect(port);
      }
    });

    state.sseRequest = req;
  }

  function scheduleReconnect(port: number) {
    if (state.stopped) return;
    const delay = state.reconnectDelay;
    state.reconnectDelay = Math.min(state.reconnectDelay * 2, SSE_RECONNECT_MAX_MS);
    setTimeout(() => {
      if (state.stopped) return;
      if (state.currentSessionId) {
        connectToSse(port, state.currentSessionId);
      }
    }, delay);
  }

  async function pollForSession() {
    if (state.stopped) return;
    try {
      const result = await daemonRequestIfRunning<LatestRunResponse>(cwd, 'GET', '/api/latest-run');
      if (!result) return; // Daemon not running - don't auto-start for polling
      const { data, port } = result;
      if (!data?.sessionId) return;

      if (data.sessionId !== state.currentSessionId) {
        connectToSse(port, data.sessionId);
      }
    } catch {
      // Daemon not running or unreachable - skip this poll
    }
  }

  // Start polling for sessions
  // Do an initial poll immediately
  pollForSession();
  state.sessionPollTimer = setInterval(pollForSession, SESSION_POLL_INTERVAL_MS);

  return state;
}

function stopSseSubscriber(state: SseSubscriberState) {
  state.stopped = true;
  if (state.sessionPollTimer) {
    clearInterval(state.sessionPollTimer);
    state.sessionPollTimer = null;
  }
  if (state.sseRequest) {
    state.sseRequest.destroy();
    state.sseRequest = null;
  }
}

// --- End SSE Subscriber ---

async function ensureGitignoreEntries(projectDir: string, entries: string[]): Promise<void> {
  const gitignorePath = join(projectDir, '.gitignore');
  let content = '';
  try {
    content = await readFile(gitignorePath, 'utf-8');
  } catch {
    // .gitignore doesn't exist yet
  }

  const lines = content.split('\n');
  const missing = entries.filter((entry) => !lines.some((line) => line.trim() === entry));

  if (missing.length === 0) return;

  const suffix = (content.length > 0 && !content.endsWith('\n') ? '\n' : '') +
    '\n# eforge\n' +
    missing.join('\n') +
    '\n';

  await writeFile(gitignorePath, content + suffix, 'utf-8');
}

export async function runMcpProxy(cwd: string): Promise<void> {
  const server = new McpServer({
    name: 'eforge',
    version: EFORGE_VERSION,
  }, {
    capabilities: {
      resources: { listChanged: true },
      logging: {},
    },
  });

  // --- Resources ---

  /** Request from an already-running daemon, or throw if not running. */
  async function requireDaemon<T = unknown>(method: string, path: string, body?: unknown): Promise<{ data: T; port: number }> {
    const result = await daemonRequestIfRunning<T>(cwd, method, path, body);
    if (!result) throw new Error('Daemon not running');
    return result;
  }

  // Resource: eforge://status
  server.resource(
    'eforge-status',
    'eforge://status',
    { description: 'Current eforge build status - latest session summary or idle state' },
    async () => {
      try {
        const { data: latestRun } = await requireDaemon<LatestRunResponse>('GET', '/api/latest-run');
        if (!latestRun?.sessionId) {
          return {
            contents: [{
              uri: 'eforge://status',
              mimeType: 'application/json',
              text: JSON.stringify({ status: 'idle', message: 'No active eforge sessions.' }),
            }],
          };
        }
        const { data: summary } = await requireDaemon<RunSummary>('GET', `/api/run-summary/${encodeURIComponent(latestRun.sessionId)}`);
        return {
          contents: [{
            uri: 'eforge://status',
            mimeType: 'application/json',
            text: JSON.stringify(summary, null, 2),
          }],
        };
      } catch (err) {
        return {
          contents: [{
            uri: 'eforge://status',
            mimeType: 'application/json',
            text: JSON.stringify({ status: 'unavailable', message: 'Daemon not running or unreachable.' }),
          }],
        };
      }
    },
  );

  // Resource template: eforge://status/{sessionId}
  server.resource(
    'eforge-session-status',
    new ResourceTemplate('eforge://status/{sessionId}', { list: undefined }),
    { description: 'Build status for a specific eforge session' },
    async (uri, variables) => {
      const sessionId = Array.isArray(variables.sessionId) ? variables.sessionId[0] : variables.sessionId;
      try {
        const { data: summary } = await requireDaemon<RunSummary>('GET', `/api/run-summary/${encodeURIComponent(sessionId)}`);
        return {
          contents: [{
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(summary, null, 2),
          }],
        };
      } catch (err) {
        return {
          contents: [{
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({ error: `Failed to fetch session ${sessionId}` }),
          }],
        };
      }
    },
  );

  // Resource: eforge://queue
  server.resource(
    'eforge-queue',
    'eforge://queue',
    { description: 'Current eforge PRD queue listing' },
    async () => {
      try {
        const { data } = await requireDaemon('GET', '/api/queue');
        return {
          contents: [{
            uri: 'eforge://queue',
            mimeType: 'application/json',
            text: JSON.stringify(data, null, 2),
          }],
        };
      } catch {
        return {
          contents: [{
            uri: 'eforge://queue',
            mimeType: 'application/json',
            text: JSON.stringify({ error: 'Daemon not running or unreachable.' }),
          }],
        };
      }
    },
  );

  // Resource: eforge://config
  server.resource(
    'eforge-config',
    'eforge://config',
    { description: 'Resolved eforge configuration' },
    async () => {
      try {
        const { data } = await requireDaemon('GET', '/api/config/show');
        return {
          contents: [{
            uri: 'eforge://config',
            mimeType: 'application/json',
            text: JSON.stringify(data, null, 2),
          }],
        };
      } catch {
        return {
          contents: [{
            uri: 'eforge://config',
            mimeType: 'application/json',
            text: JSON.stringify({ error: 'Daemon not running or unreachable.' }),
          }],
        };
      }
    },
  );

  // --- Tools ---

  // Tool: eforge_build
  server.tool(
    'eforge_build',
    'Enqueue a PRD source for the eforge daemon to build. Returns a sessionId and autoBuild status.',
    {
      source: z
        .string()
        .describe('PRD file path or inline description to enqueue for building'),
    },
    async ({ source }) => {
      const { data, port } = await daemonRequest<EnqueueResponse>(cwd, 'POST', '/api/enqueue', { source });
      const response = { ...data, monitorUrl: `http://localhost:${port}` };
      return { content: [{ type: 'text', text: JSON.stringify(response, null, 2) }] };
    },
  );

  // Tool: eforge_enqueue
  server.tool(
    'eforge_enqueue',
    'Normalize input and add it to the eforge PRD queue.',
    {
      source: z.string().describe('PRD file path, inline prompt, or rough notes to enqueue'),
      flags: z.array(z.string()).optional().describe('Optional CLI flags'),
    },
    async ({ source, flags }) => {
      const { data, port } = await daemonRequest<EnqueueResponse>(cwd, 'POST', '/api/enqueue', { source, flags: sanitizeFlags(flags) });
      const response = { ...data, monitorUrl: `http://localhost:${port}` };
      return { content: [{ type: 'text', text: JSON.stringify(response, null, 2) }] };
    },
  );

  // Tool: eforge_auto_build
  server.tool(
    'eforge_auto_build',
    'Get or set the daemon auto-build state. When enabled, the daemon automatically builds PRDs as they are enqueued.',
    {
      action: z.enum(['get', 'set']).describe("'get' returns current auto-build state, 'set' updates it"),
      enabled: z.boolean().optional().describe('Required when action is "set". Whether auto-build should be enabled.'),
    },
    async ({ action, enabled }) => {
      if (action === 'get') {
        const { data } = await daemonRequest(cwd, 'GET', '/api/auto-build');
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }
      // action === 'set'
      if (enabled === undefined) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: '"enabled" is required when action is "set"' }, null, 2) }],
          isError: true,
        };
      }
      const { data } = await daemonRequest(cwd, 'POST', '/api/auto-build', { enabled });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },
  );

  // Tool: eforge_status
  server.tool(
    'eforge_status',
    'Get the current run status including plan progress, session state, and event summary.',
    {},
    async () => {
      const { data: latestRun } = await daemonRequest<LatestRunResponse>(cwd, 'GET', '/api/latest-run');
      if (!latestRun?.sessionId) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'idle', message: 'No active eforge sessions.' }) }] };
      }
      const { data: summary } = await daemonRequest<RunSummary>(cwd, 'GET', `/api/run-summary/${encodeURIComponent(latestRun.sessionId)}`);
      return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
    },
  );

  // Tool: eforge_queue_list
  server.tool(
    'eforge_queue_list',
    'List all PRDs currently in the eforge queue with their metadata.',
    {},
    async () => {
      const { data } = await daemonRequest(cwd, 'GET', '/api/queue');
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },
  );

  // Tool: eforge_config
  server.tool(
    'eforge_config',
    'Show resolved eforge configuration or validate eforge/config.yaml.',
    {
      action: z.enum(['show', 'validate']).describe("'show' returns resolved config, 'validate' checks for errors"),
    },
    async ({ action }) => {
      const path = action === 'validate' ? '/api/config/validate' : '/api/config/show';
      const { data } = await daemonRequest(cwd, 'GET', path);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },
  );

  // Tool: eforge_daemon
  server.tool(
    'eforge_daemon',
    'Manage the eforge daemon lifecycle: start, stop, or restart the daemon.',
    {
      action: z.enum(['start', 'stop', 'restart']).describe("'start' ensures daemon is running, 'stop' gracefully stops it, 'restart' stops then starts"),
      force: z.boolean().optional().describe('When action is "stop" or "restart", force shutdown even if builds are active. Default: false.'),
    },
    async ({ action, force }) => {
      const LOCKFILE_POLL_INTERVAL_MS = 250;
      const LOCKFILE_POLL_TIMEOUT_MS = 5000;

      async function checkActiveBuilds(): Promise<string | null> {
        try {
          const { data: latestRun } = await daemonRequest<LatestRunResponse>(cwd, 'GET', '/api/latest-run');
          if (!latestRun?.sessionId) return null;
          const { data: summary } = await daemonRequest<RunSummary>(cwd, 'GET', `/api/run-summary/${encodeURIComponent(latestRun.sessionId)}`);
          if (summary?.status === 'running') {
            return 'An eforge build is currently active. Use force: true to stop anyway.';
          }
          return null;
        } catch {
          return null;
        }
      }

      async function stopDaemon(forceStop: boolean): Promise<{ stopped: boolean; message: string }> {
        // Check if daemon is running
        const lock = readLockfile(cwd);
        if (!lock) {
          return { stopped: true, message: 'Daemon is not running.' };
        }

        // Check for active builds unless force
        if (!forceStop) {
          const activeMessage = await checkActiveBuilds();
          if (activeMessage) {
            return { stopped: false, message: activeMessage };
          }
        }

        // Send stop request
        try {
          await daemonRequest(cwd, 'POST', '/api/daemon/stop', { force: forceStop });
        } catch {
          // Daemon may have already shut down before responding
        }

        // Poll for lockfile removal
        const deadline = Date.now() + LOCKFILE_POLL_TIMEOUT_MS;
        while (Date.now() < deadline) {
          await sleep(LOCKFILE_POLL_INTERVAL_MS);
          const current = readLockfile(cwd);
          if (!current) {
            return { stopped: true, message: 'Daemon stopped successfully.' };
          }
        }

        return { stopped: true, message: 'Daemon stop requested. Lockfile may take a moment to clear.' };
      }

      if (action === 'start') {
        const port = await ensureDaemon(cwd);
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'running', port }, null, 2) }] };
      }

      if (action === 'stop') {
        const result = await stopDaemon(force === true);
        if (!result.stopped) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: result.message }, null, 2) }], isError: true };
        }
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'stopped', message: result.message }, null, 2) }] };
      }

      // action === 'restart'
      const stopResult = await stopDaemon(force === true);
      if (!stopResult.stopped) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: stopResult.message }, null, 2) }], isError: true };
      }

      const port = await ensureDaemon(cwd);
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'restarted', port, message: 'Daemon restarted successfully.' }, null, 2) }] };
    },
  );

  // Tool: eforge_init
  server.tool(
    'eforge_init',
    'Initialize eforge in a project: creates eforge/config.yaml and updates .gitignore. Presents an elicitation form for backend selection.',
    {
      force: z.boolean().optional().describe('Overwrite existing eforge/config.yaml if it already exists. Default: false.'),
      postMergeCommands: z.array(z.string()).optional().describe('Post-merge validation commands (e.g. ["pnpm install", "pnpm test"]). Only applied when creating a new config, not when merging with existing.'),
    },
    async ({ force, postMergeCommands }) => {
      const configDir = join(cwd, 'eforge');
      const configPath = join(configDir, 'config.yaml');

      // Check if config already exists
      try {
        await access(configPath);
        if (!force) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                error: 'eforge/config.yaml already exists. Use force: true to overwrite.',
              }, null, 2),
            }],
            isError: true,
          };
        }
      } catch {
        // File does not exist - proceed
      }

      // Elicit backend choice from user
      let backend: string;
      try {
        const result = await server.server.elicitInput({
          mode: 'form',
          message: 'Configure eforge for this project:',
          requestedSchema: {
            type: 'object',
            properties: {
              backend: {
                type: 'string',
                title: 'Backend',
                description: 'Which LLM backend to use for builds',
                oneOf: [
                  { const: 'claude-sdk', title: 'Claude SDK - Uses Claude Code\'s built-in SDK' },
                  { const: 'pi', title: 'Pi - Experimental multi-provider via Pi SDK' },
                ],
                default: 'claude-sdk',
              },
            },
            required: ['backend'],
          },
        });

        if (result.action === 'decline') {
          return {
            content: [{ type: 'text', text: 'Initialization declined by user.' }],
          };
        }

        if (result.action === 'cancel' || !result.content) {
          return {
            content: [{ type: 'text', text: 'Initialization cancelled.' }],
          };
        }

        backend = result.content.backend as string;
      } catch (err) {
        return {
          content: [{
            type: 'text',
            text: `Elicitation failed: ${err instanceof Error ? err.message : String(err)}. You can use /eforge:config instead.`,
          }],
          isError: true,
        };
      }

      // Ensure .gitignore has .eforge/ entry (daemon state/logs - not eforge/ which is committed)
      await ensureGitignoreEntries(cwd, ['.eforge/']);

      // Create eforge/ directory if it doesn't exist
      try {
        await mkdir(configDir, { recursive: true });
      } catch {
        // Directory may already exist
      }

      // Read existing config (if any) and merge - only update backend, preserve formatting
      let configContent: string;
      try {
        const existing = await readFile(configPath, 'utf-8');
        // Replace or prepend backend line, preserving everything else
        if (/^backend\s*:/m.test(existing)) {
          configContent = existing.replace(/^backend\s*:.*$/m, `backend: ${backend}`);
        } else {
          configContent = `backend: ${backend}\n\n${existing}`;
        }
      } catch {
        // No existing config - create new one with backend and optional postMergeCommands
        const lines = [`backend: ${backend}`, ''];
        if (postMergeCommands && postMergeCommands.length > 0) {
          lines.push('build:');
          lines.push('  postMergeCommands:');
          for (const cmd of postMergeCommands) {
            lines.push(`    - ${cmd}`);
          }
          lines.push('');
        }
        configContent = lines.join('\n');
      }

      await writeFile(configPath, configContent, 'utf-8');

      // Validate config via daemon
      let validation: ConfigValidateResponse | null = null;
      try {
        const { data } = await daemonRequest<ConfigValidateResponse>(cwd, 'GET', '/api/config/validate');
        validation = data;
      } catch {
        // Daemon validation is best-effort
      }

      const response: Record<string, unknown> = {
        status: 'initialized',
        configPath: 'eforge/config.yaml',
        backend,
      };

      if (validation) {
        response.validation = validation;
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(response, null, 2) }],
      };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Start SSE subscriber after transport is connected
  const sseState = startSseSubscriber(server, cwd);

  // Chain SSE cleanup onto existing transport close handler
  const originalOnclose = transport.onclose;
  transport.onclose = () => {
    stopSseSubscriber(sseState);
    originalOnclose?.();
  };
}
