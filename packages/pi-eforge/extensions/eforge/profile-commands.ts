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
import { buildProfileCreatePayload, type TierSelection, type ProfileCreatePayload } from "./profile-payload";

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

/** Preset tier shortcut names. */
type PresetName = 'max' | 'balanced' | 'fast';

/** Built-in preset shortcuts. */
const PRESETS: Record<PresetName, TierSelection> = {
  max:      { harness: 'claude-sdk', modelId: 'claude-opus-4-7',   effort: 'high' },
  balanced: { harness: 'claude-sdk', modelId: 'claude-sonnet-4-6', effort: 'medium' },
  fast:     { harness: 'claude-sdk', modelId: 'claude-haiku-4-5',  effort: 'low' },
};

const TIER_ORDER = ['planning', 'implementation', 'review', 'evaluation'] as const;
type TierName = typeof TIER_ORDER[number];

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
 * Run the custom harness + provider + model + effort sub-flow for a single tier.
 */
async function pickCustomTier(
  ctx: UIContext,
  tierLabel: string,
  defaultHarness: "claude-sdk" | "pi",
  defaultProvider?: string,
): Promise<TierSelection | null> {
  // Harness picker
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

  const harness = (await showSelectOverlay(ctx, `eforge - ${tierLabel}: Harness`, harnessItems)) as
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
      `eforge - ${tierLabel}: Provider`,
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

  const modelId = await showSearchableSelectOverlay(ctx, `eforge - ${tierLabel}: Model`, modelItems);
  if (!modelId) return null;

  // Effort picker
  const effortItems = [
    { value: "high",   label: "high",   description: "Maximum capability — best for planning and complex tasks" },
    { value: "medium", label: "medium", description: "Balanced — good for most implementation work" },
    { value: "low",    label: "low",    description: "Fast and efficient — good for review and evaluation" },
  ];
  const effort = await showSelectOverlay(ctx, `eforge - ${tierLabel}: Effort`, effortItems);
  if (!effort) return null;

  return { harness, provider, modelId, effort };
}

/** Build a human-readable YAML preview of the profile payload. */
function buildYamlPreview(payload: ProfileCreatePayload): string {
  const lines: string[] = ["```yaml"];
  lines.push("agents:");
  lines.push("  tiers:");
  for (const [tier, entry] of Object.entries(payload.agents.tiers)) {
    lines.push(`    ${tier}:`);
    lines.push(`      harness: ${entry.harness}`);
    if (entry.pi?.provider) {
      lines.push(`      pi:`);
      lines.push(`        provider: ${entry.pi.provider}`);
    }
    lines.push(`      model: ${entry.model}`);
    lines.push(`      effort: ${entry.effort}`);
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
      "Please provide a name for the new profile. For example: `/eforge:profile:new my-profile`",
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

  // Step 2-5: Walk each tier in order
  const tierSelections: Partial<Record<TierName, TierSelection>> = {};

  for (let i = 0; i < TIER_ORDER.length; i++) {
    const tier = TIER_ORDER[i];
    const tierLabel = `New Profile: ${tier}`;
    const prevTier = i > 0 ? TIER_ORDER[i - 1] : null;
    const prevSelection = prevTier ? tierSelections[prevTier] : null;

    // Build choice items
    const choiceItems: Array<{ value: string; label: string; description: string }> = [];

    // Preset shortcuts always available
    choiceItems.push({
      value: "__preset_max__",
      label: "max preset",
      description: `claude-sdk · claude-opus-4-7 · effort: high`,
    });
    choiceItems.push({
      value: "__preset_balanced__",
      label: "balanced preset",
      description: `claude-sdk · claude-sonnet-4-6 · effort: medium`,
    });
    choiceItems.push({
      value: "__preset_fast__",
      label: "fast preset",
      description: `claude-sdk · claude-haiku-4-5 · effort: low`,
    });

    // Copy from previous tier (if not first)
    if (prevSelection) {
      const prevDesc = [
        prevSelection.harness,
        prevSelection.provider,
        prevSelection.modelId,
        `effort: ${prevSelection.effort}`,
      ].filter(Boolean).join(" · ");
      choiceItems.push({
        value: "__copy_prev__",
        label: `Copy from ${prevTier} (${prevSelection.modelId})`,
        description: prevDesc,
      });
    }

    // Custom option
    choiceItems.push({
      value: "__custom__",
      label: "Custom",
      description: "Choose harness, provider, model, and effort manually",
    });

    const choice = await showSelectOverlay(ctx, `eforge - ${tierLabel}`, choiceItems);
    if (!choice) return;

    let selection: TierSelection;

    if (choice === "__preset_max__") {
      selection = { ...PRESETS.max };
    } else if (choice === "__preset_balanced__") {
      selection = { ...PRESETS.balanced };
    } else if (choice === "__preset_fast__") {
      selection = { ...PRESETS.fast };
    } else if (choice === "__copy_prev__" && prevSelection) {
      selection = { ...prevSelection };
    } else {
      // Custom flow
      const defaultHarness = prevSelection?.harness ?? (name.startsWith("claude-") ? "claude-sdk" : "pi");
      const result = await pickCustomTier(ctx, tierLabel, defaultHarness as "claude-sdk" | "pi", prevSelection?.provider);
      if (!result) return;
      selection = result;
    }

    tierSelections[tier] = selection;
  }

  const tiers = tierSelections as Record<TierName, TierSelection>;

  // Build the daemon payload
  const payload = buildProfileCreatePayload({
    name,
    scope,
    tiers: {
      planning: tiers.planning,
      implementation: tiers.implementation,
      review: tiers.review,
      evaluation: tiers.evaluation,
    },
  });

  // YAML preview
  const yamlPreview = buildYamlPreview(payload);
  await showInfoOverlay(
    ctx,
    `eforge - Profile Preview: ${name}`,
    `Profile **${name}** will be written to ${scope} scope:\n\n${yamlPreview}\n\nPresets are starting points — edit the YAML file directly to fine-tune per-tier settings.`,
  );

  // Confirm or cancel
  const planningModel = tiers.planning.modelId;
  const implModel = tiers.implementation.modelId;
  const reviewModel = tiers.review.modelId;
  const evalModel = tiers.evaluation.modelId;

  const confirm = await showSelectOverlay(
    ctx,
    `eforge - Confirm: ${name} (${scope})`,
    [
      {
        value: "create",
        label: "✓ Create profile",
        description: `planning: ${planningModel} / impl: ${implModel} / review: ${reviewModel} / eval: ${evalModel}`,
      },
      { value: "cancel", label: "✗ Cancel", description: "Abort" },
    ],
  );
  if (confirm !== "create") return;

  // Create the profile
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

  // Offer activation
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
