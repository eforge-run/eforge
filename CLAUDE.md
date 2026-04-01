# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is this?

eforge is a standalone CLI tool and Claude Code plugin for plan-build-review workflows, built as a portable TypeScript library + CLI on `@anthropic-ai/claude-agent-sdk`. It runs outside Claude Code as an independent developer tool.

The architecture is **library-first**: a pure, event-driven engine (`src/engine/`) that yields typed `EforgeEvent`s via `AsyncGenerator`, consumed by thin surface layers (CLI today, Claude Code plugin and headless/CI in the future).

**Engine vs plugin boundary**: The engine handles everything that runs without Claude Code. The plugin is a thin launcher/facilitator - requirement refinement, subprocess delegation, status rendering. eforge will supersede the orchestrate & EEE plugins.

## Documentation

- `README.md` - User-facing overview, install instructions, and quick-start guide. Keep it current when adding features or changing CLI surface.
- `docs/roadmap.md` - High-level vision (see Roadmap section below for governance rules).
- `docs/` - PRDs and design docs for planned-but-not-yet-implemented work. Delete after implementation.
- When searching for documentation or code, always exclude `node_modules/` and `dist/` from file searches to avoid noise from vendored dependencies and build output.

## Commands

```bash
pnpm build        # Bundle with tsup → dist/cli.js
pnpm dev          # Run directly via tsx (e.g. pnpm dev -- build foo.md)
pnpm test             # Run tests (vitest)
pnpm test:watch       # Watch mode
pnpm type-check   # Type check without emitting

# Run with Langfuse tracing (dev)
pnpm dev:trace -- build some-prd.md --verbose
# Run built CLI with Langfuse tracing
node --env-file=.env dist/cli.js build some-prd.md --verbose
```

## Architecture

**Design principle**: Engine emits, consumers render. The engine never writes to stdout - all communication flows through `EforgeEvent`s.

**Agent pipeline**: Stage-driven, not a fixed linear sequence (`src/engine/pipeline.ts`). Compile and build share no runtime state - the resolved profile is persisted into orchestration.yaml during compile.

**Workflow profiles**: Config-driven via profiles (`src/engine/config.ts`): `errand`, `excursion`, `expedition`. A profile declares compile stages; build stages and review config are per-plan in orchestration.yaml.

**Backend abstraction**: All LLM interaction goes through `AgentBackend` (`src/engine/backend.ts`). Provider SDK imports restricted to `src/engine/backends/`. Implementations: `ClaudeSDKBackend` and `PiBackend`.

**Agents** (implementations in `src/engine/agents/`, prompts in `src/engine/prompts/`):
- **Formatter** - normalizes input into structured PRD
- **Planner** - explores codebase, selects profile, writes plans
- **Plan Reviewer** - blind review of plans against PRD
- **Plan Evaluator** - evaluates reviewer fixes (also handles cohesion/architecture modes)
- **Module Planner** - detailed plan for single module (expedition)
- **Cohesion Reviewer** - cross-module plan consistency review (expedition)
- **Architecture Reviewer** - architecture doc review (expedition)
- **Staleness Assessor** - checks if plans need regeneration
- **Builder** - multi-turn agent that implements plans
- **Reviewer** - blind code review, no builder context
- **Review Fixer** - applies minimal fixes from review issues
- **Parallel Reviewer** - multi-perspective code review
- **Doc Updater** - updates docs to reflect implementation changes
- **Merge Conflict Resolver** - resolves conflicts using plan intent
- **Tester** - runs tests, fixes test bugs
- **Test Writer** - writes failing tests (TDD mode)
- **Validation Fixer** - fixes post-merge validation failures

**MCP servers**: Auto-loaded from `.mcp.json`. **Plugins**: Auto-discovered from installed plugins. Both configurable via `eforge/config.yaml`.

**Orchestration** (`src/engine/orchestrator.ts`): Resolves dependency graph from `orchestration.yaml`, runs plans in parallel via git worktrees. **Monitor** (`src/monitor/`): Real-time dashboard with SQLite event persistence. **CLI** (`src/cli/`): Thin event stream consumer.

## Project structure

```
.claude-plugin/marketplace.json     # Claude Code marketplace manifest
eforge-plugin/                      # Claude Code plugin (skills for build, status, config)
.mcp.json                           # MCP server config (gitignored, auto-loaded by engine)
eforge/                             # Committable eforge artifacts (config, queue, plans)
  config.yaml                       # Optional engine config (langfuse, parallelism, etc.)
src/
  engine/                     # Library core (no stdout, events only)
    eforge.ts                 # EforgeEngine: compile(), build(), status(), watchQueue()
    events.ts                 # EforgeEvent type definitions + SEVERITY_ORDER constant
    schemas.ts                # Zod schemas for structured agent output (review issues, evaluations, etc.) + getSchemaYaml() utility
    backend.ts                # AgentBackend interface (provider abstraction)
    pipeline.ts               # Stage registry, compile/build stage implementations
    config.ts                 # Config loading, merging & validation
    git.ts                    # forgeCommit() helper — all engine commits go through here for attribution
    agents/                   # Agent implementations (16 agent files — see agent list above; plan evaluator, cohesion evaluator, and architecture evaluator share one file)
    backends/                 # SDK adapters (sole provider SDK import point): claude-sdk.ts, pi.ts, pi-mcp-bridge.ts, pi-extensions.ts
    prompts/                  # Agent prompt .md files (self-contained, no runtime plugin deps)
  monitor/                    # Web monitor — SQLite event persistence + SSE dashboard
  cli/                        # Thin CLI consumer — Commander setup, event rendering, interactive prompts
  cli.ts                      # Entry point (shebang, imports cli/index)
```

## Testing

Tests live in `test/` and use vitest. Organize by **logical unit**, not source file:

- **Group by what's tested, not where it lives.** Source files may split across test files or merge into one.
- **No mocks.** Test real code. For SDK types, hand-craft data objects cast through `unknown`.
- **Fixtures for I/O tests only.** Everything else constructs inputs inline.
- **Helpers colocated.** Test helpers live in the test file that uses them. Shared helpers that cross the 3+ file threshold: `test/test-events.ts`, `test/test-tmpdir.ts`.
- **Agent wiring tests use `StubBackend`** (`test/stub-backend.ts`). See `test/agent-wiring.test.ts`.
- **Don't test backend implementations or infra.** `ClaudeSDKBackend`, `EforgeEngine` orchestration, worktree/git ops, and tracing are integration-level.

## Configuration

eforge loads config from two levels: global (`~/.config/eforge/config.yaml`) and project-level (`eforge/config.yaml`). Priority (lowest to highest): defaults - global - project - env vars - CLI. Object sections (`langfuse`, `agents`, `build`, `plan`, `plugins`, `prdQueue`, `daemon`, `monitor`, `pi`) shallow-merge per-field. See `src/engine/config.ts` for merge logic. Built-in profiles can be overridden by name.

## Conventions

- Use Mermaid diagrams instead of ASCII art in documentation
- All engine commits use `forgeCommit()` from `src/engine/git.ts` - this appends the `Co-Authored-By: forged-by-eforge` trailer automatically. Do not use raw `exec('git', ['commit', ...])` in engine code outside of `git.ts` and `worktree.ts`.
- Provider SDK imports (`@anthropic-ai/claude-agent-sdk`, `@mariozechner/pi-ai`, `@mariozechner/pi-agent-core`) are restricted to `src/engine/backends/` - agent runners use the `AgentBackend` interface
- **Always bump the plugin version** in `eforge-plugin/.claude-plugin/plugin.json` when making any changes to the plugin (skills, plugin.json, etc.). Plugin and npm package versions are independent - do not sync them.
- The monitor UI (`src/monitor/ui/`) uses **shadcn/ui components** (Button, ScrollArea, Checkbox, Tooltip, Resizable, etc.) rather than custom UI primitives. Follow the shadcn pattern when adding new UI components.
- Exclude `node_modules/` and `dist/` from file searches - these contain vendored dependencies and build output that pollute search results.

## Tech decisions

- ESM-only (`"type": "module"`), target Node.js 22+
- `@anthropic-ai/claude-agent-sdk` chosen for Max subscription billing (zero API cost), isolated behind `AgentBackend` for swappability
- `@mariozechner/pi-ai` and `@mariozechner/pi-agent-core` provide `PiBackend` - multi-provider backend (20+ LLM providers)
- Engine uses `AsyncGenerator<EforgeEvent>` pattern - consumers iterate, no callbacks except clarification/approval
- Clarification uses engine-level events (parsed from agent XML output), not SDK's built-in `AskUserQuestion`
- Langfuse tracing for all agent calls via `src/engine/tracing.ts`

## CLI commands

Run `eforge --help` for the full command and flag reference. Key commands: `build`, `enqueue`, `status`, `queue`, `monitor`, `config`, `daemon`.

## Roadmap

`docs/roadmap.md` captures direction (what and why), not implementation details (how).

- **Read it** before proposing new features or architectural changes
- **Keep it lean** - goal + bullet points per section, no code examples or implementation plans
- **Future only** - remove items once they ship; completed work lives in git history and CLAUDE.md
- **Update it** when direction changes after discussion with the user
- **Don't duplicate it** - implementation details belong in plan files or CLAUDE.md
- **Delete PRDs after implementation** - `docs/` should reflect current state and planned work only

## Plugin candidate skills

New plugin skills are dogfooded as project-level Claude Code skills before promotion to the eforge plugin (`eforge-plugin/skills/`). They live in `.claude/skills/eforge-plugin-<name>/SKILL.md` and are invoked via `/eforge-plugin-<name>`.

- **Must be project-generic** - skills work in any project, not just this repo. They discover project structure dynamically.
- **Delegate to eforge** - the skill's job is to analyze, compose a focused prompt, and enqueue it via the eforge MCP server. The build pipeline does the actual work.
- **Promote when proven** - once a skill is working well, move it to `eforge-plugin/skills/` and bump the plugin version.

## Key references

- Roadmap: `docs/roadmap.md`
- Eval harness: [eforge-build/eval](https://github.com/eforge-build/eval)
