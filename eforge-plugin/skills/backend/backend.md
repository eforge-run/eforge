---
description: List, inspect, and switch backend profiles
argument-hint: "[name]"
---

# /eforge:backend

List, inspect, and switch named backend profiles stored in `eforge/backends/`. The active profile is tracked by the `eforge/.active-backend` marker file; when no marker is present, eforge falls back to the team default defined in `eforge/config.yaml`.

## Workflow

### Step 1: Branch on arguments

Inspect `$ARGUMENTS`:

- If `$ARGUMENTS` is empty or whitespace, go to Step 2 (**inspect mode**).
- Otherwise treat the argument as a profile name and go to Step 3 (**switch mode**).

### Step 2: Inspect mode

Call the `mcp__eforge__eforge_backend` tool with `{ action: "show" }`.

Parse the response (shape: `{ active, source, resolved: { backend, profile } }`) and report:

- **Active profile**: `{active}` (or "(none - using team default)" when `active` is null)
- **Source**: `{source}` (`local` when the active profile is picked via the `eforge/.active-backend` marker, `team` when no marker is present and the resolution falls back to the `backend:` field in `eforge/config.yaml`, `missing` when the marker points at a profile file that does not exist (stale marker), `none` when no profile is configured at all)
- **Resolved backend**: `{resolved.backend}` (e.g. `claude-sdk` or `pi`)

Then, optionally, call `mcp__eforge__eforge_backend` with `{ action: "list" }` to show the user what other profiles are available, rendering a short table of profile names and marking the active one with `●`.

If no profiles exist, suggest `/eforge:backend:new` to create one.

### Step 3: Switch mode

Call `mcp__eforge__eforge_backend` with `{ action: "use", name: "<arg>" }`.

On success, the daemon writes `eforge/.active-backend` with the new profile name. Then call `{ action: "show" }` again and report the new active profile plus the resolved backend:

> Switched to `{name}`. Resolved backend: `{resolved.backend}`. The next eforge build will use this profile.

On error (e.g. the profile does not exist), surface the error message and suggest running `/eforge:backend` with no args to list available profiles, or `/eforge:backend:new` to create a new one.

## Error Handling

| Condition | Action |
|-----------|--------|
| Profile name does not exist | Show the daemon error and list available profiles |
| No `eforge/backends/` directory | Suggest `/eforge:backend:new` to create the first profile |
| MCP tool connection failure | The MCP proxy auto-starts the daemon; if it still fails, suggest `eforge daemon start` manually |
| No config found | Tell the user: "No eforge config found. Run `/eforge:init` to initialize eforge in this project." |

## Related Skills

| Skill | When to suggest |
|-------|----------------|
| `/eforge:backend:new` | User wants to create a new named profile |
| `/eforge:config` | User wants to view or edit `eforge/config.yaml` (the team default fallback) |
| `/eforge:status` | User wants to check current build status |
