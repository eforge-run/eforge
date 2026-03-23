---
id: plan-01-enqueue-session-fix-and-queue-first
name: Enqueue Session Fix and Queue-First Foreground Build
dependsOn: []
branch: fix-enqueue-formatter-monitor-visibility-queue-first-architecture/enqueue-session-fix-and-queue-first
---

# Enqueue Session Fix and Queue-First Foreground Build

## Architecture Context

The eforge engine has two build paths: daemon-based (queue-first) and `--foreground` (fused). The fused path bypasses the queue entirely, running enqueue+compile+build in a single session via the `allPhases()` generator in `src/cli/index.ts`. Additionally, `runSession()` in `src/engine/session.ts` only recognizes `phase:end` as a success signal, so enqueue-only sessions (which emit `enqueue:complete` but no `phase:end`) fall back to `{ status: 'failed' }`.

This plan fixes both issues: making `runSession()` recognize `enqueue:complete` as success, and replacing the fused foreground path with enqueue + `runQueue()` as two separate sessions.

## Implementation

### Overview

1. Fix `runSession()` to track `enqueue:complete` as a success signal
2. Replace the `allPhases()` fused generator in the CLI build command with two separate phases: enqueue then `runQueue()`
3. Add tests for enqueue-only session result and monitor recording correctness

### Key Decisions

1. **`enqueue:complete` sets `lastResult` but `phase:end` naturally overrides it** — This is safe because in mixed sessions (if they ever exist), `phase:end` fires after `enqueue:complete` and overwrites `lastResult`. No conditional logic needed.
2. **Foreground build becomes enqueue + `engine.runQueue()`** — This makes `--foreground` behave identically to the daemon path, just in-process. The queue file acts as the handoff mechanism.
3. **`--name` passes through to both enqueue and runQueue** — The enqueue phase uses it for the PRD name; runQueue uses it to filter which PRD to process.
4. **`--dry-run` passes through to runQueue** — runQueue already supports dry-run; we just need to forward the flag.
5. **Remove pre-compile HEAD recording/reset logic** — `runQueue()` handles failure recovery internally via worktrees. The manual HEAD reset in `allPhases()` (lines 348-354, 435-439) is no longer needed.

## Scope

### In Scope
- Fix `runSession()` to recognize `enqueue:complete` as success
- Replace fused `allPhases()` build path with enqueue + `runQueue()` two-phase approach
- Forward `--dry-run`, `--name`, `--auto`, `--verbose`, `--no-monitor`, `--no-plugins`, `--profiles`, `--no-generate-profile` flags through the new path
- Add test for enqueue-only session producing `session:end` with `status: 'completed'`
- Update monitor recording test to verify enqueue run status stays 'completed'

### Out of Scope
- Monitor UI changes (handled in plan-02)
- Changes to the daemon path (already works correctly)
- Changes to `engine.enqueue()` or `engine.runQueue()` internals

## Files

### Modify
- `src/engine/session.ts` — Add `enqueue:complete` tracking in `runSession()` alongside the existing `phase:end` tracking. After line 65, add an `else if` that sets `lastResult` to `{ status: 'completed', summary: 'Enqueued: ${event.title}' }` when `event.type === 'enqueue:complete'`.
- `src/cli/index.ts` — Replace the fused `allPhases()` generator (lines ~327-406) and its wrapping logic (lines ~410-443) with two separate phases:
  - Phase 1: Run `engine.enqueue(source, opts)` wrapped in its own `runSession()` + hooks + monitor. Capture the enqueue result (specifically the PRD name/path from `enqueue:complete`).
  - Phase 2: Run `engine.runQueue({ name, auto, dryRun, ... })` to process the just-enqueued PRD. This gets its own `runSession()` wrapper (handled internally by `runQueue()`).
  - Remove `allPhases()` function entirely.
  - Remove the pre-compile HEAD recording (`headBeforeCompile`) and reset logic.
  - Remove the manual `finalResult`/`planResult` tracking variables.
  - Keep the early-return for `--queue` flag (lines 212-247) which already delegates to `runQueue()`.
- `test/session.test.ts` — Add a test case: `runSession()` with enqueue-only events (session:start, enqueue:start, agent events, enqueue:complete) produces `session:end` with `status: 'completed'` and summary containing the enqueued title.
- `test/monitor-recording.test.ts` — Add or update test to verify that after recording an enqueue-only event stream through `withRecording()` and `runSession()`, the run's final status in the database is 'completed' (not 'failed').

## Verification

- [ ] `pnpm type-check` reports zero type errors
- [ ] `pnpm test` passes all existing tests plus the two new test cases
- [ ] `pnpm build` completes with exit code 0
- [ ] New test in `session.test.ts`: `runSession()` fed an async iterable containing `[session:start, enqueue:start, enqueue:complete]` emits a `session:end` event with `result.status === 'completed'` and `result.summary` containing the enqueued title string
- [ ] New/updated test in `monitor-recording.test.ts`: after recording an enqueue-only session, the run row in SQLite has `status = 'completed'`
- [ ] In `src/cli/index.ts`, the `allPhases()` function no longer exists
- [ ] In `src/cli/index.ts`, the foreground build path calls `engine.enqueue()` followed by `engine.runQueue()` as two separate invocations
