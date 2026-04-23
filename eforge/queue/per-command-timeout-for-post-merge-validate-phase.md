---
title: Per-command timeout for post-merge validate phase
created: 2026-04-23
---

# Per-command timeout for post-merge validate phase

## Problem / Motivation

The `validate()` phase in `packages/engine/src/orchestrator/phases.ts:447` runs the user-configured `postMergeCommands` + `validateCommands` sequentially as child processes, with no timeout. If any command hangs - a stuck `vite build`, a tsc watcher in build mode, a test worker deadlock, a package manager waiting on a TTY - the engine waits indefinitely.

This happened tonight on the Hardening 11 build: `pnpm build` in `packages/monitor-ui` spawned `vite build` which sat idle for ~95 minutes. Plan was already "completed"; build run was stuck. Nothing surfaced as an error event. We only noticed because of session duration, killed the subprocess manually, and the engine then correctly recovered by escalating to the `validation-fixer` agent.

Without a timeout, this class of failure (stuck subprocess) is effectively undetectable until a human notices wall-clock time. Even detection costs wasted capacity - this session held a slot for ~1.5 hours doing nothing.

## Goal

Every `postMergeCommands` / `validateCommands` exec has a bounded wall-clock timeout. On timeout, the engine kills the entire subprocess tree (not just the direct child), emits a clear event, and treats the result as a validation failure so the existing `validation-fixer` path picks up. Default is sensible for this repo (5 minutes), configurable globally via `eforge/config.yaml`.

## Approach

### 1. Config surface

Extend the `build` section of `eforge/config.yaml` and the corresponding Zod schema in `packages/engine/src/schemas.ts` + type in `packages/engine/src/config.ts`:

```yaml
build:
  postMergeCommandTimeoutMs: 300000   # optional; default 300000 (5 min)
  postMergeCommands:
    - pnpm install
    - pnpm build
    - pnpm type-check
    - pnpm test
```

- Key: `postMergeCommandTimeoutMs` (single scalar, number of milliseconds).
- Default when unset: `300000` (5 minutes). Document the default in `docs/config.md`.
- Minimum sensible floor: `10000` (10 s). If the user sets something below that, it probably reflects a typo - log a warning (now via a `config:warning` event per Hardening 04) and clamp to the floor.
- Applies identically to every command in `postMergeCommands` and `validateCommands`. Per-command overrides are out of scope for v1 - revisit if a single command legitimately needs longer.

### 2. Exec with timeout and process-group kill

Currently the `validate()` loop exec probably uses the shared `exec()` helper in `packages/engine/src/exec.ts` (confirm during implementation). Extend that helper - or add a sibling `execWithTimeout()` - that:

1. Spawns the child with `detached: true` so it gets its own process group (PGID == PID on POSIX).
2. Starts a timer for `timeoutMs`.
3. On timer fire: SIGTERM the whole group via `process.kill(-child.pid, 'SIGTERM')`, wait a short grace (2-3 s), then SIGKILL if still alive.
4. Resolves/rejects deterministically - `timedOut: true` in the result shape, not a thrown exception the caller has to distinguish from normal non-zero exits.

On macOS/Linux, `-child.pid` targets the process group, which takes out vite workers, pnpm spawned children, etc. On Windows (unlikely here but worth noting), fall back to `taskkill /F /T /PID <pid>` or the existing `kill -9` pattern - decide based on whether eforge claims Windows support.

### 3. Thread timeout through `validate()`

In `packages/engine/src/orchestrator/phases.ts:447`, the `validate()` generator iterates `validateCommands`. Thread the configured timeout through `PhaseContext` / orchestrator options. When a command times out:

- Emit a new event: `validate:command-timeout` with `{ command: string, timeoutMs: number, pid: number }`. Add it to the `EforgeEvent` union in `packages/engine/src/events.ts`.
- Treat the run as a validation failure identical to a non-zero exit - the existing fixer loop (around line 502 "Loop continues to re-validate") picks up. No new recovery path needed.
- Record the timeout in the phase's summary so the monitor UI can show "timed out after Xm" instead of a generic failure.

### 4. Monitor UI surfacing

Add minimal rendering for `validate:command-timeout` in the monitor UI event timeline / failure banner. The event is rare but should be unmistakable when it happens - we should never again have to eyeball wall-clock time to notice a hang. Per user feedback ("surface runtime agent decisions in monitor UI"), this is a runtime signal worth elevating.

### 5. Files touched

- `packages/engine/src/exec.ts` (or new `exec-with-timeout.ts`)
- `packages/engine/src/orchestrator/phases.ts`
- `packages/engine/src/events.ts`
- `packages/engine/src/config.ts`, `packages/engine/src/schemas.ts`
- `packages/monitor-ui/src/lib/reducer.ts` + `components/common/failure-banner.tsx` (or similar) for event rendering
- `docs/config.md`
- Tests in `test/`

## Scope

### In scope

- Bounded wall-clock timeout on every `postMergeCommands` / `validateCommands` exec.
- Full subprocess-tree kill on timeout (SIGTERM group, grace, then SIGKILL).
- New `postMergeCommandTimeoutMs` config key with 5-minute default and 10-second floor (clamp + `config:warning` event).
- New `validate:command-timeout` event in the `EforgeEvent` union.
- Timeout recorded in phase summary and rendered in the monitor UI event timeline / failure banner.
- Best-effort Windows fallback (`taskkill /F /T /PID <pid>` or existing `kill -9` pattern).

### Out of scope

- Per-command timeout overrides. Single global scalar is sufficient for v1.
- Timeouts on agent (LLM) calls - that is a separate retry-policy concern (Hardening 06 territory).
- Timeout on pre-merge phases. Only `validate()` is in scope; extending to `executePlans` and `finalize` is a follow-up if those prove similarly hang-prone.
- Windows-specific process-tree kill semantics beyond a best-effort fallback.

## Acceptance Criteria

### Tests

- Unit test for `execWithTimeout()`: spawn `sleep 10` with a 500 ms timeout; assert `timedOut: true`, child is dead, and the process group cleanup ran (spawn a shell child inside the sleep and verify it also got killed).
- Integration test for `validate()`: mock a slow command, assert `validate:command-timeout` event fires and the fixer is invoked.

### Verification

- `pnpm test && pnpm build` pass.
- Manual: temporarily set `postMergeCommandTimeoutMs: 5000` in `eforge/config.yaml` and enqueue a trivial PRD. Add an artificial `sleep 10` to `postMergeCommands` (e.g., `- sh -c 'sleep 10'`). Confirm:
  - After ~5 s the command is killed.
  - A `validate:command-timeout` event appears in the monitor UI.
  - The session does not hang; it either fails or enters the `validation-fixer` loop.
  - No orphan `sleep` process remains (`ps aux | grep sleep` shows nothing for the worktree).
- End-to-end: normal build with default 5-min timeout completes with no timeout events fired.
