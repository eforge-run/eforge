---
description: Safely restart the eforge daemon, checking for active builds first
disable-model-invocation: true
---

# /eforge:restart

Safely restart the eforge daemon. Checks for active builds before stopping, then starts a fresh daemon instance.

## Workflow

### Step 1: Restart via Tool

Call the `mcp__eforge__eforge_daemon` tool with `{ action: "restart" }`.

- If the response contains an error about active builds, tell the user:

> An eforge build is currently running. The daemon cannot be safely restarted while builds are in progress. Please wait until all builds complete, then re-run `/eforge:restart`.

**Stop here. Do not proceed.**

- If the response succeeds, proceed to Step 2.

### Step 2: Report Result

Report the restart result using the response from the tool:

> **eforge daemon restarted**
>
> The daemon is now running on port {port}.

## Force Restart

If the user explicitly requests a forced restart (even with active builds), call the `mcp__eforge__eforge_daemon` tool with `{ action: "restart", force: true }`.

## Error Handling

| Error | Action |
|-------|--------|
<!-- parity-skip-start -->
| Tool unavailable | Warn the user that the eforge MCP tools are not available; suggest checking plugin configuration |
<!-- parity-skip-end -->
| Active build detected | Abort the restart; tell the user to wait until all builds complete before retrying, or use force restart |
| Restart fails | Show error output; suggest running `/eforge:restart` again or checking daemon logs |

## Related Skills

| Skill | Command | When to suggest |
|-------|---------|----------------|
| Init | `/eforge:init` | No eforge config found in the project |
| Build | `/eforge:build` | User wants to enqueue work for the daemon to build |
| Config | `/eforge:config` | User wants to view, edit, or validate the eforge config |
| Plan | `/eforge:plan` | User wants to plan changes before building |
| Status | `/eforge:status` | User wants to check build progress or queue state |
| Update | `/eforge:update` | User wants to check for or install eforge updates |
