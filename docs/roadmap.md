# ForgeAI Roadmap

## Status

| Phase | Name | Status |
|-------|------|--------|
| 1 | Engine Foundation + Plan Command | Complete |
| 2 | Build Command (single plan) | Complete |
| 3 | Parallel Orchestration | Complete |
| 4 | Polish & Robustness | Complete |
| 4b | Web Monitor | Complete |
| **5** | **Claude Code Plugin** | **Next** |
| 6 | Monitor Dashboard Enhancements | Planned |
| 7 | Planning Intelligence | Planned |
| 8 | Integration & Maturity | Planned |

## Why Plugin, Not TUI

The original PRD (see `docs/init-prd.md`) planned a TUI as Phase 5. After analysis, we're dropping TUI entirely in favor of a Claude Code plugin:

1. **Context is king** — Users already have codebase context, open files, prior discussion, and all MCP tools (brain, langfuse, browser, etc.) loaded in Claude Code. A TUI would start cold every time.
2. **Claude Code already IS a TUI** — Interactive prompts, file browsing, diff display, approval gates — all native to Claude Code. Building a TUI is months of work to recreate what exists.
3. **Proven pattern** — The orchestrate plugin already demonstrates CLI subprocess delegation via Bash Tasks works robustly for parallel worktree-based builds.

The existing CLI with `--auto` covers headless/CI use cases. The monitor dashboard covers visualization. No gap remains that a TUI uniquely fills.

## Architecture Boundary: Engine vs Plugin

**Engine** (the `forgeai` npm package — runs without Claude Code):
- Plan generation, scope assessment, clarification loops
- Plan review cycle (plan-reviewer + plan-evaluator)
- Build execution (builder + reviewer + evaluator)
- Orchestration (dependency graph, waves, worktrees, merge)
- State management (`.forge/state.json`, resume)
- Monitoring (SQLite persistence, SSE server, dashboard)
- Langfuse tracing

**Plugin** (Claude Code skills — thin orchestration layer):
- Requirement refinement using conversation context
- Launching `forgeai` CLI as subprocess
- Status rendering and monitor dashboard links
- Cross-plugin coordination (review, git, etc.)

The plugin is a **launcher and facilitator**, not a reimplementation.

## Relationship to Orchestrate & EEE Plugins

ForgeAI's engine was extracted from the orchestrate and EEE plugins (see extraction map in `docs/init-prd.md`). The forgeai plugin replaces them through graduated consolidation:

1. **Phase 5**: ForgeAI plugin provides planning + build skills that supersede orchestrate's `/orchestrate:run` and EEE's planning skills. ForgeAI's engine adds capabilities the plugins lack: Langfuse tracing, typed events, monitor dashboard, state persistence with resume, and the plan-review/plan-evaluate cycle.
2. **Phase 8**: Deprecate orchestrate + EEE plugins. ForgeAI plugin becomes the single entry point for plan-build-review workflows.

---

## Phase 5: Claude Code Plugin

**Goal**: Make forgeai accessible within Claude Code with a focus on planning quality.

**Location**: `forgeai-plugin/` in `schaake-cc-marketplace`

**Invocation model**: CLI subprocess via Bash Task (same pattern as orchestrate plugin). Requires `forgeai` to be installed and on PATH.

### Skills

#### `/forgeai:plan <source>`

Interactive planning facilitation. The core skill — this is why the plugin exists.

- Helps users refine requirements in-conversation using their full Claude Code context (MCP tools, codebase knowledge, prior discussion)
- Assesses scope (errand/excursion/expedition) interactively with the user
- Once requirements are solid, invokes `forgeai plan <source> --auto` as a Bash Task subprocess
- Streams plan output back for review
- Links to monitor dashboard for detailed progress

Frontmatter: `disable-model-invocation: true`, `context: fork`, `agent: general-purpose`

#### `/forgeai:build <planSet>`

Thin wrapper for build execution.

- Validates plan set exists and shows dry-run summary
- Delegates to `forgeai build <planSet> --auto` via Bash Task
- Points to monitor dashboard for real-time progress

Frontmatter: `disable-model-invocation: true`, `context: fork`, `agent: Bash`

#### `/forgeai:status`

Build status check.

- Reads `.forge/state.json` and renders plan statuses inline
- Links to monitor dashboard URL if monitor is running

Frontmatter: `disable-model-invocation: true`

#### `/forgeai:review <planSet>`

Code review delegation.

- Delegates to `forgeai review <planSet>` subprocess
- Renders review results inline

Frontmatter: `disable-model-invocation: true`, `context: fork`, `agent: Bash`

---

## Phase 6: Monitor Dashboard Enhancements

**Goal**: Enhance the existing web monitor to cover visualization needs that a TUI might have addressed.

Already shipped:
- Real-time SSE event streaming
- SQLite event persistence
- Run history sidebar
- Event timeline with expandable details
- Summary cards (duration, tokens, cost)

Enhancements:
- **Dependency graph view** — Mermaid-rendered plan dependency graph showing execution order and wave assignment
- **Plan file preview** — Render plan markdown with syntax highlighting
- **Wave visualization** — Show active wave, which plans are in each wave, progress per wave
- **File change heatmap** — Which files get touched by which plans (helps identify merge conflict risk)

---

## Phase 7: Planning Intelligence

**Goal**: Make the planning experience significantly better than raw CLI invocation.

### Conversational Planning Mode

New skill: `/forgeai:plan-interactive`

Multi-turn conversation where Claude Code helps the user build a PRD from a rough idea:
- Uses codebase context already in the conversation to ground requirements
- Asks targeted questions to fill gaps
- Produces a structured markdown PRD as output
- Then invokes `forgeai plan` with that PRD

### Plan Iteration

New skill: `/forgeai:plan-edit <planSet>`

After initial planning, let users review and refine plans in-conversation:
- Edit plan files interactively
- Re-run plan-review cycle on modified plans
- Handle "the plan is 80% right but I want to adjust the scope of plan-03"

### Plan Templates

Common patterns library for faster planning:
- API endpoint (route, handler, validation, tests)
- Database migration (schema change, data migration, rollback)
- Refactor (extract, rename, restructure)
- Feature flag (toggle, rollout, cleanup)

---

## Phase 8: Integration & Maturity

**Goal**: Full lifecycle coverage, CI support, provider flexibility.

### Headless/CI Mode

- `forgeai forge <source> --auto --json` for CI pipelines
- JSON event output mode for programmatic consumption
- GitHub Actions integration (PR comment with plan summary, build status)
- Webhook support for build start/complete/failed events

### Provider Abstraction

- The `AgentBackend` interface (`src/engine/backend.ts`) already supports provider swappability
- Add a second backend implementation (e.g., direct Anthropic API) for environments without Claude Agent SDK / Max subscription
- Enables forgeai in CI where SDK billing model doesn't apply

### Plugin Consolidation

- Deprecate orchestrate + EEE plugins
- ForgeAI plugin becomes the single entry point for plan-build-review workflows in Claude Code
- Migration guide for existing orchestrate/EEE users
