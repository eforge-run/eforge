# Phase 4 Polish: Robustness, Safety & Validation

## Context

aroh-forge's core engine (Phases 1–3) is complete and functional: plan/build/review commands, parallel wave orchestration, Langfuse tracing, and interactive clarification all work end-to-end. However, the orchestration pipeline has robustness gaps that surface under failure conditions — concurrent state writes can corrupt `.forge-state.json`, merge conflicts leave the repo in a dirty state, SIGINT doesn't propagate cancellation to running agents, and there's no post-merge validation step. This work hardens the engine for real-world use.

## Goals

1. **State safety** — Make `.forge-state.json` writes atomic and recoverable from corruption
2. **Merge robustness** — Block dependent merges when an upstream merge fails; clean up git state on conflict
3. **Graceful shutdown** — Propagate SIGINT/SIGTERM through the engine so running agents stop, state is saved, and worktrees are cleaned up
4. **Post-merge validation** — Run user-configured commands (tests, lints) after merging all branches
5. **Dry-run readiness checks** — Validate runtime environment (clean git, writable dirs, no branch conflicts) during `--dry-run`

## Non-Goals

- Migration execution (the `migrations` field in plan metadata stays as documentation-only)
- TUI, headless, or web UI surfaces (Phase 5+)
- npm publishing readiness (trivial, do when needed)

## Design

### Atomic State Writes

Replace `writeFileSync` in `saveState()` with write-to-temp-then-rename:

```
writeFileSync(filePath + '.tmp', data)
renameSync(filePath + '.tmp', filePath)   // atomic on POSIX same-filesystem
```

Make `loadState()` return `null` on corrupt JSON (try-catch around `JSON.parse`) instead of crashing. This lets the orchestrator create fresh state — the correct recovery behavior.

### Merge Failure Propagation

The merge phase in `orchestrator.ts` runs sequentially through `mergeOrder` (topological). Currently, if merging plan B fails, plan C (which depends on B) still attempts to merge against inconsistent state.

Fix: track failed merges in a `Set<string>`. Before each merge, check if any dependency is in the failed set. If blocked, mark as failed with a descriptive error and skip.

Additionally, when a `git merge --no-ff` fails (conflict), run `git merge --abort` before re-throwing to leave the repo clean for subsequent merge attempts or resume.

### Signal Cancellation

Thread an `AbortSignal` from CLI → ForgeEngine → Orchestrator → agents:

- Add `signal?: AbortSignal` to `BuildOptions`, `PlanOptions`, `ReviewOptions`
- Add `signal?: AbortSignal` to `OrchestratorOptions`
- CLI creates an `AbortController`, wires SIGINT/SIGTERM to `controller.abort()`
- Orchestrator checks `signal.aborted` at wave loop entry and before each merge
- On abort: save state (completed/merged plans preserved for resume), break out, run cleanup

### Post-Merge Validation

Add `postMergeCommands?: string[]` to `ForgeConfig.build`, configurable via `forge.yaml`:

```yaml
build:
  postMergeCommands:
    - "pnpm run type-check"
    - "pnpm test"
```

After the merge loop, if all plans merged and commands are configured, execute each sequentially via `sh -c`. Stop on first failure. Emit new `ForgeEvent` types:

- `validation:start` — list of commands
- `validation:command:start` — individual command starting
- `validation:command:complete` — exit code + output
- `validation:complete` — overall pass/fail

### Dry-Run Runtime Readiness

Enhance `--dry-run` to check runtime environment beyond YAML validation:

1. Git working directory is clean (`git status --porcelain`)
2. Plan branches don't already exist (warn as "will attempt resume")
3. Worktree parent directory is writable

Display warnings before the execution plan output.

## Scope

### Files to Modify

- `src/engine/state.ts` — Atomic writes, corruption recovery
- `src/engine/orchestrator.ts` — Merge blocking, abort signal, post-merge validation
- `src/engine/worktree.ts` — `git merge --abort` on conflict
- `src/engine/events.ts` — `signal` on option interfaces, validation event types
- `src/engine/config.ts` — `postMergeCommands` field
- `src/engine/plan.ts` — `validateRuntimeReadiness()` function
- `src/engine/forge.ts` — Wire signal + postMergeCommands to orchestrator
- `src/cli/index.ts` — AbortController setup, dry-run warnings
- `src/cli/display.ts` — Validation event rendering

### Tests to Add

- `test/state.test.ts` — Atomic write roundtrip, corrupt/empty/truncated JSON recovery (5 tests)
- `test/orchestration-logic.test.ts` — `shouldSkipMerge` pure function (4 tests)
- `test/config.test.ts` — `postMergeCommands` parsing and defaults (2 tests)
- `test/dry-run-validation.test.ts` — Runtime readiness checks against real temp git repos (4 tests, new file)

### Dependency Order

Units A and B have no dependencies and can be done first (or in parallel). Unit C depends on A (state safety before signal-driven state saves). Unit D depends on B (merge correctness before post-merge validation).

## Verification

- [ ] `pnpm test` passes with all new tests
- [ ] `pnpm run type-check` passes
- [ ] Corrupt `.forge-state.json` → `aroh-forge status` returns gracefully (no crash)
- [ ] `aroh-forge build <planSet> --dry-run` shows runtime warnings for dirty git / existing branches
- [ ] `forge.yaml` with `postMergeCommands` → build runs validation commands after merge, fails on non-zero exit
- [ ] SIGINT during `aroh-forge build` saves state and cleans up worktrees within 5 seconds
- [ ] Merge conflict during merge phase → repo left clean (no lingering conflict state), dependent merges skipped
