# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is this?

eforge is a standalone CLI tool and Claude Code plugin for plan-build-review workflows, built as a portable TypeScript library + CLI on `@anthropic-ai/claude-agent-sdk`. It runs outside Claude Code as an independent developer tool.

The architecture is **library-first**: a pure, event-driven engine (`src/engine/`) that yields typed `EforgeEvent`s via `AsyncGenerator`, consumed by thin surface layers (CLI today, Claude Code plugin and headless/CI in the future).

**Engine vs plugin boundary**: The engine handles everything that runs without Claude Code (plan generation, review cycles, build execution, orchestration, state, monitoring, tracing). The plugin is a thin launcher/facilitator — requirement refinement in conversation context, subprocess delegation, status rendering. Not a reimplementation.

**Relationship to orchestrate & EEE plugins**: eforge is a graduated replacement. The eforge plugin will supersede both for planning and execution, eventually deprecating them entirely.

## Commands

```bash
pnpm build        # Bundle with tsup → dist/cli.js
pnpm dev          # Run directly via tsx (e.g. pnpm dev -- run foo.md)
pnpm test             # Run tests (vitest)
pnpm test:watch       # Watch mode
pnpm type-check   # Type check without emitting

# Run with Langfuse tracing (dev)
pnpm dev:trace -- run docs/init-prd.md --verbose
# Run built CLI with Langfuse tracing
node --env-file=.env dist/cli.js run docs/init-prd.md --verbose
```

## Architecture

**Design principle**: Engine emits, consumers render. The engine never writes to stdout — all communication flows through `EforgeEvent`s.

**Agent loop**: planner → plan-reviewer → plan-evaluator → builder → reviewer → evaluator, each consuming the `AgentBackend` interface. Planning and building both use a shared `runReviewCycle()` for the review→evaluate pattern.

**Backend abstraction**: Agent runners never import the AI SDK directly. All LLM interaction goes through the `AgentBackend` interface (`src/engine/backend.ts`). The sole SDK adapter lives in `src/engine/backends/claude-sdk.ts`. New agents must accept an `AgentBackend` via their options — do not import `@anthropic-ai/claude-agent-sdk` outside of `src/engine/backends/`. The backend emits `agent:start`/`agent:stop` lifecycle events (with a UUID `agentId`) around every agent invocation — agent runners must pass these through via `isAlwaysYieldedAgentEvent()` from `events.ts`.

**MCP server propagation**: The engine auto-loads MCP servers from `.mcp.json` in the project root (same file Claude Code uses). All agents get the same MCP servers — no per-role filtering. MCP config is backend-specific: `ClaudeSDKBackend` accepts optional `mcpServers` in its constructor, and `EforgeEngineOptions.mcpServers` lets callers inject servers programmatically (overrides auto-loading). The `AgentBackend` interface has no MCP concept. Note: SDK subprocesses do NOT auto-discover MCP servers from settings files — explicit propagation is required.

**Plugin propagation**: The engine auto-discovers Claude Code plugins from `~/.claude/plugins/installed_plugins.json`. Both user-scoped (global) and project-scoped plugins matching the cwd are loaded. Plugins provide skills, hooks, and MCP servers. Like MCP servers, plugins are backend-specific: `ClaudeSDKBackend` accepts `plugins` and `settingSources` in its constructor. The `AgentBackend` interface has no plugin concept. Configure via `eforge.yaml` `plugins` section or `--no-plugins` CLI flag. The eforge Claude Code plugin itself lives in-repo at `eforge-plugin/` — this repo is also a Claude Code marketplace (see `.claude-plugin/marketplace.json`).

- **Planner** — one-shot query. Explores codebase, assesses scope, writes plan files (YAML frontmatter format). Outputs `<clarification>` XML blocks for ambiguities. For expeditions, also generates architecture + module list.
- **Plan Reviewer** — one-shot query. Blind review of plan files against PRD for cohesion, completeness, correctness. Leaves fixes unstaged.
- **Plan Evaluator** — one-shot query. Evaluates plan reviewer's unstaged fixes against planner's intent. Accepts/rejects.
- **Module Planner** — one-shot query (expedition mode only). Writes detailed plan for a single module using architecture context.
- **Builder** — multi-turn agent. Turn 1: implement plan. Turn 2: evaluate reviewer's unstaged fixes (accept/reject/review).
- **Reviewer** — one-shot query. Blind code review (no builder context), leaves fixes unstaged.
- **Validation Fixer** — one-shot coding agent. Receives post-merge validation failures and makes minimal fixes.

**Engine** (`src/engine/`): Pure library, no stdout. Agent implementations in `src/engine/agents/`, prompts in `src/engine/prompts/` (self-contained `.md` files, no runtime plugin dependencies).

**Orchestration**: `src/engine/orchestrator.ts` resolves a dependency graph from `orchestration.yaml`, computes execution waves, and runs plans in parallel via git worktrees (`src/engine/worktree.ts`). Worktrees live in a sibling directory (`../{project}-{set}-worktrees/`) to avoid CLAUDE.md context pollution. Branches merge in topological order after all plans complete. Post-merge validation runs commands from `orchestration.yaml` `validate` (planner-generated) + `eforge.yaml` `postMergeCommands` (user-configured). On failure, the validation fixer agent attempts repairs up to `maxValidationRetries` times (default 2).

**State**: `.eforge/state.json` (gitignored) tracks build progress for resume support.

**Monitor** (`src/monitor/`): Web-based real-time monitor. Records all `EforgeEvent`s to SQLite (`.eforge/monitor.db`) via a transparent `withRecording()` async generator middleware. Serves a single-page dashboard over SSE at `http://localhost:4567`. Auto-starts with `run` commands (disable with `--no-monitor`).

**CLI** (`src/cli/`): Thin consumer that iterates the engine's event stream and renders to stdout. Handles interactive clarification prompts and approval gates via callbacks.

## Project structure

```
.claude-plugin/
  marketplace.json                  # Claude Code marketplace manifest
eforge-plugin/                      # Claude Code plugin (skills for plan, run, status, roadmap)
  .claude-plugin/plugin.json
  skills/
.mcp.json                           # MCP server config (gitignored, auto-loaded by engine)
eforge.yaml                         # Optional engine config (langfuse, parallelism, etc.)
src/
  engine/                     # Library (no stdout, events only)
    eforge.ts                 # EforgeEngine: compile(), build(), status()
    events.ts                 # EforgeEvent type definitions
    index.ts                  # Barrel re-exports for engine public API
    backend.ts                # AgentBackend interface (provider abstraction)
    backends/
      claude-sdk.ts           # Claude Agent SDK adapter (sole SDK import point)
    agents/
      planner.ts              # PRD → plan files (one-shot query)
      module-planner.ts       # Expedition module → detailed plan (one-shot query)
      builder.ts              # Plan → implementation (multi-turn)
      reviewer.ts             # Blind code review (one-shot query)
      plan-reviewer.ts        # Blind plan review (one-shot query)
      plan-evaluator.ts       # Plan fix evaluation (one-shot query)
      validation-fixer.ts     # Post-merge validation fix (one-shot coding agent)
      common.ts               # Provider-agnostic XML parsers for agent output
    plan.ts                   # Plan file parsing (YAML frontmatter)
    state.ts                  # .eforge/state.json read/write
    orchestrator.ts           # Dependency graph, wave execution
    concurrency.ts            # Semaphore + AsyncEventQueue for parallel plans
    worktree.ts               # Git worktree lifecycle
    compiler.ts               # Expedition compiler (modules → plan files + orchestration.yaml)
    session.ts                # Session ID middleware (withSessionId)
    hooks.ts                  # Event hook middleware (withHooks, compilePattern, matchesPattern)
    tracing.ts                # Langfuse tracing (noop when disabled)
    prompts.ts                # Load/template .md prompt files
    prompts/                  # Agent prompt files
      planner.md
      module-planner.md
      builder.md
      reviewer.md
      evaluator.md
      plan-reviewer.md
      plan-evaluator.md
      validation-fixer.md
    config.ts                 # eforge.yaml + global config loading & merging

  monitor/                    # Web monitor (event persistence + dashboard)
    db.ts                     # SQLite: open, schema, CRUD (better-sqlite3)
    recorder.ts               # withRecording() async generator middleware
    server.ts                 # node:http server, SSE endpoint
    index.ts                  # Barrel + createMonitor() convenience
    ui/
      index.html              # Single-page monitor app (inline CSS + JS)

  cli/                        # CLI consumer (thin)
    index.ts                  # Commander setup, wires engine → display
    display.ts                # EforgeEvent → stdout rendering
    interactive.ts            # Clarification prompts, approval gates

  cli.ts                      # Entry point (shebang, imports cli/index)

eval/                           # End-to-end evaluation harness
  scenarios.yaml                # Manifest: fixture + PRD + validation per scenario
  run.sh                        # Main runner (bash)
  lib/
    run-scenario.sh             # Single-scenario runner (sourced by run.sh)
    build-result.mjs            # Parse eforge output → result.json
  fixtures/                     # Embedded test projects (no .git)
    todo-api/                   # Express + TypeScript API with 2 PRDs
  results/                      # Gitignored — timestamped run output
```

## Testing

Tests live in `test/` and use vitest. Organize by **logical unit**, not source file:

- **Group by what's tested, not where it lives.** A source file may split across multiple test files (e.g., `plan.ts` → `dependency-graph.test.ts` + `plan-parsing.test.ts`) or multiple source files may merge into one test file (e.g., XML parsers from `common.ts`, `reviewer.ts`, `builder.ts` → `xml-parsers.test.ts`).
- **No mocks.** Test real code. For SDK types, hand-craft data objects cast through `unknown` rather than mocking.
- **Fixtures for I/O tests only.** File-reading tests use `test/fixtures/`; everything else constructs inputs inline.
- **Helpers colocated.** Test helpers (e.g., `makeState()`, `asyncIterableFrom()`) live in the test file that uses them. No shared test utils unless reuse spans 3+ files.
- **Agent wiring tests use `StubBackend`** (`test/stub-backend.ts`). Test the logic between backend calls and EforgeEvents: clarification loops, XML parsing → event synthesis, error propagation. See `test/agent-wiring.test.ts`.
- **Don't test backend implementations or infra.** `ClaudeSDKBackend`, `EforgeEngine` orchestration, worktree/git ops, and tracing are integration-level — don't unit test them.

## Evaluation

`eval/` contains an end-to-end eval harness. `eval/scenarios.yaml` defines scenarios (fixture + PRD + validation commands). Fixtures in `eval/fixtures/` are plain project files copied into disposable git repos per run. Results are gitignored and auto-pruned. Run `./eval/run.sh --help` or read `eval/run.sh` for usage.

## Configuration

eforge loads config from two levels, merged together:

1. **Global (user-level)**: `~/.config/eforge/config.yaml` (respects `$XDG_CONFIG_HOME`)
2. **Project-level**: `eforge.yaml` found by walking up from cwd

**Priority chain** (lowest → highest): defaults → global config → project config → env vars → CLI overrides

**Merge strategy**:
- Object sections (`langfuse`, `agents`, `build`, `plan`, `plugins`): shallow merge per-field — project overrides global, global fields survive if project doesn't define them
- `hooks` array: **concatenate** (global hooks fire first, then project hooks)
- Arrays inside objects (`postMergeCommands`, `plugins.include/exclude/paths`, `settingSources`): project replaces global

**Hook env vars**: Hook commands receive the full `EforgeEvent` JSON on stdin plus these environment variables:

| Env var | Description |
|---------|-------------|
| `EFORGE_SESSION_ID` | Session ID - stable across compile+build in `run` mode. Preferred identifier for session tracking. |
| `EFORGE_RUN_ID` | Per-phase run ID (UUID). Changes between compile and build phases. |
| `EFORGE_EVENT_TYPE` | Event type string (e.g., `session:start`, `phase:start`, `plan:complete`) |
| `EFORGE_CWD` | Working directory for the eforge run |
| `EFORGE_GIT_REMOTE` | Git origin remote URL (empty string if not a git repo or no origin) |

`EFORGE_CWD` and `EFORGE_GIT_REMOTE` are resolved once at startup; `EFORGE_EVENT_TYPE` is set per-event; `EFORGE_SESSION_ID` and `EFORGE_RUN_ID` are captured from lifecycle events. For `eforge run`, `EFORGE_SESSION_ID` is shared across both phases while `EFORGE_RUN_ID` is unique per phase.

## Conventions

- Use Mermaid diagrams instead of ASCII art in documentation
- SDK imports (`@anthropic-ai/claude-agent-sdk`) are restricted to `src/engine/backends/` — agent runners use the `AgentBackend` interface

## Tech decisions

- ESM-only (`"type": "module"`), target Node.js 22+
- `@anthropic-ai/claude-agent-sdk` is a runtime dependency (externalized from bundle so its `import.meta.url` resolves correctly). Chosen for Max subscription billing (zero API cost). Isolated behind `AgentBackend` interface for future provider swappability.
- tsup bundles to `dist/cli.js` with shebang; SDK is externalized via `external` config to preserve subprocess resolution
- Engine uses `AsyncGenerator<EforgeEvent>` pattern — consumers iterate, no callbacks except clarification/approval
- Clarification uses engine-level events (parsed from agent XML output), not SDK's built-in `AskUserQuestion`
- Langfuse tracing for all agent calls via `src/engine/tracing.ts` (env vars: `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL`)
- MCP servers auto-loaded from `.mcp.json` (gitignored, same format as Claude Code). Agents get full tool access to configured servers (brain, langfuse, etc.). Programmatic callers can override via `EforgeEngineOptions.mcpServers`.
- Claude Code plugins auto-discovered from `~/.claude/plugins/installed_plugins.json`. Provides skills, hooks, and plugin-bundled MCP servers to agents via the SDK's `plugins` option. Configured via `eforge.yaml` `plugins` section. `settingSources: ['project']` enabled by default so agents load CLAUDE.md.

## CLI commands

```
eforge run <source>       # Compile + build + validate in one step
eforge status             # Check running builds
```

Flags: `--auto` (bypass approval gates), `--verbose` (stream output), `--dry-run` (validate only), `--adopt` (wrap existing plan), `--no-monitor` (disable web monitor), `--no-plugins` (disable plugin loading)

## Roadmap

`docs/roadmap.md` is a high-level vision document for where the project is headed. It captures direction (what and why), not implementation details (how). It will evolve over time as priorities shift.

- **Read it** before proposing new features or architectural changes to ensure alignment with planned direction
- **Keep it lean** — goal + bullet points per section, no code examples, frontmatter specs, or implementation plans
- **Future only** — remove items from the roadmap once they ship. Completed work is documented in the PRD, git history, and CLAUDE.md, not the roadmap.
- **Update it** when direction changes after discussion with the user
- **Don't duplicate it** — implementation details belong in PRDs, plan files, or CLAUDE.md, not the roadmap

The original PRD (`docs/init-prd.md`) is historical context. The roadmap is the current source of truth for future direction.

## Key references

- Roadmap: `docs/roadmap.md`
- PRD (historical): `docs/init-prd.md`
- Architecture: `plans/forge-v1/architecture.md`
- Expedition plan: `plans/forge-v1/index.yaml`
