---
description: Analyze documentation drift and enqueue an eforge build to fix it. Use when docs are stale after implementation changes. Works in any project with eforge running.
argument-hint: "<file-or-topic: e.g. README.md, CLAUDE.md, architecture, api>"
---

# /eforge-plugin-update-docs

Detect documentation drift for a given file or topic, then enqueue an eforge build with a focused prompt describing exactly what needs updating.

## Arguments

- `target` (required) - A documentation file path (e.g. `README.md`, `CLAUDE.md`, `docs/api.md`) or a topic keyword (e.g. `architecture`, `readme`, `api`). If not provided, ask the user what they want to update.

## Workflow

### Step 1: Resolve Target File

If the argument is a file path, verify it exists. If it's a keyword, search the project for likely matches:

- `readme` -> `README.md`
- `claude-md` or `claude` -> `CLAUDE.md`
- Otherwise, glob for `**/<target>*` and `**/docs/**/<target>*` to find candidates

If multiple matches, ask the user to pick one. If none found, report and stop.

Read the target file.

### Step 2: Gather Current State

Search the codebase to understand what the documentation should reflect. Adapt your search strategy to the document's content:

- Read the doc and identify its key claims - file paths, command examples, feature lists, API descriptions, architecture descriptions, agent/component inventories, configuration options
- For each category of claim, run targeted searches:
  - **File paths / directory listings** mentioned in the doc - verify they still exist via Glob
  - **Commands / scripts** mentioned - check `package.json` scripts, CLI source, or Makefile
  - **Feature / component inventories** - list the relevant source directories to see what actually exists
  - **Config options** - read the config source to check current options
  - **API surface** - grep for exports, route definitions, or tool definitions as appropriate
- Also check `git log --oneline -30` for recent changes that might affect the doc

Don't try to understand the entire codebase - focus on what the target document covers.

### Step 3: Identify Drift

Compare the doc's claims against reality. Categorize findings:

- **Stale** - doc mentions things that no longer exist or have changed
- **Missing** - things that exist but the doc doesn't mention
- **Incorrect** - descriptions that contradict current behavior

If no drift is detected, tell the user the doc is current and stop.

### Step 4: Compose Build Prompt

Write a focused prompt that describes the documentation update needed. The prompt should:

- Name the target file
- List each piece of drift with specific details (what the doc says vs. what's true now)
- Specify the editing principles: minimal edits, preserve existing style and tone, don't expand scope, don't add fluff
- Note any sections that are correct and should not be touched

Structure it as a clear PRD-style prompt that eforge's formatter and planner can work with effectively.

Example shape:

```
Update {file} to reflect current codebase state.

Changes needed:
- Section "X": says {old}, should say {new}
- Section "Y": missing {thing} which was added in {location}
- Section "Z": references {removed thing}, remove it

Editing rules:
- Minimal, targeted edits only - don't rewrite sections that are correct
- Match existing formatting and level of detail
- Don't add commentary or expand scope
```

### Step 5: Enqueue via eforge

Call `mcp__plugin_eforge_eforge__eforge_build` with `{ "source": "<the composed prompt>" }`.

Report the result to the user:

> Enqueued doc update for `{file}` (session: `{sessionId}`).
>
> **Drift summary:**
> - {count} stale items
> - {count} missing items  
> - {count} incorrect items
>
> Use `/eforge:status` to track progress.

## Error Handling

| Error | Action |
|-------|--------|
| No target argument | Ask the user which doc to update |
| Target file not found | Report and stop |
| No drift detected | Tell user doc is current, no build needed |
| eforge MCP tool error | Show the error message |
