/**
 * Native Pi command handlers for backend profile management.
 *
 * Provides interactive overlay-based UX for listing, inspecting, and
 * switching backend profiles (/eforge:backend) and a multi-step creation
 * wizard (/eforge:backend:new). Falls back to skill forwarding when
 * the Pi UI is not available.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { daemonRequest } from "@eforge-build/client";
import { showSelectOverlay, showInfoOverlay, withLoader, type UIContext } from "./ui-helpers";

// ---------------------------------------------------------------------------
// Inline response types for daemon API calls
// ---------------------------------------------------------------------------

interface BackendProfile {
  name: string;
  backend?: string;
  path: string;
  scope: "project" | "user";
  shadowedBy?: string;
}

interface BackendListData {
  profiles: BackendProfile[];
  active: string | null;
  source: string;
}

// ---------------------------------------------------------------------------
// /eforge:backend - list, inspect, and switch profiles
// ---------------------------------------------------------------------------

export async function handleBackendCommand(
  pi: ExtensionAPI,
  ctx: UIContext | null,
  args: string,
  onStatusRefresh: () => Promise<void>,
): Promise<void> {
  if (!ctx || !ctx.hasUI) {
    pi.sendUserMessage(`/skill:eforge-backend${args ? " " + args : ""}`);
    return;
  }

  // If args provided, treat as profile name -> switch mode
  const profileName = args.trim();
  if (profileName) {
    try {
      await withLoader(ctx, "Switching profile...", () =>
        daemonRequest(ctx.cwd, "POST", "/api/backend/use", { name: profileName }),
      );
      await onStatusRefresh();
      await showInfoOverlay(
        ctx,
        "eforge - Backend Switched",
        `Switched to profile **${profileName}**.\n\nThe next eforge build will use this profile.`,
      );
    } catch (err) {
      await showInfoOverlay(
        ctx,
        "eforge - Error",
        `Failed to switch to profile "${profileName}":\n\n${err instanceof Error ? err.message : String(err)}\n\nUse \`/eforge:backend\` with no args to list available profiles.`,
      );
    }
    return;
  }

  // Inspect mode: fetch and display profile list
  let listData: BackendListData;
  try {
    const result = await withLoader(ctx, "Loading profiles...", () =>
      daemonRequest<BackendListData>(ctx.cwd, "GET", "/api/backend/list?scope=all"),
    );
    listData = result.data;
  } catch (err) {
    await showInfoOverlay(
      ctx,
      "eforge - Error",
      `Failed to load profiles:\n\n${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  const { profiles, active } = listData;

  if (profiles.length === 0) {
    await showInfoOverlay(
      ctx,
      "eforge - Backend Profiles",
      "No backend profiles found.\n\nUse `/eforge:backend:new` to create one.",
    );
    return;
  }

  // Build select items with profile info
  const items = profiles.map((p) => {
    const activeMarker = p.name === active ? "●" : "○";
    const scopeBadge = p.shadowedBy ? `${p.scope} (shadowed)` : p.scope;
    const backendType = p.backend ?? "unknown";
    return {
      value: p.name,
      label: `${activeMarker} ${p.name}`,
      description: `${scopeBadge} - ${backendType}`,
    };
  });

  const selected = await showSelectOverlay(ctx, "eforge - Backend Profiles", items);
  if (!selected) return;

  // Show detail actions for the selected profile
  const isActive = selected === active;
  const detailItems = isActive
    ? [
        { value: "info", label: "● Currently active", description: `${selected} is the active profile` },
        { value: "close", label: "Close", description: "Go back" },
      ]
    : [
        { value: "switch", label: "Switch to this profile", description: `Activate ${selected}` },
        { value: "close", label: "Close", description: "Go back" },
      ];

  const action = await showSelectOverlay(ctx, `eforge - Profile: ${selected}`, detailItems);

  if (action === "switch") {
    try {
      await withLoader(ctx, "Switching profile...", () =>
        daemonRequest(ctx.cwd, "POST", "/api/backend/use", { name: selected }),
      );
      await onStatusRefresh();
      await showInfoOverlay(
        ctx,
        "eforge - Backend Switched",
        `Switched to profile **${selected}**.\n\nThe next eforge build will use this profile.`,
      );
    } catch (err) {
      await showInfoOverlay(
        ctx,
        "eforge - Error",
        `Failed to switch profile:\n\n${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// /eforge:backend:new - multi-step creation wizard
// ---------------------------------------------------------------------------

export async function handleBackendNewCommand(
  pi: ExtensionAPI,
  ctx: UIContext | null,
  args: string,
  onStatusRefresh: () => Promise<void>,
): Promise<void> {
  if (!ctx || !ctx.hasUI) {
    pi.sendUserMessage(`/skill:eforge-backend-new${args ? " " + args : ""}`);
    return;
  }

  // Parse name from args
  const name = args.trim();
  if (!name) {
    pi.sendUserMessage(
      "Please provide a name for the new backend profile. For example: `/eforge:backend:new pi-anthropic`",
    );
    return;
  }

  // Step 1: Scope picker
  const scope = await showSelectOverlay(ctx, "eforge - New Profile: Scope", [
    { value: "project", label: "Project scope", description: "eforge/backends/ - committed with the project" },
    { value: "user", label: "User scope", description: "~/.config/eforge/backends/ - reusable across projects" },
  ]);
  if (!scope) return;

  // Step 2: Backend type picker (smart default based on name hint)
  const defaultBackend = name.startsWith("claude-") ? "claude-sdk" : "pi";
  const backendItems = defaultBackend === "claude-sdk"
    ? [
        { value: "claude-sdk", label: "Claude SDK", description: "Claude Code's built-in SDK" },
        { value: "pi", label: "Pi", description: "Multi-provider via Pi SDK" },
      ]
    : [
        { value: "pi", label: "Pi", description: "Multi-provider via Pi SDK (OpenRouter, Anthropic, OpenAI, Google, etc.)" },
        { value: "claude-sdk", label: "Claude SDK", description: "Claude Code's built-in SDK" },
      ];

  const backend = await showSelectOverlay(ctx, "eforge - New Profile: Backend", backendItems);
  if (!backend) return;

  // Step 3: Provider picker (Pi only)
  let provider: string | undefined;
  if (backend === "pi") {
    let providers: string[];
    try {
      const { data } = await withLoader(ctx, "Loading providers...", () =>
        daemonRequest<{ providers: string[] }>(ctx.cwd, "GET", "/api/models/providers?backend=pi"),
      );
      providers = data.providers;
    } catch (err) {
      await showInfoOverlay(
        ctx,
        "eforge - Error",
        `Failed to load providers:\n\n${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    if (providers.length === 0) {
      await showInfoOverlay(ctx, "eforge - Error", "No providers available for the Pi backend.");
      return;
    }

    const providerItems = providers.map((p) => ({
      value: p,
      label: p,
      description: `Provider: ${p}`,
    }));

    const selectedProvider = await showSelectOverlay(ctx, "eforge - New Profile: Provider", providerItems);
    if (!selectedProvider) return;
    provider = selectedProvider;
  }

  // Step 4: Model picker for max class
  const modelQueryParams = new URLSearchParams({ backend });
  if (provider) modelQueryParams.set("provider", provider);

  let models: Array<{ id: string; provider?: string; releasedAt?: string }>;
  try {
    const { data } = await withLoader(ctx, "Loading models...", () =>
      daemonRequest<{ models: Array<{ id: string; provider?: string; releasedAt?: string }> }>(
        ctx.cwd,
        "GET",
        `/api/models/list?${modelQueryParams.toString()}`,
      ),
    );
    models = data.models;
  } catch (err) {
    await showInfoOverlay(
      ctx,
      "eforge - Error",
      `Failed to load models:\n\n${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  if (models.length === 0) {
    await showInfoOverlay(ctx, "eforge - Error", "No models available for the selected backend/provider.");
    return;
  }

  const modelItems = models.slice(0, 20).map((m) => ({
    value: m.id,
    label: m.id,
    description: [m.provider, m.releasedAt].filter(Boolean).join(" - ") || undefined,
  }));

  const maxModel = await showSelectOverlay(ctx, "eforge - New Profile: Max Model", modelItems);
  if (!maxModel) return;

  // Step 5: Balanced model (default: same as max)
  const balancedItems = [
    { value: maxModel, label: `Same as max (${maxModel})`, description: "Use the same model for balanced class" },
    ...modelItems.filter((m) => m.value !== maxModel),
  ];
  const balancedModel = await showSelectOverlay(ctx, "eforge - New Profile: Balanced Model", balancedItems);
  if (!balancedModel) return;

  // Step 6: Fast model (default: same as balanced)
  const fastItems = [
    { value: balancedModel, label: `Same as balanced (${balancedModel})`, description: "Use the same model for fast class" },
    ...modelItems.filter((m) => m.value !== balancedModel),
  ];
  const fastModel = await showSelectOverlay(ctx, "eforge - New Profile: Fast Model", fastItems);
  if (!fastModel) return;

  // Step 7: Optional tuning
  const tuneDefaults = backend === "pi" ? "effort: high, thinkingLevel: medium" : "effort: high";
  const tuneChoice = await showSelectOverlay(ctx, "eforge - New Profile: Tuning", [
    { value: "defaults", label: "Use defaults", description: tuneDefaults },
    { value: "customize", label: "Customize", description: "Choose effort level" + (backend === "pi" ? " and thinking level" : "") },
  ]);
  if (!tuneChoice) return;

  let effort: string | undefined;
  let thinkingLevel: string | undefined;

  if (tuneChoice === "customize") {
    const effortChoice = await showSelectOverlay(ctx, "eforge - New Profile: Effort Level", [
      { value: "low", label: "Low", description: "Minimal effort" },
      { value: "medium", label: "Medium", description: "Moderate effort" },
      { value: "high", label: "High", description: "High effort (default)" },
      { value: "xhigh", label: "Extra High", description: "Extra high effort" },
      { value: "max", label: "Max", description: "Maximum effort" },
    ]);
    if (!effortChoice) return;
    effort = effortChoice;

    if (backend === "pi") {
      const thinkingChoice = await showSelectOverlay(ctx, "eforge - New Profile: Thinking Level", [
        { value: "off", label: "Off", description: "No thinking" },
        { value: "low", label: "Low", description: "Light thinking" },
        { value: "medium", label: "Medium", description: "Moderate thinking (default)" },
        { value: "high", label: "High", description: "Deep thinking" },
        { value: "xhigh", label: "Extra High", description: "Maximum thinking" },
      ]);
      if (!thinkingChoice) return;
      thinkingLevel = thinkingChoice;
    }
  }

  // Step 8: Confirmation
  const modelRef = (id: string): Record<string, string> => {
    const ref: Record<string, string> = { id };
    if (provider) ref.provider = provider;
    return ref;
  };

  const confirmTitle = `eforge - Confirm: ${name} (${backend}, ${scope})`;
  const confirm = await showSelectOverlay(ctx, confirmTitle, [
    { value: "create", label: "✓ Create profile", description: `${maxModel} / ${balancedModel} / ${fastModel}` },
    { value: "cancel", label: "✗ Cancel", description: "Abort" },
  ]);
  if (confirm !== "create") return;

  // Step 9: Create the profile
  const createBody: Record<string, unknown> = {
    name,
    backend,
    scope,
    agents: {
      models: {
        max: modelRef(maxModel),
        balanced: modelRef(balancedModel),
        fast: modelRef(fastModel),
      },
      ...(effort ? { effort } : {}),
    },
  };
  if (thinkingLevel) {
    createBody.pi = { thinkingLevel };
  }

  try {
    await withLoader(ctx, "Creating profile...", () =>
      daemonRequest(ctx.cwd, "POST", "/api/backend/create", createBody),
    );
  } catch (err) {
    await showInfoOverlay(
      ctx,
      "eforge - Error",
      `Failed to create profile:\n\n${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  // Step 10: Offer activation
  const activate = await showSelectOverlay(ctx, "eforge - Activate Profile?", [
    { value: "yes", label: `Activate ${name}`, description: "Make this the active profile" },
    { value: "no", label: "Not now", description: `Switch later with /eforge:backend ${name}` },
  ]);

  if (activate === "yes") {
    try {
      await withLoader(ctx, "Activating profile...", () =>
        daemonRequest(ctx.cwd, "POST", "/api/backend/use", { name, scope }),
      );
      await onStatusRefresh();
      await showInfoOverlay(
        ctx,
        "eforge - Profile Created & Activated",
        `Profile **${name}** created and activated.\n\nThe next eforge build will use this profile.`,
      );
    } catch (err) {
      await showInfoOverlay(
        ctx,
        "eforge - Error",
        `Profile created but activation failed:\n\n${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    await showInfoOverlay(
      ctx,
      "eforge - Profile Created",
      `Profile **${name}** created at ${scope} scope.\n\nSwitch to it later with \`/eforge:backend ${name}\`.`,
    );
  }
}
