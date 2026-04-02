/**
 * eforge Pi extension — bridges eforge daemon operations into Pi as tools and commands.
 *
 * Provides the same tool surface as the Claude Code MCP proxy (src/cli/mcp-proxy.ts),
 * but as native Pi tools that talk directly to the daemon HTTP API.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { readFileSync, accessSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";

// ---------------------------------------------------------------------------
// Daemon client — inlined from the canonical sources below.
// If the daemon HTTP API changes, update this code to match.
//   src/cli/daemon-client.ts   (ensureDaemon, daemonRequest, daemonRequestWithPort)
//   src/monitor/lockfile.ts    (readLockfile, isPidAlive, isServerAlive, LockfileData)
// ---------------------------------------------------------------------------

const LOCKFILE_NAME = "daemon.lock";
const LEGACY_LOCKFILE_NAME = "monitor.lock";
const DAEMON_START_TIMEOUT_MS = 15_000;
const DAEMON_POLL_INTERVAL_MS = 500;
const LOCKFILE_POLL_INTERVAL_MS = 250;
const LOCKFILE_POLL_TIMEOUT_MS = 5000;

interface LockfileData {
  pid: number;
  port: number;
  startedAt: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lockfilePath(cwd: string): string {
  return resolve(cwd, ".eforge", LOCKFILE_NAME);
}

function legacyLockfilePath(cwd: string): string {
  return resolve(cwd, ".eforge", LEGACY_LOCKFILE_NAME);
}

function tryReadLockfileAt(path: string): LockfileData | null {
  try {
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw);
    if (
      typeof data.pid === "number" &&
      typeof data.port === "number" &&
      typeof data.startedAt === "string"
    ) {
      return data as LockfileData;
    }
    return null;
  } catch {
    return null;
  }
}

function readLockfile(cwd: string): LockfileData | null {
  return (
    tryReadLockfileAt(lockfilePath(cwd)) ??
    tryReadLockfileAt(legacyLockfilePath(cwd))
  );
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function isServerAlive(lock: LockfileData): Promise<boolean> {
  if (!isPidAlive(lock.pid)) return false;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`http://127.0.0.1:${lock.port}/api/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (res.ok) {
      const body = (await res.json()) as { status: string };
      return body.status === "ok";
    }
    return false;
  } catch {
    return false;
  }
}

async function ensureDaemon(cwd: string): Promise<number> {
  const existing = readLockfile(cwd);
  if (existing && (await isServerAlive(existing))) {
    return existing.port;
  }

  const bin = process.env.EFORGE_BIN ?? "eforge";
  const child = spawn(bin, ["daemon", "start"], {
    cwd,
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {
    /* swallow — poll loop will time out */
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
    "Daemon failed to start within timeout. Run `eforge daemon start` manually to diagnose.",
  );
}

async function daemonRequestWithPort(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<{ data: unknown; port: number }> {
  const url = `http://127.0.0.1:${port}${path}`;
  const options: RequestInit = {
    method,
    signal: signal ?? AbortSignal.timeout(30_000),
  };
  if (body !== undefined) {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(body);
  }
  const res = await fetch(url, options);
  const text = await res.text();
  if (!res.ok) {
    const truncated =
      text.length > 200 ? text.slice(0, 200) + "..." : text;
    throw new Error(`Daemon returned ${res.status}: ${truncated}`);
  }
  try {
    return { data: JSON.parse(text), port };
  } catch {
    return { data: text, port };
  }
}

async function daemonRequest(
  cwd: string,
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<{ data: unknown; port: number }> {
  const port = await ensureDaemon(cwd);
  return daemonRequestWithPort(port, method, path, body, signal);
}

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
  data: unknown,
  port: number,
): Record<string, unknown> {
  const obj =
    data != null && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : { data };
  return { ...obj, monitorUrl: `http://localhost:${port}` };
}

async function checkActiveBuilds(
  cwd: string,
): Promise<string | null> {
  try {
    const { data: latestRun } = await daemonRequest(
      cwd,
      "GET",
      "/api/latest-run",
    );
    const latestRunObj = latestRun as { sessionId?: string };
    if (!latestRunObj?.sessionId) return null;
    const { data: summary } = await daemonRequest(
      cwd,
      "GET",
      `/api/run-summary/${encodeURIComponent(latestRunObj.sessionId)}`,
    );
    const summaryObj = summary as { status?: string };
    if (summaryObj?.status === "running") {
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
      const { data, port } = await daemonRequest(
        ctx.cwd,
        "POST",
        "/api/enqueue",
        { source: params.source },
        signal,
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
      const { data: latestRun } = await daemonRequest(
        ctx.cwd,
        "GET",
        "/api/latest-run",
        undefined,
        signal,
      );
      const latestRunObj = latestRun as { sessionId?: string };
      if (!latestRunObj?.sessionId) {
        return jsonResult({
          status: "idle",
          message: "No active eforge sessions.",
        });
      }
      const { data: summary } = await daemonRequest(
        ctx.cwd,
        "GET",
        `/api/run-summary/${encodeURIComponent(latestRunObj.sessionId)}`,
        undefined,
        signal,
      );
      return jsonResult(summary);
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
      const { data } = await daemonRequest(ctx.cwd, "GET", "/api/queue", undefined, signal);
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
      const { data } = await daemonRequest(ctx.cwd, "GET", path, undefined, signal);
      return jsonResult(data);
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
        const { data } = await daemonRequest(
          ctx.cwd,
          "GET",
          "/api/auto-build",
          undefined,
          signal,
        );
        return jsonResult(data);
      }
      if (params.enabled === undefined) {
        throw new Error('"enabled" is required when action is "set"');
      }
      const { data } = await daemonRequest(
        ctx.cwd,
        "POST",
        "/api/auto-build",
        { enabled: params.enabled },
        signal,
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
      "Initialize eforge in a project: creates eforge/config.yaml (backend: pi) and updates .gitignore.",
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
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const configDir = join(ctx.cwd, "eforge");
      const configPath = join(configDir, "config.yaml");

      // Check if config already exists
      try {
        accessSync(configPath);
        if (!params.force) {
          throw new Error(
            "eforge/config.yaml already exists. Use force: true to overwrite.",
          );
        }
      } catch (err) {
        if (
          err instanceof Error &&
          err.message.includes("already exists")
        ) {
          throw err;
        }
        // File does not exist — proceed
      }

      // Pi users always get backend: pi. The /eforge:config skill handles
      // backend selection interactively when the user wants to change it.
      const backend = "pi";

      // Ensure .gitignore has .eforge/ entry
      ensureGitignoreEntries(ctx.cwd, [".eforge/"]);

      // Create eforge/ directory
      try {
        mkdirSync(configDir, { recursive: true });
      } catch {
        // Directory may already exist
      }

      // Read existing config or create new one
      let configContent: string;
      try {
        const existing = readFileSync(configPath, "utf-8");
        if (/^backend\s*:/m.test(existing)) {
          configContent = existing.replace(
            /^backend\s*:.*$/m,
            `backend: ${backend}`,
          );
        } else {
          configContent = `backend: ${backend}\n\n${existing}`;
        }
      } catch {
        const lines = [`backend: ${backend}`, ""];
        if (
          params.postMergeCommands &&
          params.postMergeCommands.length > 0
        ) {
          lines.push("build:");
          lines.push("  postMergeCommands:");
          for (const cmd of params.postMergeCommands) {
            lines.push(`    - ${yamlQuote(cmd)}`);
          }
          lines.push("");
        }
        configContent = lines.join("\n");
      }

      writeFileSync(configPath, configContent, "utf-8");

      // Validate config via daemon (best-effort)
      let validation: Record<string, unknown> | null = null;
      try {
        const { data } = await daemonRequest(
          ctx.cwd,
          "GET",
          "/api/config/validate",
          undefined,
          signal,
        );
        validation = data as Record<string, unknown>;
      } catch {
        // Daemon validation is best-effort
      }

      const response: Record<string, unknown> = {
        status: "initialized",
        configPath: "eforge/config.yaml",
        backend,
      };

      if (validation) {
        response.validation = validation;
      }

      return jsonResult(response);
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
      name: "eforge:config",
      description: "Initialize or edit eforge configuration",
      skill: "eforge-config",
    },
    {
      name: "eforge:init",
      description: "Initialize eforge in the current project",
      skill: "eforge-init",
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
}
