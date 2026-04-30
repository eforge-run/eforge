/**
 * Native Pi command handler for playbook management.
 *
 * Provides interactive overlay-based UX for listing, running, promoting,
 * and demoting playbooks (/eforge:playbook). Create and Edit are conversational
 * and delegate to the Pi skill for scope-classification reasoning and
 * section-by-section walkthrough. Falls back to skill forwarding when the
 * Pi UI is not available.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  apiPlaybookList,
  apiPlaybookEnqueue,
  apiPlaybookPromote,
  apiPlaybookDemote,
  apiGetQueue,
  type PlaybookListEntry,
  type QueueItem,
} from "@eforge-build/client";
import {
  showSelectOverlay,
  showInfoOverlay,
  withLoader,
  type UIContext,
} from "./ui-helpers";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sourceBadge(entry: PlaybookListEntry): string {
  const base = entry.source;
  if (entry.shadows && entry.shadows.length > 0) {
    return `${base} (shadows ${entry.shadows.map((s) => s.source).join(", ")})`;
  }
  return base;
}

function formatPlaybookItem(entry: PlaybookListEntry, index: number) {
  const badge = sourceBadge(entry);
  const shadowNote =
    entry.shadows && entry.shadows.length > 0
      ? ` <- shadows ${entry.shadows[0].source}`
      : "";
  return {
    value: entry.name,
    label: `${index + 1}. ${entry.name}  [${badge}]${shadowNote}`,
    description: entry.description,
  };
}

/** Fetch and format queue items as select options, returning the raw items too. */
async function fetchRunningBuilds(
  cwd: string,
): Promise<{ items: QueueItem[]; runningItems: QueueItem[] }> {
  try {
    const { data: items } = await apiGetQueue({ cwd });
    const runningItems = items.filter(
      (item) => item.status === "running" || item.status === "queued",
    );
    return { items, runningItems };
  } catch {
    return { items: [], runningItems: [] };
  }
}

// ---------------------------------------------------------------------------
// /eforge:playbook — main entry point
// ---------------------------------------------------------------------------

export async function handlePlaybookCommand(
  pi: ExtensionAPI,
  ctx: UIContext | null,
  args: string,
): Promise<void> {
  if (!ctx || !ctx.hasUI) {
    pi.sendUserMessage(`/skill:eforge-playbook${args ? " " + args : ""}`);
    return;
  }

  // Power-user shortcut: args like "run docs-sync", "list", "promote name", etc.
  const trimmed = args.trim();
  if (trimmed) {
    const [branch, ...rest] = trimmed.split(/\s+/);
    const name = rest.join(" ").trim();
    switch (branch.toLowerCase()) {
      case "create":
        // Create requires conversational reasoning — delegate to skill
        pi.sendUserMessage(
          `/skill:eforge-playbook create${name ? " " + name : ""}`,
        );
        return;
      case "edit":
        // Edit requires section-by-section conversation — delegate to skill
        pi.sendUserMessage(
          `/skill:eforge-playbook edit${name ? " " + name : ""}`,
        );
        return;
      case "run":
        await handleRunBranch(pi, ctx, name);
        return;
      case "list":
        await handleListBranch(pi, ctx);
        return;
      case "promote":
        await handlePromoteBranch(pi, ctx, name);
        return;
      case "demote":
        await handleDemoteBranch(pi, ctx, name);
        return;
      default:
        // Unknown arg — fall through to no-args menu
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // No-args menu: fetch playbook list to gate branches
  // ---------------------------------------------------------------------------

  let playbooks: PlaybookListEntry[];
  try {
    const result = await withLoader(ctx, "Loading playbooks...", () =>
      apiPlaybookList({ cwd: ctx.cwd }),
    );
    playbooks = result.data.playbooks;
  } catch (err) {
    await showInfoOverlay(
      ctx,
      "eforge - Error",
      `Failed to load playbooks:\n\n${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  const hasPlaybooks = playbooks.length > 0;
  const hasLocalPlaybooks = playbooks.some((p) => p.source === "project-local");
  const hasTeamPlaybooks = playbooks.some((p) => p.source === "project-team");

  const menuItems: { value: string; label: string; description: string }[] = [
    {
      value: "create",
      label: "Create",
      description: "Draft and save a new playbook",
    },
  ];

  if (hasPlaybooks) {
    menuItems.push(
      {
        value: "edit",
        label: "Edit",
        description: "Walk through a playbook section-by-section",
      },
      {
        value: "run",
        label: "Run",
        description: "Enqueue a playbook for building",
      },
    );
  }

  menuItems.push({
    value: "list",
    label: "List",
    description: "Read-only formatted listing of all playbooks",
  });

  if (hasLocalPlaybooks) {
    menuItems.push({
      value: "promote",
      label: "Promote",
      description: "Move a .eforge/playbooks/ entry to eforge/playbooks/",
    });
  }

  if (hasTeamPlaybooks) {
    menuItems.push({
      value: "demote",
      label: "Demote",
      description: "Move an eforge/playbooks/ entry back to .eforge/playbooks/",
    });
  }

  const choice = await showSelectOverlay(ctx, "eforge - Playbooks", menuItems);
  if (!choice) return;

  switch (choice) {
    case "create":
      // Conversational — delegate to skill
      pi.sendUserMessage("/skill:eforge-playbook create");
      break;
    case "edit":
      // Conversational — delegate to skill
      pi.sendUserMessage("/skill:eforge-playbook edit");
      break;
    case "run":
      await handleRunBranch(pi, ctx, "");
      break;
    case "list":
      await handleListBranch(pi, ctx);
      break;
    case "promote":
      await handlePromoteBranch(pi, ctx, "");
      break;
    case "demote":
      await handleDemoteBranch(pi, ctx, "");
      break;
  }
}

// ---------------------------------------------------------------------------
// Branch: Run
// ---------------------------------------------------------------------------

async function handleRunBranch(
  pi: ExtensionAPI,
  ctx: UIContext,
  preSelectedName: string,
): Promise<void> {
  // Step 1: Fetch playbooks
  let playbooks: PlaybookListEntry[];
  try {
    const result = await withLoader(ctx, "Loading playbooks...", () =>
      apiPlaybookList({ cwd: ctx.cwd }),
    );
    playbooks = result.data.playbooks;
  } catch (err) {
    await showInfoOverlay(
      ctx,
      "eforge - Error",
      `Failed to load playbooks:\n\n${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  if (playbooks.length === 0) {
    await showInfoOverlay(
      ctx,
      "eforge - Playbooks",
      "No playbooks found.\n\nUse `/eforge:playbook create` (or choose Create from the menu) to make one.",
    );
    return;
  }

  // Step 2: Pick a playbook (pre-select if name provided)
  let selectedName: string | null;
  if (preSelectedName) {
    const found = playbooks.find(
      (p) => p.name.toLowerCase() === preSelectedName.toLowerCase(),
    );
    if (!found) {
      await showInfoOverlay(
        ctx,
        "eforge - Playbook Not Found",
        `No playbook named "${preSelectedName}" found.\n\nAvailable playbooks:\n${playbooks.map((p) => `- ${p.name} [${p.source}]`).join("\n")}`,
      );
      return;
    }
    selectedName = found.name;
  } else {
    const items = playbooks.map((p, i) => formatPlaybookItem(p, i));
    selectedName = await showSelectOverlay(
      ctx,
      "eforge - Run Playbook",
      items,
    );
    if (!selectedName) return;
  }

  // Step 3: Check for in-flight builds
  const { runningItems } = await withLoader(
    ctx,
    "Checking queue...",
    () => fetchRunningBuilds(ctx.cwd),
  );

  let afterQueueId: string | undefined;

  if (runningItems.length > 0) {
    // Build wait-or-run-now options (user sees titles, never queue ids)
    const waitOptions = [
      {
        value: "now",
        label: "Run now",
        description: "Enqueue immediately, no dependency",
      },
      ...runningItems.map((item) => ({
        value: item.id,
        label: `Wait for: ${item.title}`,
        description: `[${item.status}] Runs after this build finishes`,
      })),
    ];

    const waitChoice = await showSelectOverlay(
      ctx,
      "eforge - Active Builds Detected",
      waitOptions,
    );
    if (!waitChoice) return;

    if (waitChoice !== "now") {
      // Resolve title -> queue id internally
      afterQueueId = waitChoice;
    }
  }

  // Step 4: Enqueue
  try {
    await withLoader(ctx, `Enqueueing ${selectedName}...`, () =>
      apiPlaybookEnqueue({
        cwd: ctx.cwd,
        body: afterQueueId
          ? { name: selectedName!, afterQueueId }
          : { name: selectedName! },
      }),
    );
  } catch (err) {
    await showInfoOverlay(
      ctx,
      "eforge - Error",
      `Failed to enqueue playbook "${selectedName}":\n\n${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  const afterNote = afterQueueId
    ? `\n\nIt will start after the selected build finishes.`
    : "";
  await showInfoOverlay(
    ctx,
    "eforge - Playbook Enqueued",
    `Playbook **${selectedName}** enqueued.${afterNote}`,
  );
}

// ---------------------------------------------------------------------------
// Branch: List
// ---------------------------------------------------------------------------

async function handleListBranch(
  _pi: ExtensionAPI,
  ctx: UIContext,
): Promise<void> {
  let playbooks: PlaybookListEntry[];
  try {
    const result = await withLoader(ctx, "Loading playbooks...", () =>
      apiPlaybookList({ cwd: ctx.cwd }),
    );
    playbooks = result.data.playbooks;
  } catch (err) {
    await showInfoOverlay(
      ctx,
      "eforge - Error",
      `Failed to load playbooks:\n\n${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  if (playbooks.length === 0) {
    await showInfoOverlay(
      ctx,
      "eforge - Playbooks",
      "No playbooks found.\n\nUse `/eforge:playbook create` (or choose Create from the menu) to make one.",
    );
    return;
  }

  // Group by scope tier
  const userPlaybooks = playbooks.filter((p) => p.source === "user");
  const teamPlaybooks = playbooks.filter((p) => p.source === "project-team");
  const localPlaybooks = playbooks.filter((p) => p.source === "project-local");

  const lines: string[] = [`**${playbooks.length} playbook(s)**\n`];

  if (localPlaybooks.length > 0) {
    lines.push("**Project-local** (`.eforge/playbooks/`):");
    for (const p of localPlaybooks) {
      const shadowNote =
        p.shadows && p.shadows.length > 0
          ? ` ← shadows ${p.shadows.map((s) => s.source).join(", ")}`
          : "";
      lines.push(`- **${p.name}**${shadowNote}  \n  ${p.description}`);
    }
    lines.push("");
  }

  if (teamPlaybooks.length > 0) {
    lines.push("**Project-team** (`eforge/playbooks/`):");
    for (const p of teamPlaybooks) {
      const shadowedBy =
        localPlaybooks.find((l) => l.name === p.name) != null
          ? " ⚠ shadowed by project-local"
          : "";
      lines.push(`- **${p.name}**${shadowedBy}  \n  ${p.description}`);
    }
    lines.push("");
  }

  if (userPlaybooks.length > 0) {
    lines.push("**User** (`~/.config/eforge/playbooks/`):");
    for (const p of userPlaybooks) {
      lines.push(`- **${p.name}**  \n  ${p.description}`);
    }
  }

  await showInfoOverlay(ctx, "eforge - Playbooks", lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Branch: Promote
// ---------------------------------------------------------------------------

async function handlePromoteBranch(
  _pi: ExtensionAPI,
  ctx: UIContext,
  preSelectedName: string,
): Promise<void> {
  let playbooks: PlaybookListEntry[];
  try {
    const result = await withLoader(ctx, "Loading playbooks...", () =>
      apiPlaybookList({ cwd: ctx.cwd }),
    );
    playbooks = result.data.playbooks;
  } catch (err) {
    await showInfoOverlay(
      ctx,
      "eforge - Error",
      `Failed to load playbooks:\n\n${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  const localPlaybooks = playbooks.filter((p) => p.source === "project-local");

  if (localPlaybooks.length === 0) {
    await showInfoOverlay(
      ctx,
      "eforge - Promote",
      "No project-local playbooks to promote.\n\nProject-local playbooks live in `.eforge/playbooks/` and can be promoted to `eforge/playbooks/` to share with the team.",
    );
    return;
  }

  let selectedName: string | null;
  if (preSelectedName) {
    const found = localPlaybooks.find(
      (p) => p.name.toLowerCase() === preSelectedName.toLowerCase(),
    );
    if (!found) {
      await showInfoOverlay(
        ctx,
        "eforge - Not Found",
        `No project-local playbook named "${preSelectedName}" found.\n\nLocal playbooks:\n${localPlaybooks.map((p) => `- ${p.name}`).join("\n")}`,
      );
      return;
    }
    selectedName = found.name;
  } else {
    const items = localPlaybooks.map((p, i) => ({
      value: p.name,
      label: `${i + 1}. ${p.name}`,
      description: p.description,
    }));
    selectedName = await showSelectOverlay(
      ctx,
      "eforge - Promote: Pick Playbook",
      items,
    );
    if (!selectedName) return;
  }

  // Shadow trade-off notice + confirm
  const confirm = await showSelectOverlay(
    ctx,
    `eforge - Promote: ${selectedName}`,
    [
      {
        value: "promote",
        label: "Promote to project-team",
        description: `Moves .eforge/playbooks/${selectedName}.md → eforge/playbooks/${selectedName}.md`,
      },
      {
        value: "cancel",
        label: "Cancel",
        description:
          "Note: after promotion, team-side improvements to a same-named playbook will be shadowed by this copy",
      },
    ],
  );
  if (confirm !== "promote") return;

  let destPath: string;
  try {
    const result = await withLoader(ctx, `Promoting ${selectedName}...`, () =>
      apiPlaybookPromote({ cwd: ctx.cwd, body: { name: selectedName! } }),
    );
    destPath = result.data.path;
  } catch (err) {
    await showInfoOverlay(
      ctx,
      "eforge - Error",
      `Failed to promote "${selectedName}":\n\n${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  await showInfoOverlay(
    ctx,
    "eforge - Promoted",
    `Playbook **${selectedName}** promoted to \`${destPath}\`.`,
  );
}

// ---------------------------------------------------------------------------
// Branch: Demote
// ---------------------------------------------------------------------------

async function handleDemoteBranch(
  _pi: ExtensionAPI,
  ctx: UIContext,
  preSelectedName: string,
): Promise<void> {
  let playbooks: PlaybookListEntry[];
  try {
    const result = await withLoader(ctx, "Loading playbooks...", () =>
      apiPlaybookList({ cwd: ctx.cwd }),
    );
    playbooks = result.data.playbooks;
  } catch (err) {
    await showInfoOverlay(
      ctx,
      "eforge - Error",
      `Failed to load playbooks:\n\n${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  const teamPlaybooks = playbooks.filter((p) => p.source === "project-team");

  if (teamPlaybooks.length === 0) {
    await showInfoOverlay(
      ctx,
      "eforge - Demote",
      "No project-team playbooks to demote.\n\nProject-team playbooks live in `eforge/playbooks/`. Demoting creates a personal `.eforge/playbooks/` shadow.",
    );
    return;
  }

  let selectedName: string | null;
  if (preSelectedName) {
    const found = teamPlaybooks.find(
      (p) => p.name.toLowerCase() === preSelectedName.toLowerCase(),
    );
    if (!found) {
      await showInfoOverlay(
        ctx,
        "eforge - Not Found",
        `No project-team playbook named "${preSelectedName}" found.\n\nTeam playbooks:\n${teamPlaybooks.map((p) => `- ${p.name}`).join("\n")}`,
      );
      return;
    }
    selectedName = found.name;
  } else {
    const items = teamPlaybooks.map((p, i) => ({
      value: p.name,
      label: `${i + 1}. ${p.name}`,
      description: p.description,
    }));
    selectedName = await showSelectOverlay(
      ctx,
      "eforge - Demote: Pick Playbook",
      items,
    );
    if (!selectedName) return;
  }

  // Shadow trade-off notice + confirm
  const confirm = await showSelectOverlay(
    ctx,
    `eforge - Demote: ${selectedName}`,
    [
      {
        value: "demote",
        label: "Demote to project-local",
        description: `Creates .eforge/playbooks/${selectedName}.md (shadows the team version)`,
      },
      {
        value: "cancel",
        label: "Cancel",
        description: "The daemon will run your local copy instead of the team version",
      },
    ],
  );
  if (confirm !== "demote") return;

  let destPath: string;
  try {
    const result = await withLoader(ctx, `Demoting ${selectedName}...`, () =>
      apiPlaybookDemote({ cwd: ctx.cwd, body: { name: selectedName! } }),
    );
    destPath = result.data.path;
  } catch (err) {
    await showInfoOverlay(
      ctx,
      "eforge - Error",
      `Failed to demote "${selectedName}":\n\n${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  await showInfoOverlay(
    ctx,
    "eforge - Demoted",
    `Playbook **${selectedName}** demoted to \`${destPath}\`.\n\nThe daemon will now run your local copy instead of the team version.`,
  );
}
