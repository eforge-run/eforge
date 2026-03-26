---
description: Safely restart the eforge daemon, checking for active builds first
disable-model-invocation: true
---

# /eforge:restart

Safely restart the eforge daemon. Checks for active builds before stopping, then starts a fresh daemon instance.

## Workflow

### Step 1: Check for Active Builds

Call the `mcp__eforge__eforge_status` tool to check for active builds.

- If the response contains `status: 'running'`, **abort the restart immediately** and tell the user:

> An eforge build is currently running. The daemon cannot be safely restarted while builds are in progress. Please wait until all builds complete, then re-run `/eforge:restart`.

**Stop here. Do not proceed to `eforge daemon stop`.**

- If the status is anything other than `'running'`, proceed to Step 2.

### Step 2: Stop the Daemon

```bash
eforge daemon stop
```

If the command fails (e.g. daemon was not running), note the error but continue to Step 3.

### Step 3: Start the Daemon

```bash
eforge daemon start
```

After the daemon starts, capture the output which includes the port and PID.

### Step 4: Report Result

Report the restart result:

> **eforge daemon restarted**
>
> The daemon is now running on port {port} (PID {pid}).

If the start command output does not include port/PID details, run `eforge daemon status` to retrieve them.

## Error Handling

| Error | Action |
|-------|--------|
| `mcp__eforge__eforge_status` tool unavailable | Warn the user that build status could not be checked; ask for confirmation before proceeding |
| Active build detected (`status: 'running'`) | Abort the restart; tell the user to wait until all builds complete before retrying |
| `eforge daemon stop` fails | Log the error but continue to `eforge daemon start` (daemon may not have been running) |
| `eforge daemon start` fails | Show error output; suggest running `eforge daemon start` manually |
