#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';

// Allowlist of CLI flags the proxy will forward to the daemon.
// Prevents arbitrary flag injection if the daemon passes flags to subprocesses.
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

function sanitizeFlags(flags) {
  if (!flags) return undefined;
  const result = [];
  let skipNext = false;
  for (const flag of flags) {
    if (skipNext) {
      // Previous flag was disallowed and had an argument — drop it too
      skipNext = false;
      continue;
    }
    if (ALLOWED_FLAGS.has(flag)) {
      result.push(flag);
    } else if (!flag.startsWith('-')) {
      // Non-flag value (argument to an allowed parameterized flag like --poll-interval 5000)
      result.push(flag);
    } else {
      // Disallowed flag — check if next element looks like its argument
      skipNext = true;
    }
  }
  return result;
}

const LOCKFILE_NAME = 'daemon.lock';
const LEGACY_LOCKFILE_NAME = 'monitor.lock';
const DAEMON_START_TIMEOUT_MS = 15_000;
const DAEMON_POLL_INTERVAL_MS = 500;

// --- Lockfile & daemon helpers ---

function lockfilePath(cwd) {
  return resolve(cwd, '.eforge', LOCKFILE_NAME);
}

function legacyLockfilePath(cwd) {
  return resolve(cwd, '.eforge', LEGACY_LOCKFILE_NAME);
}

async function readLockfile(cwd) {
  for (const path of [lockfilePath(cwd), legacyLockfilePath(cwd)]) {
    try {
      const data = JSON.parse(await readFile(path, 'utf-8'));
      if (data && typeof data.port === 'number' && Number.isInteger(data.port) && data.port > 0 && data.port <= 65535) return data;
    } catch {
      // try next
    }
  }
  return null;
}

async function isServerAlive(lock) {
  try {
    const res = await fetch(`http://127.0.0.1:${lock.port}/api/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureDaemon(cwd) {
  // Check if daemon is already running
  const existing = await readLockfile(cwd);
  if (existing && (await isServerAlive(existing))) {
    return existing.port;
  }

  // Auto-start daemon via CLI
  const child = spawn('npx', ['-y', 'eforge', 'daemon', 'start'], {
    cwd,
    detached: true,
    stdio: 'ignore',
  });
  child.on('error', () => {
    // Swallow spawn errors (e.g. eforge not in PATH) — the poll loop
    // below will time out and throw a descriptive error.
  });
  child.unref();

  // Poll for daemon readiness
  const deadline = Date.now() + DAEMON_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, DAEMON_POLL_INTERVAL_MS));
    const lock = await readLockfile(cwd);
    if (lock && (await isServerAlive(lock))) {
      return lock.port;
    }
  }

  throw new Error(
    'Daemon failed to start within timeout. Run `npx -y eforge daemon start` manually to diagnose.',
  );
}

// --- HTTP helper ---

async function daemonRequest(cwd, method, path, body) {
  const port = await ensureDaemon(cwd);
  const url = `http://127.0.0.1:${port}${path}`;
  const options = {
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

// --- MCP Server setup ---

const cwd = process.cwd();

const server = new McpServer({
  name: 'eforge',
  version: '0.2.0',
});

// Tool: eforge_run
server.tool(
  'eforge_run',
  'Launch an eforge run (enqueue + compile + build + validate) from a PRD source, or process the queue with --queue flag. Returns a sessionId to track progress.',
  {
    source: z
      .string()
      .optional()
      .describe(
        'PRD file path or inline description of what to build. Omit when using --queue flag.',
      ),
    flags: z
      .array(z.string())
      .optional()
      .describe('Optional CLI flags (e.g. ["--queue", "--watch"])'),
  },
  async ({ source, flags }) => {
    const sanitized = sanitizeFlags(flags);
    const isQueueMode = sanitized?.includes('--queue');
    if (isQueueMode) {
      // Queue mode uses a dedicated endpoint that doesn't require source
      const queueFlags = sanitized.filter((f) => f !== '--queue');
      const result = await daemonRequest(cwd, 'POST', '/api/queue/run', {
        flags: queueFlags.length > 0 ? queueFlags : undefined,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
    if (!source) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { error: 'source is required unless --queue flag is provided' },
              null,
              2,
            ),
          },
        ],
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
  'Normalize input and add it to the eforge PRD queue. The formatter agent produces a well-structured PRD with frontmatter.',
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
    const latestRun = await daemonRequest(cwd, 'GET', '/api/latest-run');
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
  'List all PRDs currently in the eforge queue with their metadata (title, status, priority).',
  {},
  async () => {
    const result = await daemonRequest(cwd, 'GET', '/api/queue');
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

// Tool: eforge_events
server.tool(
  'eforge_events',
  'Get run state snapshot for a known run ID. Use eforge_status instead to auto-resolve the latest run.',
  {
    runId: z.string().describe('The run ID to fetch events for'),
  },
  async ({ runId }) => {
    // Events endpoint is SSE — not consumable via a single HTTP fetch.
    // Return a run-state snapshot instead, which includes recent events.
    const state = await daemonRequest(cwd, 'GET', `/api/run-state/${encodeURIComponent(runId)}`);
    return { content: [{ type: 'text', text: JSON.stringify(state, null, 2) }] };
  },
);

// Tool: eforge_plans
server.tool(
  'eforge_plans',
  'Get compiled plan content for a specific run, including expedition architecture and module plans.',
  {
    runId: z.string().describe('The run ID to fetch plans for'),
  },
  async ({ runId }) => {
    const result = await daemonRequest(cwd, 'GET', `/api/plans/${encodeURIComponent(runId)}`);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

// Tool: eforge_diff
server.tool(
  'eforge_diff',
  "Get the git diff for a plan's implementation. Returns file-level diffs showing what changed.",
  {
    sessionId: z.string().describe('The session ID'),
    planId: z.string().describe('The plan ID to get diffs for'),
    file: z.string().optional().describe('Optional specific file path to get diff for'),
  },
  async ({ sessionId, planId, file }) => {
    let path = `/api/diff/${encodeURIComponent(sessionId)}/${encodeURIComponent(planId)}`;
    if (file) {
      path += `?file=${encodeURIComponent(file)}`;
    }
    const result = await daemonRequest(cwd, 'GET', path);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

// Tool: eforge_config
server.tool(
  'eforge_config',
  "Show resolved eforge configuration or validate eforge.yaml. Use action 'show' to see merged config, 'validate' to check for errors.",
  {
    action: z
      .enum(['show', 'validate'])
      .describe("'show' returns resolved config, 'validate' checks for errors"),
  },
  async ({ action }) => {
    const path = action === 'validate' ? '/api/config/validate' : '/api/config/show';
    const result = await daemonRequest(cwd, 'GET', path);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

// --- Start ---

const transport = new StdioServerTransport();
await server.connect(transport);
