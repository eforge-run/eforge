---
id: plan-01-upstream-runid-stamping
name: Upstream runId Stamping and Recorder Simplification
depends_on: []
branch: fix-monitor-detail-view-stuck-on-running-after-build-completes/upstream-runid-stamping
---

# Upstream runId Stamping and Recorder Simplification

## Architecture Context

The monitor recorder maintains a fragile 3-variable state machine (`runId`, `enqueueRunId`, `bufferedSessionStart`) to infer which run an event belongs to. Commit `ee5ec66` set `runId = undefined` on `phase:end` to fix queue event scoping, but this broke `session:end` recording — the detail header depends on `session:end` to set `resultStatus`.

The fix follows the same pattern as `sessionId`: stamp `runId` on events upstream via a middleware, so the recorder reads it instead of tracking state. This eliminates the root fragility.

## Implementation

### Overview

1. Add `runId?: string` to the `EforgeEvent` base type
2. Create `withRunId()` async generator middleware in `src/engine/session.ts`
3. Wire `withRunId()` into the CLI pipeline in `src/cli/index.ts`
4. Simplify the recorder to read `event.runId` instead of maintaining its own `runId` variable
5. Add tests for `withRunId()` middleware and update recorder tests

### Key Decisions

1. **`withRunId` placed after `withSessionId` but before hooks/recording** — events need `runId` stamped before the recorder sees them, and hooks may benefit from having `runId` available in env vars.
2. **`lastRunId` pattern for `session:end`** — `session:end` arrives after `phase:end` clears `currentRunId`, so we keep a `lastRunId` to ensure `session:end` gets recorded under the last phase's run.
3. **Recorder keeps `enqueueRunId`** — enqueue-only sessions have no `phase:start`/`phase:end`, so the recorder's `enqueueRunId` fallback remains necessary. The recorder state reduces from 3 variables to 2.

## Scope

### In Scope
- Adding `runId` to `EforgeEvent` base type (`src/engine/events.ts`)
- Creating `withRunId()` middleware (`src/engine/session.ts`)
- Wiring `withRunId()` into CLI pipeline (`src/cli/index.ts`)
- Simplifying recorder to read `event.runId` (`src/monitor/recorder.ts`)
- Tests for `withRunId()` middleware behavior
- Updating recorder tests to pass events through `withRunId` where needed
- Multi-phase session test verifying `session:end` IS in DB events
- Strengthening queue cycle test to verify `session:end` events ARE present per run

### Out of Scope
- UI changes (handled in plan-02)
- Monitor reducer changes (handled in plan-02)

## Files

### Modify
- `src/engine/events.ts` — Add `runId?: string` to the `EforgeEvent` intersection type at line 123
- `src/engine/session.ts` — Add `withRunId()` async generator middleware function, following `withSessionId()` pattern
- `src/cli/index.ts` — Import `withRunId` and insert it into `wrapEvents()` chain after `withSessionId`, before hooks
- `src/monitor/recorder.ts` — Remove `let runId` state variable; replace all `runId` reads with `event.runId`; keep `enqueueRunId` and `bufferedSessionStart`
- `test/monitor-recording.test.ts` — Add multi-phase session test; strengthen queue cycle test; update existing tests for `withRunId` integration
- `test/monitor-reducer.test.ts` — Add `withRunId` middleware tests (stamps `runId` within phase boundaries, no stamp on queue events, stamps `lastRunId` on `session:end`). Note: these test the middleware, not the reducer — may be placed in a new `test/with-run-id.test.ts` if cleaner, but the PRD specifies this file.

## Verification

- [ ] `pnpm type-check` passes with `runId` added to `EforgeEvent`
- [ ] `withRunId()` test: events between `phase:start` and `phase:end` have `runId` set to the phase's run ID
- [ ] `withRunId()` test: events outside any phase (queue events) have no `runId`
- [ ] `withRunId()` test: `session:end` event has `runId` set to `lastRunId` from the most recent phase
- [ ] Multi-phase session test: `session:end` IS present in SQLite events after compile + build phases
- [ ] Queue cycle test: `session:end` events ARE present per run in the DB
- [ ] Existing `enqueue-only session via runSession + withRecording` test continues to pass
- [ ] Recorder uses 2 state variables (`enqueueRunId`, `bufferedSessionStart`), not 3
- [ ] `pnpm test` — all tests pass
