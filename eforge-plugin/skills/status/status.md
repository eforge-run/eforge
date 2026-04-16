---
description: Check eforge run status and queue state via MCP tools
disable-model-invocation: true
---

# /eforge:status

Quick inline status check — queries the eforge daemon via MCP tools for current run state and queue contents.

## Workflow

### Step 0: Validate Config

Call `mcp__eforge__eforge_config` with `{ action: "validate" }`.

- If `configFound` is `false`, stop and tell the user: "No eforge config found. Run `/eforge:init` to initialize eforge in this project."
- Otherwise, continue.

### Step 1: Get Run Status

Call the `mcp__eforge__eforge_status` tool (no parameters needed).

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

Call the `mcp__eforge__eforge_queue_list` tool (no parameters needed).

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
| MCP tool returns error | Show the error, suggest running `eforge daemon start` manually |
| Daemon not running | The MCP proxy auto-starts the daemon; if it still fails, suggest running `eforge daemon start` manually |
| No config found | Tell the user: "No eforge config found. Run `/eforge:init` to initialize eforge in this project." |
| Response is malformed | Report parse error, suggest running `eforge status` CLI directly |

## Related Skills

| Skill | When to suggest |
|-------|----------------|
| `/eforge:init` | No eforge config found in the project |
| `/eforge:build` | User wants to enqueue work for the daemon |
| `/eforge:config` | Config validation fails or user wants to view/edit config |
| `/eforge:status` | User wants to refresh build status |
