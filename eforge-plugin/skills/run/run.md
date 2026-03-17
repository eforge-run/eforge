---
description: Validate source and launch eforge run (plan + build + validate, or adopt existing plans) as a background task with monitor dashboard
argument-hint: "<source> [--adopt]"
disable-model-invocation: true
---

# /eforge:run

Launch `eforge run` to plan and build from a PRD file or description. This is a thin launcher — all orchestration, agent execution, and state management are handled by the eforge CLI.

**Prerequisite**: `eforge` CLI must be installed and on PATH.

## Arguments

- `source` — PRD file path, implementation plan file path, or inline description of what to build
- `--adopt` — (optional) Explicitly adopt the source as an existing implementation plan, skipping the planner agent

## Workflow

### Step 1: Validate Source and Detect Adopt Mode

Check that `$ARGUMENTS` is provided and the source is readable:

- **File path**: Verify the file exists with the Read tool. Show a brief summary of what it describes.
- **Inline description**: Note that eforge will use this directly as the source prompt.
- **`--adopt` flag in arguments**: If present, strip it from the source path and set adopt mode.

**Adopt inference** — automatically use `--adopt` when:
1. The source path is under `~/.claude/plans/` (Claude Code's built-in `/plan` command output, not `/eforge:plan`)
2. The source was auto-detected from a prior `/plan` session in the current conversation (see below)
3. The user explicitly passes `--adopt` in arguments

If no arguments provided:
1. Check the current conversation for a plan file path from a prior `/plan` session (plan mode writes files to `~/.claude/plans/<name>.md` and the path appears in earlier conversation turns)
2. If a plan file path is found in this session, read it with the Read tool, show a brief summary, and note that **adopt mode will be used** since this is an implementation plan (not a PRD)
3. Ask the user to confirm before proceeding
4. If no plan file is found in conversation context, suggest running `/eforge:plan` first to create a PRD
- **Stop here** if the user declines or no source is identified

When adopting, the confirmation message should say:

> Found implementation plan from your planning session. Will adopt it into eforge format and run build + review + validate (planner agent skipped).

### Step 2: Launch

Run eforge as a background task:

```bash
# Normal mode (PRD → plan → build → validate)
eforge run $SOURCE --auto --verbose

# Adopt mode (plan → build → validate, planner skipped)
eforge run $SOURCE --adopt --auto --verbose
```

Use `run_in_background: true` on the Bash tool call so the user gets notified when the build completes without blocking the conversation.

- `--auto` bypasses approval gates (the user approved by invoking this skill)
- `--verbose` streams detailed output for the completion notification
- `--adopt` wraps the source into eforge plan format without running the planner agent

### Step 3: Monitor

Tell the user:

**For normal mode:**

> Build launched. You'll be notified when it completes.
>
> **Monitor**: http://localhost:4567
>
> The run executes the full lifecycle:
> 1. **Planning** — generates plan files from your source
> 2. **Building** — implements each plan in parallel on feature branches
> 3. **Merging** — merges completed plans back to the base branch
> 4. **Validation** — post-merge review/fix loop (type-check, tests, lint)
>
> Use `/eforge:status` for a quick inline status check.

**For adopt mode:**

> Build launched. You'll be notified when it completes.
>
> **Monitor**: http://localhost:4567
>
> Your implementation plan was adopted into eforge format. The run executes:
> 1. **Profile selection** — analyzes the plan against the codebase to select a workflow profile (errand/excursion/expedition, or custom profiles from eforge.yaml)
> 2. **Adoption** — wraps your plan in eforge format (errands wrap as-is; larger profiles delegate to the planner for proper decomposition)
> 3. **Plan review** — blind review of the plan artifacts
> 4. **Building** — implements each plan on feature branches (parallel for multi-plan scopes)
> 5. **Code review** — blind code review of the implementation
> 6. **Merging** — merges back to the base branch
> 7. **Validation** — post-merge validation (type-check, tests, lint)
>
> Use `/eforge:status` for a quick inline status check.

## Error Handling

| Error | Action |
|-------|--------|
| `eforge` not found | Tell user to install eforge CLI and ensure it's on PATH |
| Source file not found | Check path, suggest `/eforge:plan` to create one |
| No arguments provided | Check conversation for plan file from `/plan` session; if none found, suggest `/eforge:plan` |
| Adopt fails (invalid plan format) | Show error, suggest removing `--adopt` to use normal planning mode |
| Build fails on launch | Show error, check prerequisites |
