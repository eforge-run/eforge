# Configuration

`eforge` is configured via `eforge/config.yaml` (searched upward from cwd), environment variables, and auto-discovered files.

## `eforge/config.yaml`

> **Upgrading from pre-overhaul `eforge.yaml`:** Earlier versions of eforge stored configuration at `eforge.yaml` in the project root. This path is no longer supported. If you have a legacy `eforge.yaml`, move it with:
> ```
> mkdir -p eforge && mv eforge.yaml eforge/config.yaml
> ```
> Running eforge without migrating now aborts with a clear `ConfigMigrationError`.

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
  # model:                             # Global model override for all agents (bypasses class system)
  #   id: claude-sonnet-4-6            #   Shape: { id: "model-name" } - provider lives on the agentRuntime entry
  # thinking:                 # Global thinking config
  #   type: adaptive          # 'adaptive', 'enabled' (with optional budgetTokens), or 'disabled'
  # effort: high              # Global effort level: 'low', 'medium', 'high', 'xhigh', 'max'
  # models:                    # Map model classes to model refs (override backend defaults)
  #   max:                     # Used by most roles by default
  #     id: claude-opus-4-7
  #   balanced:                # Default for builder, review-fixer, validation-fixer, test-writer, tester, staleness-assessor, prd-validator, dependency-detector, recovery-analyst
  #     id: claude-sonnet-4-6
  #   fast:                    # Available via per-role modelClass override
  #     id: claude-haiku-4-5
  # promptDir: eforge/prompts  # Directory of .md files that shadow bundled prompts by name match.
  #                            # If eforge/prompts/reviewer.md exists, it replaces the bundled reviewer prompt.
  # tiers:                    # Per-tier overrides applied to every role in the tier
  #   planning:               # Tiers: planning, implementation, review, evaluation
  #     effort: high          #   - Most users only need to set tiers, not 24 individual roles
  #     modelClass: max
  #   implementation:
  #     effort: medium
  #     modelClass: balanced
  #   review:
  #     effort: high
  #     modelClass: max
  #   evaluation:
  #     effort: low           #   Evaluators only judge fixes; low effort is sufficient
  #     modelClass: max
  # roles:                    # Per-agent role overrides (override tier and global settings)
  #   formatter:              # Per-role options: model, modelClass, thinking, effort, maxBudgetUsd,
  #     effort: low           #   fallbackModel, allowedTools, disallowedTools, maxTurns, promptAppend
  #   builder:                # Available roles: planner, module-planner, builder, reviewer,
  #     model:                #   evaluator, plan-reviewer, plan-evaluator,
  #       id: claude-sonnet-4-6
  #     maxTurns: 50          #   architecture-reviewer, architecture-evaluator,
  #   staleness-assessor:     #   cohesion-reviewer, cohesion-evaluator, validation-fixer,
  #     modelClass: fast      #   review-fixer, merge-conflict-resolver, staleness-assessor,
  #   reviewer:               #   formatter, doc-updater, test-writer, tester,
  #     promptAppend: |       #   prd-validator, dependency-detector, gap-closer,
  #       ## Project Rules    #   recovery-analyst
  #       - Flag raw SQL queries
  #   tester:                 # Per-role `tier:` reassigns a role to a different tier
  #     tier: review          #   so it picks up the review tier's defaults instead of implementation

maxConcurrentBuilds: 2        # Max concurrent PRD builds from the queue (default: 2)

build:
  maxValidationRetries: 2     # Fix attempts on validation failure (0 = no retries)
  cleanupPlanFiles: true      # Remove plan files after successful build
  # worktreeDir: /custom/path # Override worktree base directory
  # postMergeCommandTimeoutMs: 300000  # Per-command timeout (ms) for postMerge/validate commands (default: 300000, floor: 10000)
  # postMergeCommands:        # Extra validation commands
  #   - "pnpm type-check"
  #   - "pnpm test"

Each command in `postMergeCommands` and the planner-generated validate commands runs under a wall-clock timeout. On expiry the full subprocess tree is killed and the validation-fixer loop is invoked as if the command had exited non-zero. Default 300000 ms (5 minutes). Values below 10000 ms are clamped and emit a `config:warning` event.

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

pi:                            # Pi backend config
  # apiKey: ...                # Optional API key override (env vars and ~/.pi/agent/auth.json used automatically)
  thinkingLevel: medium        # 'off', 'low', 'medium', 'high', 'xhigh'
  extensions:
    autoDiscover: true         # Auto-discover extensions from .pi/extensions/
  compaction:
    enabled: true              # Enable context compaction
    threshold: 100000          # Token threshold for compaction
  retry:
    maxRetries: 3              # Max retry attempts
    backoffMs: 1000            # Backoff between retries (ms)

claudeSdk:                     # Claude SDK backend config (ignored under backend: pi)
  disableSubagents: false      # When true, the `Task` tool is disallowed on every agent run
                               #   so agents cannot spawn subagents.
```

## Model References

Model references are **objects**, not plain strings. The shape is the same regardless of harness:

- `{ id: "model-name" }` - e.g. `{ id: claude-sonnet-4-6 }` or `{ id: anthropic/claude-opus-4-6 }`

For the Pi harness, the provider is **not** part of the model ref. Provider selection is a property of the runtime/harness binding and lives on the agentRuntime entry under `agentRuntimes.<name>.pi.provider`. The resolver splices the runtime's provider onto the resolved model at run time.

> **Migration note:** String model refs (e.g. `model: claude-sonnet-4-6`) are no longer valid. Use the object form instead. The `provider:` field on a model ref is also no longer accepted - move it to `agentRuntimes.<name>.pi.provider`.

## Model Classes

eforge uses a three-tier model class system to assign models to agent roles. Each role has a default class, and users can override it via configuration.

| Class | Default model ref (claude-sdk) | Notes |
|-------|-------------------------------|-------|
| `max` | `{ id: claude-opus-4-7 }` | Most capable - used by 15 of 24 roles |
| `balanced` | `{ id: claude-sonnet-4-6 }` | Mid-tier - used by 9 of 24 roles that don't need max capability |
| `fast` | `{ id: claude-haiku-4-5 }` | Lightweight - available via per-role `modelClass` override |

The Pi backend has no built-in class defaults - users must configure `agents.models.max` at minimum (and any other classes they assign to roles) using `{ id }` model refs. The provider is taken from the active `agentRuntime` entry's `pi.provider`, not from the model ref.

### Per-Role Default Model Classes

Each of the 24 agent roles has a built-in default model class:

| Role | Default Class | Category |
|------|--------------|----------|
| `planner` | `max` | Planning |
| `module-planner` | `max` | Planning |
| `builder` | `balanced` | Building |
| `reviewer` | `max` | Review/Eval |
| `evaluator` | `max` | Review/Eval |
| `plan-reviewer` | `max` | Review/Eval |
| `plan-evaluator` | `max` | Review/Eval |
| `architecture-reviewer` | `max` | Review/Eval |
| `architecture-evaluator` | `max` | Review/Eval |
| `cohesion-reviewer` | `max` | Review/Eval |
| `cohesion-evaluator` | `max` | Review/Eval |
| `validation-fixer` | `balanced` | Fixers |
| `review-fixer` | `balanced` | Fixers |
| `merge-conflict-resolver` | `max` | Fixers |
| `formatter` | `max` | Utilities |
| `doc-updater` | `max` | Utilities |
| `test-writer` | `balanced` | Utilities |
| `tester` | `balanced` | Utilities |
| `pipeline-composer` | `max` | Utilities |
| `gap-closer` | `max` | Utilities |
| `staleness-assessor` | `balanced` | Utilities |
| `prd-validator` | `balanced` | Utilities |
| `dependency-detector` | `balanced` | Utilities |

### Model Resolution Order

Model selection follows this priority chain (highest to lowest):

1. **Per-role `model`** - `agents.roles.<role>.model` - explicit model ref for a specific role
2. **Global `model`** - `agents.model` - explicit model ref for all roles
3. **User class override** - `agents.models.<class>` - custom model ref for the role's effective class
4. **Backend class default** - built-in model ref for the class (see table above)
5. **Fallback chain** - if the effective class has no configured model (neither user nor backend default), walk tiers to find one (see below)

The "effective class" for a role is determined by: per-role `modelClass` override > built-in class assignment.

### Fallback Chain

When a role's effective model class has no configured model (no user override and no backend default), eforge walks the tier list to find a usable model. The tier order is `max` > `balanced` > `fast`.

The algorithm:
1. Start at the role's effective class
2. Walk **ascending** toward more capable tiers (e.g. `balanced` -> `max`)
3. If no model found ascending, walk **descending** toward less capable tiers (e.g. `balanced` -> `fast`)
4. If no model found in any tier, throw a descriptive error (non-claude-sdk backends only; the Claude SDK falls back to its own default)

**Example 1: Pi backend with only `max` configured**

```yaml
agentRuntimes:
  default:
    harness: pi
    pi:
      provider: openrouter
defaultAgentRuntime: default
agents:
  models:
    max:
      id: anthropic/claude-opus-4-6
```

The `staleness-assessor` role defaults to `balanced`, but no `balanced` model is configured. The fallback chain walks ascending from `balanced` to `max` and finds the configured model. All 23 roles resolve to `anthropic/claude-opus-4-6` on the `openrouter` provider.

**Example 2: Pi backend with `balanced` and `fast` configured**

```yaml
agentRuntimes:
  default:
    harness: pi
    pi:
      provider: openrouter
defaultAgentRuntime: default
agents:
  models:
    balanced:
      id: anthropic/claude-sonnet-4-6
    fast:
      id: anthropic/claude-haiku-4-5
```

Roles defaulting to `max` (like `reviewer`) find no `max` model configured. The fallback walks descending from `max` to `balanced` and resolves to `anthropic/claude-sonnet-4-6`. Roles defaulting to `balanced` (like `staleness-assessor`) resolve directly. No role uses the `fast` model unless explicitly assigned via `modelClass`.

```yaml
# Example: downgrade some roles to cheaper models (claude-sdk backend)
agents:
  models:
    balanced:                          # Define what 'balanced' class maps to
      id: claude-sonnet-4-6
    fast:                              # Define what 'fast' class maps to
      id: claude-haiku-4-5
  roles:
    reviewer:
      modelClass: balanced             # Move reviewer from 'max' to 'balanced' class
    formatter:
      modelClass: fast                 # Move formatter to 'fast' class
    staleness-assessor:
      model:                           # Explicit model ref - bypasses the class system entirely
        id: claude-haiku-4-5
```

```yaml
# Example: Pi backend with multiple named runtimes for cross-provider routing
agentRuntimes:
  default:
    harness: pi
    pi:
      provider: openrouter
  gemini:
    harness: pi
    pi:
      provider: google
defaultAgentRuntime: default
agents:
  models:
    max:
      id: anthropic/claude-opus-4-6
    balanced:
      id: anthropic/claude-sonnet-4-6
  roles:
    staleness-assessor:
      agentRuntime: gemini       # Route this role to the gemini runtime
      model:
        id: gemini-flash
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

## Claude SDK Backend

The `claudeSdk:` block holds options that are only meaningful when `backend: claude-sdk`. When a Pi profile is active the block is ignored.

- **`disableSubagents: true`** appends `'Task'` to every agent run's `disallowedTools`, preventing agents from spawning Claude Code subagents. Useful when you want a single-agent trace (e.g. for debugging, cost control, or determinism) instead of letting a role fan out into Task-spawned helpers. Per-role `agents.roles.<role>.disallowedTools` values are preserved; `'Task'` is appended to them (de-duplicated).

The Pi backend has no `Task` tool or subagent concept, so this flag has no Pi equivalent.

```yaml
backend: claude-sdk
claudeSdk:
  disableSubagents: true
```

## Pi Backend

Declare an `agentRuntimes` entry with `harness: pi` (and set it as `defaultAgentRuntime` or assign it per-role/tier) to use the Pi multi-provider backend instead of the Claude SDK. The Pi backend uses file-backed auth storage (`~/.pi/agent/auth.json`) which supports API keys, environment variables, and OAuth tokens automatically. Configure model refs (using `{ id }` form) via `agents.models.*` or `agents.model`, declare the provider on the runtime entry as `agentRuntimes.<name>.pi.provider`, and put any other Pi-specific settings under that runtime entry's `pi:` block. The Pi backend supports the same compile/build pipeline as the Claude SDK backend.

### Authentication

Pi resolves credentials in this order:

1. **Explicit override** - `pi.apiKey` in `eforge/config.yaml` (highest priority)
2. **Environment variables** - Provider-specific env vars (e.g. `OPENROUTER_API_KEY`, `OPENAI_API_KEY`)
3. **Auth file** - `~/.pi/agent/auth.json` - supports both API keys and OAuth tokens

The `pi.apiKey` config option is optional. Most users should rely on environment variables or the auth file.

### OAuth Providers

Providers like `openai-codex` and `github-copilot` use OAuth for authentication. To set up an OAuth provider:

1. Run `pi auth login <provider>` to authenticate (this writes tokens to `~/.pi/agent/auth.json`)
2. Set the provider on the agentRuntime entry - e.g. `agentRuntimes.default.pi.provider: openai-codex` - and use a plain `{ id: codex-mini }` model ref
3. No `pi.apiKey` or environment variable is needed - tokens are read from the auth file automatically

## Backend Profiles

Backend profiles are named YAML files that bundle backend kind, provider, model selections, and tuning into a reusable unit. Profiles can be defined at project scope or user scope.

### User-Scoped Profiles

User-scoped profiles live at `~/.config/eforge/backends/<name>.yaml` (respects `$XDG_CONFIG_HOME`). They are not committed to the project repository and are reusable across all projects on the machine.

The user-scope active-backend marker lives at `~/.config/eforge/.active-backend`.

### Active Profile Precedence

The active agent runtime profile is resolved using a 6-step precedence chain (highest to lowest):

1. **Project-local marker** - `.eforge/.active-profile` file in the repo root (gitignored)
2. **Project marker** - `eforge/.active-profile` file in the project
3. **Project config** - `defaultAgentRuntime:` field in `eforge/config.yaml`
4. **User marker** - `~/.config/eforge/.active-profile` file
5. **User config** - `defaultAgentRuntime:` field in `~/.config/eforge/config.yaml`
6. **None** - no profile configured

When a profile name is resolved, the profile file is looked up local-first, then project, then user-fallback. A local profile shadows project and user profiles with the same name.

### Scope Parameter

The `scope` parameter is available on `create`, `use`, and `delete` operations:

- `scope: "local"` - operates on `.eforge/profiles/` and `.eforge/.active-profile` (gitignored, dev-personal)
- `scope: "project"` (default) - operates on `eforge/profiles/` and `eforge/.active-profile`
- `scope: "user"` - operates on `~/.config/eforge/profiles/` and `~/.config/eforge/.active-profile`

When listing profiles, all three scopes are shown. Entries shadowed by a higher-priority profile of the same name are annotated with `shadowedBy: local` or `shadowedBy: project`.

## Plugins

Plugins are auto-discovered from `~/.claude/plugins/installed_plugins.json`. Both user-scoped and project-scoped plugins matching the working directory are loaded. Use `plugins.include`/`plugins.exclude` in `eforge/config.yaml` to filter, or `--no-plugins` to disable entirely.

## Hooks

Hooks are fire-and-forget shell commands triggered by `eforge` events - useful for logging, notifications, and external system integration. They do not block or influence the pipeline. See [hooks.md](hooks.md) for configuration and details.

## Config Layers

Config merges from three levels (lowest to highest priority):

1. **Global** - `~/.config/eforge/config.yaml` (respects `$XDG_CONFIG_HOME`)
2. **Project** - `eforge/config.yaml` found by walking up from cwd
3. **Project-local** - `.eforge/config.yaml` in the repo root (gitignored; highest priority)

Object sections (`langfuse`, `agents`, `build`, `plan`, `plugins`, `prdQueue`, `daemon`, `monitor`, `pi`) shallow-merge per-field. Scalar top-level fields like `maxConcurrentBuilds` override. `hooks` arrays concatenate (global fires first). Arrays inside objects (like `postMergeCommands`) replace rather than merge. CLI flags and environment variables override everything.

Agent runtime profiles follow the same three-level pattern. Profile files can exist at project-local scope (`.eforge/profiles/` - gitignored), project scope (`eforge/profiles/`), or user scope (`~/.config/eforge/profiles/`). The active-profile marker can be set at any level: `.eforge/.active-profile` (project-local, highest precedence), `eforge/.active-profile` (project), or `~/.config/eforge/.active-profile` (user). Active profile resolution walks a 6-step precedence: (1) project-local marker, (2) project marker, (3) project config `defaultAgentRuntime:` field, (4) user marker, (5) global config `defaultAgentRuntime:` field, (6) none. When a profile name is resolved, the profile file is looked up local-first, then project, then user-fallback - so a local profile shadows project and user profiles with the same name.

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
