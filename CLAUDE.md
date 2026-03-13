# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is this?

aroh-forge is a standalone CLI tool that extracts plan-build-review workflows from the schaake-cc-marketplace Claude Code plugins into a portable TypeScript library + CLI built on `@anthropic-ai/claude-agent-sdk`. It runs outside Claude Code as an independent developer tool.

The architecture is **library-first**: a pure, event-driven engine (`src/engine/`) that yields typed `ForgeEvent`s via `AsyncGenerator`, consumed by thin surface layers (CLI today, TUI/headless/web UI in the future).

## Commands

```bash
pnpm run build        # Bundle with tsup → dist/cli.js
pnpm run dev          # Run directly via tsx (e.g. pnpm run dev -- plan foo.md)
pnpm run type-check   # Type check without emitting
```

No test framework is configured yet.

## Architecture

**Design principle**: Engine emits, consumers render. The engine never writes to stdout — all communication flows through `ForgeEvent`s.

**Three-agent loop**: planner → builder → reviewer, each wrapping an SDK `query()` call.

- **Planner** — one-shot query. Explores codebase, writes plan files (YAML frontmatter format). Outputs `<clarification>` XML blocks for ambiguities.
- **Builder** — multi-turn SDK client. Turn 1: implement plan. Turn 2: evaluate reviewer's unstaged fixes (accept/reject/review).
- **Reviewer** — one-shot query. Blind review (no builder context), leaves fixes unstaged.

**Engine** (`src/engine/`): Pure library, no stdout. Agent implementations in `src/engine/agents/`, prompts in `src/engine/prompts/` (self-contained `.md` files, no runtime plugin dependencies).

**Orchestration**: `src/engine/orchestrator.ts` resolves a dependency graph from `orchestration.yaml`, computes execution waves, and runs plans in parallel via git worktrees (`src/engine/worktree.ts`). Worktrees live in a sibling directory (`../{project}-{set}-worktrees/`) to avoid CLAUDE.md context pollution. Branches merge in topological order after all plans complete.

**State**: `.forge-state.json` (gitignored) tracks build progress for resume support.

**CLI** (`src/cli/`): Thin consumer that iterates the engine's event stream and renders to stdout. Handles interactive clarification prompts and approval gates via callbacks.

## Project structure

```
src/
  engine/                     # Library (no stdout, events only)
    forge.ts                  # ForgeEngine: plan(), build(), review(), status()
    events.ts                 # ForgeEvent type definitions
    agents/
      planner.ts              # PRD → plan files (one-shot query)
      builder.ts              # Plan → implementation (multi-turn)
      reviewer.ts             # Blind review (one-shot query)
      common.ts               # SDK message → ForgeEvent mapping
    plan.ts                   # Plan file parsing (YAML frontmatter)
    state.ts                  # .forge-state.json read/write
    orchestrator.ts           # Dependency graph, wave execution
    worktree.ts               # Git worktree lifecycle
    prompts.ts                # Load/template .md prompt files
    prompts/                  # Agent prompt files
    config.ts                 # forge.yaml loading

  cli/                        # CLI consumer (thin)
    index.ts                  # Commander setup, wires engine → display
    display.ts                # ForgeEvent → stdout rendering
    interactive.ts            # Clarification prompts, approval gates

  cli.ts                      # Entry point (shebang, imports cli/index)
```

## Conventions

- Use Mermaid diagrams instead of ASCII art in documentation

## Tech decisions

- ESM-only (`"type": "module"`), target Node.js 22+
- `@anthropic-ai/claude-agent-sdk` is a devDependency — chosen for Max subscription billing (zero API cost). Vendor lock-in accepted.
- tsup bundles to a single `dist/cli.js` with shebang for direct execution
- Engine uses `AsyncGenerator<ForgeEvent>` pattern — consumers iterate, no callbacks except clarification/approval
- Clarification uses engine-level events (parsed from agent XML output), not SDK's built-in `AskUserQuestion`
- Langfuse tracing planned for all agent calls (env vars: `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST`)

## CLI commands

```
aroh-forge plan <source>      # PRD file or prompt → plan files
aroh-forge build <planSet>    # Execute plans (implement + review)
aroh-forge review <planSet>   # Review code against plans
aroh-forge status             # Check running builds
```

Flags: `--auto` (bypass approval gates), `--verbose` (stream output), `--dry-run` (validate only)

## Key references

- PRD: `docs/init-prd.md`
- Architecture: `plans/forge-v1/architecture.md`
- Expedition plan: `plans/forge-v1/index.yaml`
