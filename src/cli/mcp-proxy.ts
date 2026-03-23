/**
 * MCP stdio proxy server.
 *
 * Bridges MCP tool calls from Claude Code to the eforge daemon's HTTP API.
 * Auto-starts the daemon if not running. Called via `eforge mcp-proxy`.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readLockfile, isServerAlive } from '../monitor/lockfile.js';
import { spawn } from 'node:child_process';

const DAEMON_START_TIMEOUT_MS = 15_000;
const DAEMON_POLL_INTERVAL_MS = 500;

const ALLOWED_FLAGS = new Set([
  '--queue',
  '--watch',
  '--auto',
  '--verbose',
  '--dry-run',
  '--no-monitor',
  '--no-plugins',
  '--no-generate-profile',
  '--poll-interval',
  '--profiles',
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureDaemon(cwd: string): Promise<number> {
  const existing = readLockfile(cwd);
  if (existing && (await isServerAlive(existing))) {
    return existing.port;
  }

  // Auto-start daemon
  const child = spawn('eforge', ['daemon', 'start'], {
    cwd,
    detached: true,
    stdio: 'ignore',
  });
  child.on('error', () => {
    // Swallow — poll loop will time out with descriptive error
  });
  child.unref();

  const deadline = Date.now() + DAEMON_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(DAEMON_POLL_INTERVAL_MS);
    const lock = readLockfile(cwd);
    if (lock && (await isServerAlive(lock))) {
      return lock.port;
    }
  }

  throw new Error(
    'Daemon failed to start within timeout. Run `eforge daemon start` manually to diagnose.',
  );
}

async function daemonRequest(
  cwd: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const port = await ensureDaemon(cwd);
  const url = `http://127.0.0.1:${port}${path}`;
  const options: RequestInit = {
    method,
    signal: AbortSignal.timeout(30_000),
  };
  if (body !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  const res = await fetch(url, options);
  const text = await res.text();
  if (!res.ok) {
    const truncated = text.length > 200 ? text.slice(0, 200) + '…' : text;
    throw new Error(`Daemon returned ${res.status}: ${truncated}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function runMcpProxy(cwd: string): Promise<void> {
  const server = new McpServer({
    name: 'eforge',
    version: '0.3.0',
  });

  // Tool: eforge_run
  server.tool(
    'eforge_run',
    'Launch an eforge run (enqueue + compile + build + validate) from a PRD source, or process the queue with --queue flag. Returns a sessionId to track progress.',
    {
      source: z
        .string()
        .optional()
        .describe('PRD file path or inline description. Omit when using --queue flag.'),
      flags: z
        .array(z.string())
        .optional()
        .describe('Optional CLI flags (e.g. ["--queue", "--watch"])'),
    },
    async ({ source, flags }) => {
      const sanitized = sanitizeFlags(flags);
      const isQueueMode = sanitized?.includes('--queue');
      if (isQueueMode) {
        const queueFlags = sanitized!.filter((f) => f !== '--queue');
        const result = await daemonRequest(cwd, 'POST', '/api/queue/run', {
          flags: queueFlags.length > 0 ? queueFlags : undefined,
        });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      if (!source) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'source is required unless --queue flag is provided' }, null, 2) }],
          isError: true,
        };
      }
      const result = await daemonRequest(cwd, 'POST', '/api/run', { source, flags: sanitized });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
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
      const result = await daemonRequest(cwd, 'POST', '/api/enqueue', { source, flags: sanitizeFlags(flags) });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  // Tool: eforge_status
  server.tool(
    'eforge_status',
    'Get the current run status including plan progress, session state, and event summary.',
    {},
    async () => {
      const latestRun = await daemonRequest(cwd, 'GET', '/api/latest-run') as { sessionId?: string };
      if (!latestRun?.sessionId) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'idle', message: 'No active eforge sessions.' }) }] };
      }
      const state = await daemonRequest(cwd, 'GET', `/api/run-state/${encodeURIComponent(latestRun.sessionId)}`);
      return { content: [{ type: 'text', text: JSON.stringify(state, null, 2) }] };
    },
  );

  // Tool: eforge_queue_list
  server.tool(
    'eforge_queue_list',
    'List all PRDs currently in the eforge queue with their metadata.',
    {},
    async () => {
      const result = await daemonRequest(cwd, 'GET', '/api/queue');
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  // Tool: eforge_events
  server.tool(
    'eforge_events',
    'Get run state snapshot for a known run ID.',
    { runId: z.string().describe('The run ID to fetch events for') },
    async ({ runId }) => {
      const state = await daemonRequest(cwd, 'GET', `/api/run-state/${encodeURIComponent(runId)}`);
      return { content: [{ type: 'text', text: JSON.stringify(state, null, 2) }] };
    },
  );

  // Tool: eforge_plans
  server.tool(
    'eforge_plans',
    'Get compiled plan content for a specific run.',
    { runId: z.string().describe('The run ID to fetch plans for') },
    async ({ runId }) => {
      const result = await daemonRequest(cwd, 'GET', `/api/plans/${encodeURIComponent(runId)}`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  // Tool: eforge_diff
  server.tool(
    'eforge_diff',
    "Get the git diff for a plan's implementation.",
    {
      sessionId: z.string().describe('The session ID'),
      planId: z.string().describe('The plan ID to get diffs for'),
      file: z.string().optional().describe('Optional specific file path'),
    },
    async ({ sessionId, planId, file }) => {
      let path = `/api/diff/${encodeURIComponent(sessionId)}/${encodeURIComponent(planId)}`;
      if (file) path += `?file=${encodeURIComponent(file)}`;
      const result = await daemonRequest(cwd, 'GET', path);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  // Tool: eforge_config
  server.tool(
    'eforge_config',
    'Show resolved eforge configuration or validate eforge.yaml.',
    {
      action: z.enum(['show', 'validate']).describe("'show' returns resolved config, 'validate' checks for errors"),
    },
    async ({ action }) => {
      const path = action === 'validate' ? '/api/config/validate' : '/api/config/show';
      const result = await daemonRequest(cwd, 'GET', path);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
