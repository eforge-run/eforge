---
id: plan-03-delete-invalidate-on-event
name: Delete invalidateOnEvent SSE-to-SWR bridge
branch: monitor-ui-cleaner-event-consumption-architecture/delete-invalidate-on-event
agents:
  builder:
    effort: low
    rationale: Pure deletion; no logic to preserve.
---

---
id: plan-03-delete-invalidate-on-event
name: Delete invalidateOnEvent SSE-to-SWR bridge
depends_on: [plan-02-orchestration-single-source]
branch: monitor-ui-cleaner-event-consumption-architecture/delete-invalidate-on-event
---

# Delete invalidateOnEvent SSE-to-SWR bridge

## Architecture Context

The PRD identifies `invalidateOnEvent` (`packages/monitor-ui/src/hooks/use-eforge-events.ts:20-48`) as the glue layer between the reducer-driven SSE world and the SWR-cached REST world: every incoming SSE event is routed through a switch that calls `mutate(...)` on five different SWR cache keys. After plan-02 deletes the orchestration arms, the remaining arms target `runs`, `sessionMetadata`, `latestRun`, `queue`, and the per-plan `['sidecar', planId]` key.

The PRD explicitly accepts that, *between* plan-03 and plan-04, the runs list and queue will lag by up to their SWR `refreshInterval` (10 s for runs/sessionMetadata, 5 s for queue) instead of being pushed by SSE. Plan-04/05 restore sub-second freshness via the new daemon-events stream. The recovery sidecar key (`['sidecar', planId]`) is the only on-demand SWR consumer that genuinely needs invalidation when a `plan:build:failed` event arrives — that responsibility moves into the new daemon-events reducer in plan-05 (queue items have a 1:1 mapping to recovery sidecars), so it can be deleted here without loss.

This plan is pure deletion: no new behavior, no new tests, just remove dead glue.

## Implementation

### Overview

1. Delete the entire `invalidateOnEvent` function (`packages/monitor-ui/src/hooks/use-eforge-events.ts:19-48`) and its usage at line 143 (`invalidateOnEvent(event, sessionId);`).
2. Remove the now-unused `mutate` import from `swr` at line 2 if not referenced elsewhere in the file (grep confirms it was only used by `invalidateOnEvent`).
3. Remove the `buildPath` import if no longer used in `use-eforge-events.ts` (it is still used in the `fetch(buildPath(API_ROUTES.runState, { id: sessionId }))` call at line 101 — keep).
4. Delete the entire `packages/monitor-ui/src/hooks/__tests__/use-eforge-events.test.ts` file. After plan-02 stripped the orchestration arms, the file is the dedicated test for `invalidateOnEvent`; with the function gone, the file becomes vestigial. (If any non-orchestration test scenarios remain after plan-02, leave just those; otherwise delete the file.)
5. Update `packages/monitor-ui/src/hooks/README.md`: replace the "SSE events also drive SWR cache invalidation via the global `mutate()` call" paragraph with a sentence explaining that SWR is now reserved for genuinely on-demand reads (`projectContext`, `recovery sidecar`) and that all live event-driven UI updates flow through `useEforgeEvents`'s reducer.

### Key Decisions

1. **Sidecar invalidation moves to plan-05.** Plan-05 introduces `useDaemonEvents` whose reducer can listen to `plan:build:failed` and either mutate the SWR sidecar key directly *or* model the sidecar fetch as part of the queue reducer slice. Either way, the responsibility moves out of `invalidateOnEvent`. In the brief window between plan-03 and plan-05, sidecars are fetched via SWR's `refreshInterval: 10000` poll (already configured at `queue-section.tsx:83`), so freshness degrades by at most 10 seconds.
2. **Polling cadence acceptance.** Per the PRD: "Step 3 makes runs list and queue lag by up to 10 s and 5 s instead of being pushed by SSE. If you want sub-second updates on those, Step 4 is required, not optional." Plan-04 and plan-05 deliver Step 4. Reviewers should not flag the lag as a regression — it is intentional and time-bound.

## Scope

### In Scope
- Delete `invalidateOnEvent` function and its call site in `useEforgeEvents`.
- Clean up unused imports in `use-eforge-events.ts`.
- Delete or trim `__tests__/use-eforge-events.test.ts` to match the new surface.
- Update `hooks/README.md` to reflect the new SSE/SWR responsibility split.

### Out of Scope
- Replacing the deleted invalidation paths with new SSE behavior (plan-04/05).
- Touching the recovery sidecar's SWR poll cadence (kept at 10 s; plan-05 may revisit).
- Any reducer changes (the reducer is unchanged).

## Files

### Modify
- `packages/monitor-ui/src/hooks/use-eforge-events.ts` — delete `invalidateOnEvent` function (lines 19-48), the call site at line 143, and the now-dead `mutate` import on line 2. Verify the JSDoc above the function is also removed.
- `packages/monitor-ui/src/hooks/__tests__/use-eforge-events.test.ts` — delete the file (the entire file is dedicated to testing `invalidateOnEvent`; after plan-02 trimmed the orchestration arms, no meaningful surface remains).
- `packages/monitor-ui/src/hooks/README.md` — replace the SSE-to-SWR paragraph with the new responsibility split.

## Verification

- [ ] `grep -rn 'invalidateOnEvent' packages/ test/` returns zero matches.
- [ ] `grep -rn "from 'swr'" packages/monitor-ui/src/hooks/use-eforge-events.ts` returns zero matches (no `mutate` import remains).
- [ ] `pnpm type-check` passes.
- [ ] `pnpm test` passes; no orphan tests for `invalidateOnEvent` remain.
- [ ] In a manual smoke test against a running daemon, after `plan:build:failed` fires the queue badge updates within ≤ 5 s (the SWR poll cadence), and the runs sidebar updates within ≤ 10 s.
