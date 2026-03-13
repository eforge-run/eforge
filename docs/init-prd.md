# aroh-forge: Standalone CLI Tool

## Context

Mark's schaake-cc-marketplace plugins (EEE, orchestrate, review) implement a complete plan-build-review loop for autonomous code generation. Chandra proved the concept overnight with a 12-hour multi-agent pipeline build. The goal is to extract this workflow into a standalone TypeScript CLI (`aroh-forge`) built on `@anthropic-ai/claude-agent-sdk`, so it works outside of Claude Code as an independent developer tool.

This is primarily an **extraction and repackaging** exercise — the skill logic, plan formats, orchestration patterns, and review policies already exist and are battle-tested.

## Design Principles

- **Library-first**: Core engine as a TypeScript library, CLI as a thin consumer. Enables headless, TUI, and web UI surfaces from the same engine.
- **Event-driven**: Engine communicates exclusively through typed `ForgeEvent`s via `AsyncGenerator` — never writes to stdout directly. Inspired by Pi's (badlogic/pi-mono) event-driven agent loop.
- **Mode-dependent clarification**: Interactive mid-plan (CLI), analyze-then-ask (headless/auto). Clarification uses engine-level events parsed from agent output, not the SDK's built-in `AskUserQuestion` tool.

## CLI Shape

```
aroh-forge plan <prd-or-prompt>    # PRD → execution plans
aroh-forge build <plan-set>        # Execute plans (implement + review)
aroh-forge review <plan-set>       # Review code against plans
aroh-forge status                  # Check running builds
```

Flags: `--auto` (bypass approval gates), `--verbose` (stream agent output), `--dry-run` (validate without executing)

## Invocation Surfaces

| Surface | Status | Description |
|---------|--------|-------------|
| **CLI** | v1 | Developer with PRD, interactive clarification, approval gates |
| **Headless** | future | Cloud/CI, no interaction, fully automated (`--auto`) |
| **TUI** | future | Guided terminal UI (Pi-inspired differential rendering), PRD → plans → approval → build |
| **Web UI** | future | Real-time monitoring dashboard + past run browsing |

All surfaces consume the same engine event stream.

## Tech Stack

- **Language**: TypeScript (ESM-only, `"type": "module"`)
- **Runtime**: Node.js 22+
- **Agent SDK**: `@anthropic-ai/claude-agent-sdk` (v0.2.74) — chosen over multi-provider SDKs for Max subscription billing (zero API cost). Vendor lock-in accepted.
- **CLI framework**: Commander.js
- **Build**: tsup → single `dist/cli.js` with shebang
- **Package manager**: pnpm

## Architecture Overview

```mermaid
graph TD
    subgraph Consumers["Consumers (thin)"]
        CLI["CLI (v1)"]
        TUI["TUI (future)"]
        Headless["Headless (future)"]
        WebUI["Web UI (future)"]
    end

    CLI & TUI & Headless & WebUI -->|ForgeEvent| EventStream["AsyncGenerator&lt;ForgeEvent&gt;"]

    subgraph Engine["Engine (library)"]
        EventStream --> ForgeCore["Forge Core\n(orchestrate)"]
        ForgeCore --> Planner
        ForgeCore --> Builder
        ForgeCore --> Reviewer
        Planner & Builder & Reviewer --> SDK["claude-agent-sdk\nquery()"]
        PlanParser["Plan Parser"] ~~~ State
        State ~~~ Worktree
        Worktree ~~~ Prompts
    end
```

## Engine (the library)

### Event System

The engine communicates exclusively through typed events. Consumers iterate over an `AsyncGenerator<ForgeEvent>` to render, persist, or stream events as appropriate.

```typescript
type ForgeEvent =
  // Lifecycle
  | { type: 'forge:start'; runId: string; planSet: string; command: 'plan' | 'build' | 'review'; timestamp: string }
  | { type: 'forge:end'; runId: string; result: ForgeResult; timestamp: string }

  // Planning
  | { type: 'plan:start'; source: string }
  | { type: 'plan:clarification'; questions: ClarificationQuestion[] }
  | { type: 'plan:clarification:answer'; answers: Record<string, string> }
  | { type: 'plan:progress'; message: string }
  | { type: 'plan:complete'; plans: PlanFile[] }

  // Building (per-plan)
  | { type: 'build:start'; planId: string }
  | { type: 'build:implement:start'; planId: string }
  | { type: 'build:implement:progress'; planId: string; message: string }
  | { type: 'build:implement:complete'; planId: string }
  | { type: 'build:review:start'; planId: string }
  | { type: 'build:review:complete'; planId: string; issues: ReviewIssue[] }
  | { type: 'build:evaluate:start'; planId: string }
  | { type: 'build:evaluate:complete'; planId: string; accepted: number; rejected: number }
  | { type: 'build:complete'; planId: string }
  | { type: 'build:failed'; planId: string; error: string }

  // Orchestration
  | { type: 'wave:start'; wave: number; planIds: string[] }
  | { type: 'wave:complete'; wave: number }
  | { type: 'merge:start'; planId: string }
  | { type: 'merge:complete'; planId: string }

  // Agent-level (streaming SDK output)
  | { type: 'agent:message'; planId?: string; agent: AgentRole; content: string }
  | { type: 'agent:tool_use'; planId?: string; agent: AgentRole; tool: string; input: unknown }
  | { type: 'agent:tool_result'; planId?: string; agent: AgentRole; tool: string; output: string }

  // User interaction needed
  | { type: 'approval:needed'; planId?: string; action: string; details: string }
  | { type: 'approval:response'; approved: boolean }
```

### Core Engine API

```typescript
interface ForgeEngine {
  plan(source: string, options: PlanOptions): AsyncGenerator<ForgeEvent>;
  build(planSet: string, options: BuildOptions): AsyncGenerator<ForgeEvent>;
  review(planSet: string, options: ReviewOptions): AsyncGenerator<ForgeEvent>;
  status(): ForgeStatus;
}

interface PlanOptions {
  name?: string;
  auto?: boolean;
  verbose?: boolean;
  cwd?: string;
  onClarification?: (questions: ClarificationQuestion[]) => Promise<Record<string, string>>;
}

interface BuildOptions {
  auto?: boolean;
  verbose?: boolean;
  dryRun?: boolean;
  cwd?: string;
  parallelism?: number;
  onApproval?: (action: string, details: string) => Promise<boolean>;
}
```

### Clarification System

The planner agent's prompt instructs it to output structured clarification blocks (`<clarification>...</clarification>` XML) when it encounters ambiguity. The engine parses these from the SDK message stream, pauses the generator, and surfaces them to the consumer via the `onClarification` callback.

```typescript
// Engine detects clarification block in agent output → emits event:
yield { type: 'plan:clarification', questions: parsedQuestions };

// Generator pauses. Consumer's onClarification callback runs:
// - CLI: readline prompts
// - TUI: renders dialog
// - Headless: no callback → engine proceeds with best guesses
// - Web: WebSocket message to browser

const answers = await options.onClarification?.(questions) ?? {};
yield { type: 'plan:clarification:answer', answers };

// Engine feeds answers back into the agent via streamInput()
```

## Agent Architecture

Self-contained prompts extracted into standalone `.md` files — no runtime plugin dependencies. Each agent wraps an SDK `query()` call and yields `ForgeEvent`s.

1. **Planner** — `query()` one-shot. Gets full tool access to explore codebase. Writes plan files. Outputs `<clarification>` blocks when encountering ambiguity.
2. **Builder** — Multi-turn (SDK `streamInput()`). Turn 1: implement plan → commit. After blind review completes, Turn 2: evaluate reviewer's unstaged fixes.
3. **Reviewer** — `query()` one-shot. Blind (no builder context). Reviews committed code, leaves fixes unstaged.

### Builder Multi-Turn Flow

```
Turn 1: Implement plan → commit
     ↓
Spawn blind reviewer (separate query, no builder context)
     ↓
Reviewer leaves fixes unstaged
     ↓
git reset --soft HEAD~1 (staged=implementation, unstaged=reviewer fixes)
     ↓
Turn 2: Evaluate fixes with full implementation context
  - Accept: strict improvements (null checks, missing await, security fixes)
  - Reject: intent-altering changes (refactors, removes features)
  - Review: correct but debatable (naming, defensive checks)
     ↓
Discard remaining unstaged → final commit
```

## Orchestration Flow

1. Parse orchestration.yaml → resolve dependency graph → compute execution waves
2. Create sibling worktree directory (`../{project}-{set}-worktrees/`) — avoids CLAUDE.md context pollution
3. Launch wave 1 plans in parallel (each in its own worktree)
4. Each plan: build → blind review → fix evaluation → final commit
5. As plans complete, launch newly-unblocked plans
6. Merge all branches in topological order
7. Run post-merge validation commands
8. Cleanup worktrees

### State Tracking

`.forge-state.json` tracks build progress for resume support:

```json
{
  "setName": "feature-name",
  "status": "running",
  "startedAt": "2026-03-12T10:00:00Z",
  "baseBranch": "main",
  "worktreeBase": "/absolute/path/to/worktrees",
  "plans": {
    "plan-01": {
      "status": "completed|running|pending|failed|blocked|merged",
      "worktreePath": "/path",
      "branch": "feature-name/component",
      "dependsOn": [],
      "merged": false
    }
  },
  "completedPlans": []
}
```

## Project Structure

```
src/
  engine/                     # The library (no stdout, events only)
    forge.ts                  # ForgeEngine: plan(), build(), review(), status()
    events.ts                 # ForgeEvent type definitions
    agents/
      planner.ts              # PRD → plan files (one-shot query)
      builder.ts              # Plan → implementation (multi-turn)
      reviewer.ts             # Blind review (one-shot query)
      common.ts               # Shared: SDK message → ForgeEvent mapping
    plan.ts                   # Plan file parsing (YAML frontmatter)
    state.ts                  # .forge-state.json read/write
    orchestrator.ts           # Dependency graph, wave execution
    worktree.ts               # Git worktree lifecycle
    prompts.ts                # Load/template .md prompt files
    prompts/
      planner.md
      builder.md
      reviewer.md
      evaluator.md
    config.ts                 # forge.yaml loading

  cli/                        # CLI consumer (thin)
    index.ts                  # Commander setup, wires engine → display
    display.ts                # ForgeEvent → stdout rendering
    interactive.ts            # Clarification prompts, approval gates

  cli.ts                      # Entry point (shebang, imports cli/index)
```

## Extraction Map

Source skills → aroh-forge components:

| Source (schaake-cc-marketplace) | Target (aroh-forge) | What to extract |
|---|----|---|
| `eee/skills/excursion-planner/` | `engine/prompts/planner.md` + `engine/agents/planner.ts` | Plan generation logic, format spec, codebase exploration strategy |
| `eee/skills/expedition-compiler/` | `engine/plan.ts` | orchestration.yaml + plan file format, dependency resolution |
| `orchestrate/skills/orchestration-coordinator/` | `engine/orchestrator.ts` + `engine/worktree.ts` | Wave execution, worktree management, merge strategy, state tracking |
| `orchestrate/skills/plan-parser/` | `engine/plan.ts` | Frontmatter parsing, plan validation |
| `review/skills/code-review/` + policies | `engine/prompts/reviewer.md` + `engine/agents/reviewer.ts` | Review criteria, severity levels, multi-policy review |
| `review/skills/evaluate-fixes/` | `engine/prompts/evaluator.md` (used in builder turn 2) | Accept/reject/review hunk classification |

## Implementation Phases

### Phase 1: Engine Foundation + Plan Command
1. `engine/events.ts` — event type definitions
2. `engine/prompts.ts` — load .md prompt files
3. `engine/plan.ts` — parse plan files (YAML frontmatter)
4. `engine/agents/common.ts` — SDK message → ForgeEvent mapping
5. `engine/agents/planner.ts` — planner agent (one-shot query)
6. `engine/forge.ts` — ForgeEngine with `plan()` method
7. `cli/display.ts` — render plan events to stdout
8. `cli/interactive.ts` — clarification prompts
9. `cli/index.ts` — wire Commander → engine
10. `prompts/planner.md` — extract from excursion-planner skill
11. **Test**: `aroh-forge plan "Add a health check endpoint"` in a test repo

### Phase 2: Build Command (single plan)
1. `engine/agents/builder.ts` — multi-turn builder
2. `engine/agents/reviewer.ts` — blind reviewer
3. `engine/state.ts` — build state tracking
4. `engine/forge.ts` — add `build()` method
5. `prompts/builder.md`, `reviewer.md`, `evaluator.md`
6. **Test**: `aroh-forge build <plan-set>` with a single plan

### Phase 3: Parallel Orchestration
1. `engine/orchestrator.ts` — dependency graph, wave execution
2. `engine/worktree.ts` — git worktree lifecycle
3. `cli/display.ts` — parallel progress rendering
4. **Test**: multi-plan set with dependencies

### Phase 4: Polish
1. `engine/config.ts` — forge.yaml
2. Resume support (read existing .forge-state.json)
3. `--auto` / interactive gates
4. `status` and `review` commands
5. Langfuse tracing
6. Error handling, cleanup on interrupt

### Phase 5 (future): TUI
- Dedicated TUI consumer using Pi-inspired patterns (differential rendering, components)
- Rich multi-plan progress display
- Guided workflow from PRD → plans → approval → build

### Phase 6 (future): Web UI + Event Persistence
- Event recorder middleware persists all ForgeEvents to SQLite (`.forge.db`)
- Web server serves dashboard for monitoring live runs + browsing past runs
- Real-time via WebSocket/SSE, history via query

**Event persistence schema**:
```sql
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  plan_set TEXT NOT NULL,
  command TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  cwd TEXT NOT NULL
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  type TEXT NOT NULL,
  plan_id TEXT,
  agent TEXT,
  data JSON NOT NULL,
  timestamp TEXT NOT NULL
);
```

The recorder is opt-in middleware, not baked into the engine:
```typescript
function withRecording(
  events: AsyncGenerator<ForgeEvent>,
  db: Database
): AsyncGenerator<ForgeEvent>
```

## Key Design Decisions

1. **AsyncGenerator event stream** — Engine yields `ForgeEvent`s, never writes stdout. Consumers iterate and render. Enables CLI, headless, TUI, and web UI from the same engine.
2. **Clarification via engine-level events** — Not SDK's `AskUserQuestion`. Planner outputs `<clarification>` XML, engine parses and surfaces via `onClarification` callback. Keeps UX decoupled from SDK.
3. **Approval gates via callback** — `onApproval` for plan-approval, pre-build confirmation. Auto mode skips them.
4. **Claude Agent SDK (Max billing)** — Chose over multi-provider SDKs. Max subscription = zero API cost. Battle-tested tools (Bash, FileRead, FileEdit, Glob, Grep). Vendor lock-in accepted.
5. **Prompts as static .md files** — Loaded at runtime, bundled by tsup. No plugin dependencies.
6. **Worktrees in sibling directory** — `../{project}-{set}-worktrees/` to avoid CLAUDE.md context pollution.
7. **State file for resume** — `.forge-state.json` tracks plan statuses, worktree paths, branches.
8. **Event persistence as middleware** — Optional SQLite recorder wraps the event stream. Engine stays pure.

## Telemetry

Langfuse tracing for all agent SDK calls. Dogfoods the aroh observability story — forge becomes the first "customer" of the diagnosis flywheel.

- **SDK**: `langfuse` npm package (JS SDK)
- **Config**: `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST` from env or forge.yaml
- **Trace structure**: one trace per `aroh-forge` invocation, spans per agent call (planner, builder, reviewer, evaluator)
- **Captured**: model, token usage, wall-clock duration, success/failure, plan metadata

## Repo

Separate repo at `~/projects/aroh/forge/` (GitHub: `aroh-ai/forge`). Bring into flywheel monorepo via `git subtree add` once baked. Zero code dependencies on flywheel — connects via MCP only.

## Verification

1. `aroh-forge plan "Add a health check endpoint"` → emits plan events, produces plan files
2. `aroh-forge plan "Add auth" --auto` → no prompts, proceeds with best guesses
3. `aroh-forge build <plan-set>` → implement → review → evaluate → clean commits
4. `aroh-forge build <plan-set> --verbose` → streams agent output
5. Multi-plan with deps → correct wave ordering, parallel execution, clean merge
6. Interrupted build → `aroh-forge status` shows state, re-run resumes

## Open Questions (deferred)

- **Package publishing**: npm? GitHub package? Private for now?
- **MCP integration**: Should forge optionally connect to aroh flywheel MCP to receive findings as input to plan generation?
