---
name: eforge-profile
description: List, inspect, and switch agent runtime profiles
disable-model-invocation: true
---

> **Note:** In Pi, the native `/eforge:profile` command provides a richer interactive experience with overlay-based profile browsing and switching. This skill serves as a fallback for non-interactive contexts and as model-readable documentation.

# /eforge:profile

List, inspect, and switch named agent runtime profiles stored in `.eforge/profiles/` (project-local scope), `eforge/profiles/` (project scope), or `~/.config/eforge/profiles/` (user scope). The active profile is tracked by a marker file at any level; resolution follows a 6-step precedence chain (see below).

## Workflow

### Step 1: Branch on arguments

Inspect `$ARGUMENTS`:

- If `$ARGUMENTS` is empty or whitespace, go to Step 2 (**inspect mode**).
- Otherwise treat the argument as a profile name and go to Step 3 (**switch mode**).

### Step 2: Inspect mode

Call the `eforge_profile` tool with `{ action: "show" }`.

Parse the response (shape: `{ active, source, resolved: { harness, profile } }`) and report:

- **Active profile**: `{active}` (or "(none - using team default)" when `active` is null)
- **Source**: `{source}` (`local` when the active profile is picked via the `.eforge/.active-profile` marker, `project` when picked via the `eforge/.active-profile` marker, `team` when no marker is present and the resolution falls back to the `defaultAgentRuntime:` field in `eforge/config.yaml`, `missing` when the marker points at a profile file that does not exist (stale marker), `none` when no profile is configured at all)
- **Resolved harness**: `{resolved.harness}` (e.g. `claude-sdk` or `pi`)

Then call `eforge_profile` with `{ action: "list" }` to show the user what other profiles are available, rendering a table with the following columns:

| Name | Scope | Harness | Active |
|------|-------|---------|--------|
| `pi-anthropic` | `local` | `pi` | `●` |
| `pi-glm` | `project (shadowed)` | `pi` | |
| `claude-fast` | `user` | `claude-sdk` | |

- **Scope**: `local` for profiles in `.eforge/profiles/` (gitignored, project-local), `project` for profiles in `eforge/profiles/`, `user` for profiles in `~/.config/eforge/profiles/`.
- Local entries shadow project and user entries of the same name. Project entries shadow user entries of the same name. Shadowed entries show `project (shadowed)` or `user (shadowed)` in the Scope column.
- Mark the active profile with `●`.

If no profiles exist, suggest `/eforge:profile-new` to create one.

### Step 3: Switch mode

Call `eforge_profile` with `{ action: "use", name: "<arg>" }`. To set the active profile at user scope instead of project scope, pass `scope: "user"`: `{ action: "use", name: "<arg>", scope: "user" }`.

On success, the daemon writes the active-profile marker at the chosen scope (`.eforge/.active-profile` for local, `eforge/.active-profile` for project, `~/.config/eforge/.active-profile` for user). Then call `{ action: "show" }` again and report the new active profile plus the resolved harness:

> Switched to `{name}`. Resolved harness: `{resolved.harness}`. The next eforge build will use this profile.

On error (e.g. the profile does not exist), surface the error message and suggest running `/eforge:profile` with no args to list available profiles, or `/eforge:profile-new` to create a new one.

## Scope Parameter

The `scope` parameter is available on `list`, `use`, `create`, and `delete` actions:

- **`list`**: `scope` accepts `"local"`, `"project"`, `"user"`, or `"all"` (default `"all"`) - shows profiles from all scopes when omitted.
- **`use` / `create` / `delete`**: `scope` accepts `"local"`, `"project"`, or `"user"` (default `"project"`) - operates on `.eforge/profiles/` and `.eforge/.active-profile` for local scope, `eforge/profiles/` and `eforge/.active-profile` for project scope, `~/.config/eforge/profiles/` and `~/.config/eforge/.active-profile` for user scope.

## Active Profile Precedence

The active agent runtime profile is resolved using a 6-step precedence chain (highest to lowest):

1. **Project-local marker** - `.eforge/.active-profile` file in the repo root (gitignored)
2. **Project marker** - `eforge/.active-profile` file in the project
3. **Project config** - `defaultAgentRuntime:` field in `eforge/config.yaml`
4. **User marker** - `~/.config/eforge/.active-profile` file
5. **User config** - `defaultAgentRuntime:` field in `~/.config/eforge/config.yaml`
6. **None** - no profile configured

When a profile name is resolved, the profile file is looked up local-first, then project, then user-fallback - so a local profile shadows project and user profiles with the same name.

## Error Handling

| Condition | Action |
|-----------|--------|
| Profile name does not exist | Show the daemon error and list available profiles |
| No `eforge/profiles/` directory | Suggest `/eforge:profile-new` to create the first profile |
| Tool connection failure | The daemon auto-starts; if it still fails, suggest `eforge daemon start` manually |
| No config found | Tell the user: "No eforge config found. Run `/eforge:init` to initialize eforge in this project." |

## Related Skills

| Skill | When to suggest |
|-------|----------------|
| `/eforge:profile-new` | User wants to create a new named profile |
| `/eforge:config` | User wants to view or edit `eforge/config.yaml` (the team default fallback) |
| `/eforge:status` | User wants to check current build status |
