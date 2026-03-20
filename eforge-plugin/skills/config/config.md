---
description: Initialize or edit eforge.yaml configuration
disable-model-invocation: true
argument-hint: "[--init|--edit]"
---

# /eforge:config

Create or modify an `eforge.yaml` configuration file interactively. Supports two modes - init for new projects and edit for existing configs.

## Mode Detection

Determine the mode from arguments and file state:

1. If `$ARGUMENTS` contains `--init`, use **init mode**
2. If `$ARGUMENTS` contains `--edit`, use **edit mode**
3. If `eforge.yaml` exists in the project root, use **edit mode**
4. Otherwise, use **init mode**

## Init Mode

### Step 1: Check Existence

If `eforge.yaml` already exists, ask the user whether they want to switch to edit mode or overwrite. Respect their choice.

### Step 2: Gather Context

Read project context to understand the codebase:

- **CLAUDE.md** - Project overview, tech stack, build commands
- **package.json** or equivalent - Dependencies, scripts
- **Project structure** - Scan top-level directories

Share a brief summary of what you found.

### Step 3: Interview

Walk the user through configuration sections, asking about each one. Only include sections where the user wants non-default behavior.

**Sections to cover:**

1. **Build settings** - `postMergeCommands` (validation commands to run after merging worktrees, e.g. `pnpm install`, `pnpm type-check`, `pnpm test`), `parallelism`, `maxValidationRetries`
2. **Profiles** - Custom workflow profiles or overrides of built-in profiles (`errand`, `excursion`, `expedition`). A profile defines compile stages only — build stages and review config are per-plan in orchestration.yaml. A profile can `extends` a built-in and override compile stages or agent settings.
3. **Hooks** - Event-driven commands that run on specific eforge events (e.g. `session:start`, `phase:end`). Each hook has `event` (pattern), `command`, and optional `timeout`.
4. **Agent settings** - Global `maxTurns`, `permissionMode` (`bypass` or `default`), `settingSources`
5. **Langfuse tracing** - Whether to enable Langfuse integration (keys are typically set via env vars)
6. **Plugin settings** - Enable/disable plugin loading, include/exclude lists
7. **PRD queue** - Queue directory, auto-revise setting

For each section, explain what it controls and suggest values based on the project context gathered in Step 2. Skip sections the user isn't interested in.

### Step 4: Present Draft

Show the user the complete `eforge.yaml` content before writing. Ask for any changes.

### Step 5: Write

Save to `eforge.yaml` in the project root.

### Step 6: Validate

Run `eforge config validate` via Bash to verify the config is valid. If validation fails, show the errors and offer to fix them.

## Edit Mode

### Step 1: Read Current Config

Read the existing `eforge.yaml` file and summarize its current settings for the user.

### Step 2: Identify Changes

Ask the user what they want to change. If `$ARGUMENTS` contains additional context beyond `--edit`, use that to understand the desired changes.

### Step 3: Apply Changes

Modify the config based on the user's requests. Present the updated content before writing.

### Step 4: Write

Save the updated `eforge.yaml`.

### Step 5: Validate

Run `eforge config validate` via Bash to verify the config is valid. If validation fails, show the errors and offer to fix them.

## Configuration Reference

Available top-level sections in `eforge.yaml`:

```yaml
# Build settings
build:
  parallelism: 4                    # Max parallel worktrees
  worktreeDir: "../my-worktrees"    # Custom worktree directory
  postMergeCommands:                # Commands to run after merge
    - pnpm install
    - pnpm type-check
    - pnpm test
  maxValidationRetries: 2           # Retry count for validation fixes
  cleanupPlanFiles: true            # Remove plan files after successful build

# Agent settings
agents:
  maxTurns: 30                      # Global max agent turns
  permissionMode: bypass            # bypass or default
  settingSources:                   # Which settings files agents load
    - project

# Langfuse tracing (keys usually via env vars)
langfuse:
  enabled: false
  host: https://cloud.langfuse.com

# Plugin loading
plugins:
  enabled: true
  include: []                       # Only load these plugins
  exclude: []                       # Skip these plugins
  paths: []                         # Additional plugin paths

# PRD queue
prdQueue:
  dir: docs/prd-queue
  autoRevise: false

# Event hooks
hooks:
  - event: "session:start"
    command: "echo 'Starting eforge session'"
    timeout: 5000

# Workflow profiles (compile stages only — build/review config is per-plan)
profiles:
  my-profile:
    extends: excursion              # Inherit from a built-in
    description: "Custom profile for my project"
    compile:
      - planner
      - plan-review-cycle
```

## Error Handling

| Condition | Action |
|-----------|--------|
| `eforge config validate` fails after write | Show errors, offer to fix |
| User provides invalid profile stage name | Warn and suggest valid stage names |
| YAML syntax error in existing file | Report the error, offer to recreate |
