---
id: plan-03-signal-validation-dryrun
name: Signal Cancellation, Post-Merge Validation & Dry-Run Readiness
depends_on: [plan-01-state-safety, plan-02-merge-robustness]
branch: phase4-polish-prd/signal-validation-dryrun
---

# Signal Cancellation, Post-Merge Validation & Dry-Run Readiness

## Architecture Context

This plan builds on atomic state writes (plan-01) and merge robustness (plan-02) to add three capabilities: graceful shutdown via AbortSignal propagation, post-merge validation commands, and dry-run runtime readiness checks. Signal cancellation depends on reliable state saves (plan-01). Post-merge validation depends on correct merge sequencing (plan-02). Dry-run readiness is independent but grouped here to avoid a fourth plan for a small feature.

## Implementation

### Overview

1. **Signal cancellation**: Thread `AbortSignal` from CLI through ForgeEngine to Orchestrator. CLI creates `AbortController`, wires SIGINT/SIGTERM to `controller.abort()`. Orchestrator checks `signal.aborted` at wave loop entry and before each merge. On abort, saves state and breaks out.
2. **Post-merge validation**: Add `postMergeCommands?: string[]` to `ForgeConfig.build`. After successful merge loop, execute each command sequentially via `child_process.execFile('sh', ['-c', cmd])`. Emit validation events for display.
3. **Dry-run readiness**: Add `validateRuntimeReadiness()` to `plan.ts` that checks git cleanliness, branch conflicts, and writable directories. Wire into `showDryRun()` in CLI.

### Key Decisions

1. **`signal?: AbortSignal` (not `AbortController`)** — The orchestrator and engine receive the signal (read-only), not the controller. Only the CLI owns the controller. This follows the standard AbortSignal pattern from the Web/Node APIs.
2. **Add `signal` to `OrchestratorOptions`, keep `abortController` on `BuildOptions`** — The existing `abortController` on `BuildOptions`/`PlanOptions`/`ReviewOptions` is already used by agent runners. The orchestrator receives a derived `AbortSignal` from the controller. The CLI creates the controller and passes it to ForgeEngine, which extracts `.signal` for the orchestrator and passes the full controller to agent runners (existing behavior).
3. **Validation commands run via `sh -c`** — This allows users to specify compound commands (e.g., `pnpm run type-check && pnpm test`) naturally. Commands execute in the repo root directory.
4. **Validation events are new ForgeEvent union members** — `validation:start`, `validation:command:start`, `validation:command:complete`, `validation:complete`. The exhaustive switch in `display.ts` forces handling.
5. **Runtime readiness returns warnings, not errors** — Dirty git or existing branches are warnings (the build may still succeed on resume). Only the display layer decides how to present them.

## Scope

### In Scope
- `signal?: AbortSignal` on `OrchestratorOptions`
- Orchestrator checks `signal.aborted` at wave loop start and before each merge
- On abort: save current state, break loop, cleanup runs via existing `finally` block
- CLI creates `AbortController`, wires SIGINT/SIGTERM to `controller.abort()`
- CLI passes `abortController` to `engine.build()` / `engine.plan()` / `engine.review()`
- ForgeEngine extracts `signal` from `abortController` and passes to orchestrator
- `postMergeCommands?: string[]` in `ForgeConfig.build` interface and `DEFAULT_CONFIG`
- `parseRawConfig` extracts `postMergeCommands` from YAML
- Orchestrator runs `postMergeCommands` after all plans merge successfully
- 4 new validation event types in `ForgeEvent` union
- `renderEvent` handles validation events in `display.ts`
- `validateRuntimeReadiness(repoRoot, plans)` in `plan.ts`
- `showDryRun()` calls `validateRuntimeReadiness` and displays warnings
- 2 new tests in `test/config.test.ts` for `postMergeCommands` parsing
- 4 new tests in `test/dry-run-validation.test.ts` for runtime readiness

### Out of Scope
- Timeout per validation command
- Parallel validation command execution
- Custom working directory for validation commands
- Signal propagation into running claude-agent-sdk processes (they already support `abortController`)

## Files

### Create
- `test/dry-run-validation.test.ts` — 4 tests for `validateRuntimeReadiness`: clean repo passes, dirty repo warns, existing branches warn, unwritable directory warns. Uses real temp git repos via `mkdtemp` + `git init`.

### Modify
- `src/engine/events.ts` — Add 4 validation event types to `ForgeEvent` union: `validation:start` (commands list), `validation:command:start` (command string), `validation:command:complete` (command, exitCode, output), `validation:complete` (passed: boolean)
- `src/engine/orchestrator.ts` — Add `signal?: AbortSignal` to `OrchestratorOptions`; check `signal.aborted` at wave loop entry (break if true) and before each merge; add `postMergeCommands?: string[]` to `OrchestratorOptions`; after merge loop, if all merged and commands configured, run each command sequentially emitting validation events; on abort during merges, mark state and break
- `src/engine/config.ts` — Add `postMergeCommands?: string[]` to `ForgeConfig.build` interface; add to `DEFAULT_CONFIG.build` (default: `undefined`); parse in `parseRawConfig` from `build.postMergeCommands` (validate array of strings); forward `postMergeCommands` in `resolveConfig`'s `build` object construction
- `src/engine/plan.ts` — Add exported `validateRuntimeReadiness(repoRoot: string, plans: OrchestrationConfig['plans']): Promise<string[]>` that returns warning strings for: dirty git (`git status --porcelain`), existing plan branches (`git branch --list`), unwritable worktree parent (`access(dir, W_OK)`)
- `src/engine/forge.ts` — In `build()`, extract `signal` from `options.abortController` and pass to orchestrator options; pass `config.build.postMergeCommands` to orchestrator options
- `src/cli/index.ts` — Create `AbortController` in `setupSignalHandlers`, return it; wire `controller.abort()` into SIGINT/SIGTERM handler; pass `abortController` to `engine.build()`, `engine.plan()`, `engine.review()`; in `showDryRun()`, call `validateRuntimeReadiness` and display warnings before execution plan
- `src/cli/display.ts` — Add cases for `validation:start`, `validation:command:start`, `validation:command:complete`, `validation:complete` in the exhaustive switch
- `test/config.test.ts` — Add 2 tests: `postMergeCommands` parsed from file config; `postMergeCommands` defaults to undefined when not set
- `test/dry-run-validation.test.ts` — 4 tests as described above

## Verification

- [ ] SIGINT during `aroh-forge build` saves state and cleans up worktrees within 5 seconds
- [ ] `forge.yaml` with `postMergeCommands` causes commands to run after all plans merge
- [ ] Post-merge validation stops on first non-zero exit code
- [ ] Validation events render correctly in CLI display
- [ ] `--dry-run` shows warnings for dirty git working directory
- [ ] `--dry-run` shows warnings for existing plan branches
- [ ] `--dry-run` shows warnings for unwritable worktree parent
- [ ] `pnpm test` passes with all new tests
- [ ] `pnpm run type-check` passes
