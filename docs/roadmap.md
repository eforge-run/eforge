# ForgeAI Roadmap

## Why Plugin, Not TUI

The original PRD planned a TUI. We're dropping it in favor of a Claude Code plugin:

1. **Context** — Users already have codebase context, MCP tools, and prior discussion in Claude Code. A TUI starts cold.
2. **Redundancy** — Claude Code already provides interactive prompts, file browsing, diff display, and approval gates.
3. **Proven pattern** — The orchestrate plugin demonstrates CLI subprocess delegation works for parallel worktree builds.

The CLI with `--auto` covers headless/CI. The monitor dashboard covers visualization.

## Architecture Boundary: Engine vs Plugin

**Engine** — Everything that runs without Claude Code: plan generation, review cycles, build execution, orchestration, state management, monitoring, tracing.

**Plugin** — Thin orchestration: requirement refinement in conversation context, launching `forgeai` CLI as subprocess, status rendering, cross-plugin coordination. A **launcher and facilitator**, not a reimplementation.

## Relationship to Orchestrate & EEE Plugins

Graduated replacement. Phase 5: forgeai plugin supersedes both for planning and execution. Phase 8: deprecate them entirely.

---

## Claude Code Plugin (next)

**Goal**: Make forgeai accessible within Claude Code with a focus on planning quality.

Plugin lives in `schaake-cc-marketplace`, invokes `forgeai` CLI as subprocess.

**Skills**:
- `/forgeai:plan <source>` — The core skill. Helps refine requirements in-conversation using full Claude Code context, then kicks off `forgeai plan`.
- `/forgeai:build <planSet>` — Validates plan set and delegates to `forgeai build`.
- `/forgeai:review <planSet>` — Delegates to `forgeai review`.
- `/forgeai:status` — Reads `.forge/state.json` and renders inline with monitor dashboard link.

**Testing**: Engine/CLI correctness covered by eval system (`eval/`). Plugin UX tested via `claude --print` smoke tests, manual scenario checklist, and Langfuse observability.

---

## Monitor Dashboard Enhancements

**Goal**: Richer visualization in the existing web monitor.

- Dependency graph view (plan execution order and wave assignment)
- Plan file preview with syntax highlighting
- Wave progress visualization
- File change heatmap (merge conflict risk)

---

## Planning Intelligence

**Goal**: Go from rough idea to refined, reviewed plans entirely within Claude Code.

- **Conversational planning** — Multi-turn requirement refinement producing a structured PRD
- **Plan iteration** — Review and refine generated plans in-conversation, re-run review cycle
- **Plan templates** — Common patterns (API endpoint, migration, refactor, feature flag)

---

## Integration & Maturity

**Goal**: Full lifecycle coverage, CI support, provider flexibility.

- **Headless/CI** — JSON event output, GitHub Actions integration, webhooks
- **Provider abstraction** — Second `AgentBackend` implementation for non-SDK environments
- **Plugin consolidation** — Deprecate orchestrate + EEE plugins, migration guide
