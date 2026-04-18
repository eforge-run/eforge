---
name: eforge-config
description: Initialize or edit eforge/config.yaml configuration, with validation via daemon tools
disable-model-invocation: true
---

> **Note:** In Pi, the native `/eforge:config` command provides a richer interactive experience with a structured config viewer overlay. This skill serves as a fallback for non-interactive contexts and as model-readable documentation.

# /eforge:config

Create or modify an `eforge/config.yaml` configuration file interactively. Supports two modes - init for new projects and edit for existing configs. Validation uses the eforge daemon.

## Mode Detection

Determine the mode from arguments and file state:

1. If `$ARGUMENTS` contains `--init`, use **init mode**
2. If `$ARGUMENTS` contains `--edit`, use **edit mode**
3. If `eforge/config.yaml` exists in the project root, use **edit mode**
4. Otherwise, use **init mode**

## Init Mode

### Step 1: Check Existence

If `eforge/config.yaml` already exists, ask the user whether they want to switch to edit mode or overwrite. Respect their choice.

### Step 2: Gather Context

Read project context to understand the codebase:

- **AGENTS.md / CLAUDE.md** - Project overview, tech stack, build commands
- **package.json** or equivalent - Dependencies, scripts
- **Project structure** - Scan top-level directories

Share a brief summary of what you found.

### Step 3: Interview

Walk the user through configuration sections, asking about each one. Only include sections where the user wants non-default behavior.

**Sections to cover:**

1. **Backend selection** (required) - Which LLM backend: `claude-sdk` (uses Claude Code's built-in SDK) or `pi` (multi-provider via Pi SDK supporting OpenRouter, Anthropic, OpenAI, Google, etc.). Note: for richer backend management (named profiles with bundled model/tuning config, project or user scope), see `/eforge:backend:new`. The `backend:` field here acts as the project config fallback in the 5-step active profile precedence.
2. **Build settings** - `postMergeCommands` (validation commands to run after merging worktrees, e.g. `pnpm install`, `pnpm type-check`, `pnpm test`), `maxValidationRetries`
3. **Model & thinking tuning** (opt-in - "Would you like to customize model or thinking settings? Most users keep defaults.") - Model references are objects: `{ id: "model-name" }` for Claude SDK, `{ provider: "provider-name", id: "model-name" }` for Pi. Model class overrides via `agents.models` (map class names `max`/`balanced`/`fast` to model ref objects), global `agents.model` override (bypasses class system), `agents.thinking` config (`adaptive`, `enabled` with optional `budgetTokens`, or `disabled`), `agents.effort` level (`low`/`medium`/`high`/`xhigh`/`max`). Model resolution order: per-role model > global model > user class override > backend class default > fallback chain. Three roles (`staleness-assessor`, `prd-validator`, `dependency-detector`) default to `balanced`; all others default to `max`. If a role's model class has no configured model, eforge walks up to more capable tiers, then down, before erroring. For `pi`, users should set at least `agents.models.max` (or `agents.model`) with `{ provider, id }` refs because Pi has no built-in model class defaults.
4. **Agent behavior** - Global `maxTurns`, `maxContinuations` (default 3 - max continuation attempts after maxTurns hit), `permissionMode` (`bypass` or `default`), `settingSources`, `bare` (default false)
5. **Per-role agent overrides** (opt-in - "Would you like to tune specific agent roles differently? Most users skip this.") - Override settings per agent role. Available roles grouped: planning (`planner`, `module-planner`), building (`builder`), review/eval (`reviewer`, `evaluator`, `plan-reviewer`, `plan-evaluator`, `architecture-reviewer`, `architecture-evaluator`, `cohesion-reviewer`, `cohesion-evaluator`), fixers (`validation-fixer`, `review-fixer`, `merge-conflict-resolver`), utilities (`formatter`, `doc-updater`, `test-writer`, `tester`, `staleness-assessor`, `prd-validator`, `dependency-detector`, `pipeline-composer`, `gap-closer`). Note: `staleness-assessor`, `prd-validator`, and `dependency-detector` default to `balanced`; all others default to `max`. Per-role options: `model`, `modelClass` (override which class the role belongs to: `max`/`balanced`/`fast`), `thinking`, `effort`, `maxBudgetUsd`, `fallbackModel`, `allowedTools`, `disallowedTools`, `maxTurns`, `promptAppend` (text appended to the agent's prompt - useful for project-specific rules like "flag raw SQL queries" for the reviewer).
6. **Prompt customization** (opt-in - "Would you like to customize agent prompts?") - `agents.promptDir` points to a directory of `.md` files that shadow bundled prompts by name (e.g. `eforge/prompts/reviewer.md` replaces the built-in reviewer prompt). Per-role `promptAppend` is safer - it appends instructions without replacing the full prompt.
7. **Profiles** - Custom workflow profiles or overrides of built-in profiles (`errand`, `excursion`, `expedition`). A profile defines compile stages only - build stages and review config are per-plan in orchestration.yaml. A profile can `extends` a built-in and override compile stages or agent settings.
8. **Hooks** - Event-driven commands that run on specific eforge events (e.g. `session:start`, `phase:end`). Each hook has `event` (pattern), `command`, and optional `timeout`.
9. **Langfuse tracing** - Whether to enable Langfuse integration (keys are typically set via env vars)
10. **Plugin settings** - Enable/disable plugin loading, include/exclude lists
11. **PRD queue** - Queue directory (`dir`), `autoBuild` (default true - daemon auto-builds after enqueue), `watchPollIntervalMs` (default 5000ms), and top-level `maxConcurrentBuilds` (default 2 - max concurrent PRD builds from the queue)
12. **Daemon** (opt-in - "Would you like to customize daemon behavior?") - `idleShutdownMs` (default 7200000 = 2 hours, set to 0 to run forever)
13. **Pi backend** (conditional - only if user chose `backend: pi` in step 1) - `thinkingLevel` (`off`/`low`/`medium`/`high`/`xhigh`), `extensions` (auto-discover from `.pi/extensions/`), `compaction` (context compaction threshold), and `retry` config. Authentication usually comes from env vars or `~/.pi/agent/auth.json`. Model selection uses `agents.model` or `agents.models.*` with `{ provider, id }` refs (provider is part of each model ref, not a separate config field).

For each section, explain what it controls and suggest values based on the project context gathered in Step 2. Skip sections the user isn't interested in.

### Step 4: Present Draft

Show the user the complete `eforge/config.yaml` content before writing. Ask for any changes.

### Step 5: Write

Save to `eforge/config.yaml` in the project root.

### Step 6: Validate

Call the `eforge_config` tool with `{ action: "validate" }`.

If validation returns errors, show them to the user and offer to fix them.

## Edit Mode

### Step 1: Read Current Config

Read the existing `eforge/config.yaml` file and summarize its current settings for the user.

### Step 2: Identify Changes

Ask the user what they want to change. If `$ARGUMENTS` contains additional context beyond `--edit`, use that to understand the desired changes.

### Step 3: Apply Changes

Modify the config based on the user's requests. Present the updated content before writing.

### Step 4: Write

Save the updated `eforge/config.yaml`.

### Step 5: Validate

Call the `eforge_config` tool with `{ action: "validate" }`.

If validation returns errors, show them to the user and offer to fix them.

## Show Resolved Config

At any point, you can show the user the fully resolved configuration (all layers merged) by calling:

`eforge_config` with `{ action: "show" }`

This returns the merged result of defaults + global config + project config.

## Configuration Reference

Available top-level sections in `eforge/config.yaml`:

```yaml
# Backend
backend: claude-sdk                    # REQUIRED - 'claude-sdk' or 'pi'

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
  # models:                            # Map model classes to model refs
  #   max:
  #     id: claude-opus-4-7            # Claude SDK: { id: "model-name" }
  #   balanced:
  #     id: claude-sonnet-4-6
  #   fast:
  #     id: claude-haiku-4-5
  # model:                             # Global model override (bypasses class system)
  #   id: claude-sonnet-4-6            # Pi: { provider: "provider-name", id: "model-name" }
  # thinking:                          # Thinking config
  #   type: adaptive                   # 'adaptive', 'enabled' (+ budgetTokens), or 'disabled'
  # effort: high                       # 'low', 'medium', 'high', 'xhigh', 'max'
  # --- Prompt customization ---
  # promptDir: eforge/prompts           # Directory of .md files that shadow bundled prompts
  # --- Per-role overrides ---
  # roles:
  #   builder:
  #     model:
  #       id: claude-sonnet-4-6
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

# Pi backend (only used when backend: pi)
# pi:
#   thinkingLevel: medium              # 'off', 'low', 'medium', 'high', 'xhigh'
#   extensions:
#     autoDiscover: true
#   compaction:
#     enabled: true
#     threshold: 100000
#   retry:
#     maxRetries: 3
#     backoffMs: 1000
#
# For Pi, configure models under agents.model or agents.models.* with { provider, id } refs:
# agents:
#   models:
#     max:
#       provider: openrouter
#       id: anthropic/claude-opus-4-6
```

## Error Handling

| Condition | Action |
|-----------|--------|
| `eforge_config` validate returns errors | Show errors, offer to fix |
| User provides invalid profile stage name | Warn and suggest valid stage names |
| YAML syntax error in existing file | Report the error, offer to recreate |
| Daemon connection failure | The daemon auto-starts; if it still fails, suggest running `eforge daemon start` manually |

## Related Skills

| Skill | Command | When to suggest |
|-------|---------|----------------|
| Init | `eforge_init` | No eforge config found in the project |
| Backend | `/eforge:backend` | User wants to list, inspect, or switch backend profiles |
| Backend (new) | `/eforge:backend:new` | User wants to create a new backend profile (project or user scope) |
| Build | `eforge_build` | User wants to enqueue work for the daemon to build |
| Plan | `eforge_plan` | User wants to plan changes before building |
| Status | `eforge_status` | User wants to check build progress or queue state |
| Restart | `eforge_restart` | User wants to restart the eforge daemon |
| Update | `eforge_update` | User wants to check for or install eforge updates |
