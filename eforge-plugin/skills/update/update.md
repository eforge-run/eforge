---
description: Check for eforge updates and guide through updating the CLI package, daemon, and plugin
disable-model-invocation: true
---

# /eforge:update

Check for available eforge updates and walk through updating the npm package, restarting the daemon, and updating the Claude Code plugin.

## Workflow

### Step 1: Check Current CLI Version

Run `npx -y eforge --version` to get the currently installed CLI version. Save this as `currentVersion`.

If the command fails, report that eforge is not installed and stop.

### Step 2: Check Latest Available Version

Run `npm view eforge version` to get the latest published version. Save this as `latestVersion`.

### Step 3: Compare Versions

If `currentVersion` equals `latestVersion`:

> eforge is already up to date (v{currentVersion}). No action needed.

**Stop here.**

### Step 4: Update the npm Package

Determine the install type by running `which eforge` and inspecting the resolved path:

- **Global install** (path contains a global `node_modules`, e.g. `/usr/local/lib/node_modules` or `~/.npm/`): Run `npm install -g eforge@latest`
- **npx usage** (no global install found): Skip this step - npx always fetches the latest version automatically.

After the install completes, run `npx -y eforge --version` again to confirm the new version. Save this as `newCliVersion`.

### Step 5: Restart the Daemon

**Before stopping the daemon**, call the `mcp__eforge__eforge_status` tool to check for active builds.

- If the response contains `status: 'running'`, **abort the update immediately** and tell the user:

> An eforge build is currently running. The daemon cannot be safely restarted while builds are in progress. Please wait until all builds complete, then re-run `/eforge:update`.

**Stop here. Do not proceed to stopping the daemon.**

- If the status is anything other than `'running'`, proceed to stop and restart the daemon:

Call the `mcp__eforge__eforge_daemon` tool with `action: "stop"`.

Then call the `mcp__eforge__eforge_daemon` tool with `action: "start"`.

After the daemon restarts, run `npx -y eforge --version` to confirm the running version. If `newCliVersion` was not set in Step 4 (npx path), save this as `newCliVersion`.

### Step 6: Update the Plugin

Tell the user:

> The Claude Code plugin also needs to be updated to match the new CLI version. Please run:
>
> `/plugin update eforge@eforge`
>
> This cannot be done automatically - skills cannot invoke slash commands.

Wait for the user to confirm they've updated the plugin before proceeding.

### Step 7: Report Summary

Report the update results:

> **eforge update complete**
>
> | Component | Old Version | New Version |
> |-----------|-------------|-------------|
> | npm package | v{currentVersion} | v{newCliVersion} |
> | Plugin | _(updated via /plugin update)_ | _(latest)_ |
> | Daemon | _(restarted)_ | _(running new version)_ |

## Error Handling

| Error | Action |
|-------|--------|
| `npx -y eforge --version` fails | Report that eforge is not installed; suggest `npm install -g eforge` |
| `npm view eforge version` fails | Report network or registry error; suggest retrying |
| `npm install -g` fails | Show error output; suggest checking permissions or using `sudo` |
| Daemon stop/start fails | Show error output; suggest running `npx -y eforge daemon start` manually |
| Active build detected (`status: 'running'`) | Abort the update; tell the user to wait until all builds complete before retrying |
