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
import { readFileSync, accessSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
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
  subscribeToSession,
  eventToProgress,
  LOCKFILE_POLL_INTERVAL_MS,
  LOCKFILE_POLL_TIMEOUT_MS,
  API_ROUTES,
  buildPath,
} from '@eforge-build/client';
import { deriveProfileName } from '@eforge-build/engine/config';
import type {
  LatestRunResponse,
  EnqueueResponse,
  RunSummary,
  ConfigValidateResponse,
  QueueItem,
  AutoBuildState,
  ConfigShowResponse,
  DaemonStreamEvent,
  SessionSummary,
  FollowCounters,
} from '@eforge-build/client';
import { handleProfileCommand, handleProfileNewCommand } from './profile-commands';
import { handleConfigCommand } from './config-command';
import { handlePlaybookCommand } from './playbook-commands';
import type { UIContext } from './ui-helpers';

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
      API_ROUTES.latestRun,
    );
    if (!latestRun?.sessionId) return null;
    const { data: summary } = await daemonRequest<RunSummary>(
      cwd,
      "GET",
      buildPath(API_ROUTES.runSummary, { id: latestRun.sessionId }),
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
    await daemonRequest(cwd, "POST", API_ROUTES.daemonStop, { force });
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
  // Module-scope context for refreshing status after harness changes
  let _latestCtx: UIContext | null = null;

  /** Refresh the Pi footer status with the active harness profile. Best-effort. */
  async function refreshStatus(ctx: { cwd: string; ui: { setStatus(key: string, text: string | undefined): void } }): Promise<void> {
    try {
      const { data } = await daemonRequest<{
        active: string | null;
        source: string;
        resolved: { harness?: string; name?: string } | null;
      }>(ctx.cwd, 'GET', API_ROUTES.profileShow);
      if (data.active && data.resolved?.harness) {
        ctx.ui.setStatus('eforge', `eforge: ${data.active} (harness: ${data.resolved.harness})`);
      } else {
        ctx.ui.setStatus('eforge', undefined);
      }
    } catch {
      ctx.ui.setStatus('eforge', undefined);
    }

    // Queue status
    try {
      const { data: queueItems } = await daemonRequest<QueueItem[]>(ctx.cwd, 'GET', API_ROUTES.queue);
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
      const { data: latestRun } = await daemonRequest<LatestRunResponse>(ctx.cwd, 'GET', API_ROUTES.latestRun);
      if (latestRun?.sessionId) {
        const { data: summary } = await daemonRequest<RunSummary>(
          ctx.cwd, 'GET', buildPath(API_ROUTES.runSummary, { id: latestRun.sessionId })
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
        API_ROUTES.enqueue,
        { source: params.source },
      );
      return jsonResult(withMonitorUrl(data, port));
    },
  });

  // ------------------------------------------------------------------
  // Tool: eforge_follow
  // Long-running tool that blocks for the lifetime of a session and streams
  // high-signal events to the caller via `onUpdate(message)`. Resolves with
  // the `SessionSummary` so the outcome lands in the conversation transcript.
  // Mirrors the MCP `eforge_follow` tool in packages/eforge/src/cli/mcp-proxy.ts
  // - both consumers share `eventToProgress()` from @eforge-build/client so the
  // per-event messages stay identical across Claude Code and Pi.
  // ------------------------------------------------------------------
  const DEFAULT_FOLLOW_TIMEOUT_MS = 1_800_000; // 30 minutes
  pi.registerTool({
    name: "eforge_follow",
    label: "eforge follow",
    description:
      "Follow a running eforge session: streams phase/files-changed/issue updates as tool progress messages and returns the final session summary. Use after eforge_build to surface live build status in the conversation.",
    parameters: Type.Object({
      sessionId: Type.String({
        description: "The session to follow (from eforge_build or eforge_status).",
      }),
      timeoutMs: Type.Optional(
        Type.Number({
          description:
            "Max time to wait for session completion in ms. Default 1,800,000 (30 minutes).",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const timeout = params.timeoutMs ?? DEFAULT_FOLLOW_TIMEOUT_MS;

      // Combine the caller's abort signal with a timeout signal so the tool
      // terminates cleanly on either cancellation or timeout.
      const timeoutController = new AbortController();
      const timeoutHandle = setTimeout(() => {
        const timeoutReason = Object.assign(new Error("eforge_follow timed out"), {
          name: "AbortError",
        });
        timeoutController.abort(timeoutReason);
      }, timeout);

      const signals: AbortSignal[] = [timeoutController.signal];
      if (signal) signals.push(signal);
      const combined = AbortSignal.any(signals);

      let counters: FollowCounters = { filesChanged: 0 };

      let summary: SessionSummary | null = null;
      let followError: Error | null = null;
      const startedAt = Date.now();

      try {
        summary = await subscribeToSession<DaemonStreamEvent>(params.sessionId, {
          cwd: ctx.cwd,
          signal: combined,
          onEvent: (event) => {
            const update = eventToProgress(event, counters);
            if (!update) return;
            counters = update.counters;
            try {
              onUpdate(update.message);
            } catch {
              // Pi UI may be closed or the callback may throw; swallow so the
              // subscription keeps running.
            }
          },
        });
      } catch (err) {
        followError = err instanceof Error ? err : new Error(String(err));
      } finally {
        clearTimeout(timeoutHandle);
      }

      if (followError || !summary) {
        const message = followError?.message ?? "eforge_follow failed";
        const isAbort =
          followError?.name === "AbortError" || /timed out/.test(message);
        return jsonResult({
          status: isAbort ? "aborted" : "error",
          sessionId: params.sessionId,
          message,
          filesChanged: counters.filesChanged,
        });
      }

      return jsonResult({
        status: summary.status,
        sessionId: summary.sessionId,
        summary: summary.summary,
        monitorUrl: summary.monitorUrl,
        durationMs: Date.now() - startedAt,
        phaseCounts: { total: summary.phaseCount },
        filesChanged: summary.filesChanged,
        issueCounts: { errors: summary.errorCount },
        eventCount: summary.eventCount,
      });
    },

    renderCall(args, theme) {
      const sessionId = typeof args.sessionId === "string" ? args.sessionId : "?";
      return new Text(
        theme.fg("toolTitle", theme.bold("eforge follow ")) +
          theme.fg("muted", sessionId),
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
        const data = JSON.parse(text.text) as {
          status?: string;
          sessionId?: string;
          summary?: string;
          monitorUrl?: string;
          durationMs?: number;
          phaseCounts?: { total?: number };
          filesChanged?: number;
          issueCounts?: { errors?: number };
          eventCount?: number;
          message?: string;
        };

        if (data.status === "aborted" || data.status === "error") {
          const icon = data.status === "aborted" ? "⊘" : "✗";
          const color = data.status === "aborted" ? "warning" : "error";
          const lines: string[] = [
            theme.fg(color, `${icon} ${data.status}`),
          ];
          if (data.message) {
            lines.push(theme.fg("dim", `  ${data.message}`));
          }
          return new Text(lines.join("\n"), 0, 0);
        }

        const statusIcon =
          data.status === "completed"
            ? "✓"
            : data.status === "failed"
              ? "✗"
              : "?";
        const statusColor =
          data.status === "completed"
            ? "success"
            : data.status === "failed"
              ? "error"
              : "muted";
        const lines: string[] = [
          theme.fg(statusColor, `${statusIcon} ${data.status ?? "unknown"}`),
        ];

        const phaseTotal = data.phaseCounts?.total ?? 0;
        const filesChanged = data.filesChanged ?? 0;
        const errors = data.issueCounts?.errors ?? 0;
        const parts: string[] = [
          theme.fg("dim", `${phaseTotal} phase(s)`),
          theme.fg("dim", `${filesChanged} file(s) changed`),
        ];
        if (errors > 0) {
          parts.push(theme.fg("error", `${errors} error(s)`));
        } else {
          parts.push(theme.fg("dim", "0 errors"));
        }
        lines.push(`  ${parts.join(theme.fg("dim", " · "))}`);

        if (data.durationMs != null) {
          const seconds = Math.round(data.durationMs / 1000);
          const mins = Math.floor(seconds / 60);
          const secs = seconds % 60;
          const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
          lines.push(theme.fg("dim", `  ${timeStr}`));
        }
        if (data.monitorUrl) {
          lines.push(theme.fg("accent", `  ${data.monitorUrl}`));
        }

        return new Text(lines.join("\n"), 0, 0);
      } catch {
        return new Text(theme.fg("muted", text.text), 0, 0);
      }
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
        API_ROUTES.latestRun,
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
        buildPath(API_ROUTES.runSummary, { id: latestRun.sessionId }),
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
      const { data } = await daemonRequest<QueueItem[]>(ctx.cwd, "GET", API_ROUTES.queue);
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
          ? API_ROUTES.configValidate
          : API_ROUTES.configShow;
      const { data } = await daemonRequest(ctx.cwd, "GET", path);
      return jsonResult(data);
    },
  });

  // ------------------------------------------------------------------
  // Tool: eforge_profile
  // ------------------------------------------------------------------
  pi.registerTool({
    name: "eforge_profile",
    label: "eforge profile",
    description:
      'Manage named profiles in eforge/profiles/. Actions: "list" enumerates profiles and reports which is active; "show" returns the resolved active profile with harness; "use" writes eforge/.active-profile to switch profiles; "create" writes a new eforge/profiles/<name>.yaml; "delete" removes a profile (refuses when active unless force: true).',
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
      harness: Type.Optional(
        StringEnum(["claude-sdk", "pi"] as const, {
          description: 'Harness kind (required for "create")',
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
      const { action, name, harness, pi: piCfg, agents, overwrite, force, scope } =
        params;

      if (action === "list") {
        const params = new URLSearchParams();
        if (scope) params.set("scope", scope);
        const qs = params.toString();
        const { data } = await daemonRequest(ctx.cwd, "GET", `${API_ROUTES.profileList}${qs ? `?${qs}` : ""}`);
        return jsonResult(data);
      }

      if (action === "show") {
        const { data } = await daemonRequest(ctx.cwd, "GET", API_ROUTES.profileShow);
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
          API_ROUTES.profileUse,
          useBody,
        );
        if (_latestCtx) await refreshStatus(_latestCtx);
        return jsonResult(data);
      }

      if (action === "create") {
        if (!name) {
          throw new Error('"name" is required when action is "create"');
        }
        if (harness !== "claude-sdk" && harness !== "pi") {
          throw new Error(
            '"harness" is required when action is "create" (must be "claude-sdk" or "pi")',
          );
        }
        const body: Record<string, unknown> = { name, harness };
        if (piCfg !== undefined) body.pi = piCfg;
        if (agents !== undefined) body.agents = agents;
        if (overwrite !== undefined) body.overwrite = overwrite;
        if (scope) body.scope = scope;
        const { data } = await daemonRequest(
          ctx.cwd,
          "POST",
          API_ROUTES.profileCreate,
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
        buildPath(API_ROUTES.profileDelete, { name }),
        body,
      );
      return jsonResult(data);
    },

    renderCall(args, theme) {
      const action = typeof args.action === "string" ? args.action : "?";
      const name = typeof args.name === "string" ? args.name : "";
      const suffix = name ? ` ${name}` : "";
      return new Text(
        theme.fg("toolTitle", theme.bold(`eforge profile ${action}${suffix}`)),
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
          const resolved = (data as { resolved?: { harness?: string } }).resolved;
          lines.push(
            theme.fg("accent", `active: ${active ?? "(none)"}`) +
              theme.fg("dim", `  source: ${source}`),
          );
          if (resolved?.harness) {
            lines.push(theme.fg("dim", `  harness: ${resolved.harness}`));
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
      'List providers or models available for a given harness. Actions: "providers" returns provider names (claude-sdk is implicit / returns []); "list" returns models, optionally filtered to a single provider, newest-first.',
    parameters: Type.Object({
      action: StringEnum(["providers", "list"] as const, {
        description:
          "'providers' returns provider names, 'list' returns available models",
      }),
      harness: StringEnum(["claude-sdk", "pi"] as const, {
        description: "Which harness to query",
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
          `${API_ROUTES.modelProviders}?harness=${encodeURIComponent(params.harness)}`,
        );
        return jsonResult(data);
      }
      const searchParams = new URLSearchParams({ harness: params.harness });
      if (params.provider) searchParams.set("provider", params.provider);
      const { data } = await daemonRequest(
        ctx.cwd,
        "GET",
        `${API_ROUTES.modelList}?${searchParams.toString()}`,
      );
      return jsonResult(data);
    },

    renderCall(args, theme) {
      const action = typeof args.action === "string" ? args.action : "?";
      const harness = typeof args.harness === "string" ? args.harness : "?";
      const provider = typeof args.provider === "string" ? args.provider : "";
      const suffix = provider ? ` / ${provider}` : "";
      return new Text(
        theme.fg(
          "toolTitle",
          theme.bold(`eforge models ${action} ${harness}${suffix}`),
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
          API_ROUTES.autoBuildGet,
        );
        return jsonResult(data);
      }
      if (params.enabled === undefined) {
        throw new Error('"enabled" is required when action is "set"');
      }
      const { data } = await daemonRequest<AutoBuildState>(
        ctx.cwd,
        "POST",
        API_ROUTES.autoBuildSet,
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
      "Initialize eforge in a project. The skill is responsible for picking provider/model interactively; the tool is a pure persister. Pass `profile` with the assembled multi-runtime spec (every runtime must use harness: 'pi'). With migrate: true, extracts legacy harness config from a pre-overhaul config.yaml.",
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
            'Post-merge validation commands. Only applied when creating a new config.',
        }),
      ),
      migrate: Type.Optional(
        Type.Boolean({
          description:
            "Extract legacy harness config from existing pre-overhaul config.yaml into a named profile and strip config.yaml. Default: false.",
        }),
      ),
      existingProfile: Type.Optional(
        Type.Object({
          name: Type.String({ description: 'Name of the existing user-scope profile to activate.' }),
          scope: StringEnum(['user', 'project']),
        }, { description: 'Existing user-scope profile to activate. When provided, skips profile creation and activates directly. Mutually exclusive with `profile` and `migrate`.' }),
      ),
      profile: Type.Optional(
        Type.Object({
          name: Type.Optional(Type.String({ description: "Profile name. Auto-derived via deriveProfileName when omitted." })),
          agentRuntimes: Type.Record(
            Type.String(),
            Type.Object({
              harness: StringEnum(["pi"]),
              pi: Type.Optional(Type.Object({ provider: Type.String() })),
            }),
          ),
          defaultAgentRuntime: Type.String(),
          models: Type.Optional(Type.Object({
            max: Type.Optional(Type.Object({ id: Type.String() })),
            balanced: Type.Optional(Type.Object({ id: Type.String() })),
            fast: Type.Optional(Type.Object({ id: Type.String() })),
          })),
          tiers: Type.Optional(Type.Object({
            max: Type.Optional(Type.Object({ agentRuntime: Type.String() })),
            balanced: Type.Optional(Type.Object({ agentRuntime: Type.String() })),
            fast: Type.Optional(Type.Object({ agentRuntime: Type.String() })),
          })),
        }, { description: "Multi-runtime profile spec. All runtimes must use harness: 'pi'. When omitted, falls back to a minimal pi-anthropic default and emits a deprecation note." }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const configDir = join(ctx.cwd, "eforge");
      const configPath = join(configDir, "config.yaml");

      // Ensure .gitignore has daemon state and active-profile marker
      ensureGitignoreEntries(ctx.cwd, [".eforge/", "eforge/.active-profile"]);

      // --- Conflict validation ---
      if (params.existingProfile) {
        if (params.profile) {
          throw new Error('`existingProfile` and `profile` cannot be set at the same time.');
        }
        if (params.migrate) {
          throw new Error('`existingProfile` and `migrate` cannot be set at the same time.');
        }
        if (params.existingProfile.scope !== 'user') {
          throw new Error('The init skill only supports user-scope existing profiles. Use `existingProfile.scope: "user"`.');
        }
      }

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

        const { profile: legacyProfile, remaining } = parseRawConfigLegacy(data);
        const harness = legacyProfile.backend as string;

        let maxModelId: string | undefined;
        let provider: string | undefined;
        const agents = legacyProfile.agents as Record<string, unknown> | undefined;
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
          ? sanitizeProfileName(harness, provider, maxModelId)
          : harness;

        const createBody: Record<string, unknown> = {
          name: profileName,
          harness,
          overwrite: true,
        };
        if (legacyProfile.agents) createBody.agents = legacyProfile.agents;
        if (legacyProfile.pi) createBody.pi = legacyProfile.pi;

        await daemonRequest(ctx.cwd, "POST", API_ROUTES.profileCreate, createBody);

        // Rewrite config.yaml with remaining fields only (no backend:) before
        // activating the profile, so a failed write leaves the profile inactive
        // (cleanly recoverable by re-running migrate).
        const yamlOut = Object.keys(remaining).length > 0
          ? stringifyYaml(remaining)
          : "";
        writeFileSync(configPath, yamlOut, "utf-8");

        await daemonRequest(ctx.cwd, "POST", API_ROUTES.profileUse, { name: profileName });

        if (_latestCtx) await refreshStatus(_latestCtx);

        return jsonResult({
          status: "migrated",
          configPath: "eforge/config.yaml",
          profileName,
          profilePath: `eforge/profiles/${profileName}.yaml`,
          harness,
          moved: Object.keys(legacyProfile),
          kept: Object.keys(remaining),
        });
      }

      // --- Existing profile mode ---

      if (params.existingProfile) {
        if (params.existingProfile.scope !== 'user') {
          throw new Error('The init skill only supports user-scope existing profiles. Use `existingProfile.scope: "user"`.');
        }

        try {
          accessSync(configPath);
          if (!params.force) {
            throw new Error(
              "eforge/config.yaml already exists. Use force: true to overwrite, or migrate: true to extract legacy harness config into a profile.",
            );
          }
        } catch (err) {
          if (err instanceof Error && !('code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT')) {
            throw err;
          }
          // File does not exist - proceed
        }

        mkdirSync(configDir, { recursive: true });
        await daemonRequest(ctx.cwd, "POST", API_ROUTES.profileUse, { name: params.existingProfile.name, scope: params.existingProfile.scope });

        const existingProfileConfigData: Record<string, unknown> = {};
        if (params.postMergeCommands && params.postMergeCommands.length > 0) {
          existingProfileConfigData.build = { postMergeCommands: params.postMergeCommands };
        }
        const existingProfileConfigContent = Object.keys(existingProfileConfigData).length > 0
          ? stringifyYaml(existingProfileConfigData)
          : "";
        writeFileSync(configPath, existingProfileConfigContent, "utf-8");

        let existingProfileValidation: ConfigValidateResponse | null = null;
        try {
          const { data } = await daemonRequest<ConfigValidateResponse>(
            ctx.cwd,
            "GET",
            API_ROUTES.configValidate,
          );
          existingProfileValidation = data;
        } catch {
          // Daemon validation is best-effort
        }

        if (_latestCtx) await refreshStatus(_latestCtx);

        const existingProfileResponse: Record<string, unknown> = {
          status: "initialized",
          configPath: "eforge/config.yaml",
          profileName: params.existingProfile.name,
          source: "user-scope",
          activatedExistingProfile: true,
        };
        if (existingProfileValidation) existingProfileResponse.validation = existingProfileValidation;
        return jsonResult(existingProfileResponse);
      }

      // --- Fresh init mode ---

      // Check if config already exists
      try {
        accessSync(configPath);
        if (!params.force) {
          throw new Error(
            "eforge/config.yaml already exists. Use force: true to overwrite, or migrate: true to extract legacy harness config into a profile.",
          );
        }
      } catch (err) {
        if (err instanceof Error && !('code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT')) {
          throw err;
        }
        // File does not exist - proceed
      }

      // Resolve effective profile spec
      let deprecation: string | undefined;
      let resolvedSpec: {
        agentRuntimes: Record<string, { harness: "pi"; pi?: { provider: string } }>;
        defaultAgentRuntime: string;
        models?: { max?: { id: string }; balanced?: { id: string }; fast?: { id: string } };
        tiers?: { max?: { agentRuntime: string }; balanced?: { agentRuntime: string }; fast?: { agentRuntime: string } };
      };

      if (params.profile) {
        // Validate that every runtime uses harness: 'pi'
        for (const [runtimeName, runtimeEntry] of Object.entries(params.profile.agentRuntimes)) {
          if ((runtimeEntry as { harness: string }).harness !== "pi") {
            throw new Error(
              `Runtime "${runtimeName}" uses harness "${(runtimeEntry as { harness: string }).harness}" but the Pi extension only supports harness: "pi". Use the Claude Code MCP proxy for claude-sdk runtimes.`,
            );
          }
          if (!(runtimeEntry as { pi?: { provider: string } }).pi?.provider) {
            throw new Error(
              `Runtime "${runtimeName}" is missing pi.provider. Each pi runtime must specify a provider (e.g. "anthropic", "openrouter").`,
            );
          }
        }
        resolvedSpec = {
          agentRuntimes: params.profile.agentRuntimes as Record<string, { harness: "pi"; pi?: { provider: string } }>,
          defaultAgentRuntime: params.profile.defaultAgentRuntime,
          models: params.profile.models,
          tiers: params.profile.tiers,
        };
      } else {
        // Pi-only minimal default fallback
        resolvedSpec = {
          agentRuntimes: { "pi-anthropic": { harness: "pi", pi: { provider: "anthropic" } } },
          defaultAgentRuntime: "pi-anthropic",
          models: {
            max: { id: "claude-opus-4-7" },
            balanced: { id: "claude-opus-4-7" },
            fast: { id: "claude-opus-4-7" },
          },
        };
        deprecation = "eforge_init was called without a profile parameter. Future versions will require it.";
      }

      // Compute profile name (use skill-supplied name if present, otherwise derive)
      const profileName = params.profile?.name ?? deriveProfileName(resolvedSpec);

      // Build agents block
      const agentsBlock: Record<string, unknown> = {};
      if (resolvedSpec.models) agentsBlock.models = resolvedSpec.models;
      if (resolvedSpec.tiers) agentsBlock.tiers = resolvedSpec.tiers;

      const createBody: Record<string, unknown> = {
        name: profileName,
        overwrite: !!params.force,
        agentRuntimes: resolvedSpec.agentRuntimes,
        defaultAgentRuntime: resolvedSpec.defaultAgentRuntime,
      };
      if (Object.keys(agentsBlock).length > 0) createBody.agents = agentsBlock;

      // Write a sentinel file so the daemon can discover the config directory.
      let wroteSentinel = false;
      try {
        accessSync(configPath);
      } catch {
        // File does not exist - write empty sentinel so daemon can find configDir
        mkdirSync(configDir, { recursive: true });
        writeFileSync(configPath, "", "utf-8");
        wroteSentinel = true;
      }

      try {
        await daemonRequest(ctx.cwd, "POST", API_ROUTES.profileCreate, createBody);

        // Activate the profile
        await daemonRequest(ctx.cwd, "POST", API_ROUTES.profileUse, { name: profileName });
      } catch (err) {
        if (wroteSentinel) {
          try { unlinkSync(configPath); } catch {}
        }
        throw err;
      }

      // Write config.yaml
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
          API_ROUTES.configValidate,
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
        profilePath: `eforge/profiles/${profileName}.yaml`,
        agentRuntimes: Object.keys(resolvedSpec.agentRuntimes),
      };

      if (validation) response.validation = validation;
      if (deprecation) response.deprecation = deprecation;

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

  // --- eforge:region plan-03-daemon-mcp-pi ---

  // ------------------------------------------------------------------
  // Tool: eforge_recover
  // ------------------------------------------------------------------
  pi.registerTool({
    name: "eforge_recover",
    label: "eforge recover",
    description:
      "Trigger failure recovery analysis for a failed build plan. Spawns the recovery agent as a background subprocess and returns its sessionId and pid.",
    parameters: Type.Object({
      setName: Type.String({
        description: "The plan set name (e.g. the orchestration set that contained the failing plan)",
      }),
      prdId: Type.String({
        description: "The plan ID (prdId) that failed and needs recovery analysis",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { data } = await daemonRequest(
        ctx.cwd,
        "POST",
        API_ROUTES.recover,
        { setName: params.setName, prdId: params.prdId },
      );
      return jsonResult(data);
    },
  });

  // ------------------------------------------------------------------
  // Tool: eforge_read_recovery_sidecar
  // ------------------------------------------------------------------
  pi.registerTool({
    name: "eforge_read_recovery_sidecar",
    label: "eforge read recovery sidecar",
    description:
      "Read the recovery analysis sidecar files for a failed build plan. Returns both the markdown summary and the structured JSON verdict produced by the recovery agent.",
    parameters: Type.Object({
      prdId: Type.String({
        description: "The plan ID (prdId) whose recovery sidecar to read",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const queryParams = new URLSearchParams({ prdId: params.prdId });
      const { data } = await daemonRequest(
        ctx.cwd,
        "GET",
        `${API_ROUTES.readRecoverySidecar}?${queryParams.toString()}`,
      );
      return jsonResult(data);
    },
  });

  // --- eforge:region plan-01-backend-apply-recovery ---

  // ------------------------------------------------------------------
  // Tool: eforge_apply_recovery
  // ------------------------------------------------------------------
  pi.registerTool({
    name: "eforge_apply_recovery",
    label: "eforge apply recovery",
    description:
      "Apply the recovery verdict for a failed build plan: requeue (retry), enqueue successor (split), or archive (abandon).",
    parameters: Type.Object({
      prdId: Type.String({
        description: "The plan ID (prdId) whose recovery verdict to apply",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { data } = await daemonRequest(
        ctx.cwd,
        "POST",
        API_ROUTES.applyRecovery,
        { prdId: params.prdId },
      );
      return jsonResult(data);
    },
  });

  // --- eforge:endregion plan-01-backend-apply-recovery ---

  // --- eforge:endregion plan-03-daemon-mcp-pi ---

  // --- eforge:region plan-02-daemon-http-and-mcp-tool ---

  // ------------------------------------------------------------------
  // Tool: eforge_playbook
  // ------------------------------------------------------------------
  pi.registerTool({
    name: "eforge_playbook",
    label: "eforge playbook",
    description:
      'Manage playbooks in eforge. Actions: "list" returns all playbooks with source and shadow chain; "show" returns a single playbook\'s frontmatter and body; "save" validates and writes a playbook to the target tier; "enqueue" loads a playbook and enqueues it as a PRD, optionally chained after another queue entry; "promote" moves a playbook from project-local (.eforge/playbooks/) to project-team (eforge/playbooks/); "demote" reverses a promote; "validate" checks a raw Markdown playbook string without writing.',
    parameters: Type.Object({
      action: StringEnum(["list", "show", "save", "enqueue", "promote", "demote", "validate"] as const, {
        description: "Operation to perform on playbooks",
      }),
      name: Type.Optional(
        Type.String({
          description: 'Playbook name (required for "show", "enqueue", "promote", "demote")',
        }),
      ),
      scope: Type.Optional(
        StringEnum(["user", "project-team", "project-local"] as const, {
          description: 'Target scope for "save" (determines which tier directory to write to)',
        }),
      ),
      playbook: Type.Optional(
        Type.Object({
          frontmatter: Type.Object({
            name: Type.String(),
            description: Type.String(),
            scope: StringEnum(["user", "project-team", "project-local"] as const),
            agentRuntime: Type.Optional(Type.String()),
            postMerge: Type.Optional(Type.Array(Type.String())),
          }),
          body: Type.Object({
            goal: Type.String(),
            outOfScope: Type.Optional(Type.String()),
            acceptanceCriteria: Type.Optional(Type.String()),
            plannerNotes: Type.Optional(Type.String()),
          }),
        }, {
          description: 'Playbook content (required for "save")',
        }),
      ),
      afterQueueId: Type.Optional(
        Type.String({
          description: 'Queue entry ID to depend on (optional, "enqueue" only). When set, the new PRD will have dependsOn: [afterQueueId].',
        }),
      ),
      raw: Type.Optional(
        Type.String({
          description: 'Raw Markdown playbook string (required for "validate")',
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { action, name, scope, playbook, afterQueueId, raw } = params;

      if (action === "list") {
        const { data } = await daemonRequest(ctx.cwd, "GET", API_ROUTES.playbookList);
        return jsonResult(data);
      }

      if (action === "show") {
        if (!name) throw new Error('"name" is required when action is "show"');
        const { data } = await daemonRequest(
          ctx.cwd,
          "GET",
          `${API_ROUTES.playbookShow}?name=${encodeURIComponent(name)}`,
        );
        return jsonResult(data);
      }

      if (action === "save") {
        if (!scope) throw new Error('"scope" is required when action is "save"');
        if (!playbook) throw new Error('"playbook" is required when action is "save"');
        const { data } = await daemonRequest(ctx.cwd, "POST", API_ROUTES.playbookSave, { scope, playbook });
        return jsonResult(data);
      }

      if (action === "enqueue") {
        if (!name) throw new Error('"name" is required when action is "enqueue"');
        const body: Record<string, unknown> = { name };
        if (afterQueueId !== undefined) body.afterQueueId = afterQueueId;
        const { data } = await daemonRequest(ctx.cwd, "POST", API_ROUTES.playbookEnqueue, body);
        return jsonResult(data);
      }

      if (action === "promote") {
        if (!name) throw new Error('"name" is required when action is "promote"');
        const { data } = await daemonRequest(ctx.cwd, "POST", API_ROUTES.playbookPromote, { name });
        return jsonResult(data);
      }

      if (action === "demote") {
        if (!name) throw new Error('"name" is required when action is "demote"');
        const { data } = await daemonRequest(ctx.cwd, "POST", API_ROUTES.playbookDemote, { name });
        return jsonResult(data);
      }

      // action === "validate"
      if (!raw) throw new Error('"raw" is required when action is "validate"');
      const { data } = await daemonRequest(ctx.cwd, "POST", API_ROUTES.playbookValidate, { raw });
      return jsonResult(data);
    },

    renderCall(args, theme) {
      const action = typeof args.action === "string" ? args.action : "?";
      const name = typeof args.name === "string" ? args.name : "";
      const suffix = name ? ` ${name}` : "";
      return new Text(
        theme.fg("toolTitle", theme.bold(`eforge playbook ${action}${suffix}`)),
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

        if (Array.isArray((data as { playbooks?: unknown }).playbooks)) {
          const playbooks = (data as { playbooks: Array<{ name: string; description: string; source: string }> }).playbooks;
          lines.push(theme.fg("accent", `${playbooks.length} playbook(s)`));
          for (const p of playbooks) {
            const source = theme.fg("dim", ` [${p.source}]`);
            lines.push(`  ${theme.fg("text", p.name)}${source}  ${theme.fg("muted", p.description)}`);
          }
        } else if ((data as { path?: unknown }).path) {
          lines.push(theme.fg("success", "✓ ") + theme.fg("text", String((data as { path: string }).path)));
        } else if ((data as { id?: unknown }).id) {
          lines.push(theme.fg("success", "✓ Enqueued: ") + theme.fg("accent", String((data as { id: string }).id)));
        } else if ((data as { ok?: unknown }).ok !== undefined) {
          const ok = (data as { ok: boolean }).ok;
          const errors = (data as { errors?: string[] }).errors ?? [];
          if (ok) {
            lines.push(theme.fg("success", "✓ Valid"));
          } else {
            lines.push(theme.fg("error", "✗ Invalid"));
            for (const err of errors) {
              lines.push(`  ${theme.fg("warning", err)}`);
            }
          }
        } else {
          lines.push(theme.fg("muted", text.text.slice(0, 200)));
        }
        return new Text(lines.join("\n"), 0, 0);
      } catch {
        return new Text(theme.fg("muted", text.text.slice(0, 200)), 0, 0);
      }
    },
  });

  // --- eforge:endregion plan-02-daemon-http-and-mcp-tool ---

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
    {
      name: "eforge:recover",
      description: "Inspect and apply recovery for a failed PRD",
      skill: "eforge-recover",
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
  // Native commands - /eforge:profile, /eforge:profile:new, /eforge:config
  // ------------------------------------------------------------------

  pi.registerCommand("eforge:profile", {
    description: "List, inspect, and switch profiles",
    handler: async (args) => {
      await handleProfileCommand(pi, _latestCtx, args, async () => {
        if (_latestCtx) await refreshStatus(_latestCtx);
      });
    },
  });

  pi.registerCommand("eforge:profile:new", {
    description: "Create a new profile in eforge/profiles/",
    handler: async (args) => {
      await handleProfileNewCommand(pi, _latestCtx, args, async () => {
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

  // --- eforge:region plan-04-skills-handheld-uis ---

  pi.registerCommand("eforge:playbook", {
    description: "Create, edit, run, list, and promote eforge playbooks",
    handler: async (args) => {
      await handlePlaybookCommand(pi, _latestCtx, args ?? "");
    },
  });

  // --- eforge:endregion plan-04-skills-handheld-uis ---
}
