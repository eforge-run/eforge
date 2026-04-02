---
name: eforge-status
description: Check eforge run status and queue state via daemon tools
disable-model-invocation: true
---

# /eforge:status

Quick inline status check — queries the eforge daemon for current run state and queue contents.

## Workflow

### Step 1: Get Run Status

Call the `eforge_status` tool (no parameters needed).

- If the response indicates no active sessions, report:

> No active eforge builds. Use `/eforge:build` to enqueue work.

- **Stop here** if no active sessions.

### Step 2: Render Status

Parse the JSON response and display:

**Session**: `{sessionId}`
**Status**: `{status}` (running / completed / failed)

#### Plan Progress

If the response contains plan-level status, render a table:

| Plan | Branch | Status | Dependencies |
|------|--------|--------|-------------|
| `{planId}` | `{branch}` | `{status}` | `{dependsOn}` |

Status values: `pending`, `running`, `completed`, `failed`, `blocked`, `merged`

### Step 3: Queue State

Call the `eforge_queue_list` tool (no parameters needed).

Parse the response. If PRD files are found, display a summary:

**Queue**: `{count}` pending PRD(s)

For each pending PRD, show the title. If there are more than 5, show the first 5 and a count of remaining.

### Step 4: Summary

If the overall status is `running`, show:

> The daemon is processing the build in the background. Use `/eforge:status` again to refresh.

If the status is `completed` or `failed`:
- **Completed**: "All plans completed successfully. Post-merge validation was included in the run."
- **Failed**: Show which plans failed and suggest using `/eforge:status` again to refresh or checking the monitor dashboard.

## Error Handling

| Condition | Action |
|-----------|--------|
| Tool returns error | Show the error, suggest running `eforge daemon start` manually |
| Daemon not running | The daemon auto-starts; if it still fails, suggest running `eforge daemon start` manually |
| Response is malformed | Report parse error, suggest running `eforge status` CLI directly |
