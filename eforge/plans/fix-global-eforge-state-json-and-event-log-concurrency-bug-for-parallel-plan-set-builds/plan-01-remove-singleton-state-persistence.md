---
id: plan-01-remove-singleton-state-persistence
name: Remove singleton state.json/event-log.jsonl persistence and make
  compile/build handoff deterministic
branch: fix-global-eforge-state-json-and-event-log-concurrency-bug-for-parallel-plan-set-builds/plan-01-remove-singleton-state-persistence
agents:
  builder:
    effort: xhigh
    rationale: Cross-file engine refactor that deletes a widely-used persistence API
      (loadState/saveState/readEventLogSnapshot/isResumable/resumeState) and
      replaces a JSON-state handoff with deterministic path computation. Touches
      orchestrator, phases, eforge.ts, recovery, schemas, and 5 test files.
      Concurrency-safety is the goal so subtle missed call sites would
      reintroduce the bug.
  reviewer:
    effort: high
    rationale: Reviewer must verify zero singleton-state references remain in active
      build/recovery paths and that the new concurrency test actually proves
      cross-build isolation.
  tester:
    effort: high
    rationale: New concurrency test must actually run two
      initializeState/Orchestrator paths in parallel against the same repo and
      prove there is no setName-mismatch failure or shared-state contamination.
---

# Remove singleton `.eforge/state.json` / `.eforge/event-log.jsonl` persistence

## Architecture Context

Eforge orchestration state is currently persisted to two singleton files in the repo: `.eforge/state.json` and `.eforge/event-log.jsonl`. Concurrent queued plan-set builds in the same repo race on these singleton paths — the observed bug is W6 reading W4's persisted `setName` in `initializeState()` and throwing `Persisted setName ... does not match config setName ...`.

The PRD's product decision is to **stop persisting active-build orchestration state** rather than namespace the artifacts. Active state lives in memory in the running build process. Durable observation/recovery comes from emitted events, monitor DB, git, and plan artifacts on the `eforge/<setName>` feature branch. Compile→build handoff becomes deterministic from `planSet` (`featureBranch = eforge/<setName>`, `worktreeBase = computeWorktreeBase(repoRoot, setName)`, `mergeWorktreePath = <worktreeBase>/__merge__`) instead of reading a JSON handoff file.

Key existing pieces that stay:
- `mutateState()` and `updatePlanStatus()` remain the single in-memory mutation entry point.
- `transitionPlan()` (and the lifecycle event variants) keep emitting `plan:status:change`, `plan:error:set`, `plan:error:clear`, `merge:worktree:set`, `merge:worktree:clear` for the SSE stream.
- `WorktreeManager` and `computeWorktreeBase()` are unchanged.
- Monitor DB / event-history synthesis (`packages/engine/src/recovery/event-history.ts`) is the daemon-mode source of truth for recovery context.

Key pieces that are removed:
- `loadState()`, `saveState()`, `readEventLogSnapshot()`, `isResumable()` from `packages/engine/src/state.ts`.
- `resumeState()` from `packages/engine/src/orchestrator/plan-lifecycle.ts` (no supported resume path remains).
- The reconcile-on-resume branch in `executePlans()` (no resume → no reconcile path).
- Singleton state writes/reads scattered through the orchestrator, eforge.ts compile/build/recover/finalize, and dependency-detection.

## Implementation

### Overview

Delete singleton state persistence helpers and every call site that reads or writes `.eforge/state.json` or `.eforge/event-log.jsonl` for active builds. Replace the JSON-state handoff between compile and build with deterministic path computation from `planSet`. Make `initializeState()` fresh-state-only. Rebuild recovery so it reconstructs from `setName` + git/artifacts + monitor event history, and is explicitly partial when no monitor DB is available. Update tests to reflect the product decision (drop legacy resume/persisted-state assertions; add a true concurrency test).

### Key Decisions

1. **Delete `loadState`/`saveState`/`readEventLogSnapshot`/`isResumable` from `packages/engine/src/state.ts`** — do not redirect or namespace them. Keep `mutateState()` and `updatePlanStatus()` as the in-memory mutation entry point. Remove `STATE_FILENAME` and `EVENT_LOG_FILENAME` constants. The singleton-state codepath must be unreachable from supported build/recovery code (zero new-build callers).

2. **Delete `resumeState()` from `packages/engine/src/orchestrator/plan-lifecycle.ts`** — there is no supported resume path. Keep `transitionPlan()`, `VALID_TRANSITIONS`, and `TransitionMetadata`.

3. **`initializeState()` becomes fresh-state-only.** No `loadState`, no `readEventLogSnapshot`, no setName-mismatch throw, no `existing?.mergeWorktreePath` carryover, no `resumed`/`resumeEvents` return. Signature simplifies to `(config, repoRoot) => EforgeState`. The `featureBranch` is always `eforge/${config.name}` and `worktreeBase` is always `computeWorktreeBase(repoRoot, config.name)`.

4. **Compile→build handoff is deterministic.** `EforgeEngine.compile()` no longer calls `loadState`/`saveEforgeState` to persist `mergeWorktreePath`. `EforgeEngine.build()` no longer calls `loadState` to read it. Both compute `mergeWorktreePath = join(computeWorktreeBase(cwd, planSet), '__merge__')` directly. The compile path already creates the merge worktree at exactly that location via `createMergeWorktree()`.

5. **Orchestrator is rebuilt without resume.** `Orchestrator.execute()` calls the new `initializeState(config, repoRoot)`, drops the `resumeEvents`/`resumed` plumbing, and computes `mergeWorktreePath` deterministically when not provided in options. Remove the early `phase:end` short-circuit for non-running state — fresh state is always running. Remove the trailing `saveState(stateDir, state)` in the `finally` block.

6. **`executePlans()` and other phase functions delete every `saveState(stateDir, state)` call** (22 sites across `packages/engine/src/orchestrator/phases.ts`). The `if (ctx.resumed) { ... reconcile ... }` block is removed entirely. `PhaseContext.stateDir` and `PhaseContext.resumed` are dropped from the interface; remaining call sites (executePlans, validate, prdValidate, finalize) operate purely in-memory. State mutations still flow through `transitionPlan()`/`mutateState()` for event emission, but there is no persistence step.

7. **Cleanup paths stop deleting `.eforge/state.json`.** The two `try { await rm(resolve(cwd, '.eforge', 'state.json')); } catch {}` calls in `eforge.ts` (success-path build cleanup at line ~854 and failed-build queue finalize at line ~1253) are removed. Worktree/branch cleanup semantics are unchanged.

8. **`status()` no longer reads `state.json`.** `EforgeEngine.status()` returns the no-build idle shape `{ running: false, plans: {}, completedPlans: [] }` unconditionally for the CLI synchronous path. Daemon-mode running-build signal already comes from the monitor REST API (out of scope for this plan).

9. **`enqueue()` dependency detection no longer reads `state.json`.** The `loadState(cwd)` call inside `enqueue()` populating `runningBuilds` is removed. `runningBuilds` is set to an empty array in CLI-only mode (acceptable per PRD: "in CLI-only mode, no-running-build/empty signal is acceptable rather than reading stale global state"). Daemon-mode dependency detection should consult monitor data, but since the engine's `enqueue()` runs in-process this stays empty here; the daemon's enqueue path can be wired separately if needed (out of scope — PRD permits empty in CLI-only mode).

10. **Recovery is rebuilt around `setName` + monitor DB + git/artifacts.** `buildFailureSummary()` no longer calls `loadState()`. It always synthesizes from monitor DB events (when `dbPath` is supplied and the DB exists) plus git log/diff against `eforge/${setName}`. The function signature stays the same. When the monitor DB is absent, the result is partial (`partial: true`) with empty `plans`, `failingPlan: { planId: 'unknown' }`, models from commit trailers, and `failedAt` derived from the latest landed-commit timestamp or `new Date().toISOString()`.

11. **`failedAt` derivation rule** (applied inside `buildFailureSummary`):
    - If monitor DB has events for this run, use the latest relevant event timestamp.
    - Else if landed commits exist, use the most recent commit's date.
    - Else use `new Date().toISOString()` and set `partial: true`.

12. **`baseBranch` derivation when no state.json exists.** Recovery synthesizes from git: try `git symbolic-ref refs/remotes/origin/HEAD --short` first; fall back to `main`. This is a small extraction inside `failure-summary.ts`.

13. **Recovery prompt and schema text updated.** `packages/engine/src/agents/recovery-analyst.ts` partial-context hint and `packages/engine/src/schemas.ts` `recoveryError`/`partial` description fields no longer reference `state.json was missing`. Replace with `"context was incomplete"` / `"some context was unavailable"` style language so the prompt is closed and accurate.

14. **Sidecar partial-summary banner updated.** `packages/engine/src/recovery/sidecar.ts` line ~95 currently says `'state.json was missing'`. Change to a neutral `'partial context'` message.

15. **The eforge.ts queue-finalize recovery path uses requested `setName` from the PRD/plan-set name, not from state.** The current code does `const setName = state?.setName ?? prdId` at ~line 1160. After removal, `setName` comes from the same source the queue scheduler already passes through (the PRD frontmatter `planSet`/`title` resolution). If no explicit setName is available at the failure-finalize site, fall back to `prdId` directly — that is exactly the previous behavior when `state` was null.

16. **No backward-compatibility layer for legacy `.eforge/state.json`.** Per the AGENTS.md "no backward compat cruft" rule and PRD scope, legacy files become orphan bytes. No migration code, no warning emitter, no cleanup utility.

17. **Concurrency reproduction test.** Add a vitest test that creates two distinct plan-set configs `set-A` and `set-B` and runs `Promise.all([orchestratorA.execute(...), orchestratorB.execute(...)])` against the same `stateDir` (repo root). Use a stub `PlanRunner` that yields no events and a stub `WorktreeManager` so the test exercises only `initializeState` + the orchestrator's pre-execute setup. Assert: neither call throws a setName-mismatch error, both produce independent in-memory state objects with their own `setName`, and the test repo has no `.eforge/state.json` written after both complete.

## Scope

### In Scope

- Delete `loadState()`, `saveState()`, `readEventLogSnapshot()`, `isResumable()`, `STATE_FILENAME`, `EVENT_LOG_FILENAME`, and the `appendSnapshotToEventLog` helper from `packages/engine/src/state.ts`.
- Delete `resumeState()` from `packages/engine/src/orchestrator/plan-lifecycle.ts`.
- Rewrite `initializeState()` in `packages/engine/src/orchestrator.ts` to be fresh-state-only with simplified return type `{ state }` (drop `resumed` and `resumeEvents`).
- Remove all 22 `saveState(stateDir, state)` call sites in `packages/engine/src/orchestrator/phases.ts` and the `ctx.resumed`/reconcile-on-resume block in `executePlans()`. Drop `stateDir` and `resumed` from `PhaseContext`.
- Remove `saveState` import + the trailing `finally { saveState(...) }` in `Orchestrator.execute()`.
- Replace JSON-state compile/build handoff in `packages/engine/src/eforge.ts`:
  - `compile()`: remove `loadState`/`saveEforgeState` calls (the entire "Persist merge worktree path to state" block at ~lines 328–348).
  - `build()`: replace `const existingState = loadState(cwd); const mergeWorktreePath = existingState?.mergeWorktreePath;` with deterministic computation `const mergeWorktreePath = join(computeWorktreeBase(cwd, planSet), '__merge__');`. Also adjust the `planBaseCwd` fallback comment since pre-worktree fallback is no longer relevant once handoff is deterministic.
  - Remove both `try { await rm(resolve(cwd, '.eforge', 'state.json')); } catch {}` calls (build-success cleanup and queue-failure finalize).
  - Queue-failure finalize: remove `const state = loadState(cwd); const setName = state?.setName ?? prdId;` and use `prdId` (or the already-known plan-set name passed through) directly.
  - `enqueue()`: remove `const state = loadState(cwd)` block; set `runningBuilds = []` for CLI-only mode.
  - `status()`: remove `loadState(this.cwd)` call; return idle shape `{ running: false, plans: {}, completedPlans: [] }`.
  - Drop the `loadState, saveState as saveEforgeState` import from `state.js`.
- Rewrite `packages/engine/src/recovery/failure-summary.ts` to never call `loadState()`. Always synthesize: monitor-DB-when-available + git log/diff/trailers. `failedAt` derivation per Decision #11. `baseBranch` derivation per Decision #12. Always produces a result with `partial: true` when no monitor DB events are found; `partial` is omitted (full summary) only when monitor DB synthesis succeeded for the requested `setName`.
- Update partial-summary copy in `packages/engine/src/recovery/sidecar.ts` and the recovery-analyst hint in `packages/engine/src/agents/recovery-analyst.ts`. Update the `recoveryError`/`partial` description strings in `packages/engine/src/schemas.ts` to drop `state.json` references.
- Update `test/state.test.ts`: remove `loadState`/`saveState`/`isResumable` describes. Keep `updatePlanStatus`. Add `mutateState` tests if not already covered (the existing `mutateState` tests in other files are sufficient — no addition required if coverage already exists; verify before adding).
- Update `test/orchestration-logic.test.ts`:
  - Remove the `saveState` import and all tests that seed state via `saveState()` (the four `initializeState` tests that seed `failedState`/`completedState`/`resumableState`/`oldState`).
  - Remove the `resumeState` describe block (function no longer exists).
  - Update remaining `initializeState` tests to match the new fresh-state-only signature: drop `resumed`/`resumeEvents` from returns, accept the simpler `{ state }` shape, and assert on fresh-state behavior only.
  - Remove the `Persisted setName ... does not match` mismatch test entirely.
- Update `test/lifecycle-event-emission.test.ts`: remove the `resumeState — lifecycle event emission` describe block. Keep `transitionPlan`, `WorktreeManager.reconcile`, and `executePlans` describes (those events are still emitted by the in-memory mutation pipeline).
- Update `test/recovery.test.ts`: rewrite the `buildFailureSummary` describes so they no longer write `.eforge/state.json` — instead, drive the function via monitor-DB seeding and a real temp git repo on the `eforge/<setName>` branch. Update `EforgeEngine.recover` integration tests to stop seeding `state.json`. The fixture `test/fixtures/recovery/state.json` is no longer used; either delete it or leave as orphan.
- Update `test/daemon-recovery.test.ts`: remove the `state.json` writes in test setup. The "with no state.json + populated event db" and "with no state.json AND no event db" tests already model the new partial-only world — adjust assertions where they expect `state.json was missing` strings and update to the new neutral copy.
- Add a new test file `test/concurrent-build-isolation.test.ts` (or extend `test/orchestration-logic.test.ts` with a new describe block — preferred for cohesion) that performs the `Promise.all` concurrency test described in Decision #17.

### Out of Scope

- Adding a set-level lock for direct/manual concurrent builds of the same `setName` (PRD explicitly out of scope).
- Migration code or warnings for existing `.eforge/state.json` files (PRD: legacy files become orphan bytes).
- Daemon-mode running-build signal for `enqueue()` dependency detection (PRD permits empty in CLI-only mode; daemon path is separate work).
- Renaming `WorktreeManager.reconcile()` or removing its merge-worktree-clear logic (still useful when the merge worktree itself is clobbered by an external process, even though there is no resume flow). Note: `reconcile()` will no longer be called from `executePlans()`; if it has no remaining callers after this refactor, leave it in place — out of scope to delete now.
- Changes to `eforge-plugin/`, `packages/pi-eforge/`, monitor UI, or daemon HTTP API (no consumer-facing surface changes).

## Files

### Create

- (None, unless the concurrency test is split into its own file. Preferred placement: a new describe block in `test/orchestration-logic.test.ts` to keep cohesion. If the builder finds it cleaner, `test/concurrent-build-isolation.test.ts` is acceptable.)

### Modify

- `packages/engine/src/state.ts` — Delete `loadState`, `saveState`, `readEventLogSnapshot`, `isResumable`, `appendSnapshotToEventLog`, `STATE_FILENAME`, `EVENT_LOG_FILENAME`, the `node:fs` imports that become unused, and the `node:path` imports if unused. Keep `mutateState()` and `updatePlanStatus()`.
- `packages/engine/src/orchestrator.ts` — Drop the `loadState`/`saveState`/`isResumable`/`readEventLogSnapshot`/`resumeState` imports. Rewrite `initializeState()` to fresh-state-only returning `{ state }`. Remove the non-running early-return in `execute()`. Compute `mergeWorktreePath` deterministically when not in options. Remove the trailing `saveState(stateDir, state)` from the `finally` block. Drop the `stateDir` constructor option if it has no remaining users (verify across the codebase before removing — if other consumers still pass it, keep the field but stop using it; preferred is full removal).
- `packages/engine/src/orchestrator/phases.ts` — Drop the `saveState` import. Delete every `saveState(stateDir, state)` call (22 sites). Remove `if (ctx.resumed)` reconcile block. Drop `stateDir` and `resumed` from `PhaseContext`. State mutations still flow through `transitionPlan()` for event emission.
- `packages/engine/src/orchestrator/plan-lifecycle.ts` — Delete `resumeState()`. Keep `transitionPlan()`, `VALID_TRANSITIONS`, and `TransitionMetadata`.
- `packages/engine/src/eforge.ts` — Drop the `loadState, saveState as saveEforgeState` import. Remove the compile-phase "Persist merge worktree path to state" block. Replace the build-phase `loadState` lookup with deterministic `mergeWorktreePath` computation. Remove the two `rm('.eforge/state.json')` calls. Remove the `loadState` call in queue-finalize and use `prdId` for `setName` fallback. Remove the `loadState` call in `enqueue()` and set `runningBuilds = []`. Rewrite `status()` to return idle shape unconditionally.
- `packages/engine/src/recovery/failure-summary.ts` — Drop `loadState` import. Inline the partial path: always synthesize from monitor DB + git. Use `failedAt` derivation rule. Use git-derived `baseBranch` fallback. The existing `synthesizeFromEvents()` helper from `event-history.ts` is the primary source.
- `packages/engine/src/recovery/sidecar.ts` — Replace `'state.json was missing'` partial banner text with neutral copy.
- `packages/engine/src/agents/recovery-analyst.ts` — Update partial-context hint to drop `state.json` reference.
- `packages/engine/src/schemas.ts` — Update `recoveryError`/`partial` description strings to drop `state.json` reference.
- `test/state.test.ts` — Remove `loadState`/`saveState`/`isResumable` describes and their imports.
- `test/orchestration-logic.test.ts` — Remove `saveState` import; remove `resumeState` describe; remove the four state-seeded `initializeState` tests; remove the persisted-setName mismatch test; update remaining `initializeState` tests to fresh-state-only signature; add a concurrency describe with the `Promise.all` two-plan-set test (Decision #17).
- `test/lifecycle-event-emission.test.ts` — Remove the `resumeState — lifecycle event emission` describe.
- `test/recovery.test.ts` — Rewrite the `buildFailureSummary` describes to drive via monitor DB / git temp repo (no `state.json` writes). Update `EforgeEngine.recover` integration tests to stop seeding `state.json`. Update assertions that expect `state.json was missing` strings.
- `test/daemon-recovery.test.ts` — Remove `state.json` writes in test setup; update partial-context assertions to neutral copy.
- `test/fixtures/recovery/state.json` — May become unused after the recovery test rewrite. The builder may delete it if no test references it after the refactor.

## Verification

- [ ] `pnpm type-check` passes — no broken imports after deleting `loadState`/`saveState`/`readEventLogSnapshot`/`isResumable`/`resumeState`.
- [ ] `pnpm test` passes including the new concurrency describe.
- [ ] `pnpm build` succeeds.
- [ ] `grep -rn "loadState\|saveState\|readEventLogSnapshot\|isResumable\|resumeState" packages/ --include='*.ts'` returns zero matches outside of `node_modules` and `dist`.
- [ ] `grep -rn "state\.json\|event-log\.jsonl" packages/engine/src/ --include='*.ts'` returns zero matches in active build/recovery code paths (the `.eforge/` developer-facing line in `AGENTS.md` is documentation-only and does not count; no source file in `packages/engine/src/` reads or writes those filenames).
- [ ] `EforgeEngine.compile()` followed by `EforgeEngine.build()` for the same `planSet` does not require `.eforge/state.json` to exist on disk between the two calls (verified by an integration-style test or by manual inspection of the call graph: compile creates the merge worktree at the deterministic path, build computes the same path independently).
- [ ] The new concurrency test runs two `initializeState`/orchestrator setups in parallel against the same `stateDir` and neither throws `Persisted setName ... does not match`. Both produce in-memory state with their own `setName`, and after both runs the repo has no `.eforge/state.json` file written.
- [ ] `EforgeEngine.recover()` against a temp repo with a populated monitor DB and the `eforge/<setName>` branch produces a sidecar whose `summary.failingPlan.planId` matches the monitor-DB event and whose `summary.partial` is `true` (since there is no longer a non-partial code path without state.json).
- [ ] `EforgeEngine.recover()` against a temp repo with no monitor DB and no `eforge/<setName>` branch produces a partial sidecar with `verdict: manual`, `partial: true`, and a non-empty `recoveryError` that does not mention `state.json`.
- [ ] `EforgeEngine.status()` returns `{ running: false, plans: {}, completedPlans: [] }` regardless of any leftover `.eforge/state.json` on disk (the file is ignored).
- [ ] No call site in `packages/engine/src/orchestrator/phases.ts` writes JSON to `.eforge/state.json`. State mutations continue to flow through `mutateState()`/`transitionPlan()` and emit lifecycle events, but no persistence happens.
- [ ] The recovery-analyst prompt rendered for a partial summary does not mention `state.json`.
