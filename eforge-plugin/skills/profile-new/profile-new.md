---
description: Create a new agent runtime profile in eforge/profiles/
argument-hint: "[name]"
---

# /eforge:profile-new

Interactively create a new named agent runtime profile (e.g. `claude-max`, `pi-anthropic`, `mixed`). The profile can live at project scope (`eforge/profiles/<name>.yaml`) or user scope (`~/.config/eforge/profiles/<name>.yaml`). It configures a harness, model, and effort level per build tier (planning → implementation → review → evaluation), then optionally activates itself.

## Workflow

### Step 0: Ask scope

Ask: "Where should this profile live? **Project-local scope** (`.eforge/profiles/`), **project scope** (`eforge/profiles/`), or **user scope** (`~/.config/eforge/profiles/`)?"

- **Project-local scope** - profile lives in `.eforge/profiles/`, gitignored and dev-personal. Takes highest precedence but is never committed.
- **Project scope** (default) - profile is committed with the project, shared with the team.
- **User scope** - profile lives in `~/.config/eforge/profiles/`, reusable across all projects on this machine.

If the user does not specify, default to project scope. Remember the chosen scope for Step 4 (pass it as `scope` to the `create` action) and Step 5 (pass it to `use` if activating).

### Step 1: Determine the profile name

- If `$ARGUMENTS` is non-empty, treat the first token as the profile name.
- Otherwise ask the user: "What should this profile be called? (e.g. `claude-max`, `pi-anthropic`, `mixed`)"

The name will be used as the filename (local: `.eforge/profiles/<name>.yaml`, project: `eforge/profiles/<name>.yaml`, user: `~/.config/eforge/profiles/<name>.yaml`).

### Step 2: Configure each tier

Walk the four built-in tiers in fixed order: **planning** → **implementation** → **review** → **evaluation**.

For each tier, present the following options:

**Preset shortcuts** (starting points — the user can customize after picking):
- **max** — `claude-sdk` harness, model `claude-opus-4-7`, effort `high`
- **balanced** — `claude-sdk` harness, model `claude-sonnet-4-6`, effort `medium`
- **fast** — `claude-sdk` harness, model `claude-haiku-4-5`, effort `low`

**Copy from previous tier** (available from `implementation` onward): reuse the harness, provider (if pi), model, and effort from the preceding tier without re-prompting. *(Default for `implementation`, `review`, and `evaluation` when the user just presses enter.)*

**Custom**: walk the sub-flow:
1. **Harness**: ask `claude-sdk` or `pi`.
2. **Provider** (pi only): call `mcp__eforge__eforge_models` with `{ action: "providers", harness: "pi" }`, show the list, confirm.
3. **Model**: call `mcp__eforge__eforge_models` with `{ action: "list", harness: "<harness>", provider: "<provider>" }` (omit `provider` for claude-sdk). Show top 10 (id + `releasedAt` when available); add a "see all" affordance if the list is longer. Default to the newest model. Confirm.
4. **Effort**: ask from `low | medium | high | xhigh | max`. Default: `high` for planning/review/evaluation, `medium` for implementation.

For the **planning** tier there is no "copy from previous" option — present presets or custom only.

Record each tier's `harness`, (optional) `provider`, `model.id`, and `effort`.

### Step 3: Preview the profile

Show the user a rendered preview of the YAML that will land in the chosen scope directory. Example for an all-claude-sdk profile:

```yaml
agents:
  tiers:
    planning:
      harness: claude-sdk
      model:
        id: claude-opus-4-7
      effort: high
    implementation:
      harness: claude-sdk
      model:
        id: claude-sonnet-4-6
      effort: medium
    review:
      harness: claude-sdk
      model:
        id: claude-opus-4-7
      effort: high
    evaluation:
      harness: claude-sdk
      model:
        id: claude-opus-4-7
      effort: high
```

Example with a mixed claude-sdk/pi-anthropic setup:

```yaml
agents:
  tiers:
    planning:
      harness: claude-sdk
      model:
        id: claude-opus-4-7
      effort: high
    implementation:
      harness: pi
      provider: anthropic
      model:
        id: claude-sonnet-4-6
      effort: medium
    review:
      harness: claude-sdk
      model:
        id: claude-opus-4-7
      effort: high
    evaluation:
      harness: pi
      provider: anthropic
      model:
        id: claude-opus-4-7
      effort: high
```

Ask for confirmation or corrections before writing.

### Step 4: Create the profile

Call `mcp__eforge__eforge_profile` with:

```
{
  action: "create",
  name: "<name>",
  scope: "<local|project|user>",
  agents: {
    tiers: {
      planning:       { harness, model: { id }, effort, provider? },
      implementation: { harness, model: { id }, effort, provider? },
      review:         { harness, model: { id }, effort, provider? },
      evaluation:     { harness, model: { id }, effort, provider? },
    }
  },
  overwrite: false,
}
```

Omit `provider` for the `claude-sdk` harness. Include it for the `pi` harness.

If the tool reports the profile already exists, ask the user whether to retry with `overwrite: true`.

### Step 5: Offer to activate

Ask: "Make `{name}` the active profile for this project?"

If yes, call `mcp__eforge__eforge_profile` with `{ action: "use", name: "<name>", scope: "<local|project|user>" }` (using the scope from Step 0). This writes the active-profile marker at the chosen scope. Confirm success and let the user know the next eforge build will use the new profile.

If no, remind the user they can switch later with `/eforge:profile <name>`.

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
