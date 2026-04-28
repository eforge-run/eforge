---
description: Initialize eforge in the current project with an interactive setup form
argument-hint: "[--force] [--migrate]"
---

# /eforge:init

<!-- parity-skip-start -->
Initialize eforge in this project. Presents a form to select a harness, provider, and model for the starter profile, then creates a named agent runtime profile under `eforge/profiles/` and activates it. Also writes `eforge/config.yaml` for team-wide settings (postMergeCommands, etc.) with `agentRuntimes:` and `defaultAgentRuntime:` as top-level keys.
<!-- parity-skip-end -->

## Workflow

### Step 1: Determine postMergeCommands

Inspect the project to figure out the right `postMergeCommands`:

1. Read `package.json` (if it exists) and note which scripts are available (e.g. `install`, `type-check`, `typecheck`, `test`, `build`, `lint`)
2. Detect the package manager from lockfiles: `pnpm-lock.yaml` -> pnpm, `yarn.lock` -> yarn, `package-lock.json` -> npm, `bun.lockb` -> bun
3. Build a suggested command list. Always start with the install command, then add validation scripts in order: type-check, test, build. For example: `["pnpm install", "pnpm type-check", "pnpm test", "pnpm build"]`
4. For non-JS projects: check for `Cargo.toml` (cargo build, cargo test), `go.mod` (go build ./..., go test ./...), `Makefile` (make), etc.
5. If you can't determine commands, use an empty list

If `eforge/config.yaml` already exists, also read its current `build.postMergeCommands` and compare against your analysis. If the existing commands look good, keep them. If your analysis suggests improvements (missing scripts, outdated commands), propose the updated set instead.

Present your suggested commands to the user briefly: "I'd suggest these postMergeCommands based on your project: ..." and ask if they look right. Accept corrections.

<!-- parity-skip-start -->
### Step 1.5: Pick harness, provider, and model

1. **Harness**: Ask the user to choose between `claude-sdk` (Claude Code's built-in SDK) or `pi` (multi-provider via Pi SDK). Default to `claude-sdk`. Profiles can later mix multiple harnesses across agent roles via `/eforge:profile-new`.
2. **Provider** (Pi only): Call `mcp__eforge__eforge_models` with `{ action: "providers", harness: "pi" }` to get available providers. Ask the user to pick one.
3. **Max model**: Call `mcp__eforge__eforge_models` with `{ action: "list", harness: "<chosen>", provider: "<chosen>" }` to get available models (sorted newest-first). Default to the newest model. The max model is used for all three model classes (max, balanced, fast) initially - users can refine later with `/eforge:profile-new`.

### Step 2: Call the tool

Call the `mcp__eforge__eforge_init` tool with:
- `force: true` if `$ARGUMENTS` contains `--force` or `force`
- `postMergeCommands`: the commands from Step 1 (only applied when creating a new config - the tool preserves existing config formatting when the file already exists)
<!-- parity-skip-end -->

The tool will create a single-entry agent runtime profile under `eforge/profiles/`, activate it via `eforge/.active-profile`, and write `eforge/config.yaml` with `agentRuntimes:` (listing available profiles) and `defaultAgentRuntime:` (the default profile name) as top-level keys alongside other team-wide settings.

### Step 2.5: Migrate existing config

If `$ARGUMENTS` contains `--migrate`, skip Steps 1.5 and 2 above. Instead call `mcp__eforge__eforge_init` with `migrate: true`. This extracts the legacy `backend:`/`pi:`/`agents.*` fields from the existing `config.yaml` into a single-entry agent runtime profile, activates it, and strips those fields from `config.yaml`.

### Step 3: Ensure `.gitignore` covers the active-profile marker

The `eforge/.active-profile` file is a per-developer marker that tracks which named agent runtime profile is active. It should never be committed - each developer can pick their own profile. The `mcp__eforge__eforge_init` tool already manages the main `.gitignore` entries, but also ensure the repo's `.gitignore` contains `eforge/.active-profile`. If it is missing, append it.

### Step 4: Report

Once the tool completes successfully, inform the user:

> eforge initialized with profile `<profileName>`. The profile lives at `eforge/profiles/<profileName>.yaml` and is now active. You can customize further with `/eforge:config --edit`, switch profiles with `/eforge:profile`, or create additional profiles with `/eforge:profile-new`. Use `/eforge:profile-new --scope user` to create a user-scope profile under `~/.config/eforge/profiles/` that applies across all your projects.

To mix multiple harnesses across agent roles (e.g. `claude-sdk` planners + `pi` builders), use `/eforge:profile-new` or edit `eforge/profiles/<profileName>.yaml` directly — `agentRuntimes` accepts multiple named entries.

## Related Skills

| Skill | Command | When to suggest |
|-------|---------|----------------|
| Build | `/eforge:build` | User wants to enqueue work for the daemon to build |
| Config | `/eforge:config` | User wants to view, edit, or validate the eforge config |
| Profile | `/eforge:profile` | User wants to inspect or switch agent runtime profiles |
| Profile (new) | `/eforge:profile-new` | User wants to create a personal agent runtime profile |
| Plan | `/eforge:plan` | User wants to plan changes before building |
| Status | `/eforge:status` | User wants to check build progress or queue state |
| Restart | `/eforge:restart` | User wants to restart the eforge daemon |
| Update | `/eforge:update` | User wants to check for or install eforge updates |
