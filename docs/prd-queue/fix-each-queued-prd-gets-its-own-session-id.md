---
title: Fix: Each queued PRD gets its own session ID
created: 2026-03-18
status: pending
---

## Problem / Motivation

When `eforge run --queue` processes multiple PRDs, all PRDs share a single session ID. The CLI creates one `sessionId = randomUUID()` before calling `engine.runQueue()` and wraps the entire queue's event stream with it. This causes the monitor to merge all PRDs into one session, showing combined timelines, token counts, and costs. The queue sidebar also doesn't update because the monitor sees one continuous session rather than discrete per-PRD runs.

The root cause is in `src/cli/index.ts` (lines 220-231 and 480-491): a single `sessionId` is created before `engine.runQueue()` and passed to `wrapEvents()` with `emitSessionStart: true, emitSessionEnd: true`. Every event from every PRD gets stamped with this one ID.

## Goal

Move session lifecycle into the engine's `runQueue()` method so each PRD's compile+build gets its own session ID, and the monitor shows separate sessions per PRD with independent timelines and costs.

## Approach

1. **`src/engine/eforge.ts`** - Yield per-PRD session events in `runQueue()`. Around each PRD's compile+build loop (lines 580-628), emit `session:start` and `session:end` boundaries with a unique `prdSessionId = randomUUID()`. Stamp each yielded event from `compile()` and `build()` with that session's ID. Queue-level events (`queue:start`, `queue:complete`, `queue:prd:start`, `queue:prd:skip`) stay outside the session boundary and don't need a sessionId - they're queue-level metadata. Import `randomUUID` from `node:crypto` if not already imported.

   ```typescript
   // Before compile (after staleness check, after updatePrdStatus('running'))
   const prdSessionId = randomUUID();
   yield { type: 'session:start', sessionId: prdSessionId, timestamp: new Date().toISOString() } as EforgeEvent;

   // Stamp compile and build events:
   // for await (const event of this.compile(...)) {
   //   yield { ...event, sessionId: prdSessionId };
   // }
   // for await (const event of this.build(...)) {
   //   yield { ...event, sessionId: prdSessionId };
   // }

   // After build completes (or compile fails), before queue:prd:complete:
   yield { type: 'session:end', sessionId: prdSessionId, result: { status: finalStatus, summary: '' }, timestamp: new Date().toISOString() } as EforgeEvent;
   ```

2. **`src/cli/index.ts`** - Stop wrapping queue events in a session at two call sites:
   - Lines ~219-236 (`run --queue` handler): Remove the single `sessionId` and change `wrapEvents` to use `emitSessionStart: false, emitSessionEnd: false`.
   - Lines ~479-496 (`queue run` handler): Same change - remove `sessionId`, set `emitSessionStart: false, emitSessionEnd: false`.

3. **`src/engine/session.ts`** - No changes needed. `withSessionId` already handles `emitSessionStart: false, emitSessionEnd: false` gracefully, passing events through and stamping any pre-existing `sessionId` on events that already have one.

## Scope

**In scope:**
- `src/engine/eforge.ts` - per-PRD session events in `runQueue()`
- `src/cli/index.ts` - two call sites (lines ~220, ~480) stop creating queue-level sessions

**Out of scope:**
- Changes to `src/engine/session.ts`
- Changes to the monitor's recording or rendering logic
- Non-queue run modes (single PRD `run` already has correct session handling)

## Acceptance Criteria

- `pnpm type-check` passes with no type errors
- `pnpm test` passes - all existing tests continue to work
- When running `eforge run --queue` with 2+ PRDs queued, the monitor shows separate sessions per PRD with independent timelines and costs
- Queue-level events (`queue:start`, `queue:complete`, `queue:prd:start`, `queue:prd:skip`) are emitted outside session boundaries without a sessionId
- Each PRD's compile+build events are stamped with that PRD's unique session ID
- `session:start` is emitted before compile begins for each PRD
- `session:end` is emitted after build completes (or compile fails) for each PRD, before `queue:prd:complete`
