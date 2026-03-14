# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is this?

aroh-forge is a standalone CLI tool that extracts plan-build-review workflows from the schaake-cc-marketplace Claude Code plugins into a portable TypeScript library + CLI built on `@anthropic-ai/claude-agent-sdk`. It runs outside Claude Code as an independent developer tool.

The architecture is **library-first**: a pure, event-driven engine (`src/engine/`) that yields typed `ForgeEvent`s via `AsyncGenerator`, consumed by thin surface layers (CLI today, TUI/headless/web UI in the future).

## Commands

```bash
pnpm run build        # Bundle with tsup → dist/cli.js
pnpm run dev          # Run directly via tsx (e.g. pnpm run dev -- plan foo.md)
pnpm test             # Run tests (vitest)
pnpm test:watch       # Watch mode
pnpm run type-check   # Type check without emitting

# Run with Langfuse tracing (dev)
pnpm dev:trace -- plan docs/init-prd.md --verbose
# Run built CLI with Langfuse tracing
node --env-file=.env dist/cli.js plan docs/init-prd.md --verbose
```

## Architecture

**Design principle**: Engine emits, consumers render. The engine never writes to stdout — all communication flows through `ForgeEvent`s.

**Agent loop**: planner → plan-reviewer → plan-evaluator → builder → reviewer → evaluator, each wrapping an SDK `query()` call. Planning and building both use a shared `runReviewCycle()` for the review→evaluate pattern.

- **Planner** — one-shot query. Explores codebase, assesses scope, writes plan files (YAML frontmatter format). Outputs `<clarification>` XML blocks for ambiguities. For expeditions, also generates architecture + module list.
- **Plan Reviewer** — one-shot query. Blind review of plan files against PRD for cohesion, completeness, correctness. Leaves fixes unstaged.
- **Plan Evaluator** — one-shot query. Evaluates plan reviewer's unstaged fixes against planner's intent. Accepts/rejects.
- **Module Planner** — one-shot query (expedition mode only). Writes detailed plan for a single module using architecture context.
- **Builder** — multi-turn SDK client. Turn 1: implement plan. Turn 2: evaluate reviewer's unstaged fixes (accept/reject/review).
- **Reviewer** — one-shot query. Blind code review (no builder context), leaves fixes unstaged.

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
    index.ts                  # Barrel re-exports for engine public API
    agents/
      planner.ts              # PRD → plan files (one-shot query)
      module-planner.ts       # Expedition module → detailed plan (one-shot query)
      builder.ts              # Plan → implementation (multi-turn)
      reviewer.ts             # Blind code review (one-shot query)
      plan-reviewer.ts        # Blind plan review (one-shot query)
      plan-evaluator.ts       # Plan fix evaluation (one-shot query)
      common.ts               # SDK message → ForgeEvent mapping
    plan.ts                   # Plan file parsing (YAML frontmatter)
    state.ts                  # .forge-state.json read/write
    orchestrator.ts           # Dependency graph, wave execution
    concurrency.ts            # Semaphore + AsyncEventQueue for parallel plans
    worktree.ts               # Git worktree lifecycle
    compiler.ts               # Expedition compiler (modules → plan files + orchestration.yaml)
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
    config.ts                 # forge.yaml loading

  cli/                        # CLI consumer (thin)
    index.ts                  # Commander setup, wires engine → display
    display.ts                # ForgeEvent → stdout rendering
    interactive.ts            # Clarification prompts, approval gates

  cli.ts                      # Entry point (shebang, imports cli/index)
```

## Testing

Tests live in `test/` and use vitest. Organize by **logical unit**, not source file:

- **Group by what's tested, not where it lives.** A source file may split across multiple test files (e.g., `plan.ts` → `dependency-graph.test.ts` + `plan-parsing.test.ts`) or multiple source files may merge into one test file (e.g., XML parsers from `common.ts`, `reviewer.ts`, `builder.ts` → `xml-parsers.test.ts`).
- **No mocks.** Test real code. For SDK types, hand-craft data objects cast through `unknown` rather than mocking.
- **Fixtures for I/O tests only.** File-reading tests use `test/fixtures/`; everything else constructs inputs inline.
- **Helpers colocated.** Test helpers (e.g., `makeState()`, `asyncIterableFrom()`) live in the test file that uses them. No shared test utils unless reuse spans 3+ files.
- **Only test pure logic.** Agent runners, `ForgeEngine`, worktree/git ops, and tracing are thin SDK wrappers — testing them means testing mocks, so don't.

## Conventions

- Use Mermaid diagrams instead of ASCII art in documentation

## Tech decisions

- ESM-only (`"type": "module"`), target Node.js 22+
- `@anthropic-ai/claude-agent-sdk` is a runtime dependency (externalized from bundle so its `import.meta.url` resolves correctly). Chosen for Max subscription billing (zero API cost). Vendor lock-in accepted.
- tsup bundles to `dist/cli.js` with shebang; SDK is externalized via `external` config to preserve subprocess resolution
- Engine uses `AsyncGenerator<ForgeEvent>` pattern — consumers iterate, no callbacks except clarification/approval
- Clarification uses engine-level events (parsed from agent XML output), not SDK's built-in `AskUserQuestion`
- Langfuse tracing for all agent calls via `src/engine/tracing.ts` (env vars: `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL`)

## CLI commands

```
aroh-forge plan <source>      # PRD file or prompt → plan files
aroh-forge run <source>       # Plan + build in one step
aroh-forge build <planSet>    # Execute plans (implement + review)
aroh-forge review <planSet>   # Review code against plans
aroh-forge status             # Check running builds
```

Flags: `--auto` (bypass approval gates), `--verbose` (stream output), `--dry-run` (validate only)

## Key references

- PRD: `docs/init-prd.md`
- Architecture: `plans/forge-v1/architecture.md`
- Expedition plan: `plans/forge-v1/index.yaml`
