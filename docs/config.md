# Configuration

`eforge` is configured via `eforge/config.yaml` (searched upward from cwd), environment variables, and auto-discovered files.

## `eforge/config.yaml`

The `backend` field is required. All other fields are optional with defaults shown below:

```yaml
backend: claude-sdk            # REQUIRED - 'claude-sdk' or 'pi'

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
  # model: claude-sonnet-4-6          # Global model override for all agents (bypasses class system)
  # thinking:                 # Global thinking config
  #   type: adaptive          # 'adaptive', 'enabled' (with optional budgetTokens), or 'disabled'
  # effort: high              # Global effort level: 'low', 'medium', 'high', 'max'
  # models:                    # Map model classes to model strings (override backend defaults)
  #   max: claude-opus-4-6    # Used by all roles by default
  #   balanced: claude-sonnet-4-6  # Available via per-role modelClass override
  #   fast: claude-haiku-4-5  # Available via per-role modelClass override
  #   auto: null              # Let the SDK choose the model
  # roles:                    # Per-agent role overrides (override global settings)
  #   formatter:              # Per-role options: model, modelClass, thinking, effort, maxBudgetUsd,
  #     effort: low           #   fallbackModel, allowedTools, disallowedTools, maxTurns
  #   builder:                # Available roles: planner, module-planner, builder, reviewer,
  #     model: claude-sonnet-4-6     #   evaluator, plan-reviewer, plan-evaluator,
  #     maxTurns: 50          #   architecture-reviewer, architecture-evaluator,
  #   staleness-assessor:     #   cohesion-reviewer, cohesion-evaluator, validation-fixer,
  #     modelClass: fast      #   review-fixer, merge-conflict-resolver, staleness-assessor,
  #                           #   formatter, doc-updater, test-writer, tester,
  #                           #   prd-validator, dependency-detector, gap-closer

maxConcurrentBuilds: 2        # Max concurrent PRD builds from the queue (default: 2)

build:
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
  autoBuild: true             # Daemon automatically builds after enqueue
  watchPollIntervalMs: 5000   # Poll interval for watch mode (ms)

daemon:
  idleShutdownMs: 7200000     # Idle timeout before auto-shutdown (2 hours). Set to 0 to disable.

monitor:
  retentionCount: 20          # Number of recent builds to retain in the monitor DB (oldest pruned)

pi:                            # Pi backend config (experimental/untested)
  provider: openrouter         # REQUIRED for pi backend - LLM provider (e.g. 'openrouter', 'anthropic', 'openai-codex')
  # apiKey: ...                # Optional API key override (env vars and ~/.pi/agent/auth.json used automatically)
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

## Model Classes

eforge assigns each agent role a **model class** that determines which model it uses by default. All roles default to `max`. Four classes exist:

| Class | Default model (claude-sdk) | Notes |
|-------|---------------------------|-------|
| `max` | `claude-opus-4-6` | All roles default to this class |
| `balanced` | `claude-sonnet-4-6` | Available via per-role `modelClass` override for cost optimization |
| `fast` | `claude-haiku-4-5` | Available via per-role `modelClass` override for lightweight tasks |
| `auto` | (SDK default) | Lets the backend choose the model |

The Pi backend has no built-in class defaults - users must configure `agents.models.max` at minimum (and any other classes they assign to roles). The engine throws a descriptive error if no model resolves for a non-claude-sdk backend.

### Model Resolution Order

Model selection follows this priority chain (highest to lowest):

1. **Per-role `model`** - `agents.roles.<role>.model` - explicit model string for a specific role
2. **Global `model`** - `agents.model` - explicit model string for all roles
3. **User class override** - `agents.models.<class>` - custom model for the role's effective class
4. **Backend class default** - built-in model for the class (see table above)

The "effective class" for a role is determined by: per-role `modelClass` override > built-in class assignment.

```yaml
# Example: downgrade some roles to cheaper models
agents:
  models:
    balanced: claude-sonnet-4-6    # Define what 'balanced' class maps to
    fast: claude-haiku-4-5         # Define what 'fast' class maps to
  roles:
    builder:
      modelClass: balanced         # Move builder from 'max' to 'balanced' class
    formatter:
      modelClass: fast             # Move formatter to 'fast' class
    staleness-assessor:
      model: claude-haiku-4-5     # Explicit model - bypasses the class system entirely
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

Set `backend: pi` to use the Pi multi-provider backend instead of the Claude SDK. The Pi backend uses file-backed auth storage (`~/.pi/agent/auth.json`) which supports API keys, environment variables, and OAuth tokens automatically. Configure provider, model, and other Pi-specific settings in the `pi` section of `eforge/config.yaml`. Note: the Pi backend is experimental and untested.

### Authentication

Pi resolves credentials in this order:

1. **Explicit override** - `pi.apiKey` in `eforge/config.yaml` (highest priority)
2. **Environment variables** - Provider-specific env vars (e.g. `OPENROUTER_API_KEY`, `OPENAI_API_KEY`)
3. **Auth file** - `~/.pi/agent/auth.json` - supports both API keys and OAuth tokens

The `pi.apiKey` config option is optional. Most users should rely on environment variables or the auth file.

### OAuth Providers

Providers like `openai-codex` and `github-copilot` use OAuth for authentication. To set up an OAuth provider:

1. Run `pi auth login <provider>` to authenticate (this writes tokens to `~/.pi/agent/auth.json`)
2. Set `pi.provider` to the OAuth provider name in `eforge/config.yaml`
3. No `pi.apiKey` or environment variable is needed - tokens are read from the auth file automatically

## Plugins

Plugins are auto-discovered from `~/.claude/plugins/installed_plugins.json`. Both user-scoped and project-scoped plugins matching the working directory are loaded. Use `plugins.include`/`plugins.exclude` in `eforge/config.yaml` to filter, or `--no-plugins` to disable entirely.

## Hooks

Hooks are fire-and-forget shell commands triggered by `eforge` events - useful for logging, notifications, and external system integration. They do not block or influence the pipeline. See [hooks.md](hooks.md) for configuration and details.

## Config Layers

Config merges from two levels (lowest to highest priority):

1. **Global** - `~/.config/eforge/config.yaml` (respects `$XDG_CONFIG_HOME`)
2. **Project** - `eforge/config.yaml` found by walking up from cwd

Object sections (`langfuse`, `agents`, `build`, `plan`, `plugins`, `prdQueue`, `daemon`, `monitor`, `pi`) shallow-merge per-field. Scalar top-level fields like `maxConcurrentBuilds` override. `hooks` arrays concatenate (global fires first). Arrays inside objects (like `postMergeCommands`) replace rather than merge. CLI flags and environment variables override everything.

## Parallelism

eforge has two dimensions of parallelism:

### Queue concurrency (`maxConcurrentBuilds`)

Controls the maximum number of PRDs built concurrently when processing the queue (`eforge build --queue` or `eforge queue run`). Default: `2`.

PRDs with `depends_on` frontmatter wait for their dependencies to complete before starting. If a dependency fails, all transitive dependents are marked as blocked and skipped.

CLI override: `--max-concurrent-builds <n>`

```yaml
maxConcurrentBuilds: 3    # Build up to 3 PRDs concurrently
```

### Plan execution

Within a single build, plans run as soon as their dependencies are met. Since plan execution is IO-bound (LLM calls), no throttle is needed - all ready plans launch immediately. This is automatic and requires no configuration.

### Enqueuing

Enqueuing is always single-threaded. The formatter processes one PRD at a time before adding it to the queue. No configuration is needed or available.
