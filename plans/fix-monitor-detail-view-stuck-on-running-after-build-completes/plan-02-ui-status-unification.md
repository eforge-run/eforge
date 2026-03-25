---
id: plan-02-ui-status-unification
name: UI Status Derivation Unification
depends_on: [plan-01-upstream-runid-stamping]
branch: fix-monitor-detail-view-stuck-on-running-after-build-completes/ui-status-unification
---

# UI Status Derivation Unification

## Architecture Context

The detail header derives status from events (looking for `session:end`), while the sidebar derives status from DB run records. When `session:end` is missing from the DB (the bug fixed in plan-01), these two paths diverge. Even with plan-01's fix ensuring `session:end` is recorded, adding `serverStatus` as an authoritative fallback makes the UI resilient to future edge cases and provides immediate status on initial load before all events are processed.

## Implementation

### Overview

1. Add `serverStatus?: string` to the `BATCH_LOAD` action in the reducer
2. Apply server status as authoritative override after event processing
3. Pass server status from the events hook into the dispatch
4. Use server status for cache decisions (whether to open SSE or use cached data)

### Key Decisions

1. **Server status as post-event override** — applied after all events are reduced, so it takes precedence when events are incomplete but the server knows the final state.
2. **Cache decision uses server status** — a session with `status === 'completed'` or `'failed'` can be cached even without a `session:end` event, preventing unnecessary SSE connections to finished runs.

## Scope

### In Scope
- Adding `serverStatus` to `BATCH_LOAD` action type (`src/monitor/ui/src/lib/reducer.ts`)
- Applying server status override logic after event processing in `BATCH_LOAD`
- Passing server status from HTTP response into dispatch (`src/monitor/ui/src/hooks/use-eforge-events.ts`)
- Using server status for session cache decisions
- Reducer tests for `serverStatus` handling

### Out of Scope
- Backend/engine changes (handled in plan-01)
- Recorder changes (handled in plan-01)

## Files

### Modify
- `src/monitor/ui/src/lib/reducer.ts` — Add `serverStatus?: string` to BATCH_LOAD action; add server status override after event processing loop
- `src/monitor/ui/src/hooks/use-eforge-events.ts` — Pass `serverStatus: data.status` in BATCH_LOAD dispatch; use server status in cache decision logic
- `test/monitor-reducer.test.ts` — Add tests: BATCH_LOAD with `serverStatus: 'completed'` and no `session:end` yields `resultStatus === 'completed'`; BATCH_LOAD with `session:end` and no `serverStatus` still works

## Verification

- [ ] Reducer test: `BATCH_LOAD` with `serverStatus: 'completed'` and no `session:end` event yields `resultStatus === 'completed'` and `isComplete === true`
- [ ] Reducer test: `BATCH_LOAD` with `serverStatus: 'failed'` and no `session:end` event yields `resultStatus === 'failed'` and `isComplete === true`
- [ ] Reducer test: `BATCH_LOAD` with `session:end` event and no `serverStatus` yields `resultStatus` from the event (existing behavior preserved)
- [ ] `pnpm type-check` passes
- [ ] `pnpm test` — all tests pass
- [ ] `pnpm build` succeeds
