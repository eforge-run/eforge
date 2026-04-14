---
name: eforge-restart
description: Safely restart the eforge daemon, checking for active builds first
disable-model-invocation: true
---

# /eforge:restart

Safely restart the eforge daemon. Checks for active builds before stopping, then starts a fresh daemon instance.

## Workflow

### Step 1: Restart via Tool

Call the `eforge_daemon` tool with `{ action: "restart" }`.

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

If the user explicitly requests a forced restart (even with active builds), call the `eforge_daemon` tool with `{ action: "restart", force: true }`.

## Error Handling

| Error | Action |
|-------|--------|
| Tool unavailable | Warn that eforge tools are not available; suggest checking the extension is loaded |
| Active build detected | Abort the restart; tell the user to wait until all builds complete before retrying, or use force restart |
| Restart fails | Show error output; suggest running `/eforge:restart` again or checking daemon logs |
