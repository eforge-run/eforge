---
name: eforge-profile-new
description: Create a new agent runtime profile in eforge/profiles/
disable-model-invocation: true
---

> **Note:** In Pi, the native `/eforge:profile-new` command provides a richer interactive experience with a guided overlay-based creation wizard. This skill serves as a fallback for non-interactive contexts and as model-readable documentation.

# /eforge:profile-new

Interactively create a new named agent runtime profile (e.g. `pi-anthropic`, `pi-openrouter`, `local-qwen`, `mixed`). The profile can live at project scope (`eforge/profiles/<name>.yaml`) or user scope (`~/.config/eforge/profiles/<name>.yaml`). It configures a harness, model, and effort level per build tier (planning → implementation → review → evaluation), then optionally activates itself.

Pi is the recommended eforge execution harness for new profiles because it is provider-flexible. Claude Code or Pi can still be the host surface; the active profile chooses the execution harness. The `claude-sdk` harness remains supported as an optional Anthropic-specific path. Starting June 15, 2026, Anthropic says Claude Agent SDK and `claude -p` usage no longer count toward Claude plan limits; eligible plans may receive a separate monthly Agent SDK credit, usage beyond that credit is billed at standard API rates when extra usage is enabled, otherwise requests stop, and API-key users remain pay-as-you-go.

## Workflow

### Step 0: Ask scope

Ask: "Where should this profile live? **Project-local scope** (`.eforge/profiles/`), **project scope** (`eforge/profiles/`), or **user scope** (`~/.config/eforge/profiles/`)?"

- **Project-local scope** - profile lives in `.eforge/profiles/`, gitignored and dev-personal. Takes highest precedence but is never committed.
- **Project scope** (default) - profile is committed with the project, shared with the team.
- **User scope** - profile lives in `~/.config/eforge/profiles/`, reusable across all projects on this machine.

If the user does not specify, default to project scope. Remember the chosen scope for Step 4 (pass it as `scope` to the `create` action) and Step 5 (pass it to `use` if activating).

### Step 1: Determine the profile name

- If `$ARGUMENTS` is non-empty, treat the first token as the profile name.
- Otherwise ask the user: "What should this profile be called? (e.g. `pi-anthropic`, `pi-openrouter`, `local-qwen`, `mixed`)"

The name will be used as the filename (local: `.eforge/profiles/<name>.yaml`, project: `eforge/profiles/<name>.yaml`, user: `~/.config/eforge/profiles/<name>.yaml`).

### Step 2: Configure each tier

Walk the four built-in tiers in fixed order: **planning** → **implementation** → **review** → **evaluation**.

For each tier, present the following options:

**Copy from a previously configured tier** (available from `implementation` onward): From the second tier onward, present one `Copy from <tierName> (<modelId>)` entry per tier already configured in this session (e.g. on `review`: `Copy from planning` and `Copy from implementation`, in `TIER_ORDER` order). The default selection is copy-from-immediately-previous when the user just presses enter.

**Custom**: walk the sub-flow:
1. **Harness**: ask `pi` (recommended/provider-flexible) or `claude-sdk` (optional Anthropic-specific Agent SDK with credit/API-priced usage).
2. **Provider** (pi only): call `eforge_models` with `{ action: "providers", harness: "pi" }`, show the list, confirm.
3. **Model**: call `eforge_models` with `{ action: "list", harness: "<harness>", provider: "<provider>" }` (omit `provider` for claude-sdk). Show top 10 (id + `releasedAt` when available); add a "see all" affordance if the list is longer. Default to the newest model. Confirm.
4. **Effort**: ask from `low | medium | high | xhigh | max`. Default: `high` for planning/review/evaluation, `medium` for implementation.

For the **planning** tier present only **Custom**, since no prior tier exists yet. Start that first custom tier with `pi` selected first unless the user explicitly asks for `claude-sdk`.

Record each tier's `harness`, optional `pi.provider`, `model`, and `effort`.

### Step 3: Preview the profile

Show the user a rendered preview of the YAML that will land in the chosen scope directory. Example Pi-first profile:

```yaml
agents:
  tiers:
    planning:
      harness: pi
      model: anthropic/claude-opus-4-6
      effort: high
      pi:
        provider: openrouter
    implementation:
      harness: pi
      model: anthropic/claude-sonnet-4-6
      effort: medium
      pi:
        provider: openrouter
    review:
      harness: pi
      model: anthropic/claude-opus-4-6
      effort: high
      pi:
        provider: openrouter
    evaluation:
      harness: pi
      model: anthropic/claude-opus-4-6
      effort: high
      pi:
        provider: openrouter
```

Example with mixed Pi providers:

```yaml
agents:
  tiers:
    planning:
      harness: pi
      model: anthropic/claude-opus-4-6
      effort: high
      pi:
        provider: openrouter
    implementation:
      harness: pi
      model: qwen3-coder
      effort: medium
      pi:
        provider: local
    review:
      harness: pi
      model: anthropic/claude-opus-4-6
      effort: high
      pi:
        provider: openrouter
    evaluation:
      harness: pi
      model: gemini-flash
      effort: high
      pi:
        provider: google
```

Optional `claude-sdk` tiers omit the `pi` block and use Anthropic model IDs:

```yaml
agents:
  tiers:
    review:
      harness: claude-sdk
      model: claude-opus-4-7
      effort: high
```

Ask for confirmation or corrections before writing.

### Step 4: Create the profile

Call `eforge_profile` with:

```
{
  action: "create",
  name: "<name>",
  scope: "<local|project|user>",
  agents: {
    tiers: {
      planning:       { harness, model, effort, pi?: { provider } },
      implementation: { harness, model, effort, pi?: { provider } },
      review:         { harness, model, effort, pi?: { provider } },
      evaluation:     { harness, model, effort, pi?: { provider } },
    }
  },
  metadata: {          // optional — descriptive only, does not affect runtime behavior
    description: "<human-readable description of what this profile is for>",
    whenToUse: ["<scenario 1>", "<scenario 2>"],
    tags: ["<tag1>", "<tag2>"],
  },
  overwrite: false,
}
```

Omit `pi` for the `claude-sdk` harness. Include `pi: { provider: "..." }` for the `pi` harness.

The `metadata` field is **optional and descriptive only** — it surfaces in profile list/show UX but does not affect active profile selection or runtime behavior. You may omit it entirely or include only the fields that are useful. Users can also edit the YAML file directly to add or update metadata later.

If the tool reports the profile already exists, ask the user whether to retry with `overwrite: true`.

### Step 5: Offer to activate

Ask: "Make `{name}` the active profile for this project?"

If yes, call `eforge_profile` with `{ action: "use", name: "<name>", scope: "<local|project|user>" }` (using the scope from Step 0). This writes the active-profile marker at the chosen scope. Confirm success and let the user know the next eforge build will use the new profile.

If no, remind the user they can switch later with `/eforge:profile <name>`.

## When to use an MCP-backed toolbelt profile

When a profile is aimed at UI-heavy / frontend / layout / screenshot / browser-validation work, point users at the MCP-backed toolbelt pattern instead of plain tier reassignment.

The canonical pattern: define a `browser-ui` toolbelt under `tools.toolbelts` in `eforge/config.yaml` referencing the `playwright` MCP server (configured in `.mcp.json` with `npx -y @playwright/mcp@latest`), and assign `toolbelt: browser-ui` to the tiers that need browser automation (typically `implementation` and `review`). Use `toolbelt: none` for tiers that should not receive project MCP servers (typically `planning` and `evaluation`).

See [Profile Toolbelts for UI Work](https://eforge.build/docs/configuration#profile-toolbelts-for-ui-work) in the public docs and the [Toolbelts](https://eforge.build/reference/config#toolbelts) section in the Configuration Reference for full configuration details. MCP server commands live in `.mcp.json`; profiles reference only server names via toolbelts - never use backend MCP tool names (such as `mcp__playwright__browser_navigate`) in profile YAML.

**Constraints (MVP):** One toolbelt per tier. Pi extensions, Claude Code plugins, and native extension-contributed tools are out of scope - toolbelts are MCP-only and declarative.

## Error Handling

| Condition | Action |
|-----------|--------|
| Invalid profile name | Surface the daemon error (names must match `[A-Za-z0-9._-]+`) |
| Profile already exists | Offer to retry with `overwrite: true` |
| Provider or model not found | Suggest rerunning the affected tier step with a different choice |
| Tool connection failure | The daemon auto-starts; if it still fails, suggest `eforge daemon start` manually |

## Related Skills

| Skill | When to suggest |
|-------|----------------|
| `/eforge:profile` | Inspect or switch between existing profiles |
| `/eforge:config` | Edit the team default `eforge/config.yaml` |
| `/eforge:init` | Initialize eforge in a project that has no config yet |
