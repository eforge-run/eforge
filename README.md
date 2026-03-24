# eforge

[![npm version](https://img.shields.io/npm/v/eforge)](https://www.npmjs.com/package/eforge)

An agentic build system. PRD in, reviewed and validated code out.

`eforge` lets you stay at the planning level. Describe what you want built - a prompt, a markdown file, a full PRD - and hand it off. eforge handles the orchestration of planning, implementation, code review, and validation across specialized agents without you managing any of it.

![eforge monitor - full pipeline](docs/images/monitor-full-pipeline.png)

## How I Use It

Plan a feature interactively in Claude Code, then hand it off with `/eforge:build`. The plugin enqueues the PRD and a daemon picks it up - compile, build, review, validate. A web monitor (default `localhost:4567`) tracks progress, cost, and token usage in real time.

I do this throughout the day. Each build lands on the current branch before the next one starts, so later builds plan against the updated codebase, not a stale snapshot.

## Install

**Prerequisites:** Node.js 22+, Anthropic API key or [Claude subscription](https://claude.ai/upgrade)

### Claude Code Plugin (recommended)

```
/plugin marketplace add eforge-build/eforge
/plugin install eforge@eforge
```

The first invocation downloads `eforge` automatically via npx. Plan interactively in Claude Code, then hand off to `eforge` for autonomous build, review, and validation.

![eforge invoked from Claude Code](docs/images/claude-code-handoff.png)

### Standalone CLI

```bash
npx eforge build "Add a health check endpoint"
```

Or install globally: `npm install -g eforge`

## Quick Start

Give `eforge` a prompt, a markdown file, or a full PRD:

```bash
eforge build "Add rate limiting to the API"
eforge build plans/my-feature-prd.md
```

By default, `eforge build` enqueues the PRD and a daemon automatically picks it up. Use `--foreground` to run in the current process instead.

## How It Works

```mermaid
flowchart TD
    Start["PRD, prompt, or plan file"]

    Start --> Formatter["Formatter"]
    Formatter --> Queue["Queue"]

    Queue --> Daemon["Daemon\n(watches queue, auto-starts)"]
    Queue -.->|"--foreground"| Worker

    Daemon -->|"spawns per PRD"| Worker["Worker Process"]

    subgraph worker ["Worker Pipeline"]
        direction TB
        subgraph compile ["Compile (profile-dependent)"]
            Planner["Planner"] --> PC["Write plans + build config"]
            PC --> PR["Plan Review Cycle"]
        end

        PR --> Orch

        subgraph build ["Build (per plan, parallel)"]
            Orch["Orchestrator"] -->|"for each plan"| BS["Run plan's build stages"]
            BS --> SM["Squash merge\n(topological order)"]
        end

        SM --> Val

        subgraph validate ["Validation"]
            Val["Run validation commands"]
            Val -->|"Pass"| Done["Done"]
            Val -->|"Fail"| Fixer["Validation Fixer"]
            Fixer --> Val
        end
    end
```

**Workflow profiles** - The planner assesses complexity and selects a profile:
- **Errand** - Small, self-contained changes. Passthrough compile, fast build.
- **Excursion** - Multi-file features. Planner writes a plan, blind review cycle, then build.
- **Expedition** - Large cross-cutting work. Architecture doc, module decomposition, cohesion review across plans, parallel builds in dependency order.

**Blind review** - Every build gets reviewed by a separate agent with no builder context. A fixer applies suggestions, then an evaluator accepts strict improvements while rejecting intent changes.

**Parallel orchestration** - Expedition plans run in isolated git worktrees, merge in topological dependency order, then run post-merge validation with auto-fix.

![eforge monitor - timeline view](docs/images/monitor-timeline.png)

![eforge commits from an expedition build](docs/images/eforge-commits.png)

## [Architecture](docs/architecture.md)

## Evaluation

An end-to-end eval harness runs `eforge` against embedded fixture projects and validates the output compiles and tests pass.

```bash
./eval/run.sh                        # Run all scenarios
./eval/run.sh todo-api-health-check  # Run one scenario
```

![eforge eval results](docs/images/eval-results.png)

## Configuration

Configured via `eforge.yaml` (searched upward from cwd), environment variables, and auto-discovered files. Custom workflow profiles, hooks, MCP servers, and plugins are all configurable. See [docs/config.md](docs/config.md) and [docs/hooks.md](docs/hooks.md).

## Status

This is a young project moving fast. I use it daily to build real features (including itself), but expect rough edges - bugs are likely, change is expected, and YMMV. Source is public so you can read, learn from, and fork it. Not accepting issues or PRs at this time.

## Development

```bash
pnpm dev          # Run via tsx (pass args after --)
pnpm build        # Bundle with tsup
pnpm test         # Run unit tests
```

## Name

**E** from the [Expedition-Excursion-Errand methodology](https://www.markschaake.com/posts/expedition-excursion-errand/) + **forge** - shaping code from plans.

## License

Apache-2.0
