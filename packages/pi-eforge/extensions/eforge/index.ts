/**
 * eforge Pi extension — bridges eforge daemon operations into Pi as tools and commands.
 *
 * Provides the same tool surface as the Claude Code MCP proxy (src/cli/mcp-proxy.ts),
 * but as native Pi tools that talk directly to the daemon HTTP API.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { readFileSync, accessSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  readLockfile,
  isServerAlive,
  ensureDaemon,
  daemonRequest,
  sleep,
  sanitizeProfileName,
  parseRawConfigLegacy,
} from '@eforge-build/client';
import type { LatestRunResponse, EnqueueResponse, RunSummary, ConfigValidateResponse, QueueItem, AutoBuildState, ConfigShowResponse } from '@eforge-build/client';
import { handleBackendCommand, handleBackendNewCommand } from './backend-commands';
import { handleConfigCommand } from './config-command';
import type { UIContext } from './ui-helpers';

const LOCKFILE_POLL_INTERVAL_MS = 250;
const LOCKFILE_POLL_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Quote a string for safe YAML scalar interpolation. */
function yamlQuote(value: string): string {
  if (/[:\[\]{}&*?|>!%#`@,\n"']/.test(value) || value !== value.trim()) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}

function jsonResult(data: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function withMonitorUrl(
  data: Record<string, unknown>,
  port: number,
): Record<string, unknown> {
  return { ...data, monitorUrl: `http://localhost:${port}` };
}

async function checkActiveBuilds(
  cwd: string,
): Promise<string | null> {
  try {
    const { data: latestRun } = await daemonRequest<LatestRunResponse>(
      cwd,
      "GET",
      "/api/latest-run",
    );
    if (!latestRun?.sessionId) return null;
    const { data: summary } = await daemonRequest<RunSummary>(
      cwd,
      "GET",
      `/api/run-summary/${encodeURIComponent(latestRun.sessionId)}`,
    );
    if (summary?.status === "running") {
      return "An eforge build is currently active. Use force: true to stop anyway.";
    }
    return null;
  } catch {
    return null;
  }
}

async function stopDaemon(
  cwd: string,
  force: boolean,
): Promise<{ stopped: boolean; message: string }> {
  const lock = readLockfile(cwd);
  if (!lock) {
    return { stopped: true, message: "Daemon is not running." };
  }

  if (!force) {
    const activeMessage = await checkActiveBuilds(cwd);
    if (activeMessage) {
      return { stopped: false, message: activeMessage };
    }
  }

  try {
    await daemonRequest(cwd, "POST", "/api/daemon/stop", { force });
  } catch {
    // Daemon may have already shut down before responding
  }

  const deadline = Date.now() + LOCKFILE_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(LOCKFILE_POLL_INTERVAL_MS);
    const current = readLockfile(cwd);
    if (!current) {
      return { stopped: true, message: "Daemon stopped successfully." };
    }
  }

  return {
    stopped: true,
    message:
      "Daemon stop requested. Lockfile may take a moment to clear.",
  };
}

// ---------------------------------------------------------------------------
// .gitignore helper
// ---------------------------------------------------------------------------

function ensureGitignoreEntries(cwd: string, entries: string[]): void {
  const gitignorePath = join(cwd, ".gitignore");
  let content = "";
  try {
    content = readFileSync(gitignorePath, "utf-8");
  } catch {
    // No .gitignore yet
  }

  const lines = content.split("\n");
  const missing = entries.filter(
    (entry) => !lines.some((line) => line.trim() === entry),
  );

  if (missing.length === 0) return;

  const suffix =
    (content.length > 0 && !content.endsWith("\n") ? "\n" : "") +
    missing.join("\n") +
    "\n";
  writeFileSync(gitignorePath, content + suffix, "utf-8");
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function eforgeExtension(pi: ExtensionAPI) {
  // Module-scope context for refreshing status after backend changes
  let _latestCtx: UIContext | null = null;

  /** Refresh the Pi footer status with the active backend profile. Best-effort. */
  async function refreshStatus(ctx: { cwd: string; ui: { setStatus(key: string, text: string | undefined): void } }): Promise<void> {
    try {
      const { data } = await daemonRequest<{
        active: string | null;
        source: string;
        resolved: { backend?: string; name?: string } | null;
      }>(ctx.cwd, 'GET', '/api/backend/show');
      if (data.active && data.resolved?.backend) {
        ctx.ui.setStatus('eforge', `eforge: ${data.active} (${data.resolved.backend})`);
      } else {
        ctx.ui.setStatus('eforge', undefined);
      }
    } catch {
      ctx.ui.setStatus('eforge', undefined);
    }

    // Queue status
    try {
      const { data: queueItems } = await daemonRequest<QueueItem[]>(ctx.cwd, 'GET', '/api/queue');
      if (queueItems.length > 0) {
        ctx.ui.setStatus('eforge-queue', `queue: ${queueItems.length}`);
      } else {
        ctx.ui.setStatus('eforge-queue', undefined);
      }
    } catch {
      ctx.ui.setStatus('eforge-queue', undefined);
    }

    // Build status
    try {
      const { data: latestRun } = await daemonRequest<LatestRunResponse>(ctx.cwd, 'GET', '/api/latest-run');
      if (latestRun?.sessionId) {
        const { data: summary } = await daemonRequest<RunSummary>(
          ctx.cwd, 'GET', `/api/run-summary/${encodeURIComponent(latestRun.sessionId)}`
        );
        if (summary?.status === 'running') {
          const parts: string[] = ['build: running'];
          if (summary.currentPhase) parts.push(summary.currentPhase);
          if (summary.currentAgent) parts.push(summary.currentAgent);
          ctx.ui.setStatus('eforge-build', parts.join(' - '));
        } else {
          ctx.ui.setStatus('eforge-build', undefined);
        }
      } else {
        ctx.ui.setStatus('eforge-build', undefined);
      }
    } catch {
      ctx.ui.setStatus('eforge-build', undefined);
    }
  }

  // Register session_start listener for Pi footer status
  pi.on('session_start', async (_ev: unknown, ctx: unknown) => {
    const typedCtx = ctx as UIContext;
    _latestCtx = typedCtx;
    await refreshStatus(typedCtx);
  });
  // ------------------------------------------------------------------
  // Tool: eforge_build
  // ------------------------------------------------------------------
  pi.registerTool({
    name: "eforge_build",
    label: "eforge build",
    description:
      "Enqueue a PRD source for the eforge daemon to build. Returns a sessionId and autoBuild status.",
    parameters: Type.Object({
      source: Type.String({
        description:
          "PRD file path or inline description to enqueue for building",
      }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const { data, port } = await daemonRequest<EnqueueResponse>(
        ctx.cwd,
        "POST",
        "/api/enqueue",
        { source: params.source },
      );
      return jsonResult(withMonitorUrl(data, port));
    },
  });

  // ------------------------------------------------------------------
  // Tool: eforge_status
  // ------------------------------------------------------------------
  pi.registerTool({
    name: "eforge_status",
    label: "eforge status",
    description:
      "Get the current run status including plan progress, session state, and event summary.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      const { data: latestRun } = await daemonRequest<LatestRunResponse>(
        ctx.cwd,
        "GET",
        "/api/latest-run",
      );
      if (!latestRun?.sessionId) {
        return jsonResult({
          status: "idle",
          message: "No active eforge sessions.",
        });
      }
      const { data: summary } = await daemonRequest<RunSummary>(
        ctx.cwd,
        "GET",
        `/api/run-summary/${encodeURIComponent(latestRun.sessionId)}`,
      );
      return jsonResult(summary);
    },

    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("eforge status")), 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      try {
        const text = result.content[0];
        if (!text || text.type !== "text") {
          return new Text(theme.fg("muted", "No data"), 0, 0);
        }
        const data = JSON.parse(text.text) as {
          status?: string;
          message?: string;
          sessionId?: string;
          runs?: Array<{ id: string; command: string; status: string; startedAt: string; completedAt: string | null }>;
          plans?: Array<{ id: string; status: string; branch: string | null; dependsOn: string[] }>;
          currentPhase?: string | null;
          currentAgent?: string | null;
          eventCounts?: { total: number; errors: number };
          duration?: { startedAt: string | null; completedAt: string | null; seconds: number | null };
        };

        // Idle state
        if (data.status === "idle") {
          return new Text(theme.fg("muted", "⊘ No active sessions"), 0, 0);
        }

        const lines: string[] = [];

        // Status + duration header
        const statusIcon = data.status === "completed" ? "✓" : data.status === "running" ? "⟳" : data.status === "failed" ? "✗" : "?";
        const statusColor = data.status === "completed" ? "success" : data.status === "running" ? "warning" : data.status === "failed" ? "error" : "muted";
        let header = theme.fg(statusColor, `${statusIcon} ${data.status}`);
        if (data.duration?.seconds != null) {
          const mins = Math.floor(data.duration.seconds / 60);
          const secs = data.duration.seconds % 60;
          const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
          header += theme.fg("dim", `  ${timeStr}`);
        }
        lines.push(header);

        // Current activity (when running)
        if (data.status === "running") {
          const parts: string[] = [];
          if (data.currentPhase) parts.push(data.currentPhase);
          if (data.currentAgent) parts.push(data.currentAgent);
          if (parts.length > 0) {
            lines.push(theme.fg("accent", `  ▸ ${parts.join(" › ")}`));
          }
        }

        // Plans
        if (data.plans && data.plans.length > 0) {
          lines.push("");
          for (const plan of data.plans) {
            const pIcon = plan.status === "completed" ? "✓" : plan.status === "running" ? "⟳" : plan.status === "failed" ? "✗" : "○";
            const pColor = plan.status === "completed" ? "success" : plan.status === "running" ? "warning" : plan.status === "failed" ? "error" : "muted";
            lines.push(`  ${theme.fg(pColor, pIcon)} ${theme.fg("text", plan.id)}`);
          }
        }

        // Event counts
        if (data.eventCounts) {
          lines.push("");
          let countsStr = theme.fg("dim", `${data.eventCounts.total} events`);
          if (data.eventCounts.errors > 0) {
            countsStr += theme.fg("error", ` · ${data.eventCounts.errors} errors`);
          } else {
            countsStr += theme.fg("dim", " · 0 errors");
          }
          lines.push(`  ${countsStr}`);
        }

        // Expanded: show runs detail
        if (expanded && data.runs && data.runs.length > 0) {
          lines.push("");
          lines.push(theme.fg("muted", "  Runs:"));
          for (const run of data.runs) {
            const rIcon = run.status === "completed" ? "✓" : run.status === "running" ? "⟳" : run.status === "failed" ? "✗" : "○";
            const rColor = run.status === "completed" ? "success" : run.status === "running" ? "warning" : run.status === "failed" ? "error" : "muted";
            lines.push(`    ${theme.fg(rColor, rIcon)} ${theme.fg("text", run.command)} ${theme.fg("dim", `(${run.status})`)}`);
          }
        }

        return new Text(lines.join("\n"), 0, 0);
      } catch {
        // Fallback to raw JSON on parse error
        const text = result.content[0];
        return new Text(theme.fg("muted", text?.type === "text" ? text.text : "Parse error"), 0, 0);
      }
    },
  });

  // ------------------------------------------------------------------
  // Tool: eforge_queue_list
  // ------------------------------------------------------------------
  pi.registerTool({
    name: "eforge_queue_list",
    label: "eforge queue list",
    description:
      "List all PRDs currently in the eforge queue with their metadata.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      const { data } = await daemonRequest<QueueItem[]>(ctx.cwd, "GET", "/api/queue");
      return jsonResult(data);
    },
  });

  // ------------------------------------------------------------------
  // Tool: eforge_config
  // ------------------------------------------------------------------
  pi.registerTool({
    name: "eforge_config",
    label: "eforge config",
    description:
      "Show resolved eforge configuration or validate eforge/config.yaml.",
    parameters: Type.Object({
      action: StringEnum(["show", "validate"] as const, {
        description:
          "'show' returns resolved config, 'validate' checks for errors",
      }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const path =
        params.action === "validate"
          ? "/api/config/validate"
          : "/api/config/show";
      const { data } = await daemonRequest(ctx.cwd, "GET", path);
      return jsonResult(data);
    },
  });

  // ------------------------------------------------------------------
  // Tool: eforge_backend
  // ------------------------------------------------------------------
  pi.registerTool({
    name: "eforge_backend",
    label: "eforge backend",
    description:
      'Manage named backend profiles in eforge/backends/. Actions: "list" enumerates profiles and reports which is active; "show" returns the resolved active profile with backend; "use" writes eforge/.active-backend to switch profiles; "create" writes a new eforge/backends/<name>.yaml; "delete" removes a profile (refuses when active unless force: true).',
    parameters: Type.Object({
      action: StringEnum(["list", "show", "use", "create", "delete"] as const, {
        description:
          "'list' enumerates profiles, 'show' returns the resolved active profile, 'use' switches the active profile, 'create' writes a new profile, 'delete' removes a profile",
      }),
      name: Type.Optional(
        Type.String({
          description:
            'Profile name (required for "use", "create", and "delete")',
        }),
      ),
      backend: Type.Optional(
        StringEnum(["claude-sdk", "pi"] as const, {
          description: 'Backend kind (required for "create")',
        }),
      ),
      pi: Type.Optional(
        Type.Record(Type.String(), Type.Any(), {
          description:
            'Pi-specific config to embed in the profile (optional, "create" only)',
        }),
      ),
      agents: Type.Optional(
        Type.Record(Type.String(), Type.Any(), {
          description:
            'Agents config block to embed in the profile (optional, "create" only)',
        }),
      ),
      overwrite: Type.Optional(
        Type.Boolean({
          description:
            "Overwrite an existing profile when creating. Default: false.",
        }),
      ),
      force: Type.Optional(
        Type.Boolean({
          description:
            "Delete even if the profile is currently active. Default: false.",
        }),
      ),
      scope: Type.Optional(
        Type.Union([Type.Literal("project"), Type.Literal("user"), Type.Literal("all")], {
          description:
            'Scope for the operation. "list" accepts project|user|all (default: all). "use", "create", "delete" accept project|user (default: project). "show" ignores scope (resolves via precedence).',
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { action, name, backend, pi: piCfg, agents, overwrite, force, scope } =
        params;

      if (action === "list") {
        const params = new URLSearchParams();
        if (scope) params.set("scope", scope);
        const qs = params.toString();
        const { data } = await daemonRequest(ctx.cwd, "GET", `/api/backend/list${qs ? `?${qs}` : ""}`);
        return jsonResult(data);
      }

      if (action === "show") {
        const { data } = await daemonRequest(ctx.cwd, "GET", "/api/backend/show");
        return jsonResult(data);
      }

      if (action === "use") {
        if (!name) {
          throw new Error('"name" is required when action is "use"');
        }
        const useBody: Record<string, unknown> = { name };
        if (scope) useBody.scope = scope;
        const { data } = await daemonRequest(
          ctx.cwd,
          "POST",
          "/api/backend/use",
          useBody,
        );
        if (_latestCtx) await refreshStatus(_latestCtx);
        return jsonResult(data);
      }

      if (action === "create") {
        if (!name) {
          throw new Error('"name" is required when action is "create"');
        }
        if (backend !== "claude-sdk" && backend !== "pi") {
          throw new Error(
            '"backend" is required when action is "create" (must be "claude-sdk" or "pi")',
          );
        }
        const body: Record<string, unknown> = { name, backend };
        if (piCfg !== undefined) body.pi = piCfg;
        if (agents !== undefined) body.agents = agents;
        if (overwrite !== undefined) body.overwrite = overwrite;
        if (scope) body.scope = scope;
        const { data } = await daemonRequest(
          ctx.cwd,
          "POST",
          "/api/backend/create",
          body,
        );
        if (_latestCtx) await refreshStatus(_latestCtx);
        return jsonResult(data);
      }

      // action === 'delete'
      if (!name) {
        throw new Error('"name" is required when action is "delete"');
      }
      const body: Record<string, unknown> = {};
      if (force !== undefined) body.force = force;
      if (scope) body.scope = scope;
      const { data } = await daemonRequest(
        ctx.cwd,
        "DELETE",
        `/api/backend/${encodeURIComponent(name)}`,
        body,
      );
      return jsonResult(data);
    },

    renderCall(args, theme) {
      const action = typeof args.action === "string" ? args.action : "?";
      const name = typeof args.name === "string" ? args.name : "";
      const suffix = name ? ` ${name}` : "";
      return new Text(
        theme.fg("toolTitle", theme.bold(`eforge backend ${action}${suffix}`)),
        0,
        0,
      );
    },

    renderResult(result, _options, theme) {
      const text = result.content[0];
      if (!text || text.type !== "text") {
        return new Text(theme.fg("muted", "No data"), 0, 0);
      }
      try {
        const data = JSON.parse(text.text) as Record<string, unknown>;
        const lines: string[] = [];

        if (Array.isArray((data as { profiles?: unknown }).profiles)) {
          const profiles = (data as { profiles: Array<{ name: string }> }).profiles;
          const active = (data as { active?: string | null }).active ?? null;
          const source = (data as { source?: string }).source ?? "none";
          lines.push(
            theme.fg("accent", `${profiles.length} profile(s)`) +
              theme.fg("dim", `  source: ${source}`),
          );
          for (const p of profiles) {
            const marker = active === p.name ? theme.fg("success", "● ") : theme.fg("muted", "○ ");
            lines.push(`  ${marker}${theme.fg("text", p.name)}`);
          }
        } else if ("resolved" in data) {
          const active = (data as { active?: string | null }).active ?? null;
          const source = (data as { source?: string }).source ?? "none";
          const resolved = (data as { resolved?: { backend?: string } }).resolved;
          lines.push(
            theme.fg("accent", `active: ${active ?? "(none)"}`) +
              theme.fg("dim", `  source: ${source}`),
          );
          if (resolved?.backend) {
            lines.push(theme.fg("dim", `  backend: ${resolved.backend}`));
          }
        } else if ("active" in data) {
          lines.push(theme.fg("success", `✓ active: ${String((data as { active?: unknown }).active)}`));
        } else if ("path" in data) {
          lines.push(theme.fg("success", `✓ created: ${String((data as { path?: unknown }).path)}`));
        } else if ("deleted" in data) {
          lines.push(theme.fg("success", `✓ deleted: ${String((data as { deleted?: unknown }).deleted)}`));
        } else {
          lines.push(theme.fg("muted", text.text));
        }
        return new Text(lines.join("\n"), 0, 0);
      } catch {
        return new Text(theme.fg("muted", text.text), 0, 0);
      }
    },
  });

  // ------------------------------------------------------------------
  // Tool: eforge_models
  // ------------------------------------------------------------------
  pi.registerTool({
    name: "eforge_models",
    label: "eforge models",
    description:
      'List providers or models available for a given backend. Actions: "providers" returns provider names (claude-sdk is implicit / returns []); "list" returns models, optionally filtered to a single provider, newest-first.',
    parameters: Type.Object({
      action: StringEnum(["providers", "list"] as const, {
        description:
          "'providers' returns provider names, 'list' returns available models",
      }),
      backend: StringEnum(["claude-sdk", "pi"] as const, {
        description: "Which backend to query",
      }),
      provider: Type.Optional(
        Type.String({
          description:
            'Optional provider filter for "list" (Pi only). Ignored for claude-sdk.',
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.action === "providers") {
        const { data } = await daemonRequest(
          ctx.cwd,
          "GET",
          `/api/models/providers?backend=${encodeURIComponent(params.backend)}`,
        );
        return jsonResult(data);
      }
      const searchParams = new URLSearchParams({ backend: params.backend });
      if (params.provider) searchParams.set("provider", params.provider);
      const { data } = await daemonRequest(
        ctx.cwd,
        "GET",
        `/api/models/list?${searchParams.toString()}`,
      );
      return jsonResult(data);
    },

    renderCall(args, theme) {
      const action = typeof args.action === "string" ? args.action : "?";
      const backend = typeof args.backend === "string" ? args.backend : "?";
      const provider = typeof args.provider === "string" ? args.provider : "";
      const suffix = provider ? ` / ${provider}` : "";
      return new Text(
        theme.fg(
          "toolTitle",
          theme.bold(`eforge models ${action} ${backend}${suffix}`),
        ),
        0,
        0,
      );
    },

    renderResult(result, { expanded }, theme) {
      const text = result.content[0];
      if (!text || text.type !== "text") {
        return new Text(theme.fg("muted", "No data"), 0, 0);
      }
      try {
        const data = JSON.parse(text.text) as Record<string, unknown>;
        const lines: string[] = [];

        if (Array.isArray((data as { providers?: unknown }).providers)) {
          const providers = (data as { providers: string[] }).providers;
          lines.push(theme.fg("accent", `${providers.length} provider(s)`));
          for (const p of providers) {
            lines.push(`  ${theme.fg("text", p)}`);
          }
        } else if (Array.isArray((data as { models?: unknown }).models)) {
          const models = (data as {
            models: Array<{ id: string; provider?: string; releasedAt?: string }>;
          }).models;
          lines.push(theme.fg("accent", `${models.length} model(s)`));
          const limit = expanded ? models.length : Math.min(10, models.length);
          for (let i = 0; i < limit; i += 1) {
            const m = models[i];
            const provider = m.provider ? theme.fg("dim", ` [${m.provider}]`) : "";
            const released = m.releasedAt ? theme.fg("dim", `  ${m.releasedAt}`) : "";
            lines.push(`  ${theme.fg("text", m.id)}${provider}${released}`);
          }
          if (!expanded && models.length > limit) {
            lines.push(theme.fg("dim", `  ... ${models.length - limit} more (expand to see all)`));
          }
        } else {
          lines.push(theme.fg("muted", text.text));
        }
        return new Text(lines.join("\n"), 0, 0);
      } catch {
        return new Text(theme.fg("muted", text.text), 0, 0);
      }
    },
  });

  // ------------------------------------------------------------------
  // Tool: eforge_daemon
  // ------------------------------------------------------------------
  pi.registerTool({
    name: "eforge_daemon",
    label: "eforge daemon",
    description:
      "Manage the eforge daemon lifecycle: start, stop, or restart the daemon.",
    parameters: Type.Object({
      action: StringEnum(["start", "stop", "restart"] as const, {
        description:
          "'start' ensures daemon is running, 'stop' gracefully stops it, 'restart' stops then starts",
      }),
      force: Type.Optional(
        Type.Boolean({
          description:
            'When action is "stop" or "restart", force shutdown even if builds are active. Default: false.',
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { action, force } = params;

      if (action === "start") {
        const port = await ensureDaemon(ctx.cwd);
        return jsonResult({ status: "running", port });
      }

      if (action === "stop") {
        const result = await stopDaemon(ctx.cwd, force === true);
        if (!result.stopped) {
          throw new Error(result.message);
        }
        return jsonResult({
          status: "stopped",
          message: result.message,
        });
      }

      // restart
      const stopResult = await stopDaemon(ctx.cwd, force === true);
      if (!stopResult.stopped) {
        throw new Error(stopResult.message);
      }
      const port = await ensureDaemon(ctx.cwd);
      return jsonResult({
        status: "restarted",
        port,
        message: "Daemon restarted successfully.",
      });
    },
  });

  // ------------------------------------------------------------------
  // Tool: eforge_auto_build
  // ------------------------------------------------------------------
  pi.registerTool({
    name: "eforge_auto_build",
    label: "eforge auto build",
    description:
      "Get or set the daemon auto-build state. When enabled, the daemon automatically builds PRDs as they are enqueued.",
    parameters: Type.Object({
      action: StringEnum(["get", "set"] as const, {
        description:
          "'get' returns current auto-build state, 'set' updates it",
      }),
      enabled: Type.Optional(
        Type.Boolean({
          description:
            'Required when action is "set". Whether auto-build should be enabled.',
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (params.action === "get") {
        const { data } = await daemonRequest<AutoBuildState>(
          ctx.cwd,
          "GET",
          "/api/auto-build",
        );
        return jsonResult(data);
      }
      if (params.enabled === undefined) {
        throw new Error('"enabled" is required when action is "set"');
      }
      const { data } = await daemonRequest<AutoBuildState>(
        ctx.cwd,
        "POST",
        "/api/auto-build",
        { enabled: params.enabled },
      );
      return jsonResult(data);
    },
  });

  // ------------------------------------------------------------------
  // Tool: eforge_init
  // ------------------------------------------------------------------
  pi.registerTool({
    name: "eforge_init",
    label: "eforge init",
    description:
      "Initialize eforge in a project: creates a named backend profile under eforge/backends/, activates it, and writes eforge/config.yaml for team-wide settings. Backend is hardcoded to 'pi'. With migrate: true, extracts backend config from an existing pre-overhaul config.yaml into a named profile.",
    parameters: Type.Object({
      force: Type.Optional(
        Type.Boolean({
          description:
            "Overwrite existing eforge/config.yaml if it already exists. Default: false.",
        }),
      ),
      postMergeCommands: Type.Optional(
        Type.Array(Type.String(), {
          description:
            'Post-merge validation commands (e.g. ["pnpm install", "pnpm test"]). Only applied when creating a new config.',
        }),
      ),
      migrate: Type.Optional(
        Type.Boolean({
          description:
            "Extract backend config from existing pre-overhaul config.yaml into a named profile and strip config.yaml. Default: false.",
        }),
      ),
      provider: Type.Optional(
        Type.String({
          description:
            'Provider name for Pi backend (e.g. "anthropic", "openrouter"). The skill should supply this after querying eforge_models { action: "providers", backend: "pi" }.',
        }),
      ),
      maxModel: Type.Optional(
        Type.String({
          description:
            'Max model ID (e.g. "claude-opus-4-7"). The skill should supply this after querying eforge_models { action: "list", backend: "pi", provider: "..." }.',
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const configDir = join(ctx.cwd, "eforge");
      const configPath = join(configDir, "config.yaml");

      // Ensure .gitignore has daemon state and active-backend marker
      ensureGitignoreEntries(ctx.cwd, [".eforge/", "eforge/.active-backend"]);

      // --- Migrate mode ---
      if (params.migrate) {
        let rawYaml: string;
        try {
          rawYaml = readFileSync(configPath, "utf-8");
        } catch {
          throw new Error("No existing eforge/config.yaml found. Nothing to migrate.");
        }

        let parsed: unknown;
        try {
          parsed = parseYaml(rawYaml);
          if (!parsed || typeof parsed !== "object") {
            throw new Error("Existing config.yaml is empty or not an object.");
          }
        } catch (err) {
          throw new Error(`Failed to parse config.yaml: ${err instanceof Error ? err.message : String(err)}`);
        }

        const data = parsed as Record<string, unknown>;
        if (data.backend === undefined) {
          throw new Error('config.yaml has no top-level "backend:" field. Nothing to migrate.');
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

        await daemonRequest(ctx.cwd, "POST", "/api/backend/create", createBody);

        // Rewrite config.yaml with remaining fields only (no backend:) before
        // activating the profile, so a failed write leaves the profile inactive
        // (cleanly recoverable by re-running migrate).
        const yamlOut = Object.keys(remaining).length > 0
          ? stringifyYaml(remaining)
          : "";
        writeFileSync(configPath, yamlOut, "utf-8");

        await daemonRequest(ctx.cwd, "POST", "/api/backend/use", { name: profileName });

        if (_latestCtx) await refreshStatus(_latestCtx);

        return jsonResult({
          status: "migrated",
          configPath: "eforge/config.yaml",
          profileName,
          profilePath: `eforge/backends/${profileName}.yaml`,
          backend,
          moved: Object.keys(profile),
          kept: Object.keys(remaining),
        });
      }

      // --- Fresh init mode ---

      // Check if config already exists
      try {
        accessSync(configPath);
        if (!params.force) {
          throw new Error(
            "eforge/config.yaml already exists. Use force: true to overwrite, or migrate: true to extract backend config into a profile.",
          );
        }
      } catch (err) {
        if (err instanceof Error && !('code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT')) {
          throw err;
        }
        // File does not exist - proceed
      }

      // Backend is always pi for Pi extension
      const backend = "pi";
      const provider = params.provider;
      const maxModelId = params.maxModel;

      // Compute profile name
      const profileName = maxModelId
        ? sanitizeProfileName(backend, provider, maxModelId)
        : backend;

      // Build model ref
      const modelRef: Record<string, string> = maxModelId
        ? { id: maxModelId }
        : { id: "claude-opus-4-7" };
      if (provider) modelRef.provider = provider;

      // Create the profile via daemon
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
      if (params.force) createBody.overwrite = true;
      await daemonRequest(ctx.cwd, "POST", "/api/backend/create", createBody);

      // Activate the profile
      await daemonRequest(ctx.cwd, "POST", "/api/backend/use", { name: profileName });

      // Create eforge/ directory
      try {
        mkdirSync(configDir, { recursive: true });
      } catch {
        // Directory may already exist
      }

      // Write config.yaml with only non-backend fields (never emit backend:)
      const configData: Record<string, unknown> = {};
      if (params.postMergeCommands && params.postMergeCommands.length > 0) {
        configData.build = { postMergeCommands: params.postMergeCommands };
      }
      const configContent = Object.keys(configData).length > 0
        ? stringifyYaml(configData)
        : "";
      writeFileSync(configPath, configContent, "utf-8");

      // Validate config via daemon (best-effort)
      let validation: ConfigValidateResponse | null = null;
      try {
        const { data } = await daemonRequest<ConfigValidateResponse>(
          ctx.cwd,
          "GET",
          "/api/config/validate",
        );
        validation = data;
      } catch {
        // Daemon validation is best-effort
      }

      if (_latestCtx) await refreshStatus(_latestCtx);

      const response: Record<string, unknown> = {
        status: "initialized",
        configPath: "eforge/config.yaml",
        profileName,
        profilePath: `eforge/backends/${profileName}.yaml`,
        backend,
      };

      if (validation) {
        response.validation = validation;
      }

      return jsonResult(response);
    },
  });

  // ------------------------------------------------------------------
  // Tool: eforge_confirm_build
  // ------------------------------------------------------------------
  pi.registerTool({
    name: "eforge_confirm_build",
    label: "eforge confirm build",
    description:
      "Present an interactive TUI overlay for the user to confirm, edit, or cancel a build source before enqueuing. Returns the user's choice.",
    parameters: Type.Object({
      source: Type.String({
        description:
          "The assembled PRD source text to preview for confirmation",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        return jsonResult({ choice: "confirm", note: "No UI available, auto-confirming" });
      }

      const items: SelectItem[] = [
        { value: "confirm", label: "✓ Confirm", description: "Enqueue for building" },
        { value: "edit", label: "✎ Edit", description: "Revise the source" },
        { value: "cancel", label: "✗ Cancel", description: "Abort" },
      ];

      const choice = await ctx.ui.custom<string>((tui, theme, _kb, done) => {
        const container = new Container();
        const mdTheme = getMarkdownTheme();

        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        container.addChild(new Text(theme.fg("accent", theme.bold("eforge - Confirm Build")), 1, 0));
        container.addChild(new Markdown(params.source, 1, 1, mdTheme));

        const selectList = new SelectList(items, items.length, {
          selectedPrefix: (text) => theme.fg("accent", text),
          selectedText: (text) => theme.fg("accent", text),
          description: (text) => theme.fg("muted", text),
          scrollInfo: (text) => theme.fg("dim", text),
          noMatch: (text) => theme.fg("warning", text),
        });

        selectList.onSelect = (item) => done(item.value);
        selectList.onCancel = () => done("cancel");

        container.addChild(selectList);
        container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

        return {
          render: (width: number) => container.render(width),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            selectList.handleInput(data);
            tui.requestRender();
          },
        };
      });

      return jsonResult({ choice: choice ?? "cancel" });
    },

    renderCall(args, theme) {
      const source = typeof args.source === "string" ? args.source : "";
      const truncated = (source.length > 200 ? source.slice(0, 200) + "..." : source).replace(/\n/g, " ");
      const text =
        theme.fg("toolTitle", theme.bold("eforge confirm build ")) +
        theme.fg("muted", `Source preview (${source.length} chars)`) +
        "\n" +
        theme.fg("dim", `  ${truncated}`);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const text = result.content[0];
      let choice = "unknown";
      try {
        if (text?.type === "text") {
          const parsed = JSON.parse(text.text);
          choice = parsed.choice ?? "unknown";
        }
      } catch {
        // fallback
      }

      const icons: Record<string, string> = {
        confirm: theme.fg("success", "✓ ") + theme.fg("accent", "Confirmed"),
        edit: theme.fg("warning", "✎ ") + theme.fg("accent", "Edit requested"),
        cancel: theme.fg("error", "✗ ") + theme.fg("muted", "Cancelled"),
      };

      return new Text(icons[choice] ?? theme.fg("muted", choice), 0, 0);
    },
  });

  // ------------------------------------------------------------------
  // Command aliases — map /eforge:* to /skill:eforge-*
  // Pi has no programmatic skill invocation API, so we delegate via
  // sendUserMessage which injects the skill command as user input.
  // ------------------------------------------------------------------

  const skillCommands: Array<{
    name: string;
    description: string;
    skill: string;
  }> = [
    {
      name: "eforge:build",
      description: "Enqueue a build for eforge",
      skill: "eforge-build",
    },
    {
      name: "eforge:status",
      description: "Check eforge run status and queue state",
      skill: "eforge-status",
    },
    {
      name: "eforge:init",
      description: "Initialize eforge in the current project",
      skill: "eforge-init",
    },
    {
      name: "eforge:plan",
      description: "Start or resume a structured planning conversation",
      skill: "eforge-plan",
    },
    {
      name: "eforge:restart",
      description: "Safely restart the eforge daemon",
      skill: "eforge-restart",
    },
    {
      name: "eforge:update",
      description: "Check for eforge updates and guide through updating",
      skill: "eforge-update",
    },
  ];

  for (const cmd of skillCommands) {
    pi.registerCommand(cmd.name, {
      description: cmd.description,
      handler: async (args) => {
        const message = `/skill:${cmd.skill}${args ? " " + args : ""}`;
        pi.sendUserMessage(message.trim());
      },
    });
  }

  // ------------------------------------------------------------------
  // Native commands - /eforge:backend, /eforge:backend:new, /eforge:config
  // ------------------------------------------------------------------

  pi.registerCommand("eforge:backend", {
    description: "List, inspect, and switch backend profiles",
    handler: async (args) => {
      await handleBackendCommand(pi, _latestCtx, args, async () => {
        if (_latestCtx) await refreshStatus(_latestCtx);
      });
    },
  });

  pi.registerCommand("eforge:backend:new", {
    description: "Create a new backend profile in eforge/backends/",
    handler: async (args) => {
      await handleBackendNewCommand(pi, _latestCtx, args, async () => {
        if (_latestCtx) await refreshStatus(_latestCtx);
      });
    },
  });

  pi.registerCommand("eforge:config", {
    description: "Initialize or edit eforge configuration",
    handler: async (args) => {
      await handleConfigCommand(pi, _latestCtx, args);
    },
  });
}
