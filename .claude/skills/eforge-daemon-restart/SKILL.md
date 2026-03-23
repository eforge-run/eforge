---
description: Rebuild eforge from source and restart the daemon. Use during development after making code changes so the MCP tools pick up the latest build.
---

# /daemon-restart

Rebuilds eforge from source and restarts the persistent daemon so MCP tools serve fresh code.

**Prerequisite**: Must be run from the eforge project root with `pnpm` available.

## Workflow

### Step 1: Build

Run a full build to pick up source changes:

```bash
pnpm build
```

**On build failure**: Stop immediately. Show the build error. Do not continue.

### Step 2: Stop Daemon

Stop the running daemon (if any):

```bash
eforge daemon stop
```

If the daemon wasn't running, that's fine — continue to Step 3.

### Step 3: Start Daemon

Start a fresh daemon with the newly built code:

```bash
eforge daemon start
```

**On failure**: Show the error and suggest running `eforge daemon start` manually to diagnose.

### Step 4: Confirm

Report that the daemon is running with fresh code. Include the port and PID from the output.
