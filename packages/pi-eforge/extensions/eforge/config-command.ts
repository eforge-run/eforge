/**
 * Native Pi command handler for config viewing.
 *
 * Provides a structured read-only overlay of the resolved eforge
 * configuration (/eforge:config). Falls back to skill forwarding
 * when the Pi UI is not available.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { daemonRequest, API_ROUTES } from "@eforge-build/client";
import { showInfoOverlay, withLoader, type UIContext } from "./ui-helpers";

// ---------------------------------------------------------------------------
// /eforge:config - structured config viewer
// ---------------------------------------------------------------------------

export async function handleConfigCommand(
  pi: ExtensionAPI,
  ctx: UIContext | null,
  args: string,
): Promise<void> {
  if (!ctx || !ctx.hasUI) {
    pi.sendUserMessage(`/skill:eforge-config${args ? " " + args : ""}`);
    return;
  }

  let config: Record<string, unknown>;
  try {
    const { data } = await withLoader(ctx, "Loading config...", () =>
      daemonRequest<Record<string, unknown>>(ctx.cwd, "GET", API_ROUTES.configShow),
    );
    config = (data ?? {}) as Record<string, unknown>;
  } catch (err) {
    await showInfoOverlay(
      ctx,
      "eforge - Configuration Error",
      `Failed to load config:\n\n${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  const sections: string[] = [];

  // Post-merge commands
  const build = config.build as Record<string, unknown> | undefined;
  if (build?.postMergeCommands) {
    sections.push("## Post-Merge Commands\n");
    for (const cmd of build.postMergeCommands as string[]) {
      sections.push(`- \`${cmd}\``);
    }
    sections.push("");
  }

  // Hooks
  const hooks = config.hooks as Array<Record<string, unknown>> | undefined;
  if (hooks && hooks.length > 0) {
    sections.push("## Hooks\n");
    for (const hook of hooks) {
      sections.push(`- **${hook.event}**: \`${hook.command}\``);
    }
    sections.push("");
  }

  // Daemon settings
  const daemon = config.daemon as Record<string, unknown> | undefined;
  if (daemon) {
    sections.push("## Daemon\n");
    if (daemon.idleShutdownMs !== undefined) {
      const ms = daemon.idleShutdownMs as number;
      const display = ms === 0 ? "run forever" : `${Math.round(ms / 60000)} min idle timeout`;
      sections.push(`- ${display}`);
    }
    sections.push("");
  }

  // Agents defaults
  const agents = config.agents as Record<string, unknown> | undefined;
  if (agents) {
    sections.push("## Agents\n");
    if (agents.maxTurns) sections.push(`- Max turns: ${agents.maxTurns}`);
    if (agents.maxContinuations) sections.push(`- Max continuations: ${agents.maxContinuations}`);
    if (agents.effort) sections.push(`- Effort: ${agents.effort}`);
    if (agents.permissionMode) sections.push(`- Permission mode: ${agents.permissionMode}`);
    const models = agents.models as Record<string, unknown> | undefined;
    if (models) {
      sections.push("- Model classes:");
      for (const [cls, ref] of Object.entries(models)) {
        const modelRef = ref as Record<string, string>;
        const display = modelRef.provider ? `${modelRef.provider}/${modelRef.id}` : modelRef.id;
        sections.push(`  - **${cls}**: ${display}`);
      }
    }
    sections.push("");
  }

  // Queue
  const prdQueue = config.prdQueue as Record<string, unknown> | undefined;
  if (prdQueue) {
    sections.push("## Queue\n");
    if (prdQueue.autoBuild !== undefined) sections.push(`- Auto-build: ${prdQueue.autoBuild}`);
    if (prdQueue.dir) sections.push(`- Directory: \`${prdQueue.dir}\``);
    sections.push("");
  }

  // Max concurrent builds
  if (config.maxConcurrentBuilds !== undefined) {
    sections.push("## Concurrency\n");
    sections.push(`- Max concurrent builds: ${config.maxConcurrentBuilds}`);
    sections.push("");
  }

  if (sections.length === 0) {
    sections.push("*No custom configuration. Using defaults.*\n");
  }

  sections.push("---\n");
  sections.push("Edit `eforge/config.yaml` directly to change settings.\n");
  sections.push("Use `/eforge:backend` to manage backend profiles.");

  await showInfoOverlay(ctx, "eforge - Configuration", sections.join("\n"));
}
