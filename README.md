# eforge

An autonomous build engine with blind review. You express intent - eforge plans, implements, reviews with a fresh-context agent that has zero knowledge of the builder's reasoning, and validates. No supervision required.

The name combines **E** from the [Expedition-Excursion-Errand (EEE) methodology](https://www.markschaake.com/posts/expedition-excursion-errand/) with **forge** - shaping code from plans.

eforge builds itself.

![eforge invoked from Claude Code](docs/images/claude-code-handoff.png)

![eforge monitor - full pipeline](docs/images/monitor-full-pipeline.png)

## Status

eforge is a personal tool built for my own workflows. Source is public so you can read it, learn from it, and fork it. Issues and PRs are not open - this is not a community project. If it's useful to you as-is, great.

## Why eforge?

A single agent writing and reviewing its own work is a developer merging their own PRs. eforge enforces separation: the builder and reviewer are independent agents with no shared context. The reviewer can't be primed by the builder's reasoning, so it catches what a self-reviewing agent won't.

Beyond blind review, eforge handles the full engineering workflow autonomously. You express intent - a PRD, a markdown file, a one-line prompt - and eforge plans, implements, reviews, and validates without supervision. The developer stays at the planning layer, adding plan after plan while eforge works through the queue. Queued work is re-assessed before execution so changes from earlier builds are accounted for, not blindly applied to a codebase that has moved on.

The methodology evolved through real-world use with Claude Code - first as hand-crafted skills, then as battle-tested plugins, now as a standalone engine:

1. **Plan** - a detailed, profile-aware planning session with clarification for ambiguities
2. **Implement** - execute the plan, with documentation updates running in parallel
3. **Blind review** - a single agent writing and reviewing its own work is a developer merging their own PRs. The reviewer gets a fresh context with zero knowledge of the builder's reasoning.
4. **Fix & evaluate** - a fixer agent applies reviewer suggestions, then the evaluator applies per-hunk verdicts - accepting strict improvements while rejecting anything that alters intent
5. **Validate** - verify against the original plan, fix any failures

Every phase produces a git commit - `enqueue(feature-name)`, `plan(feature-name)`, `feat(plan-01-feature-name)` - so the full lifecycle is traceable in git history. After a successful build, plan files and the PRD are cleaned up so the repo stays clean, but the history preserves what was planned and why. Disable cleanup with `--no-cleanup` or `cleanupPlanFiles: false` to keep plan artifacts around.

Plan interactively in Claude Code, then hand off to eforge. Or queue multiple PRDs and let eforge process them continuously. Agents inherit your project's plugins, skills, and MCP servers automatically, each build runs in an isolated git worktree for clean feature development, and the engine is backend-flexible - the sole implementation today uses the [Claude Agent SDK](https://docs.anthropic.com/en/docs/agents-and-tools/claude-agent-sdk), but the `AgentBackend` abstraction means it can be extended to support other systems.

## How It Works

```mermaid
flowchart TD
    Start["PRD, prompt, or plan file"]

    Start --> Formatter["Formatter"]
    Formatter --> Queue["Queue"]
    Queue --> Planner

    subgraph plan ["Planning"]
        Planner["Planner"] --> PC["Commit plans"]
        PC --> PR["Plan Reviewer (blind)"]
        PR --> PE["Plan Evaluator"]
        PE --> PF["Final plan commit"]
    end

    PF --> Orch

    subgraph build ["Build"]
        Orch["Orchestrator"] --> Impl["Builder"]
        Orch --> DocUpdate["doc-update"]
        Impl --> BC["Commit implementation"]
        DocUpdate --> BC
        BC --> CR["Code Reviewer (blind)"]
        CR --> RF["review-fix"]
        RF --> CE["Evaluator"]
        CE --> BF["Final code commit"]
    end

    BF --> Merge["Merge"]

    subgraph validate ["Validation"]
        Merge --> Val["Run validation commands"]
        Val -->|"Pass"| Done["Done"]
        Val -->|"Fail"| Fixer["Validation Fixer"]
        Fixer --> Val
    end
```

- **Planning** - The planner explores the codebase, selects a workflow profile (errand = 1 plan, excursion = 2-3, expedition = 4+), asks clarifying questions, and writes plan files. If the work is already complete, the planner emits a skip signal and exits early. Plans go through a blind review cycle before building starts.
- **Building** - Each plan runs in an isolated git worktree. The builder implements the plan, a blind reviewer proposes fixes in a fresh context, and the evaluator applies per-hunk verdicts - accepting strict improvements while rejecting anything that alters intent.
- **Validation** - Runs configured commands (type-check, tests, linting). If validation fails, a fixer agent attempts minimal repairs automatically.
- **Orchestration** - Multi-plan sets are resolved into a dependency graph, executed in parallel waves, and merged in topological order.

![eforge monitor - timeline view](docs/images/monitor-timeline.png)

## Getting Started

### Install

**Prerequisites:** Node.js 22+, Anthropic API key or [Claude subscription](https://claude.ai/upgrade) (for the Agent SDK backend)

#### Claude Code Plugin (recommended)

The plugin lets you plan interactively in Claude Code and hand off to eforge for build, review, and validation. The first invocation downloads eforge automatically via npx - no global install needed.

Add the marketplace and install from within Claude Code:

```
/plugin marketplace add eforge-run/eforge
/plugin install eforge@eforge
```

Once installed, the primary entrypoint is `/eforge:run` - it takes a PRD or prompt and handles planning, building, review, and validation end-to-end.

| Skill | Description |
|-------|-------------|
| `/eforge:enqueue` | Normalize input and add to queue |
| `/eforge:run` | Enqueue + compile + build + validate in one step |
| `/eforge:status` | Check build progress |
| `/eforge:config` | Initialize or edit `eforge.yaml` with interactive guidance |

#### Standalone CLI

Run directly with npx (no install required):

```bash
npx eforge run docs/my-feature.md
```

Or install globally:

```bash
npm install -g eforge
```

### CLI Usage

```bash
# Normalize input and add to the PRD queue
eforge enqueue docs/my-feature.md

# Enqueue + compile + build + validate in one step
eforge run docs/my-feature.md
eforge run "Add a health check endpoint"

# Process all PRDs from the queue
eforge run --queue

# Watch queue and process new PRDs as they arrive
eforge run --queue --watch

# Check running builds
eforge status

# List PRDs in the queue
eforge queue list

# Process specific PRD from the queue
eforge queue run my-feature

# Watch queue for new PRDs
eforge queue run --watch

# Validate eforge.yaml configuration
eforge config validate

# Show resolved configuration (all layers merged)
eforge config show

# Start or connect to the monitor dashboard
eforge monitor
```

Each command supports `--help` for the full list of options. Common flags:

| Flag | Description |
|------|-------------|
| `--auto` | Bypass approval gates |
| `--verbose` | Stream agent output |
| `--dry-run` | Validate without executing |
| `--queue` | Process all PRDs from the queue |
| `--watch` | Watch queue for new PRDs (with `--queue`) |
| `--poll-interval <ms>` | Poll interval for watch mode (default 5000) |
| `--no-monitor` | Disable web monitor server (events still recorded) |
| `--no-plugins` | Disable plugin loading |
| `--no-generate-profile` | Disable custom profile generation (enabled by default) |

## Configuration

eforge is configured via `eforge.yaml` (searched upward from cwd), environment variables, and auto-discovered files.

### `eforge.yaml`

All fields are optional. Defaults are shown:

```yaml
plugins:
  enabled: true               # Auto-discover Claude Code plugins
  # include:                  # Allowlist - only load these (plugin identifiers)
  #   - "git@schaake-cc-marketplace"
  # exclude:                  # Denylist - skip these from auto-discovery
  #   - "ui@schaake-cc-marketplace"
  # paths:                    # Additional local plugin directories
  #   - /path/to/custom-plugin

agents:
  maxTurns: 30                # Max agent turns before stopping
  permissionMode: bypass      # 'bypass' or 'default'
  settingSources:             # Which Claude Code settings to load (user, project, local)
    - project                 # Loads CLAUDE.md and project settings

build:
  parallelism: <cpu-count>    # Max parallel plan executions
  maxValidationRetries: 2     # Fix attempts on validation failure (0 = no retries)
  cleanupPlanFiles: true      # Remove plan files after successful build
  # worktreeDir: /custom/path # Override worktree base directory
  # postMergeCommands:        # Extra validation commands (appended to planner-generated ones)
  #   - "pnpm install"
  #   - "pnpm type-check"
  #   - "pnpm test"

plan:
  outputDir: plans            # Where plan artifacts are written

prdQueue:
  dir: docs/prd-queue          # Where queued PRDs are stored
  autoRevise: false             # Auto-revise PRDs on enqueue
  watchPollIntervalMs: 5000     # Poll interval for --watch mode

langfuse:
  # publicKey: lf_pk_...      # Or set LANGFUSE_PUBLIC_KEY env var
  # secretKey: lf_sk_...      # Or set LANGFUSE_SECRET_KEY env var
  host: https://cloud.langfuse.com  # Or set LANGFUSE_BASE_URL env var
```

### MCP Servers

MCP servers are auto-loaded from `.mcp.json` in the project root (same format Claude Code uses). All agents receive the same MCP servers.

```json
{
  "mcpServers": {
    "brain": {
      "command": "npx",
      "args": ["brain-mcp-server"],
      "env": { "BRAIN_DB": "/path/to/db" }
    }
  }
}
```

### Plugins

Plugins are auto-discovered from `~/.claude/plugins/installed_plugins.json`. Both user-scoped (global) and project-scoped plugins matching the working directory are loaded. Plugins provide skills, hooks, and MCP servers to eforge's agents.

Use `plugins.include`/`plugins.exclude` in `eforge.yaml` to filter, or `--no-plugins` to disable entirely.

### Hooks

Hooks are fire-and-forget shell commands triggered by eforge events - useful for logging, notifications, and external system integration. They do not block or influence the pipeline. See [docs/hooks.md](docs/hooks.md) for configuration, event patterns, and environment variables.

## Architecture

eforge is **library-first**. The engine (`src/engine/`) is a pure TypeScript library that communicates exclusively through typed `EforgeEvent`s via `AsyncGenerator` - it never writes to stdout. The CLI and web monitor are thin consumers that iterate the event stream and render.

Agent runners use the `AgentBackend` interface - all SDK interaction is isolated behind a single adapter (`src/engine/backends/claude-sdk.ts`). New surfaces (CI, TUI, web) consume the same event stream.

A real-time web monitor records all events to SQLite and serves a dashboard over SSE, auto-starting with `run` commands. Recording is decoupled from the web server - events are always persisted, even with `--no-monitor` or `enqueue`.

## Evaluation

An end-to-end eval harness lives in `eval/`. It runs eforge against embedded fixture projects and validates the output compiles and tests pass.

```bash
./eval/run.sh                        # Run all scenarios
./eval/run.sh todo-api-health-check  # Run one scenario
./eval/run.sh --dry-run              # Smoke-test the harness
```

See `eval/scenarios.yaml` for the scenario manifest and `eval/fixtures/` for the test projects.

![eforge eval results](docs/images/eval-results.png)

## Development

```bash
pnpm dev          # Run via tsx (pass args after --)
pnpm build        # Bundle with tsup
pnpm type-check   # Type check
pnpm test         # Run unit tests
```

### Dogfooding

Since builds modify source code, the running Node.js process would use stale code - so local development uses project-specific Claude Code skills that rebuild between runs.

**Setup** (one-time):

```bash
pnpm install && pnpm build
pnpm link --global   # puts eforge on PATH from local build
```

After making changes, rebuild with `pnpm build` before running. The dogfood skills handle this automatically.

**Skills** (available in Claude Code when working in this repo):

| Skill | Description |
|-------|-------------|
| `/eforge-dogfood-run` | Rebuild from source, then run a single PRD or queue cycle using the local binary |
| `/eforge-dogfood-watch` | Rebuild between each queue cycle - continuous processing with fresh builds |

These are separate from the plugin skills (`/eforge:run`, etc.) which are designed for end users. The dogfood skills use the local binary on PATH so you're always testing the latest source.

## License

Apache-2.0
