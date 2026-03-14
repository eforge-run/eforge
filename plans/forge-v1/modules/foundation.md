# Foundation

## Architecture Reference

This module implements the **foundation** layer from the architecture — all shared types, parsers, and utilities that every other module depends on (Wave 1).

Key constraints from architecture:
- Engine emits, consumers render — all types must support the `AsyncGenerator<ForgeEvent>` pattern
- `ForgeEvent` is a namespace-prefixed discriminated union — exhaustive matching must be possible
- Plan files use YAML frontmatter + markdown body
- Prompts are static `.md` files loaded at runtime
- SDK message mapping bridges `@anthropic-ai/claude-agent-sdk` types to `ForgeEvent`
- State file (`.forge-state.json`) enables crash-resume

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

## Dependencies

| Module | Dependency Type | Notes |
|--------|-----------------|-------|
| (none) | - | Foundation has no module dependencies |

### External Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `yaml` | ^2.x | Parse YAML frontmatter in plan files and orchestration.yaml |
| `@anthropic-ai/claude-agent-sdk` | ^0.2.74 | SDK message types (`SDKMessage`, `SDKAssistantMessage`, etc.) for the mapper |

## Implementation Approach

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

## Testing Strategy

No test framework is configured yet. Verification will be done via type-checking and manual validation.

### Type Check
- `pnpm type-check` must pass with zero errors
- All `ForgeEvent` variants must be exhaustively enumerable via `switch(event.type)`

### Manual Validation
- Import and call `parsePlanFile()` on an existing plan file in `plans/`
- Import and call `parseOrchestrationConfig()` on a sample orchestration.yaml
- Verify `resolveDependencyGraph()` produces correct waves for the forge-v1 module graph
- Verify `loadPrompt()` reads and templates a test `.md` file
- Verify `parseClarificationBlocks()` extracts questions from sample XML

### Build
- `pnpm build` must succeed — tsup bundles all new files

## Verification Criteria

- [ ] `pnpm type-check` passes with zero errors
- [ ] `pnpm build` produces `dist/cli.js` without errors
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
