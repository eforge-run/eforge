---
id: plan-01-config-and-agent
name: Config, Pipeline Registration, and Dependency Detector Agent
depends_on: []
branch: parallel-queue-builds/config-and-agent
---

# Config, Pipeline Registration, and Dependency Detector Agent

## Architecture Context

This plan adds the foundational pieces needed by the queue scheduler: the `prdQueue.parallelism` config option, the `dependency-detector` agent role registration, and the new dependency detector agent itself. These are independent of the scheduler restructuring and must land first so the scheduler plan can reference them.

The dependency detector follows the exact pattern of `formatter.ts` - a toolless, single-turn agent that takes structured input and returns JSON output. It runs during `enqueue()` to auto-populate `depends_on` frontmatter.

## Implementation

### Overview

Three areas of change:
1. Add `parallelism` to `prdQueue` config schema and defaults
2. Register `dependency-detector` as a new agent role across config, events, and pipeline
3. Implement the dependency detector agent and its prompt

### Key Decisions

1. **Model class `max`** for dependency-detector, consistent with all other roles in `AGENT_MODEL_CLASSES`. The PRD originally suggested `fast` but the actual codebase has all roles at `max`. Users can override to `fast` via per-role `modelClass` config if desired.
2. **Toolless one-shot pattern** - same as `formatter.ts`: `maxTurns: 1`, `tools: 'none'`, returns parsed JSON.
3. **`parallelism` default of `1`** - backwards-compatible sequential behavior. Existing users see no change.

## Scope

### In Scope
- `prdQueue.parallelism` config schema field and default value
- `dependency-detector` added to `AGENT_ROLES`, `AgentRole` type, and `AGENT_MODEL_CLASSES`
- New `src/engine/agents/dependency-detector.ts` agent runner
- New `src/engine/prompts/dependency-detector.md` prompt template
- Integration of dependency detection into `EforgeEngine.enqueue()` flow

### Out of Scope
- Greedy scheduler restructuring of `runQueue()` (plan-02)
- CLI `--queue-parallelism` flag (plan-02)
- Removal of `git reset --hard` (plan-02)

## Files

### Create
- `src/engine/agents/dependency-detector.ts` - Toolless one-shot agent that analyzes a new PRD against existing queue items and running builds to produce a `depends_on` JSON array. Follows the `formatter.ts` pattern: extends `SdkPassthroughConfig`, uses `loadPrompt('dependency-detector', ...)`, `maxTurns: 1`, `tools: 'none'`, parses JSON output.
- `src/engine/prompts/dependency-detector.md` - Prompt template with placeholders for `{{prdContent}}`, `{{queueItems}}` (JSON array of `{id, title, scopeSummary}`), and `{{runningBuilds}}` (JSON array of `{planSetName, planTitles}`). Instructs the agent to return a JSON array of PRD ids that the new PRD should depend on, or `[]` if independent. Criteria: declare dependency when two PRDs likely modify the same files or when the new PRD's work builds on another's output.

### Modify
- `src/engine/config.ts` - Add `parallelism: z.number().int().positive().optional()` to the `prdQueue` schema (line 264-269). Add `'dependency-detector'` to `AGENT_ROLES` array (line 14-21). Update `DEFAULT_CONFIG.prdQueue` to include `parallelism: 1` (line 393). Update the `ResolvedConfig` type's `prdQueue` field (line 334) to include `parallelism: number`. Update `resolveConfig()` (line 495-500) to thread `parallelism` through: `parallelism: fileConfig.prdQueue?.parallelism ?? DEFAULT_CONFIG.prdQueue.parallelism`.
- `src/engine/events.ts` - Add `'dependency-detector'` to the `AgentRole` union type (line 10).
- `src/engine/pipeline.ts` - Add `'dependency-detector': 'max'` to `AGENT_MODEL_CLASSES` map (around line 274).
- `src/engine/eforge.ts` - Import `runDependencyDetector` from `./agents/dependency-detector.js`. In `enqueue()` method (lines 334-398), after formatter runs and title is inferred but before `enqueuePrd()`, add dependency detection step: load queue via `loadQueue()`, load state via `loadState()`, run the dependency detector agent, parse the JSON output into `depends_on` string array, and pass it to `enqueuePrd()`. Wrap in try/catch so detection failure doesn't block enqueue (falls back to empty `depends_on`).

## Verification

- [ ] `pnpm type-check` passes with zero errors
- [ ] `pnpm test` passes - no existing tests break
- [ ] `AGENT_ROLES` array in `config.ts` includes `'dependency-detector'`
- [ ] `AgentRole` type in `events.ts` includes `'dependency-detector'`
- [ ] `AGENT_MODEL_CLASSES` in `pipeline.ts` has entry for `'dependency-detector'` with value `'max'`
- [ ] `DEFAULT_CONFIG.prdQueue.parallelism` equals `1`
- [ ] `dependency-detector.ts` exports `runDependencyDetector` as an async generator matching the `formatter.ts` pattern
- [ ] `enqueue()` calls `runDependencyDetector` after formatting, before `enqueuePrd()`, and passes the returned `depends_on` array to `enqueuePrd()`
- [ ] If dependency detection throws, `enqueue()` continues with empty `depends_on` (graceful fallback)
