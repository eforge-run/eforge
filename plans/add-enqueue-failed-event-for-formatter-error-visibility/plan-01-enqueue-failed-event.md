---
id: plan-01-enqueue-failed-event
name: Add enqueue:failed event across all layers
depends_on: []
branch: add-enqueue-failed-event-for-formatter-error-visibility/enqueue-failed-event
---

# Add enqueue:failed Event

## Architecture Context

The `EforgeEvent` union in `src/engine/events.ts` is the sole communication channel between the engine and all consumers (CLI, monitor, session). Adding a new variant requires updating every exhaustive switch/handler — the `never` default in `display.ts` enforces this at type-check time. The existing `build:failed` event (line 181) is the closest pattern to follow.

The monitor UI's `classifyEvent` function (line 21 of `event-card.tsx`) already applies red styling to any event type ending in `:failed`, so no styling changes are needed.

## Implementation

### Overview

Add `enqueue:failed` as a new variant to the `EforgeEvent` union, emit it when the formatter throws during enqueue, and propagate it through session result derivation, monitor DB recording, CLI display, and monitor UI (event card + reducer).

### Key Decisions

1. **Error payload is a string** — matches `build:failed` pattern (`error: string`). The formatter error message is extracted via `err instanceof Error ? err.message : String(err)`.
2. **Emit and return** — after yielding `enqueue:failed`, the enqueue generator returns without yielding `enqueue:complete`. This prevents the session from deriving a "completed" result.
3. **Reuse generic `:failed` styling** — `classifyEvent` already handles the `:failed` suffix, so no CSS/styling changes needed in the monitor UI.

## Scope

### In Scope
- New `enqueue:failed` event type with `error` payload in `EforgeEvent` union
- try-catch around formatter + enqueue logic in `eforge.ts` to emit the new event
- Session result derivation (`session.ts`) to produce `{ status: 'failed', summary: '...' }`
- Monitor DB recording (`recorder.ts`) to mark enqueue run as failed
- CLI display (`display.ts`) exhaustive switch case with `failSpinner`
- Monitor UI event card (`event-card.tsx`) summary and detail rendering
- Monitor UI reducer (`reducer.ts`) `enqueueStatus` state tracking with `'failed'` value
- Unit tests for session result and monitor recording

### Out of Scope
- Changes to the formatter agent itself
- Retry logic for failed enqueues
- Changes to `classifyEvent` (`:failed` suffix styling already works generically)

## Files

### Modify
- `src/engine/events.ts` — Add `| { type: 'enqueue:failed'; error: string }` after `enqueue:complete` (line 231)
- `src/engine/eforge.ts` — Wrap formatter call + enqueue logic (lines 286-318) in try-catch; on error yield `enqueue:failed` and return
- `src/engine/session.ts` — Add `else if (event.type === 'enqueue:failed')` handler (after line 69) to set `lastResult` to `{ status: 'failed', summary: 'Enqueue failed: ...' }`
- `src/monitor/recorder.ts` — Add handler after `enqueue:complete` block (line 97) to call `db.updateRunStatus(enqueueRunId, 'failed', ...)` on `enqueue:failed`
- `src/cli/display.ts` — Add `case 'enqueue:failed':` with `failSpinner('enqueue', ...)` after the `enqueue:complete` case (line 641)
- `src/monitor/ui/src/components/timeline/event-card.tsx` — Add `case 'enqueue:failed'` in `eventSummary()` (after line 89) and `eventDetail()` (alongside `build:failed` at line 149)
- `src/monitor/ui/src/lib/reducer.ts` — Widen `enqueueStatus` type to include `'failed'` in three locations (lines 104, 304, 326); add `if (event.type === 'enqueue:failed')` handler after `enqueue:complete` block (line 125)
- `test/session.test.ts` — Add test: `session:end` carries `{ status: 'failed', summary: 'Enqueue failed: ...' }` when `enqueue:failed` is yielded
- `test/monitor-recording.test.ts` — Add test: monitor DB run is marked `failed` when `enqueue:failed` is recorded

## Verification

- [ ] `pnpm type-check` passes with zero errors — confirms exhaustive switch coverage for the new event type
- [ ] `pnpm test` passes — all existing tests plus new tests for session result and monitor recording
- [ ] `pnpm build` succeeds — bundle includes the new event handling
- [ ] New test in `test/session.test.ts` asserts: when `enqueue:failed` is in the event stream, `session:end` result is `{ status: 'failed', summary: 'Enqueue failed: <error>' }`
- [ ] New test in `test/monitor-recording.test.ts` asserts: when `enqueue:failed` event is recorded, the DB run status is `'failed'`
