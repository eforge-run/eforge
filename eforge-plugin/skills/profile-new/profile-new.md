---
description: Create a new agent runtime profile in eforge/profiles/
argument-hint: "[name]"
---

# /eforge:profile-new

Interactively create a new named agent runtime profile (e.g. `pi-anthropic`, `pi-glm`, `claude-fast`). The profile can live at project scope (`eforge/profiles/<name>.yaml`) or user scope (`~/.config/eforge/profiles/<name>.yaml`). It selects a harness, provider, model, and optional tuning, then optionally activates itself.

> A single profile may later contain multiple `agentRuntimes` entries to mix harnesses across agent roles — use this skill to create the initial profile, then edit the YAML directly or run this skill again.

## Workflow

### Step 0: Ask scope

Ask: "Where should this profile live? **Project-local scope** (`.eforge/profiles/`), **project scope** (`eforge/profiles/`), or **user scope** (`~/.config/eforge/profiles/`)?"

- **Project-local scope** - profile lives in `.eforge/profiles/`, gitignored and dev-personal. Takes highest precedence but is never committed.
- **Project scope** (default) - profile is committed with the project, shared with the team.
- **User scope** - profile lives in `~/.config/eforge/profiles/`, reusable across all projects on this machine.

If the user does not specify, default to project scope. Remember the chosen scope for Step 7 (pass it as `scope` to the `create` action) and Step 8 (pass it to `use` if activating).

### Step 1: Determine the profile name

- If `$ARGUMENTS` is non-empty, treat the first token as the profile name.
- Otherwise ask the user: "What should this profile be called? (e.g. `pi-anthropic`, `pi-glm`, `claude-fast`)"

The name will be used as the filename (local: `.eforge/profiles/<name>.yaml`, project: `eforge/profiles/<name>.yaml`, user: `~/.config/eforge/profiles/<name>.yaml`).

### Step 2: Pick the harness

Ask: "Which harness? `claude-sdk` (Claude Code's built-in SDK) or `pi` (multi-provider via Pi SDK)?"

Use a smart default based on the name hint:
- Names starting with `pi-` default to harness `pi`.
- Names starting with `claude-` default to harness `claude-sdk`.
- Otherwise default to harness `pi` (the more flexible option) and let the user override.

### Step 3: Pick a provider (Pi only)

Only if `harness === "pi"`:

Call `mcp__eforge__eforge_models` with `{ action: "providers", harness: "pi" }`.

Parse the `{ providers: string[] }` response and show the list. Use a smart default based on the name hint (e.g. `pi-anthropic` -> `anthropic`, `pi-glm` -> `zai`, `pi-openrouter` -> `openrouter`). Ask the user to confirm or pick another.

Skip this step for `claude-sdk` (provider is always Anthropic / implicit).

### Step 4: Pick a model per class

Eforge routes agent roles through three model classes:

- **max** — heavy reasoning (planners, reviewers, architecture/cohesion agents). Most roles default here.
- **balanced** — mid-range general-purpose work.
- **fast** — lightweight or throwaway calls.

A profile sets one model per class via `agents.models.{max,balanced,fast}`, so each agent role picks up the right tier.

Call `mcp__eforge__eforge_models` with:
- `{ action: "list", harness: "claude-sdk" }` for claude-sdk, or
- `{ action: "list", harness: "pi", provider: "<chosen>" }` for pi.

Parse the `{ models: ModelInfo[] }` response (already sorted newest-first). Show the top 10 (id + `releasedAt` when available); add a "see all" affordance if the list is longer.

Then walk the user through each class in order:

1. **max** — default to the newest model. Confirm the pick.
2. **balanced** — default to **same as `max`**. Offer the list if the user wants a different model (e.g., a cheaper mid-tier).
3. **fast** — default to **same as `balanced`**. Offer the list if the user wants a cheaper/faster model.

A user who just accepts defaults gets the same model for all three classes — fine as a starting point. Users who want a ladder (e.g., `opus` / `sonnet` / `haiku`) can set each class explicitly.

### Step 5: Optional tuning

Ask the user whether they want to customize tuning. Most users skip this. Defaults:

- **Pi only** - `pi.thinkingLevel`: `off` | `low` | `medium` | `high` | `xhigh`. Default: `medium`.
- **All harnesses** - `agents.effort`: `low` | `medium` | `high` | `xhigh` | `max`. Default: `high`.

Collect only the values the user explicitly sets.

### Step 6: Synthesize and preview the profile

Build the profile object that will go to the tool:

```
{
  name: "<name>",
  harness: "<claude-sdk|pi>",
  // For pi: provider is REQUIRED on the runtime entry; thinkingLevel only if user set.
  pi: { provider: "<chosen-provider>", thinkingLevel: "<level>"? },
  agents: {
    models: {
      max:      { id: "<id>" },
      balanced: { id: "<id>" },
      fast:     { id: "<id>" },
      // provider for Pi belongs on the agentRuntime entry (pi.provider above), not on model refs
    },
    effort: "<effort>"?,                       // only if user set
  },
}
```

Show the user a rendered preview of the YAML that will land in the chosen scope directory (local: `.eforge/profiles/<name>.yaml`, project: `eforge/profiles/<name>.yaml`, user: `~/.config/eforge/profiles/<name>.yaml`):

```yaml
harness: pi
pi:
  thinkingLevel: medium
  provider: anthropic
agents:
  models:
    max:
      id: claude-opus-4-7
    balanced:
      id: claude-sonnet-4-6
    fast:
      id: claude-haiku-4-5
  effort: high
```

Ask for confirmation or corrections before writing.

### Step 7: Create the profile

Call `mcp__eforge__eforge_profile` with:

```
{
  action: "create",
  name: "<name>",
  scope: "<local|project|user>",   // from Step 0
  harness: "<claude-sdk|pi>",
  pi: { ... }?,       // omit if empty
  agents: { ... }?,   // omit if empty
  overwrite: false,
}
```

If the tool reports the profile already exists, ask the user whether to retry with `overwrite: true`.

### Step 8: Offer to activate

Ask: "Make `{name}` the active profile for this project?"

If yes, call `mcp__eforge__eforge_profile` with `{ action: "use", name: "<name>", scope: "<local|project|user>" }` (using the scope from Step 0). This writes the active-profile marker at the chosen scope. Confirm success and let the user know the next eforge build will use the new profile.

If no, remind the user they can switch later with `/eforge:profile <name>`.

## Error Handling

| Condition | Action |
|-----------|--------|
| Invalid profile name | Surface the daemon error (names must match `[A-Za-z0-9._-]+`) |
| Profile already exists | Offer to retry with `overwrite: true` |
| Provider or model not found | Suggest rerunning Step 3 or Step 4 with a different choice |
| Tool connection failure | The daemon auto-starts; if it still fails, suggest `eforge daemon start` manually |

## Related Skills

| Skill | When to suggest |
|-------|----------------|
| `/eforge:profile` | Inspect or switch between existing profiles |
| `/eforge:config` | Edit the team default `eforge/config.yaml` |
| `/eforge:init` | Initialize eforge in a project that has no config yet |
