---
name: eforge-update
description: Check for eforge updates and guide through updating the CLI package and daemon
disable-model-invocation: true
---

# /eforge:update

Check for available eforge updates and walk through updating the npm package, restarting the daemon, and updating the <!-- parity-skip-start -->Pi package<!-- parity-skip-end -->.

## Workflow

### Step 1: Check Current CLI Version

Run `npx -y @eforge-build/eforge --version` to get the currently installed CLI version. Save this as `currentVersion`.

If the command fails, report that eforge is not installed and stop.

### Step 2: Check Latest Available Version

Run `npm view @eforge-build/eforge version` to get the latest published version. Save this as `latestVersion`.

### Step 3: Compare Versions

If `currentVersion` equals `latestVersion`:

> eforge is already up to date (v{currentVersion}). No action needed.

**Stop here.**

### Step 4: Update the npm Package

Determine the install type by running `which eforge` and inspecting the resolved path:

- **Global install** (path contains a global `node_modules`, e.g. `/usr/local/lib/node_modules` or `~/.npm/`): Run `npm install -g @eforge-build/eforge@latest`
- **npx usage** (no global install found): Skip this step - npx always fetches the latest version automatically.

After the install completes, run `npx -y @eforge-build/eforge --version` again to confirm the new version. Save this as `newCliVersion`.

### Step 5: Restart the Daemon

**Before stopping the daemon**, call the `eforge_status` tool to check for active builds.

- If the response contains `status: 'running'`, **abort the update immediately** and tell the user:

> An eforge build is currently running. The daemon cannot be safely restarted while builds are in progress. Please wait until all builds complete, then re-run `/eforge:update`.

**Stop here. Do not proceed to stopping the daemon.**

- If the status is anything other than `'running'`, proceed to stop and restart the daemon:

Call the `eforge_daemon` tool with `{ action: "stop" }`.

Then call the `eforge_daemon` tool with `{ action: "start" }`.

After the daemon restarts, run `npx -y @eforge-build/eforge --version` to confirm the running version. If `newCliVersion` was not set in Step 4 (npx path), save this as `newCliVersion`.

<!-- parity-skip-start -->
### Step 6: Update the Pi Package

Tell the user:

> The Pi package should also be updated to match the new CLI version. Run:
>
> ```
> pi update
> ```
>
> This will update all non-pinned packages including eforge.

If the user installed via a local path (for development), remind them to pull the latest source and rebuild instead.
<!-- parity-skip-end -->

### Step 7: Report Summary

Report the update results:

> **eforge update complete**
>
> | Component | Old Version | New Version |
> |-----------|-------------|-------------|
> | npm package | v{currentVersion} | v{newCliVersion} |
<!-- parity-skip-start -->
> | Pi package | _(update via `pi update`)_ | _(latest)_ |
<!-- parity-skip-end -->
> | Daemon | _(restarted)_ | _(running new version)_ |

## Error Handling

| Error | Action |
|-------|--------|
| `npx -y @eforge-build/eforge --version` fails | Report that eforge is not installed; suggest `npm install -g @eforge-build/eforge` |
| `npm view @eforge-build/eforge version` fails | Report network or registry error; suggest retrying |
| `npm install -g` fails | Show error output; suggest checking permissions or using `sudo` |
| Daemon stop/start fails | Show error output; suggest running `npx -y @eforge-build/eforge daemon start` manually |
| Active build detected (`status: 'running'`) | Abort the update; tell the user to wait until all builds complete before retrying |

## Related Skills

| Skill | Command | When to suggest |
|-------|---------|----------------|
| Init | `/eforge:init` | No eforge config found in the project |
| Build | `/eforge:build` | User wants to enqueue work for the daemon to build |
| Config | `/eforge:config` | User wants to view, edit, or validate the eforge config |
| Plan | `/eforge:plan` | User wants to plan changes before building |
| Status | `/eforge:status` | User wants to check build progress or queue state |
| Restart | `/eforge:restart` | User wants to restart the eforge daemon |
