---
id: plan-01-foundation
name: Foundation
depends_on: []
branch: forge-v1/foundation
---

# Foundation

## Architecture Context

This module implements the **foundation** layer — all shared types, parsers, and utilities that every other module depends on (Wave 1).

Key constraints from architecture:
- Engine emits, consumers render — all types must support the `AsyncGenerator<ForgeEvent>` pattern
- `ForgeEvent` is a namespace-prefixed discriminated union — exhaustive matching must be possible
- Plan files use YAML frontmatter + markdown body
- Prompts are static `.md` files loaded at runtime
- SDK message mapping bridges `@anthropic-ai/claude-agent-sdk` types to `ForgeEvent`
- State file (`.forge-state.json`) enables crash-resume

### ForgeEvent Type

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

### Supporting Types

```typescript
interface PlanFile {
  id: string;
  name: string;
  dependsOn: string[];
  branch: string;
  migrations?: Array<{ timestamp: string; description: string }>;
  body: string;
  filePath: string;
}

interface OrchestrationConfig {
  name: string;
  description: string;
  created: string;
  mode: 'excursion' | 'expedition';
  baseBranch: string;
  plans: Array<{ id: string; name: string; dependsOn: string[]; branch: string }>;
}

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

interface ClarificationQuestion {
  id: string;
  question: string;
  context?: string;
  options?: string[];
  default?: string;
}

interface ReviewIssue {
  severity: 'critical' | 'warning' | 'suggestion';
  category: string;
  file: string;
  line?: number;
  description: string;
  fix?: string;
}

interface ForgeStatus {
  running: boolean;
  setName?: string;
  plans: Record<string, PlanState['status']>;
  completedPlans: string[];
}
```

## Implementation

### Overview

Six focused files, each with a single responsibility. All are pure library code — no I/O side effects beyond file reads (prompts, state). No stdout. Every function is independently testable.

### Key Decisions

1. **Hand-roll frontmatter parsing** rather than adding `gray-matter` — it's a simple regex split (`---\n...\n---`) + `yaml.parse()`. One fewer dependency.
2. **Dependency graph uses Kahn's algorithm** (BFS topological sort) — straightforward, detects cycles, naturally produces waves by BFS depth.
3. **Clarification parser uses regex** to extract `<clarification>` XML blocks from assistant text, then parses the inner structure. Robust against partial/malformed output.
4. **SDK mapper is a generator function** `mapSDKMessages()` that takes an `AsyncIterable<SDKMessage>` and yields individual `ForgeEvent`s — composable with the agent generators upstream.
5. **State operations are synchronous** (`readFileSync`/`writeFileSync`) — state file is small, and atomic writes prevent corruption. Reads happen at startup, writes after each status change.
6. **Prompt loader caches** loaded prompts in a `Map<string, string>` keyed by filename — prompts don't change during a run.
7. **Re-export all types from a barrel** `src/engine/index.ts` — downstream modules import from `../engine/index.js`.

## Scope

### In Scope
- `ForgeEvent` discriminated union type and all supporting types (`AgentRole`, `ForgeResult`, `ClarificationQuestion`, `ReviewIssue`, `PlanFile`, `OrchestrationConfig`, `ForgeState`, `PlanState`, engine option interfaces)
- Plan file parser — YAML frontmatter extraction, `PlanFile` construction, validation
- Orchestration config parser — `orchestration.yaml` → `OrchestrationConfig`
- Dependency graph resolver — topological sort into execution waves + merge order
- Plan set validator — structural checks on plan files and orchestration config
- Prompt loader — read `.md` files from `src/engine/prompts/`, substitute template variables
- SDK message → `ForgeEvent` mapper — convert `SDKMessage` stream to typed engine events
- Clarification XML parser — extract `<clarification>` blocks from assistant message text
- State file I/O — load, save, update plan status, check resumability
- Add `yaml` npm dependency for YAML parsing

### Out of Scope
- Agent implementations (planner, builder, reviewer) → respective modules
- Orchestrator / worktree lifecycle → orchestration module
- `forge.yaml` config loading → config module
- `ForgeEngine` class / integration → forge-core module
- CLI commands, display, interactive prompts → cli module
- Prompt `.md` file content (the actual prompts) → agent modules will create those

## Files

### Create

- `src/engine/events.ts` — `ForgeEvent` discriminated union, `AgentRole`, `ForgeResult`, `ClarificationQuestion`, `ReviewIssue`, `PlanFile`, `OrchestrationConfig`, `ForgeState`, `PlanState`, `PlanOptions`, `BuildOptions`, `ReviewOptions`, `ForgeStatus`
- `src/engine/plan.ts` — `parsePlanFile(mdPath)`, `parseOrchestrationConfig(yamlPath)`, `resolveDependencyGraph(plans)`, `validatePlanSet(configPath)`
- `src/engine/prompts.ts` — `loadPrompt(name, vars?)` — reads from `src/engine/prompts/` (or bundled path), substitutes `{{var}}` placeholders
- `src/engine/agents/common.ts` — `mapSDKMessages(messages, agent, planId?)` async generator, `parseClarificationBlocks(text)` helper
- `src/engine/state.ts` — `loadState(stateDir)`, `saveState(stateDir, state)`, `updatePlanStatus(state, planId, status)`, `isResumable(state)`
- `src/engine/index.ts` — Barrel re-exports from all foundation files

### Modify

- `package.json` — Add `yaml` to `dependencies`

## Verification

- [ ] `pnpm run type-check` passes with zero errors
- [ ] `pnpm run build` produces `dist/cli.js` without errors
- [ ] `ForgeEvent` type matches architecture spec exactly (all variants present)
- [ ] `parsePlanFile()` correctly parses YAML frontmatter + markdown body from a `.md` plan file
- [ ] `parseOrchestrationConfig()` correctly parses a valid `orchestration.yaml`
- [ ] `resolveDependencyGraph()` returns correct wave groupings and merge order (topological)
- [ ] `resolveDependencyGraph()` throws on circular dependencies
- [ ] `validatePlanSet()` reports missing/malformed plan files
- [ ] `loadPrompt()` reads `.md` files and substitutes `{{variable}}` placeholders
- [ ] `mapSDKMessages()` yields appropriate `ForgeEvent`s for `SDKAssistantMessage`, `SDKPartialAssistantMessage`, and `SDKResultMessage`
- [ ] `parseClarificationBlocks()` extracts structured questions from `<clarification>` XML in text
- [ ] `loadState()` / `saveState()` round-trips a `ForgeState` object through JSON
- [ ] `updatePlanStatus()` correctly mutates plan status and updates `completedPlans`
- [ ] `isResumable()` returns true only when state is `running` and has incomplete plans
- [ ] All exports available via `src/engine/index.ts` barrel
