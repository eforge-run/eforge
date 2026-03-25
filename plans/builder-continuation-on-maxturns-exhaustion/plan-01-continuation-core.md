---
id: plan-01-continuation-core
name: Builder Continuation on maxTurns Exhaustion
depends_on: []
branch: builder-continuation-on-maxturns-exhaustion/continuation-core
---

# Builder Continuation on maxTurns Exhaustion

## Architecture Context

The builder agent (`src/engine/agents/builder.ts`) runs with a fixed `maxTurns` (default 75). When the Claude Agent SDK exhausts turns, it emits a result with `subtype: 'error_max_turns'`, which `mapSDKMessages()` in `src/engine/backends/claude-sdk.ts` converts to a thrown `Error` (line 200-203: `Agent builder failed: error_max_turns`). The `builderImplement()` function catches this and yields a `build:failed` event (line 118-120). The `implementStage` in `pipeline.ts` detects `build:failed` and sets `ctx.buildFailed = true`, halting the build.

The continuation mechanism adds a retry loop in `implementStage` that intercepts `error_max_turns` failures specifically, checkpoints progress via `forgeCommit()`, and relaunches the builder with a continuation prompt containing the diff of completed work. This follows the same composite-stage pattern as `review-cycle` (pipeline.ts lines 914-937).

## Implementation

### Overview

Add a continuation loop to the `implementStage` build stage that detects `error_max_turns` failures, checkpoints partial work, and relaunches the builder with context about what was already done. Add the supporting event type, config field, and builder prompt template changes.

### Key Decisions

1. **Continuation lives in `implementStage`, not `builderImplement()`** — The stage owns the retry policy, git operations, and event emission. `builderImplement()` stays a single-invocation function. This keeps the builder agent pure (prompt in, events out) and the stage responsible for orchestration.

2. **Detect `error_max_turns` from `build:failed` event error string** — `builderImplement()` already catches errors and yields `build:failed` with the error message. The continuation loop checks `event.error` for `error_max_turns` rather than restructuring error propagation. This is the least invasive approach.

3. **Intermediate commits via `forgeCommit()`** — WIP commits checkpoint progress and get squashed during the final merge. The builder prompt already instructs the agent to stage all changes, but the builder may not have committed before hitting the turn limit. The continuation loop runs `git add -A` then `forgeCommit()` to ensure all work is captured.

4. **Diff truncation** — Large diffs (>50,000 chars) are truncated to a file-list summary to avoid filling the continuation builder's context. The file list includes per-file change stats from `git diff --stat`.

5. **`maxContinuations` defaults to 3** — Added to the `agents` config section alongside `maxTurns`. Per-plan override available in `OrchestrationConfig.plans` entries.

## Scope

### In Scope
- Continuation loop in `implementStage` triggered by `error_max_turns` in `build:failed` events
- Intermediate git commit checkpointing via `forgeCommit()`
- Continuation prompt generation with completed diff context
- `maxContinuations` config at global (`agents.maxContinuations`) and per-plan levels
- New `build:implement:continuation` event type
- CLI rendering of the continuation event
- Builder prompt template update for continuation context
- Diff size management (truncation for large diffs)
- Unit tests for continuation loop logic using StubBackend

### Out of Scope
- Dynamic scaling of `maxTurns`
- Changes to the review-cycle or other composite stages
- Monitor UI updates for the new event (the monitor already handles unknown events gracefully)
- Changes to `ClaudeSDKBackend` or `AgentBackend` interface

## Files

### Modify
- `src/engine/events.ts` — Add `build:implement:continuation` to the `EforgeEvent` union type. Add optional `maxContinuations?: number` to `OrchestrationConfig.plans` entries.
- `src/engine/plan.ts` — Update `parseOrchestrationConfig()` to parse `maxContinuations` from plan entries (add `maxContinuations: typeof p.maxContinuations === 'number' ? p.maxContinuations : undefined` to the plan mapping at ~line 189-196, and add `...(p.max_continuations != null && { maxContinuations: Number(p.max_continuations) })` or equivalent).
- `src/engine/config.ts` — Add `maxContinuations` (default: 3) to the `agents` config section in `DEFAULT_CONFIG`, the Zod schema (`eforgeConfigSchema`), the `EforgeConfig` interface (add `maxContinuations: number` to the `agents` type literal), and the `resolveConfig()` merge logic (add `maxContinuations: fileConfig.agents?.maxContinuations ?? DEFAULT_CONFIG.agents.maxContinuations` alongside the existing agents fields).
- `src/engine/pipeline.ts` — Wrap `builderImplement()` call in `implementStage` with a continuation loop. On `build:failed` with `error_max_turns`: check `git status --porcelain` for changes, `git add -A` + `forgeCommit()` to checkpoint, build continuation prompt with diff, yield `build:implement:continuation` event, retry. Resolve `maxContinuations` from per-plan config > global config > default (3).
- `src/engine/agents/builder.ts` — Add optional `continuationContext` to `BuilderOptions` (fields: `attempt: number`, `maxContinuations: number`, `completedDiff: string`). When present, prepend continuation context to the prompt via `loadPrompt()` template variables.
- `src/engine/prompts/builder.md` — Add conditional `{{continuation_context}}` section near the top that includes: attempt number, instruction not to redo completed work, and the completed diff. Add general instruction encouraging Agent tool for parallelizing bulk edits when many files remain.
- `src/cli/display.ts` — Add case for `build:implement:continuation` event: update spinner text to show continuation attempt number (e.g., "plan-01 — continuing (attempt 2/3)").

### Create
- `test/continuation.test.ts` — Unit tests for the continuation loop: (1) successful build with no continuation needed, (2) `error_max_turns` with dirty worktree triggers continuation and retry, (3) `error_max_turns` with clean worktree fails immediately, (4) non-`error_max_turns` errors fail immediately without continuation, (5) max continuations exhausted fails after all attempts, (6) `maxContinuations` per-plan override takes precedence over global config.

## Verification

- [ ] `pnpm type-check` exits with code 0
- [ ] `pnpm build` exits with code 0
- [ ] `pnpm test` exits with code 0, including all tests in `test/continuation.test.ts`
- [ ] `build:implement:continuation` event type exists in the `EforgeEvent` union in `src/engine/events.ts`
- [ ] `maxContinuations` field exists in `DEFAULT_CONFIG.agents` with value `3` in `src/engine/config.ts`
- [ ] `OrchestrationConfig.plans` entries accept optional `maxContinuations` field in `src/engine/events.ts`
- [ ] `implementStage` in `src/engine/pipeline.ts` contains a loop that retries on `error_max_turns`
- [ ] `builderImplement` in `src/engine/agents/builder.ts` accepts `continuationContext` in its options
- [ ] `src/engine/prompts/builder.md` contains a `{{continuation_context}}` template variable
- [ ] `src/cli/display.ts` handles `build:implement:continuation` event type
- [ ] `test/continuation.test.ts` contains tests for: success without continuation, retry on max_turns with dirty worktree, immediate fail on max_turns with clean worktree, immediate fail on non-max_turns errors, exhaustion of max continuations
