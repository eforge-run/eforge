---
description: Validate source and launch eforge run (enqueue + plan + build + validate) as a background task with monitor dashboard
argument-hint: "<source> [--queue] [--watch]"
disable-model-invocation: true
---

# /eforge:run

Launch `eforge run` to plan and build from a PRD file or description. This is a thin launcher - all orchestration, agent execution, and state management are handled by the eforge CLI.

**Prerequisite**: `eforge` CLI must be installed and on PATH.

## Arguments

- `source` - PRD file path or inline description of what to build (required unless `--queue`)
- `--queue` - (optional) Process all PRDs from the queue instead of a single source
- `--watch` - (optional) Enable watch mode: continuously poll the queue for new PRDs after each cycle
- `--poll-interval <ms>` - (optional) Poll interval in milliseconds for watch mode (default: 5000)

## Workflow

### Step 1: Validate Source

**If `--queue` is in arguments:**
Skip source validation. Will process the entire PRD queue.

**Otherwise**, check that `$ARGUMENTS` is provided and the source is readable:

- **File path**: Verify the file exists with the Read tool. Show a brief summary of what it describes.
- **Inline description**: Note that eforge will use this directly as the source prompt.

If no arguments provided:
1. Check the current conversation for a PRD or plan file path from a prior session
2. If found, read it with the Read tool and show a brief summary
3. Ask the user to confirm before proceeding
4. If no file is found in conversation context, suggest running `/eforge:enqueue` first to create a PRD
- **Stop here** if the user declines or no source is identified

### Step 2: Launch

Run eforge as a background task:

```bash
# Normal mode (enqueue + plan + build + validate)
eforge run $SOURCE --auto --verbose

# Queue mode (process all PRDs from the queue)
eforge run --queue --auto --verbose

# Watch mode (continuously poll the queue for new PRDs)
eforge run --queue --watch --auto --verbose

# Watch mode with custom poll interval
eforge run --queue --watch --poll-interval 10000 --auto --verbose
```

Use `run_in_background: true` on the Bash tool call so the user gets notified when the build completes without blocking the conversation.

- `--auto` bypasses approval gates (the user approved by invoking this skill)
- `--verbose` streams detailed output for the completion notification

### Step 3: Resolve Monitor URL

Wait ~3 seconds for the monitor server to start and write its lockfile, then read the actual monitor URL:

```bash
sleep 3
```

Use the Read tool to read `.eforge/monitor.lock` from the project root. This file is JSON with `pid`, `port`, and `startedAt` fields.

- **If the file exists and is valid JSON**: Extract the `port` field and construct the URL as `http://localhost:{port}`.
- **If the file is missing or unreadable**: Fall back to `http://localhost:4567`.

Use the resolved URL as `{MONITOR_URL}` in the next step.

### Step 4: Monitor

Tell the user:

**For normal mode:**

> Build launched. You'll be notified when it completes.
>
> **Monitor**: {MONITOR_URL}
>
> The run executes the full lifecycle:
> 1. **Enqueue** - formats and normalizes your source into a structured PRD
> 2. **Profile selection** - selects a workflow profile based on task complexity
> 3. **Planning** - generates plan files from your source
> 4. **Plan review** - blind review of the plan artifacts
> 5. **Building** - implements each plan in parallel on feature branches
> 6. **Code review** - blind code review of the implementation
> 7. **Merging** - merges completed plans back to the base branch
> 8. **Validation** - post-merge review/fix loop (type-check, tests, lint)
> 9. **Squash** - collapses all intermediate commits into a single content commit
>
> Use `/eforge:status` for a quick inline status check.

**For queue mode:**

> Queue processing launched. You'll be notified when it completes.
>
> **Monitor**: {MONITOR_URL}
>
> Each queued PRD goes through the full lifecycle: enqueue formatting, planning, building, review, merging, and validation.
>
> Use `/eforge:status` for a quick inline status check.

**For watch mode (--watch):**

> Queue watch mode started. The queue will be polled for new PRDs after each cycle.
>
> **Monitor**: {MONITOR_URL}
>
> Press Ctrl+C to stop watching. The process exits cleanly on abort.
>
> Use `/eforge:status` for a quick inline status check.

## Error Handling

| Error | Action |
|-------|--------|
| `eforge` not found | Tell user to install eforge CLI and ensure it's on PATH |
| Source file not found | Check path, suggest `/eforge:enqueue` to create one |
| No arguments provided | Check conversation for plan file; if none found, suggest `/eforge:enqueue` |
| Build fails on launch | Show error, check prerequisites |
