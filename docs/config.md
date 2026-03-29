# Configuration

`eforge` is configured via `eforge/config.yaml` (searched upward from cwd), environment variables, and auto-discovered files.

## `eforge/config.yaml`

All fields are optional. Defaults are shown:

```yaml
backend: claude-sdk            # 'claude-sdk' or 'pi' - which LLM backend to use

plugins:
  enabled: true               # Auto-discover Claude Code plugins
  # include:                  # Allowlist - only load these (plugin identifiers)
  # exclude:                  # Denylist - skip these from auto-discovery
  # paths:                    # Additional local plugin directories

agents:
  maxTurns: 30                # Max agent turns before stopping
  maxContinuations: 3         # Max continuation attempts after maxTurns hit
  permissionMode: bypass      # 'bypass' or 'default'
  settingSources:             # Which Claude Code settings to load
    - project                 # Loads CLAUDE.md and project settings
  bare: false                 # Pass --bare to Claude Code subprocess (auto-true when ANTHROPIC_API_KEY set)
  # model: claude-sonnet-4-20250514  # Global model override for all agents
  # thinking:                 # Global thinking config
  #   type: adaptive          # 'adaptive', 'enabled' (with optional budgetTokens), or 'disabled'
  # effort: high              # Global effort level: 'low', 'medium', 'high', 'max'
  # roles:                    # Per-agent role overrides (override global settings)
  #   formatter:              # Per-role options: model, thinking, effort, maxBudgetUsd,
  #     effort: low           #   fallbackModel, allowedTools, disallowedTools, maxTurns
  #   builder:                # Available roles: planner, module-planner, builder, reviewer,
  #     model: claude-sonnet-4-20250514  #   evaluator, plan-reviewer, plan-evaluator,
  #     maxTurns: 50          #   architecture-reviewer, architecture-evaluator,
  #                           #   cohesion-reviewer, cohesion-evaluator, validation-fixer,
  #                           #   review-fixer, merge-conflict-resolver, staleness-assessor,
  #                           #   formatter, doc-updater, test-writer, tester

build:
  parallelism: <cpu-count>    # Max parallel plan executions
  maxValidationRetries: 2     # Fix attempts on validation failure (0 = no retries)
  cleanupPlanFiles: true      # Remove plan files after successful build
  # worktreeDir: /custom/path # Override worktree base directory
  # postMergeCommands:        # Extra validation commands
  #   - "pnpm type-check"
  #   - "pnpm test"

plan:
  outputDir: eforge/plans     # Where plan artifacts are written

prdQueue:
  dir: eforge/queue           # Where queued PRDs are stored
  autoRevise: true            # Auto-revise stale PRDs before building
  autoBuild: true             # Daemon automatically builds after enqueue
  watchPollIntervalMs: 5000   # Poll interval for watch mode (ms)

daemon:
  idleShutdownMs: 7200000     # Idle timeout before auto-shutdown (2 hours). Set to 0 to disable.

pi:                            # Pi backend config (experimental/untested)
  provider: openrouter         # LLM provider
  model: anthropic/claude-sonnet-4  # Model identifier
  thinkingLevel: medium        # 'off', 'medium', 'high'
  extensions:
    autoDiscover: true         # Auto-discover extensions from .pi/extensions/
  compaction:
    enabled: true              # Enable context compaction
    threshold: 100000          # Token threshold for compaction
  retry:
    maxRetries: 3              # Max retry attempts
    backoffMs: 1000            # Backoff between retries (ms)
```

## Profiles

Workflow profiles control which compile stages run. Built-in profiles (`errand`, `excursion`, `expedition`) cover the common cases - define custom profiles in `eforge/config.yaml` or via `--profiles` files to extend or override them.

```yaml
profiles:
  my-profile:
    description: "Custom workflow with extra review"
    extends: excursion          # Inherit from a built-in or other custom profile
    compile:
      - planner
      - plan-review-cycle
```

Build stages and review config are per-plan, determined by the planner during compile and stored in `orchestration.yaml` - profiles only control compile stages.

## MCP Servers

MCP servers are auto-loaded from `.mcp.json` in the project root (same format Claude Code uses). All `eforge` agents receive the same MCP servers.

## Pi Backend

Set `backend: pi` to use the Pi multi-provider backend instead of the Claude SDK. The Pi backend requires a `PI_API_KEY` environment variable (or a provider-specific API key, e.g. `OPENROUTER_API_KEY` for the default OpenRouter provider). Configure provider, model, and other Pi-specific settings in the `pi` section of `eforge/config.yaml`. Note: the Pi backend is experimental and untested.

## Plugins

Plugins are auto-discovered from `~/.claude/plugins/installed_plugins.json`. Both user-scoped and project-scoped plugins matching the working directory are loaded. Use `plugins.include`/`plugins.exclude` in `eforge/config.yaml` to filter, or `--no-plugins` to disable entirely.

## Hooks

Hooks are fire-and-forget shell commands triggered by `eforge` events - useful for logging, notifications, and external system integration. They do not block or influence the pipeline. See [hooks.md](hooks.md) for configuration and details.

## Config Layers

Config merges from two levels (lowest to highest priority):

1. **Global** - `~/.config/eforge/config.yaml` (respects `$XDG_CONFIG_HOME`)
2. **Project** - `eforge/config.yaml` found by walking up from cwd

Object sections (`langfuse`, `agents`, `build`, `plan`, `plugins`, `prdQueue`, `daemon`, `pi`) shallow-merge per-field. `hooks` arrays concatenate (global fires first). Arrays inside objects (like `postMergeCommands`) replace rather than merge. CLI flags and environment variables override everything.
