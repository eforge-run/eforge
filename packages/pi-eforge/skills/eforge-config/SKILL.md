---
name: eforge-config
description: Initialize or edit eforge/config.yaml team-wide settings, with validation via daemon tools
disable-model-invocation: true
---

> **Note:** In Pi, the native `/eforge:config` command provides a richer interactive experience with a structured config viewer overlay. This skill serves as a fallback for non-interactive contexts and as model-readable documentation.

# /eforge:config

Create or modify an `eforge/config.yaml` configuration file interactively. Supports two modes - init for new projects and edit for existing configs. Validation uses the eforge daemon.

`eforge/config.yaml` holds **team-wide settings only** (postMergeCommands, agent tuning, hooks, queue config, etc.). Backend selection and backend-specific tuning live in named profile files (`eforge/backends/<name>.yaml` for project scope, or `~/.config/eforge/backends/<name>.yaml` for user scope) and are managed by `/eforge:init` and `/eforge:backend:new`. The `backend:` field is **not valid** in `eforge/config.yaml`; the schema rejects it.

## Mode Detection

Determine the mode from arguments and file state:

1. If `$ARGUMENTS` contains `--init`, use **init mode**
2. If `$ARGUMENTS` contains `--edit`, use **edit mode**
3. If `eforge/config.yaml` exists in the project root, use **edit mode**
4. Otherwise, use **init mode**

## Init Mode

### Step 1: Check Existence

If `eforge/config.yaml` already exists, ask the user whether they want to switch to edit mode or overwrite. Respect their choice.

### Step 2: Require an active backend profile

This skill does not create backend profiles. Before gathering team-wide settings, confirm a backend profile is already active by calling `eforge_backend` with `{ action: "show" }`. Inspect the response:

- If `active` is `null` (no profile is active for this project) or `resolved.backend` is missing, **stop**. Tell the user:
  > `/eforge:config` only manages team-wide settings. This project has no active backend profile. Run `/eforge:init` to set up eforge in a fresh project (creates a profile and `config.yaml`), or `/eforge:backend:new` to add a profile to an existing setup. Come back to `/eforge:config` once a profile is active.
  Do not proceed with the interview and do not write `eforge/config.yaml`.
- Otherwise note the resolved backend kind (`resolved.backend` is `claude-sdk` or `pi`) and, for Pi, the profile's provider. Use these when suggesting models later.

### Step 3: Gather Context

Read project context to understand the codebase:

- **AGENTS.md / CLAUDE.md** - Project overview, tech stack, build commands
- **package.json** or equivalent - Dependencies, scripts
- **Project structure** - Scan top-level directories

Share a brief summary of what you found.

### Step 4: Interview

Walk the user through configuration sections, asking about each one. Only include sections where the user wants non-default behavior. **Do not** collect backend, provider, or Pi-specific tuning here - those belong in backend profile files.

**Sections to cover:**

1. **Build settings** - `postMergeCommands` (validation commands to run after merging worktrees, e.g. `pnpm install`, `pnpm type-check`, `pnpm test`), `maxValidationRetries`
2. **Model & thinking tuning** (opt-in - "Would you like to customize model or thinking settings? Most users keep defaults.") - Model references are objects: `{ id: "model-name" }` for Claude SDK, `{ provider: "provider-name", id: "model-name" }` for Pi. Model class overrides via `agents.models` (map class names `max`/`balanced`/`fast` to model ref objects), global `agents.model` override (bypasses class system), `agents.thinking` config (`adaptive`, `enabled` with optional `budgetTokens`, or `disabled`), `agents.effort` level (`low`/`medium`/`high`/`xhigh`/`max`). Model resolution order: per-role model > global model > user class override > backend class default > fallback chain. Eight roles (`builder`, `review-fixer`, `validation-fixer`, `test-writer`, `tester`, `staleness-assessor`, `prd-validator`, `dependency-detector`) default to `balanced`; all others default to `max`. If a role's model class has no configured model, eforge walks up to more capable tiers, then down, before erroring. Whenever you suggest a specific model ID, **call `eforge_models` first** with `{ action: "list", backend: "<resolved-backend>" }` (and `provider: "<profile-provider>"` for Pi) and pick from the returned list (newest-first). Never propose a model ID from memory.
3. **Agent behavior** - Global `maxTurns`, `maxContinuations` (default 3 - max continuation attempts after maxTurns hit), `permissionMode` (`bypass` or `default`), `settingSources`, `bare` (default false)
4. **Per-role agent overrides** (opt-in - "Would you like to tune specific agent roles differently? Most users skip this.") - Override settings per agent role. Available roles grouped: planning (`planner`, `module-planner`), building (`builder`), review/eval (`reviewer`, `evaluator`, `plan-reviewer`, `plan-evaluator`, `architecture-reviewer`, `architecture-evaluator`, `cohesion-reviewer`, `cohesion-evaluator`), fixers (`validation-fixer`, `review-fixer`, `merge-conflict-resolver`), utilities (`formatter`, `doc-updater`, `test-writer`, `tester`, `staleness-assessor`, `prd-validator`, `dependency-detector`, `pipeline-composer`, `gap-closer`). Note: Eight roles (`builder`, `review-fixer`, `validation-fixer`, `test-writer`, `tester`, `staleness-assessor`, `prd-validator`, `dependency-detector`) default to `balanced`; all others default to `max`. Per-role options: `model`, `modelClass` (override which class the role belongs to: `max`/`balanced`/`fast`), `thinking`, `effort`, `maxBudgetUsd`, `fallbackModel`, `allowedTools`, `disallowedTools`, `maxTurns`, `promptAppend` (text appended to the agent's prompt - useful for project-specific rules like "flag raw SQL queries" for the reviewer). Same rule as section 2: call `eforge_models` before proposing any model ID.
5. **Prompt customization** (opt-in - "Would you like to customize agent prompts?") - `agents.promptDir` points to a directory of `.md` files that shadow bundled prompts by name (e.g. `eforge/prompts/reviewer.md` replaces the built-in reviewer prompt). Per-role `promptAppend` is safer - it appends instructions without replacing the full prompt.
6. **Profiles** - Custom workflow profiles or overrides of built-in profiles (`errand`, `excursion`, `expedition`). A profile defines compile stages only - build stages and review config are per-plan in orchestration.yaml. A profile can `extends` a built-in and override compile stages or agent settings.
7. **Hooks** - Event-driven commands that run on specific eforge events (e.g. `session:start`, `phase:end`). Each hook has `event` (pattern), `command`, and optional `timeout`.
8. **Langfuse tracing** - Whether to enable Langfuse integration (keys are typically set via env vars)
9. **Plugin settings** - Enable/disable plugin loading, include/exclude lists
10. **PRD queue** - Queue directory (`dir`), `autoBuild` (default true - daemon auto-builds after enqueue), `watchPollIntervalMs` (default 5000ms), and top-level `maxConcurrentBuilds` (default 2 - max concurrent PRD builds from the queue)
11. **Daemon** (opt-in - "Would you like to customize daemon behavior?") - `idleShutdownMs` (default 7200000 = 2 hours, set to 0 to run forever)

For each section, explain what it controls and suggest values based on the project context gathered in Step 3. Skip sections the user isn't interested in.

### Step 5: Present Draft

Show the user the complete `eforge/config.yaml` content before writing. Confirm it contains no `backend:` key (that field belongs only in profile files and will fail validation if it appears here). Ask for any changes.

### Step 6: Write

Save to `eforge/config.yaml` in the project root.

### Step 7: Validate

Call the `eforge_config` tool with `{ action: "validate" }`.

If validation returns errors, show them to the user and offer to fix them.

## Edit Mode

### Step 1: Read Current Config

Read the existing `eforge/config.yaml` file and summarize its current settings for the user.

### Step 2: Identify Changes

Ask the user what they want to change. If `$ARGUMENTS` contains additional context beyond `--edit`, use that to understand the desired changes. If the requested change is really about the backend (switching backend kind, provider, or the profile's own model/tuning), stop and redirect them to `/eforge:backend` (switch active profile) or `/eforge:backend:new` (create a new profile) - that configuration does not belong in `eforge/config.yaml`.

### Step 3: Apply Changes

Modify the config based on the user's requests. Present the updated content before writing. If the change involves a model ID anywhere (`agents.models.*`, `agents.model`, per-role `model`), first resolve the active backend by calling `eforge_backend` with `{ action: "show" }`, then call `eforge_models` with `{ action: "list", backend: "<resolved-backend>" }` (and `provider` for Pi) to fetch the live list. Pick from that list; do not suggest model IDs from memory.

### Step 4: Write

Save the updated `eforge/config.yaml`.

### Step 5: Validate

Call the `eforge_config` tool with `{ action: "validate" }`.

If validation returns errors, show them to the user and offer to fix them.

## Show Resolved Config

At any point, you can show the user the fully resolved configuration (all layers merged) by calling:

`eforge_config` with `{ action: "show" }`

This returns the merged result of defaults + global config + project config + active profile.

## Configuration Reference

Available top-level sections in `eforge/config.yaml`. Note: `backend:` and backend-specific sections (`pi:`, `claudeSdk:`) are **not valid here** - they live in backend profile files under `eforge/backends/` or `~/.config/eforge/backends/`.

```yaml
# Queue concurrency
maxConcurrentBuilds: 2                 # Max concurrent PRD builds (default: 2)

# Build settings
build:
  worktreeDir: "../my-worktrees"       # Custom worktree directory
  postMergeCommands:                   # Commands to run after merge
    - pnpm install
    - pnpm type-check
    - pnpm test
  maxValidationRetries: 2              # Retry count for validation fixes
  cleanupPlanFiles: true               # Remove plan files after successful build

# Agent settings
agents:
  maxTurns: 30                         # Global max agent turns
  maxContinuations: 3                  # Max continuation attempts after maxTurns hit
  permissionMode: bypass               # bypass or default
  settingSources:                      # Which settings files agents load
    - project
  bare: false                          # Bare mode
  # --- Model class system ---
  # Model IDs in the examples below are illustrative only. Always call
  # eforge_models with action="list" and the resolved backend
  # (and provider, for Pi) before filling in concrete model IDs.
  # models:                            # Map model classes to model refs
  #   max:
  #     id: <model-id>                 # Claude SDK: { id: "model-name" }
  #   balanced:
  #     id: <model-id>
  #   fast:
  #     id: <model-id>
  # model:                             # Global model override (bypasses class system)
  #   id: <model-id>                   # Pi: { provider: "provider-name", id: "model-name" }
  # thinking:                          # Thinking config
  #   type: adaptive                   # 'adaptive', 'enabled' (+ budgetTokens), or 'disabled'
  # effort: xhigh                      # 'low', 'medium', 'high', 'xhigh', 'max'
  # thinkingLevel: xhigh              # Pi only: 'off', 'low', 'medium', 'high', 'xhigh'
  # --- Prompt customization ---
  # promptDir: eforge/prompts           # Directory of .md files that shadow bundled prompts
  # --- Per-role overrides ---
  # roles:
  #   builder:
  #     model:
  #       id: <model-id>
  #     maxTurns: 50
  #     maxBudgetUsd: 10.0
  #   formatter:
  #     effort: low
  #   staleness-assessor:
  #     modelClass: fast               # Override model class for this role
  #   reviewer:
  #     promptAppend: |                # Append project-specific rules to the prompt
  #       ## Project Rules
  #       - Flag raw SQL queries

# Plan output
plan:
  outputDir: eforge/plans              # Where plan artifacts are written

# Langfuse tracing (keys usually via env vars)
langfuse:
  enabled: false
  host: https://cloud.langfuse.com

# Plugin loading
plugins:
  enabled: true
  include: []                          # Only load these plugins
  exclude: []                          # Skip these plugins
  paths: []                            # Additional plugin paths

# PRD queue
prdQueue:
  dir: eforge/queue
  autoBuild: true                      # Daemon auto-builds after enqueue
  watchPollIntervalMs: 5000            # Poll interval for watch mode (ms)

# Daemon
daemon:
  idleShutdownMs: 7200000              # Idle timeout (2h). 0 = run forever.

# Event hooks
hooks:
  - event: "session:start"
    command: "echo 'Starting eforge session'"
    timeout: 5000

# Workflow profiles (compile stages only - build/review config is per-plan)
profiles:
  my-profile:
    extends: excursion                 # Inherit from a built-in
    description: "Custom profile for my project"
    compile:
      - planner
      - plan-review-cycle
```

## Error Handling

| Condition | Action |
|-----------|--------|
| No active backend profile | Stop and direct the user to `/eforge:init` or `/eforge:backend:new` |
| `eforge_config` validate returns errors | Show errors, offer to fix |
| Validation error mentions `backend:` is not valid here | Remove the key; backend lives in profile files, not `config.yaml` |
| User provides invalid profile stage name | Warn and suggest valid stage names |
| YAML syntax error in existing file | Report the error, offer to recreate |
| Daemon connection failure | The daemon auto-starts; if it still fails, suggest running `eforge daemon start` manually |

## Related Skills

| Skill | Command | When to suggest |
|-------|---------|----------------|
| Init | `eforge_init` | No eforge config found in the project, or no active backend profile |
| Backend | `eforge_backend` | User wants to list, inspect, or switch backend profiles |
| Backend (new) | `/eforge:backend:new` | User wants to create a new backend profile (project or user scope) |
| Build | `eforge_build` | User wants to enqueue work for the daemon to build |
| Plan | `eforge_plan` | User wants to plan changes before building |
| Status | `eforge_status` | User wants to check build progress or queue state |
| Restart | `eforge_restart` | User wants to restart the eforge daemon |
| Update | `eforge_update` | User wants to check for or install eforge updates |
