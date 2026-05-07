---
title: Fix global `.eforge/state.json` and event-log concurrency bug for parallel plan-set builds
created: 2026-05-07
---

# Fix global `.eforge/state.json` and event-log concurrency bug for parallel plan-set builds

## Problem / Motivation

Eforge currently persists mutable orchestration state and event-log snapshots to singleton repo paths (`.eforge/state.json` and `.eforge/event-log.jsonl`). When the daemon runs independent queued plan sets concurrently in the same repository, one build can read or delete another build's state.

The observed symptom is a build failing during initialization with `Persisted setName "<other-set>" does not match config setName "<this-set>"`, even though the failed plan set's implementation was unrelated. This breaks the expected ability to run independent plan-set builds concurrently and can contaminate recovery sidecars with the wrong set/branch context.

**Observed bug report:** two independent queued plan sets can run concurrently, but one child can read another plan set's singleton `.eforge/state.json` / `.eforge/event-log.jsonl`. The concrete failure was W6 reading W4's persisted `setName`, causing `initializeState()` to throw before W6 build initialization.

**Reproduction Steps:**
- Allow two independent queued plan sets to run concurrently in the same repo after their dependency boundary clears.
- In the recorded case, W4 (`w4-single-source-the-runinfo-row-api-ui-types-after-w3-lands`) and W6 (`w6-async-daemon-mutation-sweep`) were allowed to build in parallel after W3 completed. W6 compiled successfully, but its build phase immediately failed because `initializeState()` read W4's persisted state and rejected the mismatched set name.
- Future automated reproduction should create or simulate two plan sets A and B sharing a repo, persist compile handoff state for A, then initialize/build B and verify B does not read A's state or event-log snapshot.

**Root Cause:**
Global state pathing plus over-reliance on an unreliable state artifact. `packages/engine/src/state.ts` hard-codes singleton `.eforge/state.json` and `.eforge/event-log.jsonl`, so concurrent active plan sets share one mutable state cache. In practice, recovery sidecars are already frequently degraded because `state.json` is often missing, stale, invalid, or has already been cleaned up by the time recovery runs. That means `state.json` is both unsafe for concurrency and not dependable for recovery. The better root-cause framing is: active orchestration state was persisted to a singleton cache and then treated as a durable recovery source, but it is neither correctly scoped nor reliably available.

**Project context:**
- Eforge engine owns orchestration and emits typed events; daemon/runtime state lives under `.eforge/`.
- Engine state mutations must go through `mutateState()`/state helpers, and tests should use real code with Vitest.
- Roadmap alignment: this is a daemon/orchestration safety bug, aligned with the roadmap goal of making the daemon the single orchestration authority with stronger safety checks. It should not add scheduling/workflow scope.

**Current implementation hotspots:**
- **Singleton state implementation:** `packages/engine/src/state.ts` hard-codes `STATE_FILENAME = '.eforge/state.json'` and `EVENT_LOG_FILENAME = '.eforge/event-log.jsonl'`. `loadState()`, `saveState()`, and `readEventLogSnapshot()` all use those singleton paths. `saveState()` also appends snapshots to the singleton event log.
- **Build initialization:** `packages/engine/src/orchestrator.ts` prefers `readEventLogSnapshot(stateDir)` and falls back to `loadState(stateDir)`. A mismatched legacy state throws `Persisted setName ... does not match config setName ... delete or update .eforge/state.json`. Fresh state preserves `existing?.mergeWorktreePath`, so the compile/build handoff depends on reading the same state record.
- **Compile/build handoff:** `packages/engine/src/eforge.ts` compile creates a merge worktree, then mutates or creates the singleton state to persist `mergeWorktreePath`; build later calls `loadState(cwd)` to find that path before reading orchestration artifacts from the merge worktree.
- **Cleanup:** successful build cleanup removes `.eforge/state.json`; queue failure finalization reads singleton state to choose `setName`, builds recovery summary, then removes `.eforge/state.json` after sidecar commit. Both are unsafe while another plan set is active.
- **Recovery:** `packages/engine/src/recovery/failure-summary.ts` calls `loadState(cwd)` without checking `setName`, so a failed plan can receive another active plan set's base branch, feature branch, plan statuses, and model context. Partial recovery already exists when state is missing, backed by monitor event history and git.
- **Existing tests:** `test/state.test.ts` asserts singleton paths; `test/orchestration-logic.test.ts` currently asserts that mismatched set names throw. These should be updated or supplemented to prove per-plan-set isolation and legacy fallback behavior.

## Goal

Eliminate the singleton `.eforge/state.json` / `.eforge/event-log.jsonl` active-build persistence so independent queued plan sets can build concurrently in the same repository without one build reading or deleting another build's state, and ensure recovery sidecars are reconstructed from stable sources (requested `setName`, monitor DB, git, plan artifacts) rather than an unreliable shared JSON cache.

## Approach

Design direction changed from namespaced state files to removing active-build state files entirely. Treat `.eforge/state.json` and `.eforge/event-log.jsonl` pseudo-resume/recovery support as implementation residue, not a supported product requirement. Recoveries already often fail to produce meaningful sidecars because `state.json` is missing, stale, invalid, or cleaned up before recovery; therefore the fix should not preserve or namespace that unreliable artifact.

**Key technical decisions:**

- **Active orchestration state lives in memory** inside the running build process. Durable observation/recovery comes from emitted events, monitor DB where available, and git/plan artifacts on the `eforge/<setName>` feature branch.
- **Deterministic handoff paths** computed from `planSet`:
  - `featureBranch = eforge/<setName>`
  - `worktreeBase = computeWorktreeBase(repoRoot, setName)`
  - `mergeWorktreePath = <worktreeBase>/__merge__`
  - Replaces reading a JSON handoff file.
- **`initializeState()` becomes fresh-state creation only** — no load/resume/mismatched-set validation.
- **Delete active persistence helpers** rather than keeping legacy fallbacks: new builds should have no code path capable of reading singleton state.
- **Recovery sidecars reconstructed from stable sources:** requested `setName`/`prdId`, monitor DB event history keyed by session/run/plan set when available, git log/diff on `eforge/<setName>`, and orchestration/plan artifacts in the merge worktree or feature branch.
- **CLI-only recovery is intentionally git/artifact-only and partial** when there is no monitor DB: include landed commits, diffstat, models from commit trailers, and any plan artifacts that can be read; omit or fallback state-only fields such as per-plan errors and completion timestamps.
- **Plan lifecycle mutations** still go through the single mutation entry point (`mutateState()` / transition helpers); persistence calls throughout orchestration phases (especially in `packages/engine/src/orchestrator/phases.ts`) are removed rather than redirected.

**Code Impact:**

Primary engine changes are expected in:
- `packages/engine/src/state.ts` — keep the in-memory mutation entry point (`mutateState()` and any still-used transition/status helpers) but delete active persistence helpers such as `loadState()`, `saveState()`, `readEventLogSnapshot()`, `isResumable()`, and persisted-state resume plumbing if no other supported path uses them.
- `packages/engine/src/orchestrator.ts` — create fresh in-memory state for each build and stop loading/replaying persisted state.
- `packages/engine/src/orchestrator/phases.ts` — especially important because it contains the bulk of current `saveState(...)` call sites; those calls should be removed, not redirected.
- `packages/engine/src/eforge.ts` — compile/build should use deterministic worktree/branch paths instead of JSON handoff state.
- `packages/engine/src/recovery/failure-summary.ts` — reconstruct from the requested set name, git, plan artifacts, and monitor/event history when available; CLI-only recovery should be explicitly git/artifact-only and partial when there is no monitor DB.

**Profile Signal:** **Excursion**. This is cross-file engine work, but it is still one cohesive design: remove JSON active-state persistence, make compile/build handoff deterministic, and adjust recovery/status/tests accordingly. It should not require multiple independently planned subplans, an architecture document, or a subplan cohesion review step. The work needs careful implementation, but it fits as a single coordinated plan.

## Scope

**In scope:**

- Removing singleton `.eforge/state.json` and `.eforge/event-log.jsonl` reads/writes from all supported active-build orchestration paths.
- Deleting active persistence helpers (`loadState()`, `saveState()`, `readEventLogSnapshot()`, `isResumable()`, persisted-state `resumeState()` plumbing) where no supported path uses them.
- Making compile/build handoff deterministic via plan-set-derived paths.
- Making `initializeState()` fresh-state-only.
- Removing pseudo-resume behavior from persisted state.
- Removing `saveState(...)` calls from `orchestrator/phases.ts` (deletion, not redirection).
- Removing singleton state file removal from cleanup paths.
- Updating recovery/failure-summary to reconstruct from `setName` + git/artifacts + monitor/event history.
- Updating status/dependency-detection to stop reading singleton JSON state (use daemon/monitor in daemon mode; accept empty/no-running signal in CLI-only mode).
- Updating/supplementing tests including `test/state.test.ts` and `test/orchestration-logic.test.ts` to reflect the product decision (drop legacy resume assertions; add concurrency coverage).
- Adding a true concurrency reproduction test (e.g. `Promise.all` over two independent build/orchestrator initializations with different plan sets in the same repo).

**Out of scope:**

- Adding scheduling or workflow scope beyond the safety bug fix.
- Adding a set-level lock for direct/manual concurrent builds of the same `setName` (same-set concurrent builds will still collide on deterministic feature branch and merge worktree paths; design assumes plan-set names are unique in flight, with queue claim locks as the normal enforcement mechanism).
- Preserving or namespacing the unreliable `.eforge/state.json` artifact.
- Maintaining backward compatibility with persisted-state resume behavior.

**Risks:**

- Recovery sidecars may lose state-only details in CLI-only mode because there is no monitor DB; acceptable if documented and marked partial.
- Fields formerly read from state, such as per-plan error strings and `completedAt`, must be either derived from event timestamps when monitor DB exists or intentionally omitted/fallbacked in git-only summaries.
- Same-`setName` concurrent builds will still collide on deterministic feature branch and merge worktree paths.
- Direct/manual concurrent builds of the same set remain outside this bug unless a separate set-level lock is added.
- Removing pseudo-resume may break tests that encoded implementation-resume behavior; tests should be updated to reflect the product decision rather than preserving legacy behavior.

## Acceptance Criteria

- Eforge no longer writes or reads `.eforge/state.json` or `.eforge/event-log.jsonl` for active build orchestration. Active persistence helpers such as `loadState()`, `saveState()`, `readEventLogSnapshot()`, `isResumable()`, and persisted-state `resumeState()` plumbing are deleted or made unreachable from supported build paths; legacy files are orphan bytes that no new-build code reads.
- Build computes its compile/build handoff deterministically from the requested plan set (`eforge/<setName>`, `computeWorktreeBase(repoRoot, setName)`, and `__merge__`) instead of loading `mergeWorktreePath` from JSON state.
- Orchestrator state is created fresh in memory for each build process. Pseudo-resume behavior from persisted state is removed.
- Plan lifecycle mutations still go through the single mutation entry point (`mutateState()` / transition helpers); persistence calls throughout orchestration phases, especially in `packages/engine/src/orchestrator/phases.ts`, are removed rather than redirected.
- Cleanup paths no longer remove singleton state files and do not need per-set state cleanup. Existing worktree/branch cleanup semantics remain unchanged.
- Recovery/failure-summary uses the requested `setName` as source of truth and reconstructs context from git/orchestration artifacts plus monitor/event history when available. It must not read unrelated legacy JSON state. Missing context produces an explicit partial summary instead of a mismatched full summary.
- CLI-only recovery without monitor DB is intentionally partial and git/artifact-only: it includes landed commits, diffstat, models parsed from commit trailers, and readable plan/orchestration artifacts when available; per-plan errors and precise completion timestamps are omitted or fallbacked because they were state-only/event-only details.
- `failedAt`/completion timing is derived from the latest relevant monitor event timestamp when monitor DB exists; otherwise use the latest landed commit timestamp or current time with `partial: true`.
- Status/dependency-detection code no longer uses singleton JSON state. In daemon mode, running-build signal comes from daemon/monitor run data; in CLI-only mode, no-running-build/empty signal is acceptable rather than reading stale global state.
- Reproduction coverage includes a true concurrency test (for example `Promise.all` over two independent build/orchestrator initializations with different plan sets in the same repo) proving there is no persisted-state `setName` mismatch path. Sequential-only coverage is not sufficient.
- Grep after implementation shows no supported build/recovery path reads or writes singleton `.eforge/state.json` / `.eforge/event-log.jsonl`.
