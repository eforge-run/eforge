---
description: Read eforge state file and render inline status with plan progress and monitor link
disable-model-invocation: true
---

# /eforge:status

Quick inline status check — reads `.eforge/state.json` directly without invoking the eforge CLI.

## Workflow

### Step 1: Read State

Read the state file:

```bash
cat .eforge/state.json
```

If the file doesn't exist, report:

> No active eforge builds. Run `/eforge:run` to plan and build, or `/eforge:plan` to create a PRD first.

**Stop here** if no state file exists.

### Step 2: Render Status

Parse the JSON and display:

**Plan Set**: `{setName}`
**Status**: `{status}` (running / completed / failed)
**Started**: `{startedAt}`
**Duration**: Calculate from `startedAt` to now if status is `running`

#### Plan Progress

Render a table of per-plan statuses:

| Plan | Branch | Status | Dependencies |
|------|--------|--------|-------------|
| `{planId}` | `{branch}` | `{status}` | `{dependsOn}` |

Status values: `pending`, `running`, `completed`, `failed`, `blocked`, `merged`

Completed plans count: `{completedPlans.length}` / `{total plans}`

### Step 3: Monitor Link

If the overall status is `running`, show:

> **Monitor**: http://localhost:4567
>
> The monitor dashboard shows real-time progress: event timeline, per-plan status, token/cost tracking, and run history.

If the status is `completed` or `failed`, omit the monitor link and show a summary instead:
- **Completed**: "All plans completed successfully. Post-merge validation was included in the run."
- **Failed**: Show which plans failed and suggest checking logs.

## Error Handling

| Condition | Action |
|-----------|--------|
| `.eforge/state.json` missing | Report no active builds, suggest `/eforge:plan` |
| State file is malformed JSON | Report parse error, suggest running `eforge status` CLI directly |
| State file exists but empty | Treat as missing state |
