# forge-v1 Architecture

## Vision

aroh-forge is a standalone CLI tool that extracts the plan-build-review autonomous coding loop from schaake-cc-marketplace Claude Code plugins into a portable TypeScript library + CLI. The architecture separates a pure, event-driven engine (the library) from thin consumer layers (CLI, future TUI/headless/web UI), enabling the same orchestration logic to power multiple invocation surfaces.

## Core Principles

1. **Engine emits, consumers render** — The engine yields typed `ForgeEvent`s via `AsyncGenerator`, never writes to stdout. All display logic lives in consumers.
2. **Callbacks for interaction** — Clarification and approval gates use callbacks (`onClarification`, `onApproval`). CLI provides readline implementations; headless provides none; TUI/web provide their own.
3. **Prompts are data, not code** — Agent behavior is defined in `.md` prompt files loaded at runtime. No plugin dependencies.
4. **SDK as runtime host** — `@anthropic-ai/claude-agent-sdk` provides the agent runtime (LLM, tools, permissions). It's a devDependency expected at runtime, not bundled.

## Shared Data Model

### ForgeEvent

The central communication type. All engine→consumer communication flows through this discriminated union:

```typescript
// Namespace-prefixed type discriminator
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

  // Agent-level (verbose streaming)
  | { type: 'agent:message'; planId?: string; agent: AgentRole; content: string }
  | { type: 'agent:tool_use'; planId?: string; agent: AgentRole; tool: string; input: unknown }
  | { type: 'agent:tool_result'; planId?: string; agent: AgentRole; tool: string; output: string }

  // User interaction
  | { type: 'approval:needed'; planId?: string; action: string; details: string }
  | { type: 'approval:response'; approved: boolean }

type AgentRole = 'planner' | 'builder' | 'reviewer' | 'evaluator';
type ForgeResult = { status: 'completed' | 'failed'; summary: string };
```

### PlanFile

Parsed representation of a plan file (YAML frontmatter + markdown body):

```typescript
interface PlanFile {
  id: string;            // e.g. "plan-01-auth-api"
  name: string;          // "Auth API"
  dependsOn: string[];   // ["plan-01-database"]
  branch: string;        // "feature/auth-api"
  migrations?: Array<{ timestamp: string; description: string }>;
  body: string;          // Markdown content (scope, implementation, files, verification)
  filePath: string;      // Absolute path to the .md file
}
```

### OrchestrationConfig

Parsed representation of `orchestration.yaml`:

```typescript
interface OrchestrationConfig {
  name: string;
  description: string;
  created: string;
  mode: 'excursion' | 'expedition';
  baseBranch: string;
  plans: Array<{
    id: string;
    name: string;
    dependsOn: string[];
    branch: string;
  }>;
}
```

### ForgeState

Build state persisted to `.forge-state.json`:

```typescript
interface ForgeState {
  setName: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
  baseBranch: string;
  worktreeBase: string;
  plans: Record<string, PlanState>;
  completedPlans: string[];
}

interface PlanState {
  status: 'pending' | 'running' | 'completed' | 'failed' | 'blocked' | 'merged';
  worktreePath?: string;
  branch: string;
  dependsOn: string[];
  merged: boolean;
  error?: string;
}
```

### ClarificationQuestion

```typescript
interface ClarificationQuestion {
  id: string;
  question: string;
  context?: string;     // Why the agent is asking
  options?: string[];   // Suggested answers (optional)
  default?: string;     // Default if no callback / auto mode
}
```

### ReviewIssue

```typescript
interface ReviewIssue {
  severity: 'critical' | 'warning' | 'suggestion';
  category: string;     // "bug", "security", "error-handling", "edge-case", etc.
  file: string;
  line?: number;
  description: string;
  fix?: string;         // Suggested fix (unstaged by reviewer)
}
```

## Integration Contracts

### Engine → Consumer (ForgeEvent stream)

```typescript
interface ForgeEngine {
  plan(source: string, options: PlanOptions): AsyncGenerator<ForgeEvent>;
  build(planSet: string, options: BuildOptions): AsyncGenerator<ForgeEvent>;
  review(planSet: string, options: ReviewOptions): AsyncGenerator<ForgeEvent>;
  status(): ForgeStatus;
}
```

```typescript
interface ReviewOptions {
  auto?: boolean;
  verbose?: boolean;
  cwd?: string;
}

interface ForgeStatus {
  running: boolean;
  setName?: string;
  plans: Record<string, PlanState['status']>;
  completedPlans: string[];
}
```

Consumers iterate the generator. The engine may pause the generator when it needs user input (clarification, approval) — the consumer's callback resolves the pause.

### Engine → SDK (query calls)

Each agent wraps SDK `query()`:

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

// One-shot (planner, reviewer)
const q = query({
  prompt: composedPrompt,
  options: {
    cwd: workingDir,
    tools: { type: 'preset', preset: 'claude_code' },
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    maxTurns: 30,
    abortController: controller,
  }
});
for await (const msg of q) { /* map to ForgeEvent */ }

// Multi-turn (builder)
// Uses AsyncIterable<SDKUserMessage> as prompt + streamInput() for turn 2
```

### Agent Common → SDK Message Mapping

`agents/common.ts` maps `SDKMessage` types to `ForgeEvent`:

| SDK Message Type | ForgeEvent Type |
|---|---|
| `SDKAssistantMessage` | `agent:message` |
| `SDKResultMessage` (tool result) | `agent:tool_result` |
| Tool use content blocks | `agent:tool_use` |
| `SDKPartialAssistantMessage` | `agent:message` (streaming delta) |

The mapper also detects `<clarification>` XML blocks in assistant messages and extracts them as `ClarificationQuestion[]`.

### Orchestrator → Worktree Manager

```typescript
// worktree.ts exports
function createWorktree(repoRoot: string, branch: string, worktreeBase: string): Promise<string>;
function removeWorktree(worktreePath: string): Promise<void>;
function mergeWorktree(repoRoot: string, branch: string, targetBranch: string): Promise<void>;
function cleanupWorktrees(worktreeBase: string): Promise<void>;
```

### Orchestrator → Plan Parser

```typescript
// plan.ts exports
function parseOrchestrationConfig(yamlPath: string): Promise<OrchestrationConfig>;
function parsePlanFile(mdPath: string): Promise<PlanFile>;
function resolveDependencyGraph(plans: OrchestrationConfig['plans']): { waves: string[][]; mergeOrder: string[] };
function validatePlanSet(configPath: string): Promise<{ valid: boolean; errors: string[] }>;
```

### Orchestrator → State Manager

```typescript
// state.ts exports
function loadState(stateDir: string): ForgeState | null;
function saveState(stateDir: string, state: ForgeState): void;
function updatePlanStatus(state: ForgeState, planId: string, status: PlanState['status']): ForgeState;
function isResumable(state: ForgeState): boolean;
```

## Technical Decisions

### ADR-001: AsyncGenerator Event Stream
**Status**: Accepted
**Context**: Need to support CLI, headless, TUI, and web UI from the same engine. Traditional callback or EventEmitter patterns create tight coupling.
**Decision**: Engine methods return `AsyncGenerator<ForgeEvent>`. Consumers iterate with `for await...of`.
**Consequences**: Clean separation. Consumers are just loops. Event persistence is a passthrough wrapper. Backpressure is handled naturally by the generator protocol. Tradeoff: parallel plan events need multiplexing (orchestrator must interleave events from concurrent plans).

### ADR-002: Engine-Level Clarification (not SDK tool)
**Status**: Accepted
**Context**: The SDK provides `AskUserQuestion` tool, but using it ties UX to SDK behavior and makes headless/TUI/web harder.
**Decision**: Planner prompt instructs the agent to output `<clarification>` XML blocks. Engine parses these from the message stream, pauses, and surfaces via `onClarification` callback.
**Consequences**: Full UX control per consumer. Slightly more complex prompt engineering. Must handle edge case where agent doesn't use the XML format.

### ADR-003: Claude Agent SDK (Max Billing)
**Status**: Accepted
**Context**: Pi's multi-provider SDK offers flexibility. Claude SDK offers Max subscription billing (zero per-token cost) and battle-tested Claude Code tools.
**Decision**: Use `@anthropic-ai/claude-agent-sdk`. Accept vendor lock-in.
**Consequences**: Free agent calls on Max. Full Claude Code toolset. Cannot switch LLM providers without engine rewrite.

### ADR-004: Sibling Worktree Directory
**Status**: Accepted
**Context**: Parallel plans run in git worktrees. Worktrees inside the repo pollute CLAUDE.md context for all agents.
**Decision**: Create worktrees in `../{project}-{set}-worktrees/` (sibling to repo root).
**Consequences**: Agents see a clean working directory. Cleanup is straightforward (remove the sibling dir). Edge case: parent directory permissions.

### ADR-005: Prompts as Static .md Files
**Status**: Accepted
**Context**: Source prompts live in schaake-cc-marketplace plugin SKILL.md files. Could load plugins at runtime or extract to standalone files.
**Decision**: Extract and adapt prompts into `src/engine/prompts/*.md`. Load at runtime. Bundle with tsup.
**Consequences**: Zero plugin dependencies. Prompts are versionable, diffable, self-contained. Must manually sync if upstream plugins evolve (acceptable — forge is the successor, not a consumer).

### ADR-006: Event Persistence as Middleware
**Status**: Accepted
**Context**: Web UI needs to query past runs and stream live events. Could bake storage into the engine or layer it on top.
**Decision**: Optional `withRecording()` wrapper that persists events to SQLite as they pass through. Engine stays pure.
**Consequences**: Engine is testable without storage. Recording is opt-in. SQLite schema is simple (runs + events tables). Web UI reads from the same DB.

## Quality Attributes

### Performance
- Parallel plan execution bounded by `parallelism` option (default: CPU cores)
- Worktree creation is the main bottleneck (full git checkout) — mitigated by reusing worktrees on resume
- Event stream is lazy (generator) — no buffering unless consumer opts in

### Reliability
- State file enables resume after crash/interrupt
- Each plan's work is isolated in a worktree — one plan's failure doesn't corrupt others
- Cleanup runs even on error (try/finally pattern in orchestrator)
- Blocked plans are marked when dependencies fail

### Security
- `permissionMode: 'bypassPermissions'` means agents run with full tool access — this is intentional for autonomous operation
- `.forge-state.json` and `.forge.db` are gitignored (may contain paths, timestamps)
- No secrets stored in state — Langfuse keys come from env vars

## Module Overview

| Module | Purpose | Dependencies |
|--------|---------|--------------|
| **foundation** | ForgeEvent types, plan parsing, prompt loading, SDK→event mapping | none |
| **planner** | Planner agent + planner prompt extraction | foundation |
| **builder** | Builder agent (multi-turn) + builder/evaluator prompts | foundation |
| **reviewer** | Reviewer agent + reviewer prompt extraction | foundation |
| **orchestration** | Dependency graph, wave execution, worktree lifecycle, state tracking | foundation |
| **forge-core** | ForgeEngine integration (plan/build/review/status methods) | planner, builder, reviewer, orchestration |
| **cli** | Commander wiring, display rendering, interactive prompts | forge-core |
| **config** | forge.yaml loading, Langfuse tracing setup | foundation |

### Dependency Graph

```mermaid
graph TD
    foundation --> planner
    foundation --> builder
    foundation --> reviewer
    foundation --> orchestration
    foundation --> config
    planner --> forge-core
    builder --> forge-core
    reviewer --> forge-core
    orchestration --> forge-core
    forge-core --> cli
```

### Wave Execution

- **Wave 1**: foundation (must complete first — all types and utilities)
- **Wave 2**: planner, builder, reviewer, orchestration, config (all parallel)
- **Wave 3**: forge-core (integrates wave 2 modules)
- **Wave 4**: cli (thin consumer of forge-core)
