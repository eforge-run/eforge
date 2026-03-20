---
description: Validate source and launch eforge run (enqueue + plan + build + validate) as a background task with monitor dashboard
argument-hint: "<source> [--queue] [--watch]"
disable-model-invocation: true
---

# /eforge:run

Launch `eforge run` to plan and build from a PRD file or description. This is a thin launcher - all orchestration, agent execution, and state management are handled by the eforge CLI.

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

Resolve the eforge CLI command, preferring a local install over npx:

```bash
if command -v eforge >/dev/null 2>&1; then
  EFORGE_CMD="eforge"
else
  EFORGE_CMD="npx --yes eforge"
fi
```

Run eforge as a background task using the resolved command:

```bash
# Normal mode (enqueue + plan + build + validate)
$EFORGE_CMD run $SOURCE --auto --verbose

# Queue mode (process all PRDs from the queue)
$EFORGE_CMD run --queue --auto --verbose

# Watch mode (continuously poll the queue for new PRDs)
$EFORGE_CMD run --queue --watch --auto --verbose

# Watch mode with custom poll interval
$EFORGE_CMD run --queue --watch --poll-interval 10000 --auto --verbose
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
> The run formats your source into a PRD, selects a workflow profile, then compiles and builds. The pipeline varies by profile - errands skip straight to building, while excursions and expeditions go through planning and plan review first. Every profile gets blind code review (a separate agent with no builder context), merge, and post-merge validation.
>
> Use `/eforge:status` for a quick inline status check.

**For queue mode:**

> Queue processing launched. You'll be notified when it completes.
>
> **Monitor**: {MONITOR_URL}
>
> Each queued PRD goes through the same pipeline: formatting, profile selection, compile, build with blind review, merge, and validation.
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
| Source file not found | Check path, suggest `/eforge:enqueue` to create one |
| No arguments provided | Check conversation for plan file; if none found, suggest `/eforge:enqueue` |
| Build fails on launch | Show error, check prerequisites |
| Version mismatch (e.g. "unknown option", "unknown command", or other CLI errors suggesting the installed eforge version doesn't match the plugin) | Tell the user the CLI and plugin versions may be out of sync. Suggest `npm update -g eforge` or clearing the npx cache (`npx --yes eforge@latest --version` to force refresh). Suggest `/plugin update eforge@eforge` to update the plugin. If both are already at the latest version, suggest reporting as a bug. |
