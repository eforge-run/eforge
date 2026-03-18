# eforge

You plan, eforge builds - a CLI that turns intent into reviewed, validated code without supervision.

The name combines **E** from the [Expedition-Excursion-Errand (EEE) methodology](https://www.markschaake.com/posts/expedition-excursion-errand/) with **forge** - shaping code from plans.

## Why eforge?

eforge is focused on one thing: converting intent into working code through reliable engineering workflows you don't have to supervise. It doesn't try to solve the planning side - no brainstorming, no specification guidance, no opinionated project structure. That's the highest-leverage work and eforge stays out of your way to do it however you see fit. You express intent - a PRD, a markdown file, a one-line prompt - and eforge handles the entire engineering workflow autonomously: implementation, review, validation, and merge. The developer stays at the planning layer, adding plan after plan while eforge works through the queue - on through the night if needed. Queued work is re-assessed before execution so changes from earlier builds are accounted for, not blindly applied to a codebase that has moved on.

Two design choices make this work:

**Scope-aware execution.** A typo fix and a multi-module feature shouldn't go through the same process. The planner reads the codebase and selects a workflow profile automatically - errand (1 plan), excursion (2-3 plans), expedition (4+). The pipeline adapts rather than forcing every task through a heavyweight process or requiring you to manually choose the right mode.

**Independent review.** A single agent writing and reviewing its own work is a developer merging their own PRs. eforge separates building from review architecturally - the reviewer gets a fresh context with zero knowledge of the builder's reasoning, and an evaluator applies per-hunk verdicts on the resulting fixes, accepting only strict improvements.

The methodology evolved through real-world use with Claude Code - first as hand-crafted skills, then as battle-tested plugins, now as a standalone engine:

1. **Plan** - a detailed, profile-aware planning session with clarification for ambiguities
2. **Implement** - execute the plan, with documentation updates running in parallel
3. **Blind review** - a fresh context reviews the work with zero knowledge of the builder's reasoning
4. **Fix & evaluate** - a fixer agent applies reviewer suggestions, then the evaluator applies per-hunk verdicts - accepting strict improvements while rejecting anything that alters intent
5. **Validate** - verify against the original plan, fix any failures

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

## Getting Started

### Install

**Prerequisites:** Node.js 22+, pnpm, [Claude Max subscription](https://claude.ai/upgrade) (for the Agent SDK backend)

```bash
git clone https://github.com/eforge-run/eforge.git
cd eforge
pnpm install && pnpm build
pnpm link --global
```

### Claude Code Plugin (recommended)

The plugin lets you plan interactively in Claude Code and hand off to eforge for build, review, and validation. It requires the eforge CLI to be installed and on PATH.

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
| `--no-monitor` | Disable web monitor |
| `--no-plugins` | Disable plugin loading |
| `--generate-profile` | Let the planner generate a custom workflow profile |

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

A real-time web monitor records all events to SQLite and serves a dashboard over SSE, auto-starting with `run` commands.

## Evaluation

An end-to-end eval harness lives in `eval/`. It runs eforge against embedded fixture projects and validates the output compiles and tests pass.

```bash
./eval/run.sh                        # Run all scenarios
./eval/run.sh todo-api-health-check  # Run one scenario
./eval/run.sh --dry-run              # Smoke-test the harness
```

See `eval/scenarios.yaml` for the scenario manifest and `eval/fixtures/` for the test projects.

## Development

```bash
pnpm dev          # Run via tsx (pass args after --)
pnpm build        # Bundle with tsup
pnpm type-check   # Type check
pnpm test         # Run unit tests
```

## License

Apache-2.0
