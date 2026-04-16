---
description: Initialize eforge in the current project with an interactive setup form
argument-hint: "[--force]"
---

# /eforge:init

Initialize eforge in this project. Presents a form to select a backend and creates `eforge/config.yaml` with sensible defaults.

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

### Step 2: Call the tool

Call `mcp__eforge__eforge_init` with:
- `force: true` if `$ARGUMENTS` contains `--force` or `force`
- `postMergeCommands`: the commands from Step 1 (only applied when creating a new config - the tool preserves existing config formatting when the file already exists)

### Step 3: Report

Once the tool completes successfully, inform the user:

> eforge initialized. You can customize further with `/eforge:config --edit`.

## Related Skills

| Skill | Command | When to suggest |
|-------|---------|----------------|
| Build | `/eforge:build` | User wants to enqueue work for the daemon to build |
| Config | `/eforge:config` | User wants to view, edit, or validate the eforge config |
| Status | `/eforge:status` | User wants to check build progress or queue state |
| Restart | `/eforge:restart` | User wants to restart the eforge daemon |
| Update | `/eforge:update` | User wants to check for or install eforge updates |
