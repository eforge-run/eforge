/**
 * MCP stdio proxy server.
 *
 * Bridges MCP tool calls from Claude Code to the eforge daemon's HTTP API.
 * Auto-starts the daemon if not running. Called via `eforge mcp-proxy`.
 */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFile, writeFile, access, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { ensureDaemon, daemonRequest, daemonRequestIfRunning, sleep, readLockfile, subscribeWithSnapshot, aggregateSessionSummary, eventToProgress, LOCKFILE_POLL_INTERVAL_MS, LOCKFILE_POLL_TIMEOUT_MS, API_ROUTES, buildPath, apiRecover, apiReadRecoverySidecar, apiApplyRecovery, apiGetRunningRuns, apiGetRunningSessionSummaries, apiListExtensions, apiShowExtension, apiValidateExtensions, apiNewExtension, apiReloadExtensions } from '@eforge-build/client';
import { deriveProfileName } from '@eforge-build/engine/config';
import type {
  RunInfo,
  EnqueueResponse,
  RunSummary,
  ConfigValidateResponse,
  DaemonStreamEvent,
  SessionSummary,
  SessionStreamSnapshot,
  FollowCounters,
  VersionResponse,
  ExtensionNewRequest,
} from '@eforge-build/client';
import { createDaemonTool, McpUserError, formatResourceJson } from './mcp-tool-factory.js';

declare const EFORGE_VERSION: string;



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
        const { data: runs } = await requireDaemon<RunInfo[]>('GET', API_ROUTES.runs);
        const latestRun = runs[0] ?? null;
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
      profile: z
        .string()
        .optional()
        .describe('Run this build on the named profile instead of the active profile'),
    },
    handler: async ({ source, profile }, { cwd: toolCwd }) => {
      const body: { source: string; profile?: string } = { source };
      if (profile) body.profile = profile;
      const { data, port } = await daemonRequest<EnqueueResponse>(toolCwd, 'POST', API_ROUTES.enqueue, body);
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
      const events: DaemonStreamEvent[] = [];

      try {
        // Resolve base URL from lockfile — consistent with the pre-plan-02 subscriber
        // behavior which did the same resolution internally.
        const lock = readLockfile(toolCwd);
        if (!lock) throw new Error('Daemon not running — lockfile not found');
        const monitorUrl = `http://127.0.0.1:${lock.port}`;
        const url = `${monitorUrl}${buildPath(API_ROUTES.events, { runId: sessionId })}`;

        for await (const frame of subscribeWithSnapshot<SessionStreamSnapshot, DaemonStreamEvent>(
          url,
          { signal },
        )) {
          if (frame.kind === 'snapshot') {
            const snapshot = frame.snapshot;
            // Re-seed events from snapshot (handles initial connect and reconnect).
            events.length = 0;
            for (const ev of snapshot.events) {
              try {
                events.push(JSON.parse(ev.data) as DaemonStreamEvent);
              } catch { /* skip unparseable */ }
            }
            // If terminal, aggregate from snapshot events and stop.
            if (snapshot.status === 'completed' || snapshot.status === 'failed') {
              summary = aggregateSessionSummary(sessionId, events, monitorUrl);
              break;
            }
          } else if (frame.kind === 'event') {
            events.push(frame.event);
            const update = eventToProgress(frame.event, counters);
            if (update) {
              counters = update.counters;
              // Fire-and-forget; emitProgress swallows its own errors.
              void emitProgress(update.message);
            }
            if (frame.event.type === 'session:end') {
              summary = aggregateSessionSummary(sessionId, events, monitorUrl);
              break;
            }
          }
        }
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
    description: 'Get the current run status including plan progress, session state, event summary, and the daemon vs CLI version.',
    schema: {},
    handler: async (_args, { cwd: toolCwd }) => {
      // Always include version info — diagnostic for "is the running daemon
      // stale relative to the CLI on $PATH?". Resolved best-effort: a missing
      // eforgeVersion means we're talking to a pre-version-aware daemon.
      const { data: versionData } = await daemonRequest<VersionResponse>(toolCwd, 'GET', API_ROUTES.version);
      const daemonVersion = versionData.eforgeVersion ?? 'unknown (pre-version-aware daemon)';
      const cliVersion = EFORGE_VERSION;
      const versionMismatch = versionData.eforgeVersion !== undefined && daemonVersion !== cliVersion;
      const versions = {
        daemonVersion,
        cliVersion,
        ...(versionMismatch && {
          versionMismatch: 'Daemon was built from a different commit than the CLI on $PATH. Restart the daemon (`eforge daemon restart`) to pick up the latest build.',
        }),
      };

      const summaries = await apiGetRunningSessionSummaries({ cwd: toolCwd });
      if (summaries.length === 0) {
        return { status: 'idle', message: 'No active eforge sessions.', ...versions };
      }
      return {
        status: 'active',
        builds: summaries.map(({ run, summary }) => ({
          ...summary,
          runId: run.id,
          command: run.command,
        })),
        ...versions,
      };
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
    description: 'Show resolved eforge configuration or validate eforge/config.yaml. Config merges three tiers: user (~/.config/eforge/config.yaml), project (eforge/config.yaml), and project-local (.eforge/config.yaml, gitignored). Pass verbose: true with action "show" to see per-tier file presence.',
    schema: {
      action: z.enum(['show', 'validate']).describe("'show' returns resolved config, 'validate' checks for errors"),
      verbose: z.boolean().optional().describe('When true and action is "show", returns per-tier file presence alongside the merged result.'),
    },
    handler: async ({ action, verbose }, { cwd: toolCwd }) => {
      if (action === 'validate') {
        const { data } = await daemonRequest(toolCwd, 'GET', API_ROUTES.configValidate);
        return data;
      }
      const qs = verbose ? '?verbose=1' : '';
      const { data } = await daemonRequest(toolCwd, 'GET', `${API_ROUTES.configShow}${qs}`);
      return data;
    },
  });

  // Tool: eforge_profile
  createDaemonTool(server, cwd, {
    name: 'eforge_profile',
    description: 'Manage named profiles in eforge/profiles/ (project), .eforge/profiles/ (local, gitignored), or ~/.config/eforge/profiles/ (user). Actions: "list" enumerates profiles and reports which is active; "show" returns the resolved active profile; "use" writes the active-profile marker to switch profiles; "create" writes a new profile (pass `agents.tiers` with self-contained tier recipes; optionally pass `metadata` with `description`, `whenToUse`, and `tags` — descriptive only, does not affect runtime behavior); "delete" removes a profile (refuses when active unless force: true).',
    schema: {
      action: z.enum(['list', 'show', 'use', 'create', 'delete']).describe(
        "'list' enumerates profiles, 'show' returns the resolved active profile, 'use' switches the active profile, 'create' writes a new profile, 'delete' removes a profile",
      ),
      name: z.string().optional().describe('Profile name (required for "use", "create", and "delete")'),
      agents: z.record(z.string(), z.any()).optional().describe('Agents config block to embed in the profile (required for "create"; must include agents.tiers with tier recipes)'),
      metadata: z.object({
        description: z.string().optional().describe('Human-readable description of what this profile is for'),
        whenToUse: z.array(z.string()).optional().describe('Scenarios when this profile should be used'),
        tags: z.array(z.string()).optional().describe('Tags for categorizing this profile'),
      }).optional().describe('Descriptive metadata for the profile (does not affect runtime behavior)'),
      overwrite: z.boolean().optional().describe('Overwrite an existing profile when creating. Default: false.'),
      force: z.boolean().optional().describe('Delete even if the profile is currently active. Default: false.'),
      scope: z.enum(['local', 'project', 'user', 'all']).optional().describe(
        'Scope for the operation. "list" accepts local|project|user|all (default: all). "use", "create", "delete" accept local|project|user (default: project). "local" targets .eforge/ (gitignored, dev-personal, highest precedence). "show" ignores scope (resolves via precedence).',
      ),
    },
    handler: async ({ action, name, agents, metadata, overwrite, force, scope }, { cwd: toolCwd }) => {
      if (action === 'list') {
        const params = new URLSearchParams();
        if (scope) params.set('scope', scope);
        const qs = params.toString();
        const { data } = await daemonRequest(toolCwd, 'GET', `${API_ROUTES.profileList}${qs ? `?${qs}` : ''}`);
        return data;
      }

      if (action === 'show') {
        const { data } = await daemonRequest(toolCwd, 'GET', API_ROUTES.profileShow);
        // Derive a tier toolbelt summary from the resolved profile config so
        // Claude Code skill consumers can easily surface it without digging
        // through the full profile config object.
        const resolvedProfile = (data as { resolved?: { profile?: unknown } }).resolved?.profile as {
          agents?: { tiers?: Record<string, { toolbelt?: string }> };
          tools?: { toolbelts?: Record<string, { description?: string; mcpServers: string[] }> };
        } | null | undefined;
        if (resolvedProfile?.agents?.tiers) {
          const toolbeltsRegistry = resolvedProfile.tools?.toolbelts ?? {};
          const tierToolbelts: Record<string, { toolbelt: string; mcpServers: string[] }> = {};
          for (const [tierName, tier] of Object.entries(resolvedProfile.agents.tiers)) {
            const tb = tier.toolbelt;
            tierToolbelts[tierName] = {
              toolbelt: tb === undefined ? 'all (default)' : tb,
              mcpServers: tb && tb !== 'none' ? [...(toolbeltsRegistry[tb]?.mcpServers ?? [])].sort() : [],
            };
          }
          return { ...(data as Record<string, unknown>), tierToolbelts };
        }
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
        const body: Record<string, unknown> = { name };
        if (agents !== undefined) body.agents = agents;
        if (metadata !== undefined) body.metadata = metadata;
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

  // --- eforge:region plan-02-extension-tooling-surfaces ---
  // Tool: eforge_extension
  createDaemonTool(server, cwd, {
    name: 'eforge_extension',
    description: 'Manage native eforge extensions. Actions: "list" returns all extension entries with status/provenance/diagnostics; "show" returns one extension by name; "validate" returns valid:false when extension load errors exist, optionally scoped to a name or ad-hoc path; "new" scaffolds an extension; "reload" refreshes discovery and restarts the runtime watcher when running.',
    schema: {
      action: z.enum(['list', 'show', 'validate', 'new', 'reload']).describe('Extension operation to perform'),
      name: z.string().min(1).optional().describe('Extension name (required for "show" and "new", optional for "validate")'),
      path: z.string().min(1).optional().describe('Ad-hoc extension file/directory path to validate ("validate" only)'),
      scope: z.enum(['local', 'project', 'user']).optional().describe('Scope for "new". Defaults to local.'),
      template: z.enum(['event-logger', 'blank']).optional().describe('Scaffold template for "new". Defaults to event-logger.'),
      force: z.boolean().optional().describe('Overwrite an existing extension file when action is "new". Default: false.'),
    },
    handler: async ({ action, name, path, scope, template, force }, { cwd: toolCwd }) => {
      if (action === 'list') {
        if (name !== undefined || path !== undefined || scope !== undefined || template !== undefined || force !== undefined) throw new Error('"list" does not accept name, path, scope, template, or force');
        const { data } = await apiListExtensions({ cwd: toolCwd });
        return data;
      }
      if (action === 'show') {
        if (!name) throw new Error('"name" is required when action is "show"');
        if (path !== undefined || scope !== undefined || template !== undefined || force !== undefined) throw new Error('"show" does not accept path, scope, template, or force');
        const { data } = await apiShowExtension({ cwd: toolCwd, name });
        return data;
      }
      if (action === 'validate') {
        if (scope !== undefined || template !== undefined || force !== undefined) throw new Error('"validate" does not accept scope, template, or force');
        if (name !== undefined && path !== undefined) throw new Error('Specify only one of "name" or "path" for validate');
        const request: { cwd: string; name?: string; path?: string } = { cwd: toolCwd };
        if (name !== undefined) request.name = name;
        if (path !== undefined) request.path = path;
        const { data } = await apiValidateExtensions(request);
        return data;
      }
      if (action === 'new') {
        if (!name) throw new Error('"name" is required when action is "new"');
        if (path !== undefined) throw new Error('"path" is not supported when action is "new"');
        const body: ExtensionNewRequest = { name };
        if (scope !== undefined) body.scope = scope;
        if (template !== undefined) body.template = template as ExtensionNewRequest['template'];
        if (force !== undefined) body.force = force;
        const { data } = await apiNewExtension({ cwd: toolCwd, body });
        return data;
      }
      if (name !== undefined || path !== undefined || scope !== undefined || template !== undefined || force !== undefined) throw new Error('"reload" does not accept name, path, scope, template, or force');
      const { data } = await apiReloadExtensions({ cwd: toolCwd });
      return data;
    },
  });
  // --- eforge:endregion plan-02-extension-tooling-surfaces ---

  // Tool: eforge_models
  createDaemonTool(server, cwd, {
    name: 'eforge_models',
    description: 'List providers or models available for a given harness. Actions: "providers" returns provider names (claude-sdk is implicit / returns []); "list" returns models, optionally filtered to a single provider, newest-first.',
    schema: {
      action: z.enum(['providers', 'list']).describe("'providers' returns provider names, 'list' returns available models"),
      harness: z.enum(['claude-sdk', 'pi']).describe('Which harness to query'),
      provider: z.string().optional().describe('Optional provider filter for "list" (Pi only). Ignored for claude-sdk.'),
    },
    handler: async ({ action, harness, provider }, { cwd: toolCwd }) => {
      if (action === 'providers') {
        const { data } = await daemonRequest(toolCwd, 'GET', `${API_ROUTES.modelProviders}?harness=${encodeURIComponent(harness)}`);
        return data;
      }
      // action === 'list'
      const params = new URLSearchParams({ harness });
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
          const { data: runs } = await apiGetRunningRuns({ cwd: toolCwd });
          // Mirrors checkActiveBuildsMessage from packages/pi-eforge/extensions/eforge/pure-helpers.ts
          if (runs.length === 0) return null;
          if (runs.length === 1) {
            return 'An eforge build is currently active. Use force: true to stop anyway.';
          }
          return `${runs.length} eforge builds are currently active. Use force: true to stop anyway.`;
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
    description: 'Initialize eforge in a project. The skill is responsible for picking harness/model/effort per tier interactively; the tool is a pure persister. Pass `profile.tiers` with one self-contained recipe per tier (planning/implementation/review/evaluation). Each tier carries its own harness + model + effort.',
    schema: {
      force: z.boolean().optional().describe('Overwrite existing eforge/config.yaml if it already exists. Default: false.'),
      postMergeCommands: z.array(z.string()).optional().describe('Post-merge validation commands. Only applied when creating a new config.'),
      existingProfile: z.object({
        name: z.string().describe('Name of the existing local- or user-scope profile to activate.'),
        scope: z.enum(['local', 'user']).describe('Scope of the existing profile.'),
      }).optional().describe('Existing local- or user-scope profile to activate. Existing profiles may use any supported harness. When provided, skips profile creation and activates the profile directly.'),
      profile: z.object({
        name: z.string().optional().describe('Profile name. Auto-derived via deriveProfileName when omitted.'),
        tiers: z.record(
          z.enum(['planning', 'implementation', 'review', 'evaluation']),
          z.object({
            harness: z.enum(['claude-sdk', 'pi']),
            model: z.string(),
            effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
            thinking: z.boolean().optional(),
            pi: z.object({ provider: z.string() }).optional(),
            claudeSdk: z.object({ disableSubagents: z.boolean().optional() }).optional(),
          }),
        ).describe('Self-contained tier recipes — each tier carries harness + model + effort + tuning'),
      }).optional().describe('Multi-tier profile spec. When omitted, falls back to a minimal claude-sdk default and emits a deprecation note.'),
    },
    handler: async ({ force, postMergeCommands, existingProfile, profile }, { cwd: toolCwd }) => {
      const configDir = join(toolCwd, 'eforge');
      const configPath = join(configDir, 'config.yaml');

      // Ensure .gitignore has daemon state (.eforge/) and the per-developer active-profile marker.
      await ensureGitignoreEntries(toolCwd, ['.eforge/', 'eforge/.active-profile']);

      // --- Conflict validation ---
      if (existingProfile) {
        if (profile) {
          throw new McpUserError({ error: '`existingProfile` and `profile` cannot be set at the same time.' });
        }
        if (existingProfile.scope !== 'local' && existingProfile.scope !== 'user') {
          throw new McpUserError({ error: 'The init skill only supports local- or user-scope existing profiles. Use `existingProfile.scope: "local"` or `"user"`.' });
        }
      }

      // --- Existing profile mode ---

      if (existingProfile) {
        let configExists = false;
        try {
          await access(configPath);
          configExists = true;
        } catch {
          // File does not exist - proceed
        }
        if (configExists && !force) {
          throw new McpUserError({
            error: 'eforge/config.yaml already exists. Use force: true to overwrite, or migrate: true to extract legacy harness config into a profile.',
          });
        }

        // Write a sentinel file before calling profile/use so the daemon can
        // discover this fresh project's eforge config directory.
        let wroteExistingProfileSentinel = false;
        if (!configExists) {
          await mkdir(configDir, { recursive: true });
          await writeFile(configPath, '', 'utf-8');
          wroteExistingProfileSentinel = true;
        }

        try {
          await daemonRequest(toolCwd, 'POST', API_ROUTES.profileUse, { name: existingProfile.name, scope: existingProfile.scope });
        } catch (err) {
          if (wroteExistingProfileSentinel) {
            try {
              await unlink(configPath);
            } catch (cleanupErr) {
              process.stderr.write(`eforge_init: failed to remove sentinel ${configPath} after profileUse error: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}\n`);
            }
          }
          throw err;
        }

        const existingProfileConfigData: Record<string, unknown> = {};
        if (postMergeCommands && postMergeCommands.length > 0) {
          existingProfileConfigData.build = { postMergeCommands };
        }
        const existingProfileConfigContent = Object.keys(existingProfileConfigData).length > 0
          ? stringifyYaml(existingProfileConfigData)
          : '';
        await writeFile(configPath, existingProfileConfigContent, 'utf-8');

        let existingProfileValidation: ConfigValidateResponse | null = null;
        try {
          const { data } = await daemonRequest<ConfigValidateResponse>(toolCwd, 'GET', API_ROUTES.configValidate);
          existingProfileValidation = data;
        } catch {
          // Daemon validation is best-effort
        }

        const existingProfileResponse: Record<string, unknown> = {
          status: 'initialized',
          configPath: 'eforge/config.yaml',
          profileName: existingProfile.name,
          source: `${existingProfile.scope}-scope`,
          activatedExistingProfile: true,
        };
        if (existingProfileValidation) existingProfileResponse.validation = existingProfileValidation;
        return existingProfileResponse;
      }

      // --- Fresh init mode ---

      let freshConfigExists = false;
      try {
        await access(configPath);
        freshConfigExists = true;
      } catch {
        // File does not exist - proceed
      }
      if (freshConfigExists && !force) {
        throw new McpUserError({
          error: 'eforge/config.yaml already exists. Use force: true to overwrite.',
        });
      }

      // Resolve effective tier recipes spec
      let deprecation: string | undefined;
      let resolvedTiers: Record<string, { harness: 'claude-sdk' | 'pi'; model: string; effort: string; thinking?: boolean; pi?: { provider: string }; claudeSdk?: { disableSubagents?: boolean } }>;

      if (profile) {
        resolvedTiers = profile.tiers as Record<string, { harness: 'claude-sdk' | 'pi'; model: string; effort: string; thinking?: boolean; pi?: { provider: string }; claudeSdk?: { disableSubagents?: boolean } }>;
      } else {
        // Minimal default fallback for legacy callers
        resolvedTiers = {
          planning: { harness: 'claude-sdk', model: 'claude-opus-4-7', effort: 'high' },
          implementation: { harness: 'claude-sdk', model: 'claude-sonnet-4-6', effort: 'medium' },
          review: { harness: 'claude-sdk', model: 'claude-opus-4-7', effort: 'high' },
          evaluation: { harness: 'claude-sdk', model: 'claude-opus-4-7', effort: 'high' },
        };
        deprecation = 'eforge_init was called without a profile parameter. Future versions will require it. Update your skill or harness wrapper.';
      }

      // Compute profile name (use skill-supplied name if present, otherwise derive from tiers)
      const profileName = profile?.name ?? deriveProfileName({ agents: { tiers: resolvedTiers } });

      // Build agents block
      const agentsBlock: Record<string, unknown> = { tiers: resolvedTiers };

      const createBody: Record<string, unknown> = {
        name: profileName,
        overwrite: !!force,
        agents: agentsBlock,
      };

      // Write a sentinel file so the daemon can discover the config directory.
      let wroteSentinel = false;
      if (!freshConfigExists) {
        await mkdir(configDir, { recursive: true });
        await writeFile(configPath, '', 'utf-8');
        wroteSentinel = true;
      }

      try {
        await daemonRequest(toolCwd, 'POST', API_ROUTES.profileCreate, createBody);
        await daemonRequest(toolCwd, 'POST', API_ROUTES.profileUse, { name: profileName });
      } catch (err) {
        if (wroteSentinel) {
          try {
            await unlink(configPath);
          } catch (cleanupErr) {
            process.stderr.write(`eforge_init: failed to remove sentinel ${configPath} after profile setup error: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}\n`);
          }
        }
        throw err;
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
        tiers: Object.keys(resolvedTiers),
      };

      if (validation) response.validation = validation;
      if (deprecation) response.deprecation = deprecation;

      return response;
    },
  });

  // --- eforge:region plan-03-daemon-mcp-pi ---

  // Tool: eforge_recover
  createDaemonTool(server, cwd, {
    name: 'eforge_recover',
    description: 'Trigger failure recovery analysis for a failed build plan. Spawns the recovery agent as a background subprocess and returns its sessionId and pid.',
    schema: {
      setName: z.string().describe('The plan set name (e.g. the orchestration set that contained the failing plan)'),
      prdId: z.string().describe('The plan ID (prdId) that failed and needs recovery analysis'),
    },
    handler: async ({ setName, prdId }, { cwd: toolCwd }) => {
      const { data } = await apiRecover({ cwd: toolCwd, body: { setName, prdId } });
      return data;
    },
  });

  // Tool: eforge_read_recovery_sidecar
  createDaemonTool(server, cwd, {
    name: 'eforge_read_recovery_sidecar',
    description: 'Read the recovery analysis sidecar files for a failed build plan. Returns both the markdown summary and the structured JSON verdict produced by the recovery agent.',
    schema: {
      prdId: z.string().describe('The plan ID (prdId) whose recovery sidecar to read'),
    },
    handler: async ({ prdId }, { cwd: toolCwd }) => {
      const { data } = await apiReadRecoverySidecar({ cwd: toolCwd, prdId });
      return data;
    },
  });

  // --- eforge:region plan-01-backend-apply-recovery ---

  // Tool: eforge_apply_recovery
  createDaemonTool(server, cwd, {
    name: 'eforge_apply_recovery',
    description: 'Apply the recovery verdict for a failed build plan: requeue (retry), enqueue successor (split), or archive (abandon).',
    schema: {
      prdId: z.string().describe('The plan ID (prdId) whose recovery verdict to apply'),
    },
    handler: async ({ prdId }, { cwd: toolCwd }) => {
      const { data } = await apiApplyRecovery({ cwd: toolCwd, body: { prdId } });
      return data;
    },
  });

  // --- eforge:endregion plan-01-backend-apply-recovery ---

  // --- eforge:endregion plan-03-daemon-mcp-pi ---

  // --- eforge:region plan-02-daemon-http-and-mcp-tool ---

  // Tool: eforge_playbook
  createDaemonTool(server, cwd, {
    name: 'eforge_playbook',
    description: 'Manage playbooks in eforge. Actions: "list" returns all playbooks with source and shadow chain; "show" returns a single playbook\'s frontmatter and body; "save" validates and writes a playbook to the target tier; "enqueue" loads a playbook and enqueues it as a PRD, optionally chained after another queue entry; "promote" moves a playbook from project-local (.eforge/playbooks/) to project-team (eforge/playbooks/); "demote" reverses a promote; "validate" checks a raw Markdown playbook string without writing.',
    schema: {
      action: z.enum(['list', 'show', 'save', 'enqueue', 'promote', 'demote', 'validate']).describe(
        'Operation to perform on playbooks',
      ),
      name: z.string().optional().describe('Playbook name (required for "show", "enqueue", "promote", "demote")'),
      scope: z.enum(['user', 'project-team', 'project-local']).optional().describe(
        'Target scope for "save" (determines which tier directory to write to)',
      ),
      playbook: z.object({
        frontmatter: z.object({
          name: z.string(),
          description: z.string(),
          scope: z.enum(['user', 'project-team', 'project-local']),
          agentRuntime: z.string().optional(),
          postMerge: z.array(z.string()).optional(),
        }),
        body: z.object({
          goal: z.string(),
          outOfScope: z.string().optional().default(''),
          acceptanceCriteria: z.string().optional().default(''),
          plannerNotes: z.string().optional().default(''),
        }),
      }).optional().describe('Playbook content (required for "save")'),
      afterQueueId: z.string().optional().describe('Queue entry ID to depend on (optional, "enqueue" only). When set, the new PRD will have dependsOn: [afterQueueId].'),
      raw: z.string().optional().describe('Raw Markdown playbook string (required for "validate")'),
    },
    handler: async ({ action, name, scope, playbook, afterQueueId, raw }, { cwd: toolCwd }) => {
      if (action === 'list') {
        const { data } = await daemonRequest(toolCwd, 'GET', API_ROUTES.playbookList);
        return data;
      }

      if (action === 'show') {
        if (!name) throw new Error('"name" is required when action is "show"');
        const { data } = await daemonRequest(toolCwd, 'GET', `${API_ROUTES.playbookShow}?name=${encodeURIComponent(name)}`);
        return data;
      }

      if (action === 'save') {
        if (!scope) throw new Error('"scope" is required when action is "save"');
        if (!playbook) throw new Error('"playbook" is required when action is "save"');
        const { data } = await daemonRequest(toolCwd, 'POST', API_ROUTES.playbookSave, { scope, playbook });
        return data;
      }

      if (action === 'enqueue') {
        if (!name) throw new Error('"name" is required when action is "enqueue"');
        const body: Record<string, unknown> = { name };
        if (afterQueueId !== undefined) body.afterQueueId = afterQueueId;
        const { data } = await daemonRequest(toolCwd, 'POST', API_ROUTES.playbookEnqueue, body);
        return data;
      }

      if (action === 'promote') {
        if (!name) throw new Error('"name" is required when action is "promote"');
        const { data } = await daemonRequest(toolCwd, 'POST', API_ROUTES.playbookPromote, { name });
        return data;
      }

      if (action === 'demote') {
        if (!name) throw new Error('"name" is required when action is "demote"');
        const { data } = await daemonRequest(toolCwd, 'POST', API_ROUTES.playbookDemote, { name });
        return data;
      }

      // action === 'validate'
      if (!raw) throw new Error('"raw" is required when action is "validate"');
      const { data } = await daemonRequest(toolCwd, 'POST', API_ROUTES.playbookValidate, { raw });
      return data;
    },
  });

  // --- eforge:endregion plan-02-daemon-http-and-mcp-tool ---

  // --- eforge:region plan-03-tools-and-skills ---

  // Tool: eforge_session_plan
  createDaemonTool(server, cwd, {
    name: 'eforge_session_plan',
    description: 'Manage session plans in eforge. Actions: "list-active" returns all active (planning/ready) session plans; "show" returns a single session plan\'s data and readiness detail; "create" creates a new session plan file; "set-section" writes a dimension section to the session file; "skip-dimension" records a skipped dimension with a reason; "set-status" updates the session plan status (e.g. to "ready" or "abandoned"); "select-dimensions" sets planning type and depth and populates the required/optional dimension lists from the work-type playbook; "readiness" checks whether all required dimensions are covered; "migrate-legacy" converts a legacy boolean-dimensions session file to the current shape. Pass open: true on "create" or "show" to best-effort open the session plan file in the default application.',
    schema: {
      action: z.enum([
        'list-active',
        'show',
        'create',
        'set-section',
        'skip-dimension',
        'set-status',
        'select-dimensions',
        'readiness',
        'migrate-legacy',
      ]).describe('Operation to perform on session plans'),
      session: z.string().optional().describe('Session ID (required for all actions except "list-active")'),
      topic: z.string().optional().describe('Session topic (required for "create")'),
      dimension: z.string().optional().describe('Dimension name in kebab-case (required for "set-section" and "skip-dimension")'),
      content: z.string().optional().describe('Dimension content (required for "set-section")'),
      reason: z.string().optional().describe('Reason for skipping (required for "skip-dimension")'),
      status: z.enum(['planning', 'ready', 'abandoned', 'submitted']).optional().describe('New status (required for "set-status")'),
      planning_type: z.enum(['bugfix', 'feature', 'refactor', 'architecture', 'docs', 'maintenance', 'unknown']).optional().describe('Planning work type (optional for "create" and "select-dimensions")'),
      planning_depth: z.enum(['quick', 'focused', 'deep']).optional().describe('Planning depth (optional for "create" and "select-dimensions")'),
      open: z.boolean().optional().describe('When true, best-effort opens the resulting session plan file in the user\'s default application. Used by the /eforge:plan skill on create and on show after a session is selected.'),
    },
    handler: async ({ action, session, topic, dimension, content, reason, status, planning_type, planning_depth, open }, { cwd: toolCwd }) => {
      if (action === 'list-active') {
        const { data } = await daemonRequest(toolCwd, 'GET', API_ROUTES.sessionPlanList);
        return data;
      }

      if (action === 'show') {
        if (!session) throw new Error('"session" is required when action is "show"');
        const { data } = await daemonRequest(toolCwd, 'GET', `${API_ROUTES.sessionPlanShow}?session=${encodeURIComponent(session)}`);
        if (open === true && typeof (data as Record<string, unknown>).path === 'string') {
          const { openSessionPlanFile } = await import('./open-session-plan.js');
          const openStatus = openSessionPlanFile({ path: (data as Record<string, unknown>).path as string, cwd: toolCwd });
          return { ...(data as Record<string, unknown>), open: openStatus };
        }
        return data;
      }

      if (action === 'create') {
        if (!session) throw new Error('"session" is required when action is "create"');
        if (!topic) throw new Error('"topic" is required when action is "create"');
        const body: Record<string, unknown> = { session, topic };
        if (planning_type !== undefined) body.planning_type = planning_type;
        if (planning_depth !== undefined) body.planning_depth = planning_depth;
        const { data } = await daemonRequest(toolCwd, 'POST', API_ROUTES.sessionPlanCreate, body);
        if (open === true && typeof (data as Record<string, unknown>).path === 'string') {
          const { openSessionPlanFile } = await import('./open-session-plan.js');
          const openStatus = openSessionPlanFile({ path: (data as Record<string, unknown>).path as string, cwd: toolCwd });
          return { ...(data as Record<string, unknown>), open: openStatus };
        }
        return data;
      }

      if (action === 'set-section') {
        if (!session) throw new Error('"session" is required when action is "set-section"');
        if (!dimension) throw new Error('"dimension" is required when action is "set-section"');
        if (content === undefined) throw new Error('"content" is required when action is "set-section"');
        const { data } = await daemonRequest(toolCwd, 'POST', API_ROUTES.sessionPlanSetSection, { session, dimension, content });
        return data;
      }

      if (action === 'skip-dimension') {
        if (!session) throw new Error('"session" is required when action is "skip-dimension"');
        if (!dimension) throw new Error('"dimension" is required when action is "skip-dimension"');
        if (!reason) throw new Error('"reason" is required when action is "skip-dimension"');
        const { data } = await daemonRequest(toolCwd, 'POST', API_ROUTES.sessionPlanSkipDimension, { session, dimension, reason });
        return data;
      }

      if (action === 'set-status') {
        if (!session) throw new Error('"session" is required when action is "set-status"');
        if (!status) throw new Error('"status" is required when action is "set-status"');
        const { data } = await daemonRequest(toolCwd, 'POST', API_ROUTES.sessionPlanSetStatus, { session, status });
        return data;
      }

      if (action === 'select-dimensions') {
        if (!session) throw new Error('"session" is required when action is "select-dimensions"');
        const body: Record<string, unknown> = { session };
        if (planning_type !== undefined) body.planning_type = planning_type;
        if (planning_depth !== undefined) body.planning_depth = planning_depth;
        const { data } = await daemonRequest(toolCwd, 'POST', API_ROUTES.sessionPlanSelectDimensions, body);
        return data;
      }

      if (action === 'readiness') {
        if (!session) throw new Error('"session" is required when action is "readiness"');
        const { data } = await daemonRequest(toolCwd, 'GET', `${API_ROUTES.sessionPlanReadiness}?session=${encodeURIComponent(session)}`);
        return data;
      }

      // action === 'migrate-legacy'
      if (!session) throw new Error('"session" is required when action is "migrate-legacy"');
      const { data } = await daemonRequest(toolCwd, 'POST', API_ROUTES.sessionPlanMigrateLegacy, { session });
      return data;
    },
  });

  // --- eforge:endregion plan-03-tools-and-skills ---

  const transport = new StdioServerTransport();
  await server.connect(transport);

  installStdinExitHandlers(process.stdin);
}

export function installStdinExitHandlers(stdin: NodeJS.ReadableStream): void {
  stdin.on('close', () => process.exit(0));
  stdin.on('end', () => process.exit(0));
}
