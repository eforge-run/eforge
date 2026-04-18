---
description: Create a new backend profile in eforge/backends/
argument-hint: "[name]"
---

# /eforge:backend:new

Interactively create a new named backend profile (e.g. `pi-anthropic`, `pi-glm`, `claude-fast`). The profile can live at project scope (`eforge/backends/<name>.yaml`) or user scope (`~/.config/eforge/backends/<name>.yaml`). It selects a backend kind, provider, model, and optional tuning, then optionally activates itself.

## Workflow

### Step 0: Ask scope

Ask: "Where should this profile live? **Project scope** (`eforge/backends/`) or **user scope** (`~/.config/eforge/backends/`)?"

- **Project scope** (default) - profile is committed with the project, shared with the team.
- **User scope** - profile lives in `~/.config/eforge/backends/`, reusable across all projects on this machine.

If the user does not specify, default to project scope. Remember the chosen scope for Step 7 (pass it as `scope` to the `create` action) and Step 8 (pass it to `use` if activating).

### Step 1: Determine the profile name

- If `$ARGUMENTS` is non-empty, treat the first token as the profile name.
- Otherwise ask the user: "What should this profile be called? (e.g. `pi-anthropic`, `pi-glm`, `claude-fast`)"

The name will be used as the filename (project: `eforge/backends/<name>.yaml`, user: `~/.config/eforge/backends/<name>.yaml`).

### Step 2: Pick the backend kind

Ask: "Which backend? `claude-sdk` (Claude Code's built-in SDK) or `pi` (multi-provider via Pi SDK)?"

Use a smart default based on the name hint:
- Names starting with `pi-` default to `pi`.
- Names starting with `claude-` default to `claude-sdk`.
- Otherwise default to `pi` (the more flexible option) and let the user override.

### Step 3: Pick a provider (Pi only)

Only if `backend === "pi"`:

Call `mcp__eforge__eforge_models` with `{ action: "providers", backend: "pi" }`.

Parse the `{ providers: string[] }` response and show the list. Use a smart default based on the name hint (e.g. `pi-anthropic` -> `anthropic`, `pi-glm` -> `zai`, `pi-openrouter` -> `openrouter`). Ask the user to confirm or pick another.

Skip this step for `claude-sdk` (provider is always Anthropic / implicit).

### Step 4: Pick a model per class

Eforge routes agent roles through three model classes:

- **max** — heavy reasoning (planners, reviewers, architecture/cohesion agents). Most roles default here.
- **balanced** — mid-range general-purpose work.
- **fast** — lightweight or throwaway calls.

A profile sets one model per class via `agents.models.{max,balanced,fast}`, so each agent role picks up the right tier.

Call `mcp__eforge__eforge_models` with:
- `{ action: "list", backend: "claude-sdk" }` for claude-sdk, or
- `{ action: "list", backend: "pi", provider: "<chosen>" }` for pi.

Parse the `{ models: ModelInfo[] }` response (already sorted newest-first). Show the top 10 (id + `releasedAt` when available); add a "see all" affordance if the list is longer.

Then walk the user through each class in order:

1. **max** — default to the newest model. Confirm the pick.
2. **balanced** — default to **same as `max`**. Offer the list if the user wants a different model (e.g., a cheaper mid-tier).
3. **fast** — default to **same as `balanced`**. Offer the list if the user wants a cheaper/faster model.

A user who just accepts defaults gets the same model for all three classes — fine as a starting point. Users who want a ladder (e.g., `opus` / `sonnet` / `haiku`) can set each class explicitly.

### Step 5: Optional tuning

Ask the user whether they want to customize tuning. Most users skip this. Defaults:

- **Pi only** - `pi.thinkingLevel`: `off` | `low` | `medium` | `high` | `xhigh`. Default: `medium`.
- **All backends** - `agents.effort`: `low` | `medium` | `high` | `xhigh` | `max`. Default: `high`.

Collect only the values the user explicitly sets.

### Step 6: Synthesize and preview the profile

Build the profile object that will go to the tool:

```
{
  name: "<name>",
  backend: "<claude-sdk|pi>",
  // For pi:
  pi: { thinkingLevel: "<level>" }?,           // only if user set
  agents: {
    models: {
      max:      { id: "<id>", provider: "<provider>"? },   // provider only for pi
      balanced: { id: "<id>", provider: "<provider>"? },
      fast:     { id: "<id>", provider: "<provider>"? },
    },
    effort: "<effort>"?,                       // only if user set
  },
}
```

Show the user a rendered preview of the YAML that will land in the chosen scope directory (project: `eforge/backends/<name>.yaml`, user: `~/.config/eforge/backends/<name>.yaml`):

```yaml
backend: pi
pi:
  thinkingLevel: medium
agents:
  models:
    max:
      provider: anthropic
      id: claude-opus-4-7
    balanced:
      provider: anthropic
      id: claude-sonnet-4-6
    fast:
      provider: anthropic
      id: claude-haiku-4-5
  effort: high
```

Ask for confirmation or corrections before writing.

### Step 7: Create the profile

Call `mcp__eforge__eforge_backend` with:

```
{
  action: "create",
  name: "<name>",
  scope: "<project|user>",   // from Step 0
  backend: "<claude-sdk|pi>",
  pi: { ... }?,       // omit if empty
  agents: { ... }?,   // omit if empty
  overwrite: false,
}
```

If the tool reports the profile already exists, ask the user whether to retry with `overwrite: true`.

### Step 8: Offer to activate

Ask: "Make `{name}` the active profile for this project?"

If yes, call `mcp__eforge__eforge_backend` with `{ action: "use", name: "<name>", scope: "<project|user>" }` (using the scope from Step 0). This writes the active-backend marker at the chosen scope. Confirm success and let the user know the next eforge build will use the new profile.

If no, remind the user they can switch later with `/eforge:backend <name>`.

## Error Handling

| Condition | Action |
|-----------|--------|
| Invalid profile name | Surface the daemon error (names must match `[A-Za-z0-9._-]+`) |
| Profile already exists | Offer to retry with `overwrite: true` |
| Provider or model not found | Suggest rerunning Step 3 or Step 4 with a different choice |
| MCP tool connection failure | The MCP proxy auto-starts the daemon; if it still fails, suggest `eforge daemon start` manually |

## Related Skills

| Skill | When to suggest |
|-------|----------------|
| `/eforge:backend` | Inspect or switch between existing profiles |
| `/eforge:config` | Edit the team default `eforge/config.yaml` |
| `/eforge:init` | Initialize eforge in a project that has no config yet |
