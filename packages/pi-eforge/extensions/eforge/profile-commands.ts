/**
 * Native Pi command handlers for profile management.
 *
 * Provides interactive overlay-based UX for listing, inspecting, and
 * switching profiles (/eforge:profile) and a multi-step creation
 * wizard (/eforge:profile:new). Falls back to skill forwarding when
 * the Pi UI is not available.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { daemonRequest, API_ROUTES, buildPath } from "@eforge-build/client";
import { showSelectOverlay, showSearchableSelectOverlay, showInfoOverlay, withLoader, type UIContext } from "./ui-helpers";
import { buildProfileCreatePayload, runtimeName, type ModelClassSelection, type ProfileCreatePayload } from "./profile-payload";

// ---------------------------------------------------------------------------
// Inline response types for daemon API calls
// ---------------------------------------------------------------------------

interface ProfileEntry {
  name: string;
  harness?: string;
  path: string;
  scope: "project" | "user";
  shadowedBy?: string;
}

interface ProfileListData {
  profiles: ProfileEntry[];
  active: string | null;
  source: string;
}

// ---------------------------------------------------------------------------
// /eforge:profile - list, inspect, and switch profiles
// ---------------------------------------------------------------------------

export async function handleProfileCommand(
  pi: ExtensionAPI,
  ctx: UIContext | null,
  args: string,
  onStatusRefresh: () => Promise<void>,
): Promise<void> {
  if (!ctx || !ctx.hasUI) {
    pi.sendUserMessage(`/skill:eforge-profile${args ? " " + args : ""}`);
    return;
  }

  // If args provided, treat as profile name -> switch mode
  const profileName = args.trim();
  if (profileName) {
    try {
      await withLoader(ctx, "Switching profile...", () =>
        daemonRequest(ctx.cwd, "POST", API_ROUTES.profileUse, { name: profileName }),
      );
      await onStatusRefresh();
      await showInfoOverlay(
        ctx,
        "eforge - Profile Switched",
        `Switched to profile **${profileName}**.\n\nThe next eforge build will use this profile.`,
      );
    } catch (err) {
      await showInfoOverlay(
        ctx,
        "eforge - Error",
        `Failed to switch to profile "${profileName}":\n\n${err instanceof Error ? err.message : String(err)}\n\nUse \`/eforge:profile\` with no args to list available profiles.`,
      );
    }
    return;
  }

  // Inspect mode: fetch and display profile list
  let listData: ProfileListData;
  try {
    const result = await withLoader(ctx, "Loading profiles...", () =>
      daemonRequest<ProfileListData>(ctx.cwd, "GET", `${API_ROUTES.profileList}?scope=all`),
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
      "eforge - Profiles",
      "No profiles found.\n\nUse `/eforge:profile:new` to create one.",
    );
    return;
  }

  // Build select items with profile info
  const items = profiles.map((p) => {
    const activeMarker = p.name === active ? "●" : "○";
    const scopeBadge = p.shadowedBy ? `${p.scope} (shadowed)` : p.scope;
    const harnessType = p.harness ?? "unknown";
    return {
      value: p.name,
      label: `${activeMarker} ${p.name}`,
      description: `${scopeBadge} - ${harnessType}`,
    };
  });

  const selected = await showSelectOverlay(ctx, "eforge - Profiles", items);
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
        daemonRequest(ctx.cwd, "POST", API_ROUTES.profileUse, { name: selected }),
      );
      await onStatusRefresh();
      await showInfoOverlay(
        ctx,
        "eforge - Profile Switched",
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
// /eforge:profile:new - multi-step creation wizard
// ---------------------------------------------------------------------------

/** Model info as returned by the daemon models list endpoint. */
interface ModelInfo {
  id: string;
  provider?: string;
  releasedAt?: string;
}

/** Load model list from the daemon for a given harness/provider. Returns null on error (error shown). */
async function loadModelsList(
  ctx: UIContext,
  harness: string,
  provider?: string,
): Promise<ModelInfo[] | null> {
  const params = new URLSearchParams({ harness });
  if (provider) params.set("provider", provider);
  try {
    const { data } = await withLoader(ctx, "Loading models...", () =>
      daemonRequest<{ models: ModelInfo[] }>(
        ctx.cwd,
        "GET",
        `${API_ROUTES.modelList}?${params.toString()}`,
      ),
    );
    if (data.models.length === 0) {
      await showInfoOverlay(ctx, "eforge - Error", "No models available for the selected harness/provider.");
      return null;
    }
    return data.models;
  } catch (err) {
    await showInfoOverlay(
      ctx,
      "eforge - Error",
      `Failed to load models:\n\n${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Run the runtime + model sub-flow for a single model class.
 * Picks harness, optional provider (Pi), then model from that runtime's list.
 */
async function pickRuntimeAndModel(
  ctx: UIContext,
  stepLabel: string,
  defaultHarness: "claude-sdk" | "pi",
  defaultProvider?: string,
): Promise<{ harness: "claude-sdk" | "pi"; provider?: string; modelId: string } | null> {
  // Harness picker — smart default order
  const harnessItems =
    defaultHarness === "claude-sdk"
      ? [
          { value: "claude-sdk", label: "Claude SDK", description: "Claude Code's built-in SDK" },
          { value: "pi", label: "Pi", description: "Multi-provider via Pi SDK" },
        ]
      : [
          {
            value: "pi",
            label: "Pi",
            description: "Multi-provider via Pi SDK (OpenRouter, Anthropic, OpenAI, Google, etc.)",
          },
          { value: "claude-sdk", label: "Claude SDK", description: "Claude Code's built-in SDK" },
        ];

  const harness = (await showSelectOverlay(ctx, `eforge - ${stepLabel}: Runtime`, harnessItems)) as
    | "claude-sdk"
    | "pi"
    | null;
  if (!harness) return null;

  // Provider picker (Pi only)
  let provider: string | undefined;
  if (harness === "pi") {
    let providers: string[];
    try {
      const { data } = await withLoader(ctx, "Loading providers...", () =>
        daemonRequest<{ providers: string[] }>(ctx.cwd, "GET", `${API_ROUTES.modelProviders}?harness=pi`),
      );
      providers = data.providers;
    } catch (err) {
      await showInfoOverlay(
        ctx,
        "eforge - Error",
        `Failed to load providers:\n\n${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
    if (providers.length === 0) {
      await showInfoOverlay(ctx, "eforge - Error", "No providers available for the Pi harness.");
      return null;
    }

    // Default provider to top when previously selected
    const providerItems =
      defaultProvider && providers.includes(defaultProvider)
        ? [
            { value: defaultProvider, label: defaultProvider, description: "Previously selected" },
            ...providers
              .filter((p) => p !== defaultProvider)
              .map((p) => ({ value: p, label: p, description: `Provider: ${p}` })),
          ]
        : providers.map((p) => ({ value: p, label: p, description: `Provider: ${p}` }));

    const selectedProvider = await showSearchableSelectOverlay(
      ctx,
      `eforge - ${stepLabel}: Provider`,
      providerItems,
    );
    if (!selectedProvider) return null;
    provider = selectedProvider;
  }

  // Model picker
  const models = await loadModelsList(ctx, harness, provider);
  if (!models) return null;

  const modelItems = models.map((m) => ({
    value: m.id,
    label: m.id,
    description: [m.provider, m.releasedAt].filter(Boolean).join(" - ") || undefined,
  }));

  const modelId = await showSearchableSelectOverlay(ctx, `eforge - ${stepLabel}: Model`, modelItems);
  if (!modelId) return null;

  return { harness, provider, modelId };
}

/** Build a human-readable YAML preview of the profile payload. */
function buildYamlPreview(payload: ProfileCreatePayload): string {
  const lines: string[] = ["```yaml"];
  lines.push("agentRuntimes:");
  for (const [rtName, entry] of Object.entries(payload.agentRuntimes)) {
    lines.push(`  ${rtName}:`);
    lines.push(`    harness: ${entry.harness}`);
    if (entry.pi?.provider) {
      lines.push(`    pi:`);
      lines.push(`      provider: ${entry.pi.provider}`);
    }
  }
  lines.push(`defaultAgentRuntime: ${payload.defaultAgentRuntime}`);
  lines.push("agents:");
  lines.push("  models:");
  lines.push(`    max:`);
  lines.push(`      id: ${payload.agents.models.max.id}`);
  lines.push(`    balanced:`);
  lines.push(`      id: ${payload.agents.models.balanced.id}`);
  lines.push(`    fast: # not currently used by default by any built-in tier`);
  lines.push(`      id: ${payload.agents.models.fast.id}`);
  if (payload.agents.tiers) {
    lines.push("  tiers:");
    lines.push("    implementation:");
    lines.push(`      agentRuntime: ${payload.agents.tiers.implementation.agentRuntime}`);
  }
  lines.push("```");
  return lines.join("\n");
}

export async function handleProfileNewCommand(
  pi: ExtensionAPI,
  ctx: UIContext | null,
  args: string,
  onStatusRefresh: () => Promise<void>,
): Promise<void> {
  if (!ctx || !ctx.hasUI) {
    pi.sendUserMessage(`/skill:eforge-profile-new${args ? " " + args : ""}`);
    return;
  }

  // Parse name from args
  const name = args.trim();
  if (!name) {
    pi.sendUserMessage(
      "Please provide a name for the new profile. For example: `/eforge:profile:new pi-anthropic`",
    );
    return;
  }

  // Step 1: Scope picker
  const scope = await showSelectOverlay(ctx, "eforge - New Profile: Scope", [
    { value: "project", label: "Project scope", description: "eforge/profiles/ - committed with the project" },
    { value: "user", label: "User scope", description: "~/.config/eforge/profiles/ - reusable across projects" },
    {
      value: "local",
      label: "Local scope",
      description: ".eforge/profiles/ - gitignored, dev-personal, highest precedence",
    },
  ]) as "project" | "user" | "local" | null;
  if (!scope) return;

  // Step 2: Max model class — pick runtime + model
  const defaultHarness = name.startsWith("claude-") ? "claude-sdk" : "pi";
  const maxResult = await pickRuntimeAndModel(ctx, "New Profile: max", defaultHarness);
  if (!maxResult) return;

  const maxSelection: ModelClassSelection = {
    harness: maxResult.harness,
    provider: maxResult.provider,
    modelId: maxResult.modelId,
  };
  const maxRtName = runtimeName(maxSelection.harness, maxSelection.provider);

  // Step 3: Balanced model class
  // Offer "Same as max" at top, then "Different runtime"
  const balancedChoice = await showSelectOverlay(ctx, "eforge - New Profile: balanced", [
    {
      value: "__same__",
      label: `Same as max (${maxResult.modelId})`,
      description: `Runtime: ${maxRtName}`,
    },
    {
      value: "__different__",
      label: "Different runtime",
      description: "Choose a different harness, provider, or model",
    },
  ]);
  if (!balancedChoice) return;

  let balancedSelection: ModelClassSelection;
  if (balancedChoice === "__same__") {
    balancedSelection = maxSelection;
  } else {
    const balancedResult = await pickRuntimeAndModel(
      ctx,
      "New Profile: balanced",
      maxResult.harness,
      maxResult.provider,
    );
    if (!balancedResult) return;
    balancedSelection = {
      harness: balancedResult.harness,
      provider: balancedResult.provider,
      modelId: balancedResult.modelId,
    };
  }
  const balancedRtName = runtimeName(balancedSelection.harness, balancedSelection.provider);

  // Step 4: Fast model class
  // Offer "Same as balanced" first; add "Same as max" when runtimes differ; then "Different runtime"
  const fastChoiceItems: Array<{ value: string; label: string; description: string }> = [
    {
      value: "__same_balanced__",
      label: `Same as balanced (${balancedSelection.modelId})`,
      description: `Runtime: ${balancedRtName}`,
    },
  ];
  if (maxRtName !== balancedRtName) {
    fastChoiceItems.push({
      value: "__same_max__",
      label: `Same as max (${maxSelection.modelId})`,
      description: `Runtime: ${maxRtName}`,
    });
  }
  fastChoiceItems.push({
    value: "__different__",
    label: "Different runtime",
    description: "Choose a different harness, provider, or model",
  });

  const fastChoice = await showSelectOverlay(ctx, "eforge - New Profile: fast", fastChoiceItems);
  if (!fastChoice) return;

  let fastSelection: ModelClassSelection;
  if (fastChoice === "__same_balanced__") {
    fastSelection = balancedSelection;
  } else if (fastChoice === "__same_max__") {
    fastSelection = maxSelection;
  } else {
    const fastResult = await pickRuntimeAndModel(
      ctx,
      "New Profile: fast",
      balancedSelection.harness,
      balancedSelection.provider,
    );
    if (!fastResult) return;
    fastSelection = {
      harness: fastResult.harness,
      provider: fastResult.provider,
      modelId: fastResult.modelId,
    };
  }

  // Build the daemon payload
  const payload = buildProfileCreatePayload({
    name,
    scope,
    max: maxSelection,
    balanced: balancedSelection,
    fast: fastSelection,
  });

  // Step 5: YAML preview
  const yamlPreview = buildYamlPreview(payload);
  await showInfoOverlay(
    ctx,
    `eforge - Profile Preview: ${name}`,
    `Profile **${name}** will be written to ${scope} scope:\n\n${yamlPreview}\n\nThe \`fast\` model is declared for future/manual use and is not currently used by default by any built-in tier.`,
  );

  // Step 6: Confirm or cancel
  const confirm = await showSelectOverlay(
    ctx,
    `eforge - Confirm: ${name} (${scope})`,
    [
      {
        value: "create",
        label: "✓ Create profile",
        description: `max: ${maxSelection.modelId} / balanced: ${balancedSelection.modelId} / fast: ${fastSelection.modelId}`,
      },
      { value: "cancel", label: "✗ Cancel", description: "Abort" },
    ],
  );
  if (confirm !== "create") return;

  // Step 7: Create the profile
  try {
    await withLoader(ctx, "Creating profile...", () =>
      daemonRequest(ctx.cwd, "POST", API_ROUTES.profileCreate, payload as unknown as Record<string, unknown>),
    );
  } catch (err) {
    await showInfoOverlay(
      ctx,
      "eforge - Error",
      `Failed to create profile:\n\n${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  // Step 8: Offer activation
  const activate = await showSelectOverlay(ctx, "eforge - Activate Profile?", [
    { value: "yes", label: `Activate ${name}`, description: "Make this the active profile" },
    { value: "no", label: "Not now", description: `Switch later with /eforge:profile ${name}` },
  ]);

  if (activate === "yes") {
    try {
      await withLoader(ctx, "Activating profile...", () =>
        daemonRequest(ctx.cwd, "POST", API_ROUTES.profileUse, { name, scope }),
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
      `Profile **${name}** created at ${scope} scope.\n\nSwitch to it later with \`/eforge:profile ${name}\`.`,
    );
  }
}
