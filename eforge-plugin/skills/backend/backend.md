---
description: List, inspect, and switch backend profiles
argument-hint: "[name]"
---

# /eforge:backend

List, inspect, and switch named backend profiles stored in `eforge/backends/` (project scope) or `~/.config/eforge/backends/` (user scope). The active profile is tracked by a marker file at either level; resolution follows a 5-step precedence chain (see below).

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

Then call `mcp__eforge__eforge_backend` with `{ action: "list" }` to show the user what other profiles are available, rendering a table with the following columns:

| Name | Scope | Backend | Active |
|------|-------|---------|--------|
| `pi-anthropic` | `project` | `pi` | `●` |
| `claude-fast` | `user` | `claude-sdk` | |
| `pi-glm` | `user (shadowed)` | `pi` | |

- **Scope**: `project` for profiles in `eforge/backends/`, `user` for profiles in `~/.config/eforge/backends/`.
- User entries shadowed by a project profile of the same name show `user (shadowed)` in the Scope column (the project profile takes precedence when resolved by name).
- Mark the active profile with `●`.

If no profiles exist, suggest `/eforge:backend:new` to create one.

### Step 3: Switch mode

Call `mcp__eforge__eforge_backend` with `{ action: "use", name: "<arg>" }`. To set the active profile at user scope instead of project scope, pass `scope: "user"`: `{ action: "use", name: "<arg>", scope: "user" }`.

On success, the daemon writes `eforge/.active-backend` with the new profile name. Then call `{ action: "show" }` again and report the new active profile plus the resolved backend:

> Switched to `{name}`. Resolved backend: `{resolved.backend}`. The next eforge build will use this profile.

On error (e.g. the profile does not exist), surface the error message and suggest running `/eforge:backend` with no args to list available profiles, or `/eforge:backend:new` to create a new one.

## Scope Parameter

The `scope` parameter is available on `list`, `use`, `create`, and `delete` actions:

- **`list`**: `scope` accepts `"project"`, `"user"`, or `"all"` (default `"all"`) - shows profiles from both scopes when omitted.
- **`use` / `create` / `delete`**: `scope` accepts `"project"` or `"user"` (default `"project"`) - operates on `eforge/backends/` and `eforge/.active-backend` for project scope, `~/.config/eforge/backends/` and `~/.config/eforge/.active-backend` for user scope.

## Active Profile Precedence

The active backend profile is resolved using a 5-step precedence chain (highest to lowest):

1. **Project marker** - `eforge/.active-backend` file in the project
2. **Project config** - `backend:` field in `eforge/config.yaml`
3. **User marker** - `~/.config/eforge/.active-backend` file
4. **User config** - `backend:` field in `~/.config/eforge/config.yaml`
5. **None** - no profile configured

When a profile name is resolved, the profile file is looked up project-first, then user-fallback - so a user-scope marker can still resolve to a project-scope profile file if one exists with that name.

## Error Handling

| Condition | Action |
|-----------|--------|
| Profile name does not exist | Show the daemon error and list available profiles |
| No `eforge/backends/` directory | Suggest `/eforge:backend:new` to create the first profile |
| Tool connection failure | The daemon auto-starts; if it still fails, suggest `eforge daemon start` manually |
| No config found | Tell the user: "No eforge config found. Run `/eforge:init` to initialize eforge in this project." |

## Related Skills

| Skill | When to suggest |
|-------|----------------|
| `/eforge:backend:new` | User wants to create a new named profile |
| `/eforge:config` | User wants to view or edit `eforge/config.yaml` (the team default fallback) |
| `/eforge:status` | User wants to check current build status |
