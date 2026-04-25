/**
 * MCP stdio proxy server.
 *
 * Bridges MCP tool calls from Claude Code to the eforge daemon's HTTP API.
 * Auto-starts the daemon if not running. Called via `eforge mcp-proxy`.
 */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFile, writeFile, access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { ensureDaemon, daemonRequest, daemonRequestIfRunning, sleep, readLockfile, subscribeToSession, eventToProgress, LOCKFILE_POLL_INTERVAL_MS, LOCKFILE_POLL_TIMEOUT_MS, sanitizeProfileName, parseRawConfigLegacy, API_ROUTES, buildPath } from '@eforge-build/client';
import type {
  LatestRunResponse,
  EnqueueResponse,
  RunSummary,
  ConfigValidateResponse,
  DaemonStreamEvent,
  SessionSummary,
  FollowCounters,
} from '@eforge-build/client';
import { createDaemonTool, McpUserError, formatResourceJson } from './mcp-tool-factory.js';

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

// `eventToProgress` and `FollowCounters` are imported from `@eforge-build/client`
// so the MCP proxy and the Pi extension share a single source of truth for the
// event -> progress mapping. See packages/client/src/event-to-progress.ts.
// Re-export for any existing consumers of the previous in-file surface.
export { eventToProgress };
export type { FollowCounters };

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
        const { data: latestRun } = await requireDaemon<LatestRunResponse>('GET', API_ROUTES.latestRun);
        if (!latestRun?.sessionId) {
          return {
            contents: [{
              uri: 'eforge://status',
              mimeType: 'application/json',
              text: JSON.stringify({ status: 'idle', message: 'No active eforge sessions.' }),
            }],
          };
        }
        const { data: summary } = await requireDaemon<RunSummary>('GET', buildPath(API_ROUTES.runSummary, { id: latestRun.sessionId }));
        return {
          contents: [{
            uri: 'eforge://status',
            mimeType: 'application/json',
            text: formatResourceJson(summary),
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
        const { data: summary } = await requireDaemon<RunSummary>('GET', buildPath(API_ROUTES.runSummary, { id: sessionId }));
        return {
          contents: [{
            uri: uri.href,
            mimeType: 'application/json',
            text: formatResourceJson(summary),
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
        const { data } = await requireDaemon('GET', API_ROUTES.queue);
        return {
          contents: [{
            uri: 'eforge://queue',
            mimeType: 'application/json',
            text: formatResourceJson(data),
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
        const { data } = await requireDaemon('GET', API_ROUTES.configShow);
        return {
          contents: [{
            uri: 'eforge://config',
            mimeType: 'application/json',
            text: formatResourceJson(data),
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
  createDaemonTool(server, cwd, {
    name: 'eforge_build',
    description: 'Enqueue a PRD source for the eforge daemon to build. Returns a sessionId and autoBuild status.',
    schema: {
      source: z
        .string()
        .describe('PRD file path or inline description to enqueue for building'),
    },
    handler: async ({ source }, { cwd: toolCwd }) => {
      const { data, port } = await daemonRequest<EnqueueResponse>(toolCwd, 'POST', API_ROUTES.enqueue, { source });
      return { ...data, monitorUrl: `http://localhost:${port}` };
    },
  });

  // Tool: eforge_follow
  // Long-running tool that blocks for the lifetime of a session and streams
  // high-signal events as MCP `notifications/progress`. Resolves with the
  // session summary so the outcome lands in the conversation transcript.
  const DEFAULT_FOLLOW_TIMEOUT_MS = 1_800_000; // 30 minutes

  createDaemonTool(server, cwd, {
    name: 'eforge_follow',
    description: 'Follow a running eforge session: streams phase/files-changed/issue updates as progress notifications and returns the final session summary. Use after eforge_build to surface live build status in the conversation.',
    schema: {
      sessionId: z.string().describe('The session to follow (from eforge_build or eforge_status).'),
      timeoutMs: z.number().optional().describe('Max time to wait for session completion in ms. Default 1,800,000 (30 minutes).'),
    },
    handler: async ({ sessionId, timeoutMs }, { cwd: toolCwd, extra, server: toolServer }) => {
      const timeout = timeoutMs ?? DEFAULT_FOLLOW_TIMEOUT_MS;
      const progressToken = extra?._meta?.progressToken;

      // Combine the caller's abort signal with a timeout signal so the tool
      // terminates cleanly on either cancellation or timeout.
      const timeoutController = new AbortController();
      const timeoutHandle = setTimeout(() => {
        const timeoutReason = Object.assign(new Error('eforge_follow timed out'), { name: 'AbortError' });
        timeoutController.abort(timeoutReason);
      }, timeout);

      const signals: AbortSignal[] = [timeoutController.signal];
      if (extra?.signal) signals.push(extra.signal as AbortSignal);
      // `AbortSignal.any` is available on Node 22+ (the engines requirement).
      const signal = AbortSignal.any(signals);

      let progressCounter = 0;
      let counters: FollowCounters = { filesChanged: 0 };

      async function emitProgress(message: string): Promise<void> {
        if (progressToken === undefined) return;
        progressCounter += 1;
        try {
          await toolServer.server.notification({
            method: 'notifications/progress',
            params: {
              progressToken,
              progress: progressCounter,
              message,
            },
          });
        } catch {
          // Transport may be closed or the client may not support progress
        }
      }

      let summary: SessionSummary | null = null;
      let followError: Error | null = null;
      const startedAt = Date.now();

      try {
        summary = await subscribeToSession<DaemonStreamEvent>(sessionId, {
          cwd: toolCwd,
          signal,
          onEvent: (event) => {
            const update = eventToProgress(event, counters);
            if (!update) return;
            counters = update.counters;
            // Fire-and-forget; emitProgress swallows its own errors.
            void emitProgress(update.message);
          },
        });
      } catch (err) {
        followError = err instanceof Error ? err : new Error(String(err));
      } finally {
        clearTimeout(timeoutHandle);
      }

      if (followError || !summary) {
        const message = followError?.message ?? 'eforge_follow failed';
        const isAbort = followError?.name === 'AbortError' || /timed out/.test(message);
        throw new McpUserError({
          status: isAbort ? 'aborted' : 'error',
          sessionId,
          message,
          filesChanged: counters.filesChanged,
        });
      }

      return {
        status: summary.status,
        sessionId: summary.sessionId,
        summary: summary.summary,
        monitorUrl: summary.monitorUrl,
        durationMs: Date.now() - startedAt,
        phaseCounts: { total: summary.phaseCount },
        filesChanged: summary.filesChanged,
        issueCounts: { errors: summary.errorCount },
        eventCount: summary.eventCount,
      };
    },
  });

  // Tool: eforge_enqueue
  createDaemonTool(server, cwd, {
    name: 'eforge_enqueue',
    description: 'Normalize input and add it to the eforge PRD queue.',
    schema: {
      source: z.string().describe('PRD file path, inline prompt, or rough notes to enqueue'),
      flags: z.array(z.string()).optional().describe('Optional CLI flags'),
    },
    handler: async ({ source, flags }, { cwd: toolCwd }) => {
      const { data, port } = await daemonRequest<EnqueueResponse>(toolCwd, 'POST', API_ROUTES.enqueue, { source, flags: sanitizeFlags(flags) });
      return { ...data, monitorUrl: `http://localhost:${port}` };
    },
  });

  // Tool: eforge_auto_build
  createDaemonTool(server, cwd, {
    name: 'eforge_auto_build',
    description: 'Get or set the daemon auto-build state. When enabled, the daemon automatically builds PRDs as they are enqueued.',
    schema: {
      action: z.enum(['get', 'set']).describe("'get' returns current auto-build state, 'set' updates it"),
      enabled: z.boolean().optional().describe('Required when action is "set". Whether auto-build should be enabled.'),
    },
    handler: async ({ action, enabled }, { cwd: toolCwd }) => {
      if (action === 'get') {
        const { data } = await daemonRequest(toolCwd, 'GET', API_ROUTES.autoBuildGet);
        return data;
      }
      // action === 'set'
      if (enabled === undefined) {
        throw new Error('"enabled" is required when action is "set"');
      }
      const { data } = await daemonRequest(toolCwd, 'POST', API_ROUTES.autoBuildSet, { enabled });
      return data;
    },
  });

  // Tool: eforge_status
  createDaemonTool(server, cwd, {
    name: 'eforge_status',
    description: 'Get the current run status including plan progress, session state, and event summary.',
    schema: {},
    handler: async (_args, { cwd: toolCwd }) => {
      const { data: latestRun } = await daemonRequest<LatestRunResponse>(toolCwd, 'GET', API_ROUTES.latestRun);
      if (!latestRun?.sessionId) {
        return { status: 'idle', message: 'No active eforge sessions.' };
      }
      const { data: summary } = await daemonRequest<RunSummary>(toolCwd, 'GET', buildPath(API_ROUTES.runSummary, { id: latestRun.sessionId }));
      return summary;
    },
  });

  // Tool: eforge_queue_list
  createDaemonTool(server, cwd, {
    name: 'eforge_queue_list',
    description: 'List all PRDs currently in the eforge queue with their metadata.',
    schema: {},
    handler: async (_args, { cwd: toolCwd }) => {
      const { data } = await daemonRequest(toolCwd, 'GET', API_ROUTES.queue);
      return data;
    },
  });

  // Tool: eforge_config
  createDaemonTool(server, cwd, {
    name: 'eforge_config',
    description: 'Show resolved eforge configuration or validate eforge/config.yaml.',
    schema: {
      action: z.enum(['show', 'validate']).describe("'show' returns resolved config, 'validate' checks for errors"),
    },
    handler: async ({ action }, { cwd: toolCwd }) => {
      const path = action === 'validate' ? API_ROUTES.configValidate : API_ROUTES.configShow;
      const { data } = await daemonRequest(toolCwd, 'GET', path);
      return data;
    },
  });

  // Tool: eforge_profile
  createDaemonTool(server, cwd, {
    name: 'eforge_profile',
    description: 'Manage named profiles in eforge/profiles/. Actions: "list" enumerates profiles and reports which is active; "show" returns the resolved active profile with backend; "use" writes eforge/.active-profile to switch profiles; "create" writes a new eforge/profiles/<name>.yaml; "delete" removes a profile (refuses when active unless force: true).',
    schema: {
      action: z.enum(['list', 'show', 'use', 'create', 'delete']).describe(
        "'list' enumerates profiles, 'show' returns the resolved active profile, 'use' switches the active profile, 'create' writes a new profile, 'delete' removes a profile",
      ),
      name: z.string().optional().describe('Profile name (required for "use", "create", and "delete")'),
      backend: z.enum(['claude-sdk', 'pi']).optional().describe('Backend kind (required for "create")'),
      pi: z.record(z.string(), z.any()).optional().describe('Pi-specific config to embed in the profile (optional, "create" only)'),
      agents: z.record(z.string(), z.any()).optional().describe('Agents config block to embed in the profile (optional, "create" only)'),
      overwrite: z.boolean().optional().describe('Overwrite an existing profile when creating. Default: false.'),
      force: z.boolean().optional().describe('Delete even if the profile is currently active. Default: false.'),
      scope: z.enum(['project', 'user', 'all']).optional().describe(
        'Scope for the operation. "list" accepts project|user|all (default: all). "use", "create", "delete" accept project|user (default: project). "show" ignores scope (resolves via precedence).',
      ),
    },
    handler: async ({ action, name, backend, pi, agents, overwrite, force, scope }, { cwd: toolCwd }) => {
      if (action === 'list') {
        const params = new URLSearchParams();
        if (scope) params.set('scope', scope);
        const qs = params.toString();
        const { data } = await daemonRequest(toolCwd, 'GET', `${API_ROUTES.profileList}${qs ? `?${qs}` : ''}`);
        return data;
      }

      if (action === 'show') {
        const { data } = await daemonRequest(toolCwd, 'GET', API_ROUTES.profileShow);
        return data;
      }

      if (action === 'use') {
        if (!name) throw new Error('"name" is required when action is "use"');
        const useBody: Record<string, unknown> = { name };
        if (scope) useBody.scope = scope;
        const { data } = await daemonRequest(toolCwd, 'POST', API_ROUTES.profileUse, useBody);
        return data;
      }

      if (action === 'create') {
        if (!name) throw new Error('"name" is required when action is "create"');
        if (backend !== 'claude-sdk' && backend !== 'pi') {
          throw new Error('"backend" is required when action is "create" (must be "claude-sdk" or "pi")');
        }
        const body: Record<string, unknown> = { name, backend };
        if (pi !== undefined) body.pi = pi;
        if (agents !== undefined) body.agents = agents;
        if (overwrite !== undefined) body.overwrite = overwrite;
        if (scope) body.scope = scope;
        const { data } = await daemonRequest(toolCwd, 'POST', API_ROUTES.profileCreate, body);
        return data;
      }

      // action === 'delete'
      if (!name) throw new Error('"name" is required when action is "delete"');
      const body: Record<string, unknown> = {};
      if (force !== undefined) body.force = force;
      if (scope) body.scope = scope;
      const { data } = await daemonRequest(toolCwd, 'DELETE', buildPath(API_ROUTES.profileDelete, { name }), body);
      return data;
    },
  });

  // Tool: eforge_models
  createDaemonTool(server, cwd, {
    name: 'eforge_models',
    description: 'List providers or models available for a given backend. Actions: "providers" returns provider names (claude-sdk is implicit / returns []); "list" returns models, optionally filtered to a single provider, newest-first.',
    schema: {
      action: z.enum(['providers', 'list']).describe("'providers' returns provider names, 'list' returns available models"),
      backend: z.enum(['claude-sdk', 'pi']).describe('Which backend to query'),
      provider: z.string().optional().describe('Optional provider filter for "list" (Pi only). Ignored for claude-sdk.'),
    },
    handler: async ({ action, backend, provider }, { cwd: toolCwd }) => {
      if (action === 'providers') {
        const { data } = await daemonRequest(toolCwd, 'GET', `${API_ROUTES.modelProviders}?backend=${encodeURIComponent(backend)}`);
        return data;
      }
      // action === 'list'
      const params = new URLSearchParams({ backend });
      if (provider) params.set('provider', provider);
      const { data } = await daemonRequest(toolCwd, 'GET', `${API_ROUTES.modelList}?${params.toString()}`);
      return data;
    },
  });

  // Tool: eforge_daemon
  createDaemonTool(server, cwd, {
    name: 'eforge_daemon',
    description: 'Manage the eforge daemon lifecycle: start, stop, or restart the daemon.',
    schema: {
      action: z.enum(['start', 'stop', 'restart']).describe("'start' ensures daemon is running, 'stop' gracefully stops it, 'restart' stops then starts"),
      force: z.boolean().optional().describe('When action is "stop" or "restart", force shutdown even if builds are active. Default: false.'),
    },
    handler: async ({ action, force }, { cwd: toolCwd }) => {
      async function checkActiveBuilds(): Promise<string | null> {
        try {
          const { data: latestRun } = await daemonRequest<LatestRunResponse>(toolCwd, 'GET', API_ROUTES.latestRun);
          if (!latestRun?.sessionId) return null;
          const { data: summary } = await daemonRequest<RunSummary>(toolCwd, 'GET', buildPath(API_ROUTES.runSummary, { id: latestRun.sessionId }));
          if (summary?.status === 'running') {
            return 'An eforge build is currently active. Use force: true to stop anyway.';
          }
          return null;
        } catch {
          return null;
        }
      }

      async function stopDaemon(forceStop: boolean): Promise<{ stopped: boolean; message: string }> {
        const lock = readLockfile(toolCwd);
        if (!lock) {
          return { stopped: true, message: 'Daemon is not running.' };
        }

        if (!forceStop) {
          const activeMessage = await checkActiveBuilds();
          if (activeMessage) {
            return { stopped: false, message: activeMessage };
          }
        }

        try {
          await daemonRequest(toolCwd, 'POST', API_ROUTES.daemonStop, { force: forceStop });
        } catch {
          // Daemon may have already shut down before responding
        }

        const deadline = Date.now() + LOCKFILE_POLL_TIMEOUT_MS;
        while (Date.now() < deadline) {
          await sleep(LOCKFILE_POLL_INTERVAL_MS);
          const current = readLockfile(toolCwd);
          if (!current) {
            return { stopped: true, message: 'Daemon stopped successfully.' };
          }
        }

        return { stopped: true, message: 'Daemon stop requested. Lockfile may take a moment to clear.' };
      }

      if (action === 'start') {
        const port = await ensureDaemon(toolCwd);
        return { status: 'running', port };
      }

      if (action === 'stop') {
        const result = await stopDaemon(force === true);
        if (!result.stopped) {
          throw new McpUserError({ error: result.message });
        }
        return { status: 'stopped', message: result.message };
      }

      // action === 'restart'
      const stopResult = await stopDaemon(force === true);
      if (!stopResult.stopped) {
        throw new McpUserError({ error: stopResult.message });
      }
      const port = await ensureDaemon(toolCwd);
      return { status: 'restarted', port, message: 'Daemon restarted successfully.' };
    },
  });

  // Tool: eforge_init
  createDaemonTool(server, cwd, {
    name: 'eforge_init',
    description: 'Initialize eforge in a project: creates a named backend profile under eforge/profiles/, activates it, and writes eforge/config.yaml for team-wide settings. Presents an elicitation form for backend, provider, and model selection. With migrate: true, extracts backend config from an existing pre-overhaul config.yaml into a named profile.',
    schema: {
      force: z.boolean().optional().describe('Overwrite existing eforge/config.yaml if it already exists. Default: false.'),
      postMergeCommands: z.array(z.string()).optional().describe('Post-merge validation commands (e.g. ["pnpm install", "pnpm test"]). Only applied when creating a new config, not when merging with existing.'),
      migrate: z.boolean().optional().describe('Extract backend config from existing pre-overhaul config.yaml into a named profile and strip config.yaml. Default: false.'),
    },
    handler: async ({ force, postMergeCommands, migrate }, { cwd: toolCwd, server: toolServer }) => {
      const configDir = join(toolCwd, 'eforge');
      const configPath = join(configDir, 'config.yaml');

      // Ensure .gitignore has daemon state (.eforge/) and the per-developer active-profile marker.
      await ensureGitignoreEntries(toolCwd, ['.eforge/', 'eforge/.active-profile']);

      // --- Migrate mode ---
      if (migrate) {
        let rawYaml: string;
        try {
          rawYaml = await readFile(configPath, 'utf-8');
        } catch {
          throw new McpUserError({ error: 'No existing eforge/config.yaml found. Nothing to migrate.' });
        }

        let data: Record<string, unknown>;
        try {
          const parsed = parseYaml(rawYaml);
          if (!parsed || typeof parsed !== 'object') {
            throw new McpUserError({ error: 'Existing config.yaml is empty or not an object.' });
          }
          data = parsed as Record<string, unknown>;
        } catch (err) {
          if (err instanceof McpUserError) throw err;
          throw new McpUserError({ error: `Failed to parse config.yaml: ${err instanceof Error ? err.message : String(err)}` });
        }

        if (data.backend === undefined) {
          throw new McpUserError({ error: 'config.yaml has no top-level "backend:" field. Nothing to migrate.' });
        }

        const { profile, remaining } = parseRawConfigLegacy(data);
        const backend = profile.backend as string;

        let maxModelId: string | undefined;
        let provider: string | undefined;
        const agents = profile.agents as Record<string, unknown> | undefined;
        if (agents?.models) {
          const models = agents.models as Record<string, unknown>;
          const maxModel = models.max as { id?: string; provider?: string } | undefined;
          maxModelId = maxModel?.id;
          provider = maxModel?.provider;
        } else if (agents?.model) {
          const model = agents.model as { id?: string; provider?: string };
          maxModelId = model.id;
          provider = model.provider;
        }

        const profileName = maxModelId
          ? sanitizeProfileName(backend, provider, maxModelId)
          : backend;

        const createBody: Record<string, unknown> = {
          name: profileName,
          backend,
          overwrite: true,
        };
        if (profile.agents) createBody.agents = profile.agents;
        if (profile.pi) createBody.pi = profile.pi;

        await daemonRequest(toolCwd, 'POST', API_ROUTES.profileCreate, createBody);

        const yamlOut = Object.keys(remaining).length > 0
          ? stringifyYaml(remaining)
          : '';
        await writeFile(configPath, yamlOut, 'utf-8');

        await daemonRequest(toolCwd, 'POST', API_ROUTES.profileUse, { name: profileName });

        return {
          status: 'migrated',
          configPath: 'eforge/config.yaml',
          profileName,
          profilePath: `eforge/profiles/${profileName}.yaml`,
          backend,
          moved: Object.keys(profile),
          kept: Object.keys(remaining),
        };
      }

      // --- Fresh init mode ---

      try {
        await access(configPath);
        if (!force) {
          throw new McpUserError({
            error: 'eforge/config.yaml already exists. Use force: true to overwrite, or migrate: true to extract backend config into a profile.',
          });
        }
      } catch (err) {
        if (err instanceof McpUserError) throw err;
        // File does not exist - proceed
      }

      // Elicit backend choice from user
      let backend: string;
      try {
        const result = await toolServer.server.elicitInput({
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
          return { status: 'declined', message: 'Initialization declined by user.' };
        }
        if (result.action === 'cancel' || !result.content) {
          return { status: 'cancelled', message: 'Initialization cancelled.' };
        }
        backend = result.content.backend as string;
      } catch (err) {
        if (err instanceof McpUserError) throw err;
        throw new McpUserError({
          error: `Elicitation failed: ${err instanceof Error ? err.message : String(err)}. You can use /eforge:config instead.`,
        });
      }

      // Elicit provider (if pi, via /api/models/providers)
      let provider: string | undefined;
      if (backend === 'pi') {
        try {
          const { data: providersResp } = await daemonRequest<{ providers: string[] }>(toolCwd, 'GET', `${API_ROUTES.modelProviders}?backend=pi`);
          if (providersResp.providers.length > 0) {
            const providerSchema = {
              type: 'object' as const,
              properties: {
                provider: {
                  type: 'string' as const,
                  title: 'Provider',
                  description: 'Which provider to use',
                  oneOf: providersResp.providers.map((p) => ({ const: p, title: p })),
                  default: providersResp.providers[0],
                },
              },
              required: ['provider'],
            };
            const provResult = await toolServer.server.elicitInput({
              mode: 'form',
              message: 'Select a provider:',
              requestedSchema: providerSchema,
            });
            if (provResult.action === 'accept' && provResult.content) {
              provider = provResult.content.provider as string;
            }
          }
        } catch {
          // Best-effort provider selection
        }
      }

      // Elicit max model (via /api/models/list)
      let maxModelId: string | undefined;
      try {
        const params = new URLSearchParams({ backend });
        if (provider) params.set('provider', provider);
        const { data: modelsResp } = await daemonRequest<{ models: Array<{ id: string; provider?: string }> }>(
          toolCwd, 'GET', `${API_ROUTES.modelList}?${params.toString()}`,
        );
        if (modelsResp.models.length > 0) {
          const topModels = modelsResp.models.slice(0, 10);
          const modelSchema = {
            type: 'object' as const,
            properties: {
              model: {
                type: 'string' as const,
                title: 'Max Model',
                description: 'Primary model for heavy reasoning (planners, reviewers). Used for all model classes by default.',
                oneOf: topModels.map((m) => ({ const: m.id, title: m.id })),
                default: topModels[0].id,
              },
            },
            required: ['model'],
          };
          const modelResult = await toolServer.server.elicitInput({
            mode: 'form',
            message: 'Select the max model:',
            requestedSchema: modelSchema,
          });
          if (modelResult.action === 'accept' && modelResult.content) {
            maxModelId = modelResult.content.model as string;
          } else {
            maxModelId = topModels[0].id;
          }
        }
      } catch {
        // Best-effort model selection
      }

      const profileName = maxModelId
        ? sanitizeProfileName(backend, provider, maxModelId)
        : backend;

      const modelRef: Record<string, string> = maxModelId ? { id: maxModelId } : { id: 'claude-opus-4-7' };
      if (provider) modelRef.provider = provider;

      const createBody: Record<string, unknown> = {
        name: profileName,
        backend,
        agents: {
          models: {
            max: { ...modelRef },
            balanced: { ...modelRef },
            fast: { ...modelRef },
          },
        },
      };
      if (force) createBody.overwrite = true;
      await daemonRequest(toolCwd, 'POST', API_ROUTES.profileCreate, createBody);

      await daemonRequest(toolCwd, 'POST', API_ROUTES.profileUse, { name: profileName });

      try {
        await mkdir(configDir, { recursive: true });
      } catch {
        // Directory may already exist
      }

      const configData: Record<string, unknown> = {};
      if (postMergeCommands && postMergeCommands.length > 0) {
        configData.build = { postMergeCommands };
      }
      const configContent = Object.keys(configData).length > 0
        ? stringifyYaml(configData)
        : '';
      await writeFile(configPath, configContent, 'utf-8');

      let validation: ConfigValidateResponse | null = null;
      try {
        const { data } = await daemonRequest<ConfigValidateResponse>(toolCwd, 'GET', API_ROUTES.configValidate);
        validation = data;
      } catch {
        // Daemon validation is best-effort
      }

      const response: Record<string, unknown> = {
        status: 'initialized',
        configPath: 'eforge/config.yaml',
        profileName,
        profilePath: `eforge/profiles/${profileName}.yaml`,
        backend,
      };

      if (validation) {
        response.validation = validation;
      }

      return response;
    },
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
