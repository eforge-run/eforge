---
description: Create a new agent runtime profile in eforge/profiles/
argument-hint: "[name]"
---

# /eforge:profile-new

Interactively create a new named agent runtime profile (e.g. `pi-anthropic`, `pi-glm`, `claude-fast`). The profile can live at project scope (`eforge/profiles/<name>.yaml`) or user scope (`~/.config/eforge/profiles/<name>.yaml`). It selects an agent runtime and model per model class (`max`, `balanced`, `fast`), then optionally activates itself.

## Workflow

### Step 0: Ask scope

Ask: "Where should this profile live? **Project-local scope** (`.eforge/profiles/`), **project scope** (`eforge/profiles/`), or **user scope** (`~/.config/eforge/profiles/`)?"

- **Project-local scope** - profile lives in `.eforge/profiles/`, gitignored and dev-personal. Takes highest precedence but is never committed.
- **Project scope** (default) - profile is committed with the project, shared with the team.
- **User scope** - profile lives in `~/.config/eforge/profiles/`, reusable across all projects on this machine.

If the user does not specify, default to project scope. Remember the chosen scope for Step 6 (pass it as `scope` to the `create` action) and Step 7 (pass it to `use` if activating).

### Step 1: Determine the profile name

- If `$ARGUMENTS` is non-empty, treat the first token as the profile name.
- Otherwise ask the user: "What should this profile be called? (e.g. `pi-anthropic`, `pi-glm`, `claude-fast`)"

The name will be used as the filename (local: `.eforge/profiles/<name>.yaml`, project: `eforge/profiles/<name>.yaml`, user: `~/.config/eforge/profiles/<name>.yaml`).

### Step 2: Pick agent runtime and model for **max**

The `max` class handles heavy reasoning work — planners, reviewers, architecture agents. Most roles default to `max`.

Ask: "Which harness for max? `claude-sdk` (Claude Code's built-in SDK) or `pi` (multi-provider via Pi SDK)?"

Use a smart default based on the name hint:
- Names starting with `pi-` default to harness `pi`.
- Names starting with `claude-` default to harness `claude-sdk`.
- Otherwise default to harness `pi` (the more flexible option).

**If `pi`:** Call `mcp__eforge__eforge_models` with `{ action: "providers", harness: "pi" }`, show the list, infer provider from the name hint (e.g. `pi-anthropic` → `anthropic`, `pi-glm` → `zai`), confirm with the user. Derive runtime name: `pi-<provider>`.

**If `claude-sdk`:** Runtime name is `claude-sdk`.

Call `mcp__eforge__eforge_models` with `{ action: "list", harness: "<harness>", provider: "<provider>" }` (omit `provider` for claude-sdk). Show top 10 models (id + `releasedAt` when available); add a "see all" affordance if the list is longer. Default to the newest model. Confirm.

Record: `max.runtimeName`, `max.modelId`.

### Step 3: Pick agent runtime and model for **balanced**

The `balanced` class handles mid-range general-purpose work (most implementation agents).

Present three options:
1. **"Same runtime and model as max (`<max-model-id>`)"** — accepts max's runtime and model. *(Default.)*
2. **"Different model from `<max-runtime-name>`"** — same runtime, pick a different model from that runtime's list.
3. **"Different runtime"** — run the harness → provider → model sub-flow (same pattern as Step 2) and derive a new runtime name.

For option 2: call `mcp__eforge__eforge_models` for the max runtime's harness+provider, show the list, default to the max model.

Record: `balanced.runtimeName`, `balanced.modelId`.

### Step 4: Pick agent runtime and model for **fast**

> **Note:** `fast` is declared in the profile and available for manual use, but eforge does not currently route any built-in workload tier to `fast` by default.

Present options:
- **"Same as balanced (`<balanced-model-id>`)"** — *(Default.)*
- If `max.runtimeName !== balanced.runtimeName`: **"Same as max (`<max-model-id>`)"**
- **"Different runtime"** — run the harness → provider → model sub-flow.

Record: `fast.runtimeName`, `fast.modelId`.

### Step 5: Synthesize and preview the profile

Build the `agentRuntimes` map by de-duplicating entries keyed by runtime name (`claude-sdk` for the Claude SDK runtime, `pi-<provider>` for each distinct Pi provider). Set `defaultAgentRuntime` to the max runtime name.

Emit `agents.tiers.implementation.agentRuntime` **only** when `balanced.runtimeName` differs from `max.runtimeName`. Do not emit any other tier overrides.

Build the profile object that will go to the tool:

```
{
  name: "<name>",
  agentRuntimes: {
    "<max-runtime-name>": { harness: "<harness>", pi?: { provider: "<provider>" } },
    // additional entries for distinct balanced/fast runtimes
  },
  defaultAgentRuntime: "<max-runtime-name>",
  agents: {
    models: {
      max:      { id: "<id>" },
      balanced: { id: "<id>" },
      fast:     { id: "<id>" },
      // Pi provider belongs on agentRuntimes.<name>.pi.provider, never inside model refs
    },
    tiers: {                                  // only when balanced.runtimeName ≠ max.runtimeName
      implementation: { agentRuntime: "<balanced-runtime-name>" },
    },
  },
}
```

Show the user a rendered preview of the YAML that will land in the chosen scope directory (local: `.eforge/profiles/<name>.yaml`, project: `eforge/profiles/<name>.yaml`, user: `~/.config/eforge/profiles/<name>.yaml`). Example with a mixed claude-sdk/pi-anthropic setup:

```yaml
agentRuntimes:
  claude-sdk:
    harness: claude-sdk
  pi-anthropic:
    harness: pi
    pi:
      provider: anthropic
defaultAgentRuntime: claude-sdk
agents:
  models:
    max:
      id: claude-opus-4-7
    balanced:
      id: claude-opus-4-7
    fast:
      id: claude-haiku-4-5  # declared but not currently used by default
  tiers:
    implementation:
      agentRuntime: pi-anthropic  # only present when balanced runtime differs from max
```

The preview must contain the literal text `agentRuntimes:` and a note that the `fast` model class is **not currently used by default** by any built-in workload tier.

Ask for confirmation or corrections before writing.

### Step 6: Create the profile

Call `mcp__eforge__eforge_profile` with:

```
{
  action: "create",
  name: "<name>",
  scope: "<local|project|user>",         // from Step 0
  agentRuntimes: { ... },                // de-duplicated map from Step 5
  defaultAgentRuntime: "<max-runtime>",
  agents: {
    models: { max: { id }, balanced: { id }, fast: { id } },
    tiers?: { implementation: { agentRuntime: "<balanced-runtime>" } },
  },
  overwrite: false,
}
```

If the tool reports the profile already exists, ask the user whether to retry with `overwrite: true`.

### Step 7: Offer to activate

Ask: "Make `{name}` the active profile for this project?"

If yes, call `mcp__eforge__eforge_profile` with `{ action: "use", name: "<name>", scope: "<local|project|user>" }` (using the scope from Step 0). This writes the active-profile marker at the chosen scope. Confirm success and let the user know the next eforge build will use the new profile.

If no, remind the user they can switch later with `/eforge:profile <name>`.

## Error Handling

| Condition | Action |
|-----------|--------|
| Invalid profile name | Surface the daemon error (names must match `[A-Za-z0-9._-]+`) |
| Profile already exists | Offer to retry with `overwrite: true` |
| Provider or model not found | Suggest rerunning the affected model-class step (Step 2, 3, or 4) with a different choice |
| Tool connection failure | The daemon auto-starts; if it still fails, suggest `eforge daemon start` manually |

## Related Skills

| Skill | When to suggest |
|-------|----------------|
| `/eforge:profile` | Inspect or switch between existing profiles |
| `/eforge:config` | Edit the team default `eforge/config.yaml` |
| `/eforge:init` | Initialize eforge in a project that has no config yet |
