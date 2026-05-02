# Configuration

`eforge` is configured via `eforge/config.yaml` (searched upward from cwd), environment variables, and auto-discovered files.

## `eforge/config.yaml`

> **Upgrading from pre-overhaul `eforge.yaml`:** Earlier versions of eforge stored configuration at `eforge.yaml` in the project root. This path is no longer supported. If you have a legacy `eforge.yaml`, move it with:
> ```
> mkdir -p eforge && mv eforge.yaml eforge/config.yaml
> ```
> Running eforge without migrating now aborts with a clear `ConfigMigrationError`.

All fields are optional with defaults shown below:

```yaml
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
  # promptDir: eforge/prompts  # Directory of .md files that shadow bundled prompts by name match.
  #                            # If eforge/prompts/reviewer.md exists, it replaces the bundled reviewer prompt.
  # tiers:                    # Per-tier recipes — each tier is a self-contained harness + model + effort unit
  #   planning:               # Four built-in tiers: planning, implementation, review, evaluation
  #     harness: claude-sdk   #   harness: 'claude-sdk' or 'pi'
  #     model: claude-opus-4-7 #  model: plain string model identifier
  #     effort: high          #   effort: 'low', 'medium', 'high', 'xhigh', 'max'
  #     # thinking: true      #   Optional: enable thinking; coerced to adaptive for adaptive-only models
  #     # pi:                 #   Pi-specific sub-block (ignored unless harness: pi)
  #     #   provider: openrouter
  #     # claudeSdk:          #   Claude SDK-specific sub-block (ignored unless harness: claude-sdk)
  #     #   disableSubagents: false
  #   implementation:
  #     harness: claude-sdk
  #     model: claude-sonnet-4-6
  #     effort: medium
  #   review:
  #     harness: claude-sdk
  #     model: claude-opus-4-7
  #     effort: high
  #   evaluation:
  #     harness: claude-sdk
  #     model: claude-opus-4-7
  #     effort: high
  # roles:                    # Per-agent role overrides
  #   formatter:              # Per-role options: tier, effort, thinking, maxTurns, promptAppend,
  #     effort: low           #   allowedTools, disallowedTools, shards (builder-only)
  #   builder:                # Available roles: planner, module-planner, builder, reviewer,
  #     effort: high          #  evaluator, plan-reviewer, plan-evaluator,
  #     maxTurns: 50          #   architecture-reviewer, architecture-evaluator,
  #   staleness-assessor:     #   cohesion-reviewer, cohesion-evaluator, validation-fixer,
  #     tier: planning        #   review-fixer, merge-conflict-resolver, staleness-assessor,
  #   reviewer:               #   formatter, doc-author, doc-syncer, test-writer, tester,
  #     promptAppend: |       #   prd-validator, dependency-detector, gap-closer,
  #       ## Project Rules    #   recovery-analyst, pipeline-composer
  #       - Flag raw SQL queries

maxConcurrentBuilds: 2        # Max concurrent PRD builds from the queue (default: 2)

build:
  maxValidationRetries: 2     # Fix attempts on validation failure (0 = no retries)
  cleanupPlanFiles: true      # Remove plan files after successful build
  # worktreeDir: /custom/path # Override worktree base directory
  # postMergeCommandTimeoutMs: 300000  # Per-command timeout (ms) for postMerge/validate commands (default: 300000, floor: 10000)
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
```

Each command in `postMergeCommands` and the planner-generated validate commands runs under a wall-clock timeout. On expiry the full subprocess tree is killed and the validation-fixer loop is invoked as if the command had exited non-zero. Default 300000 ms (5 minutes). Values below 10000 ms are clamped and emit a `config:warning` event.

## Tiers

eforge uses four tiers as the single configuration axis for agent routing. Each tier is a self-contained recipe: `harness + model + effort`, with optional harness-specific sub-blocks.

### Built-in Tier Defaults

| Tier | Default harness | Default model | Default effort |
|------|----------------|---------------|----------------|
| `planning` | `claude-sdk` | `claude-opus-4-7` | `high` |
| `implementation` | `claude-sdk` | `claude-sonnet-4-6` | `medium` |
| `review` | `claude-sdk` | `claude-opus-4-7` | `high` |
| `evaluation` | `claude-sdk` | `claude-opus-4-7` | `high` |

Override any tier by specifying it under `agents.tiers` in `eforge/config.yaml`. You only need to list the tiers you want to change - unspecified tiers keep their engine defaults.

### Complete Tier Recipe

Each tier supports the following fields:

```yaml
agents:
  tiers:
    planning:
      harness: claude-sdk       # Required: 'claude-sdk' or 'pi'
      model: claude-opus-4-7   # Required: plain string model identifier
      effort: high             # Required: 'low', 'medium', 'high', 'xhigh', 'max'
      thinking: true           # Optional: enable thinking; coerced to adaptive for adaptive-only models
      maxTurns: 30             # Optional: max turns override for all roles in this tier
      pi:                      # Optional: Pi-specific config (ignored unless harness: pi)
        provider: openrouter   # Provider name (openrouter, google, openai, etc.)
        # thinkingLevel: xhigh # Pi only: 'off', 'low', 'medium', 'high', 'xhigh'
      claudeSdk:               # Optional: Claude SDK-specific config (ignored unless harness: claude-sdk)
        disableSubagents: false # Prevent agents in this tier from spawning subagents
```

### Pi Backend Tiers

To use the Pi multi-provider backend for a tier, set `harness: pi` and provide a `pi.provider`:

```yaml
agents:
  tiers:
    planning:
      harness: pi
      model: anthropic/claude-opus-4-6
      effort: high
      pi:
        provider: openrouter
    implementation:
      harness: pi
      model: anthropic/claude-sonnet-4-6
      effort: medium
      pi:
        provider: openrouter
    review:
      harness: pi
      model: anthropic/claude-opus-4-6
      effort: high
      pi:
        provider: openrouter
    evaluation:
      harness: pi
      model: anthropic/claude-opus-4-6
      effort: high
      pi:
        provider: openrouter
```

The Pi backend uses file-backed auth storage (`~/.pi/agent/auth.json`) which supports API keys, environment variables, and OAuth tokens automatically.

**Pi Authentication** resolves credentials in this order:

1. **Environment variables** - Provider-specific env vars (e.g. `OPENROUTER_API_KEY`, `OPENAI_API_KEY`)
2. **Auth file** - `~/.pi/agent/auth.json` - supports both API keys and OAuth tokens

**OAuth Providers** (like `openai-codex` and `github-copilot`) use OAuth for authentication:

1. Run `pi auth login <provider>` to authenticate (writes tokens to `~/.pi/agent/auth.json`)
2. Set the provider on the tier - e.g. `pi.provider: openai-codex` - and use a plain model id (e.g. `codex-mini`)
3. No API key or environment variable is needed - tokens are read from the auth file automatically

### Claude SDK Tiers

The `claudeSdk:` sub-block on a tier holds options specific to the Claude SDK harness:

- **`disableSubagents: true`** appends `'Task'` to every agent run's `disallowedTools` for all roles in that tier, preventing agents from spawning Claude Code subagents. Useful for debugging, cost control, or determinism.

```yaml
agents:
  tiers:
    implementation:
      harness: claude-sdk
      model: claude-sonnet-4-6
      effort: medium
      claudeSdk:
        disableSubagents: true
```

Per-role `agents.roles.<role>.disallowedTools` values are preserved; `'Task'` is appended (de-duplicated).

## Model References

Model references are **plain strings**, not objects. Examples:

- `claude-opus-4-7` - Claude SDK model identifier
- `claude-sonnet-4-6`
- `anthropic/claude-opus-4-6` - Pi / OpenRouter model identifier (provider prefix + model name)
- `gemini-flash` - Google provider model identifier

Specify the model directly on the tier recipe:

```yaml
agents:
  tiers:
    planning:
      harness: claude-sdk
      model: claude-opus-4-7
      effort: high
```

> **Migration note:** The old object form (`model: { id: claude-sonnet-4-6 }`) is no longer valid. Use plain strings. The `provider:` field that used to live on model refs now lives on the tier's `pi.provider`. See [config-migration.md](config-migration.md) for worked examples.

## Role-to-Tier Assignment

Every agent role has a built-in default tier. Most projects never need to change these defaults.

### Built-in Tier Assignments

| Role | Default Tier | Description |
|------|-------------|-------------|
| `planner` | `planning` | Orchestration and composition |
| `module-planner` | `planning` | Module-level planning |
| `formatter` | `planning` | PRD formatting |
| `pipeline-composer` | `planning` | Pipeline composition |
| `merge-conflict-resolver` | `planning` | Merge conflict resolution |
| `doc-author` | `implementation` | Plan-driven doc authoring |
| `doc-syncer` | `implementation` | Diff-driven doc sync |
| `gap-closer` | `planning` | Gap analysis and filling |
| `builder` | `implementation` | Code writing |
| `review-fixer` | `implementation` | Applies reviewer feedback |
| `validation-fixer` | `implementation` | Applies validation feedback |
| `test-writer` | `implementation` | Test authoring |
| `tester` | `implementation` | Test execution and analysis |
| `recovery-analyst` | `implementation` | Build failure diagnosis |
| `dependency-detector` | `implementation` | Dependency analysis |
| `prd-validator` | `implementation` | PRD validation |
| `staleness-assessor` | `implementation` | Staleness detection |
| `reviewer` | `review` | Code and design review |
| `architecture-reviewer` | `review` | Architecture review |
| `cohesion-reviewer` | `review` | Cross-module cohesion review |
| `plan-reviewer` | `review` | Plan review |
| `evaluator` | `evaluation` | Build acceptance verdict |
| `architecture-evaluator` | `evaluation` | Architecture acceptance verdict |
| `cohesion-evaluator` | `evaluation` | Cohesion acceptance verdict |
| `plan-evaluator` | `evaluation` | Plan acceptance verdict |

### Overriding Role-to-Tier Assignment

Use `agents.roles[role].tier:` to reassign a role to a different tier. The role then inherits all settings from the target tier (harness, model, effort, provider, etc.):

```yaml
agents:
  roles:
    # Move staleness-assessor from 'implementation' to a lighter tier config
    staleness-assessor:
      tier: implementation    # keep in implementation (default), or reassign
    # Move reviewer to implementation tier (lighter model, less effort)
    reviewer:
      tier: implementation
```

## Per-Role Field Overrides

Per-role overrides let you tune individual fields without reassigning the role to a different tier. The role stays in its natural tier but the specified fields take precedence over the tier recipe:

```yaml
agents:
  roles:
    builder:
      effort: high          # Override effort for this role only
      maxTurns: 80          # Override maxTurns for this role only
    formatter:
      effort: low           # Formatter only needs low effort
    reviewer:
      promptAppend: |           # Append project-specific rules to this role's prompt
        ## Project Rules
        - Flag raw SQL queries
    staleness-assessor:
      tier: planning            # Move staleness-assessor to a heavier-weight tier
```

Available per-role override fields: `tier`, `effort`, `thinking`, `maxTurns`, `allowedTools`, `disallowedTools`, `promptAppend`, `shards` (builder-only).

## Workflow Profiles

Workflow profile selection (`errand`, `excursion`, or `expedition`) is determined per-build by the `pipeline-composer` agent, which classifies the incoming PRD by complexity and selects the appropriate compile pipeline. Custom YAML profiles with `extends:` / `compile:` keys are not configurable in `eforge/config.yaml` - the schema rejects a top-level `profiles:` key.

## Backend Profiles

Agent runtime profiles are named YAML files that bundle tier recipes (harness, model, effort, provider) into a reusable unit. Profiles can be defined at project scope or user scope.

### User-Scoped Profiles

User-scoped profiles live at `~/.config/eforge/profiles/<name>.yaml` (respects `$XDG_CONFIG_HOME`). They are not committed to the project repository and are reusable across all projects on the machine.

The user-scope active-profile marker lives at `~/.config/eforge/.active-profile`.

### Active Profile Precedence

Profile resolution uses `@eforge-build/scopes` named-set resolution. The precedence chain below is the user-visible expression of that resolution.

The active agent runtime profile is resolved using a precedence chain (highest to lowest):

1. **Project-local marker** - `.eforge/.active-profile` file in the repo root (gitignored)
2. **Project marker** - `eforge/.active-profile` file in the project
3. **User marker** - `~/.config/eforge/.active-profile` file
4. **None** - no profile configured; engine defaults apply

When a profile name is resolved, the profile file is looked up local-first, then project, then user-fallback. A local profile shadows project and user profiles with the same name.

### Scope Parameter

The `scope` parameter is available on `create`, `use`, and `delete` operations:

- `scope: "local"` - operates on `.eforge/profiles/` and `.eforge/.active-profile` (gitignored, dev-personal)
- `scope: "project"` (default) - operates on `eforge/profiles/` and `eforge/.active-profile`
- `scope: "user"` - operates on `~/.config/eforge/profiles/` and `~/.config/eforge/.active-profile`

When listing profiles, all three scopes are shown. Entries shadowed by a higher-priority profile of the same name are annotated with `shadowedBy: local` or `shadowedBy: project`.

## MCP Servers

MCP servers are auto-loaded from `.mcp.json` in the project root (same format Claude Code uses). All `eforge` agents receive the same MCP servers.

## Plugins

Plugins are auto-discovered from `~/.claude/plugins/installed_plugins.json`. Both user-scoped and project-scoped plugins matching the working directory are loaded. Use `plugins.include`/`plugins.exclude` in `eforge/config.yaml` to filter, or `--no-plugins` to disable entirely.

## Hooks

Hooks are fire-and-forget shell commands triggered by `eforge` events - useful for logging, notifications, and external system integration. They do not block or influence the pipeline. See [hooks.md](hooks.md) for configuration and details.

## Config Layers

Config merges from three levels (lowest to highest priority):

1. **Global** - `~/.config/eforge/config.yaml` (respects `$XDG_CONFIG_HOME`)
2. **Project** - `eforge/config.yaml` found by walking up from cwd
3. **Project-local** - `.eforge/config.yaml` in the repo root (gitignored; highest priority)

Scope discovery and precedence are implemented in `@eforge-build/scopes`. Engine code calls `getScopeDirectory(scope)` for tier directory lookup, `resolveLayeredSingletons('config.yaml')` for the layered-singleton merge order, and `resolveNamedSet('profiles')` for active-profile resolution. Engine retains parsing, schema validation, `mergePartialConfigs()`, and active-profile semantics.

Object sections (`langfuse`, `agents`, `build`, `plan`, `plugins`, `prdQueue`, `daemon`, `monitor`) shallow-merge per-field. Scalar top-level fields like `maxConcurrentBuilds` override. `hooks` arrays concatenate (global fires first). Arrays inside objects (like `postMergeCommands`) replace rather than merge. CLI flags and environment variables override everything.

### Lookup modes

- **Layered singleton** - all existing scope files are returned in canonical merge order `user -> project-team -> project-local`. Used for `config.yaml`. The caller owns parsing and merge semantics.
- **Named set** - directory entries are unique by name across tiers; same-name entries shadow lower-precedence tiers. Used for `profiles/` and `playbooks/`. The highest-precedence copy wins.
- Project-local-only state (e.g. `.eforge/session-plans/*.md`) is not resolved through scope tiers; it is a project-local artifact and is read directly from the project-local scope by `@eforge-build/input`.

Agent runtime profiles follow the same three-level pattern. Profile files can exist at project-local scope (`.eforge/profiles/` - gitignored), project scope (`eforge/profiles/`), or user scope (`~/.config/eforge/profiles/`). The active-profile marker can be set at any level: `.eforge/.active-profile` (project-local, highest precedence), `eforge/.active-profile` (project), or `~/.config/eforge/.active-profile` (user). When a profile name is resolved, the profile file is looked up local-first, then project, then user-fallback - so a local profile shadows project and user profiles with the same name.

Playbooks are reusable input artifacts owned by `@eforge-build/input`, resolved across scopes by `@eforge-build/scopes`. The daemon compiles playbooks to ordinary build source via `playbookToBuildSource` before enqueue. Playbooks follow the same three-tier pattern: `.eforge/playbooks/` (project-local, highest precedence), `eforge/playbooks/` (project scope), and `~/.config/eforge/playbooks/` (user scope). When the same playbook name exists at multiple tiers, the highest-precedence tier wins and lower-tier copies are reported as shadows. Each playbook carries a `scope` frontmatter field that must match the tier it was loaded from; a mismatch is surfaced as a warning in the listing. The `eforge playbook` command manages playbooks from the CLI: `list` shows all available playbooks with source labels and shadow chains; `new` scaffolds a new playbook file non-interactively (accepts `--scope`, `--name`, `--description`, `--from <file>`); `edit <name>` opens the resolved playbook in `$EDITOR` and validates the result before saving; `run <name> [--after <queue-id>]` enqueues the playbook (also available as `eforge play <name>`); `promote <name>` moves a playbook from `.eforge/playbooks/` to `eforge/playbooks/` and stages the new file; `demote <name>` moves it back to project-local scope.

## Parallelism

eforge has two dimensions of parallelism:

### Queue concurrency (`maxConcurrentBuilds`)

Controls the maximum number of PRDs built concurrently when processing the queue (`eforge build --queue` or `eforge queue run`). Default: `2`.

PRDs with `depends_on` frontmatter are held in a `waiting` state until their upstream builds reach a terminal state. When an upstream build completes, its dependents transition from `waiting` to `pending` and are dispatched normally. If an upstream build fails or is cancelled, all transitive dependents transition to `skipped` with a reason recording the upstream id and terminal state. Skip propagation is recursive - if a `skipped` entry itself has dependents, those also become `skipped`.

CLI override: `--max-concurrent-builds <n>`

```yaml
maxConcurrentBuilds: 3    # Build up to 3 PRDs concurrently
```

### Plan execution

Within a single build, plans run as soon as their dependencies are met. Since plan execution is IO-bound (LLM calls), no throttle is needed - all ready plans launch immediately. This is automatic and requires no configuration.

### Enqueuing

Enqueuing is always single-threaded. The formatter processes one PRD at a time before adding it to the queue. No configuration is needed or available.
