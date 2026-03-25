---
title: Fix monitor detail view stuck on "Running" after build completes
created: 2026-03-25
status: running
---

# Fix monitor detail view stuck on "Running" after build completes

## Problem / Motivation

The monitor UI detail header shows "Running" (with a spinner) after a build completes, while the sidebar correctly shows a green checkmark. This is a regression from commit `ee5ec66` which added `runId = undefined` on `phase:end` to fix queue event scoping, but broke `session:end` recording.

The detail header depends on `session:end` being present in events to set `resultStatus`. The sidebar derives status from DB run records (unaffected). These two different status derivation paths diverge when `session:end` is not recorded.

After `ee5ec66`, the event flow is:
```
phase:end → runId = undefined
session:end → activeRunId = runId ?? enqueueRunId = undefined → NOT inserted into SQLite
```

**Root fragility**: The recorder maintains a multi-variable state machine (`runId`, `enqueueRunId`, `bufferedSessionStart`) that infers run association from event ordering. Any ordering change breaks it — as `ee5ec66` proved. Compare with `sessionId` which is stamped on events upstream by `withSessionId()` so the recorder just reads it.

## Goal

Eliminate the fragile run-ID inference in the recorder by stamping `runId` on events upstream (parallel to how `sessionId` works), and unify the UI status derivation so the detail header and sidebar always agree.

## Approach

### Step 1: Add `runId` to event base type

**File**: `src/engine/events.ts` (line 123)

Add `runId` alongside `sessionId`:
```typescript
export type EforgeEvent = { sessionId?: string; runId?: string } & (...)
```

### Step 2: Create `withRunId()` middleware

**File**: `src/engine/session.ts`

Parallel to `withSessionId()`. Stamps `runId` on events based on `phase:start`/`phase:end` boundaries:

```typescript
export async function* withRunId(
  events: AsyncGenerator<EforgeEvent>,
): AsyncGenerator<EforgeEvent> {
  let currentRunId: string | undefined;
  let lastRunId: string | undefined;

  for await (const event of events) {
    if (event.type === 'phase:start') {
      currentRunId = event.runId;
      lastRunId = event.runId;
    }

    // session:end gets last-known runId so recorder can persist it
    const effectiveRunId = currentRunId ?? (event.type === 'session:end' ? lastRunId : undefined);
    yield { ...event, ...(effectiveRunId && { runId: effectiveRunId }) } as EforgeEvent;

    if (event.type === 'phase:end') {
      currentRunId = undefined;
    }
    if (event.type === 'session:end') {
      currentRunId = undefined;
      lastRunId = undefined;
    }
  }
}
```

Key behaviors:
- Events within a phase get that phase's `runId`
- Events between phases (queue events) get no `runId` → not recorded (preserves `ee5ec66`'s scoping fix)
- `session:end` gets `lastRunId` → recorded under last phase's run
- `session:start` has no `runId` (arrives before any phase) → recorder buffers as before

**Enqueue/formatter flow**: Enqueue sessions have no `phase:start`/`phase:end` — they emit `enqueue:start` → formatter agent → `enqueue:complete`. `withRunId` has nothing to stamp on these events (`currentRunId` stays `undefined`). The recorder handles them via `enqueueRunId` (created on `enqueue:start`, used as fallback in `event.runId ?? enqueueRunId`). For `session:end` of enqueue-only sessions, `withRunId`'s `lastRunId` is also `undefined` (no phases), but the recorder's `enqueueRunId` is still set → event gets recorded. This is verified in the existing `enqueue-only session via runSession + withRecording` test (line 176).

### Step 3: Wire `withRunId` into the pipeline

**File**: `src/cli/index.ts` — `wrapEvents()` function (line 70)

Add `withRunId` after sessionId stamping, before hooks/recording:
```typescript
function wrapEvents(events, monitor, hooks, sessionOpts?) {
  let wrapped = sessionOpts ? withSessionId(events, sessionOpts) : events;
  wrapped = withRunId(wrapped);  // NEW
  if (hooks.length > 0) {
    wrapped = withHooks(wrapped, hooks, process.cwd());
  }
  return monitor.wrapEvents(wrapped);
}
```

Import `withRunId` from `../engine/session.js`.

### Step 4: Simplify the recorder

**File**: `src/monitor/recorder.ts`

Replace the fragile `runId` state tracking with reading from `event.runId`. The recorder reduces from 3 state variables to 2 (`enqueueRunId` + `bufferedSessionStart`). The `runId` variable and all its clearing/tracking logic are removed.

Key changes:
- Remove `let runId` variable
- `phase:start` handler: use `event.runId` directly for DB operations (no more `runId = event.runId`)
- Event insertion: use `event.runId ?? enqueueRunId` instead of `runId ?? enqueueRunId`
- `phase:end` handler: use `event.runId` directly (no more `runId = undefined`)
- `session:end` handler: `event.runId` is stamped by `withRunId` → event gets recorded
- Remove `session:end` cleanup of `runId` (doesn't exist anymore); keep `enqueueRunId = undefined`

### Step 5: DRY the UI status derivation

**File**: `src/monitor/ui/src/lib/reducer.ts`

Add optional `serverStatus` to `BATCH_LOAD` action:
```typescript
| { type: 'BATCH_LOAD'; events: Array<...>; serverStatus?: string }
```

After processing events in BATCH_LOAD, apply server status as authoritative source (same run-record logic as sidebar's `rollupStatus()`):
```typescript
if (action.serverStatus === 'completed') {
  acc.resultStatus = 'completed';
  acc.isComplete = true;
} else if (action.serverStatus === 'failed') {
  acc.resultStatus = 'failed';
  acc.isComplete = true;
}
```

**File**: `src/monitor/ui/src/hooks/use-eforge-events.ts`

1. Pass server status (line 89): `dispatch({ type: 'BATCH_LOAD', events: parsed, serverStatus: data.status });`
2. Use server status for cache decisions (line 93-96): `const isSessionDone = hasSessionEnd || data.status === 'completed' || data.status === 'failed';`

### Step 6: Tests

**File**: `test/monitor-recording.test.ts`
1. Add multi-phase session test (compile + build) verifying `session:end` IS in DB events
2. Strengthen existing queue cycle test to verify `session:end` events ARE present per run
3. Update existing tests to pass events through `withRunId` where needed (events now carry `runId`)

**File**: New test or section in existing test for `withRunId` middleware:
- Stamps `runId` on events within phase boundaries
- Does NOT stamp queue events between sessions
- Stamps `lastRunId` on `session:end`

**File**: `test/monitor-reducer.test.ts`
1. Test `BATCH_LOAD` with `serverStatus: 'completed'` and no `session:end` → `resultStatus === 'completed'`
2. Test `BATCH_LOAD` with `session:end` and no `serverStatus` → still works

## Scope

**In scope:**
- Adding `runId` to the event base type (`src/engine/events.ts`)
- Creating `withRunId()` middleware (`src/engine/session.ts`)
- Wiring `withRunId` into the CLI pipeline (`src/cli/index.ts`)
- Simplifying the recorder to read `event.runId` instead of tracking state (`src/monitor/recorder.ts`)
- Unifying UI status derivation with `serverStatus` on `BATCH_LOAD` (`src/monitor/ui/src/lib/reducer.ts`, `src/monitor/ui/src/hooks/use-eforge-events.ts`)
- Tests for `withRunId`, recorder, and reducer changes (`test/monitor-recording.test.ts`, `test/monitor-reducer.test.ts`)

**Files to modify:**
- `src/engine/events.ts`
- `src/engine/session.ts`
- `src/cli/index.ts`
- `src/monitor/recorder.ts`
- `src/monitor/ui/src/lib/reducer.ts`
- `src/monitor/ui/src/hooks/use-eforge-events.ts`
- `test/monitor-recording.test.ts`
- `test/monitor-reducer.test.ts`

**Out of scope:** N/A

## Acceptance Criteria

1. `pnpm test` — all tests pass (including new and updated tests)
2. `pnpm build` succeeds and daemon restarts cleanly
3. Triggering a build results in the detail header showing "Completed" (not stuck on "Running") when the build finishes
4. Sidebar and detail header agree on status at all times
5. Multi-phase session test verifies `session:end` IS present in DB events
6. Queue cycle test verifies `session:end` events ARE present per run
7. `withRunId` middleware tests verify:
   - `runId` is stamped on events within `phase:start`/`phase:end` boundaries
   - Queue events between sessions do NOT get a `runId`
   - `session:end` gets `lastRunId`
8. Reducer tests verify:
   - `BATCH_LOAD` with `serverStatus: 'completed'` and no `session:end` → `resultStatus === 'completed'`
   - `BATCH_LOAD` with `session:end` and no `serverStatus` → still works
9. Existing `enqueue-only session via runSession + withRecording` test continues to pass (enqueue flow unaffected)
10. Recorder state is reduced from 3 variables (`runId`, `enqueueRunId`, `bufferedSessionStart`) to 2 (`enqueueRunId`, `bufferedSessionStart`)
