---
id: plan-05-daemon-events-ui-consumer
name: useDaemonEvents hook + UI consumer migration
branch: monitor-ui-cleaner-event-consumption-architecture/daemon-events-ui-consumer
agents:
  builder:
    effort: high
    rationale: Introduces a new reducer + hook, replatforms three components off
      SWR, removes the auto-switch refs and the latest-run endpoint entirely.
      Multi-component coordination.
  reviewer:
    effort: high
    rationale: Final architecture-converging plan; reviewer must validate that
      exactly two SSE subscribers exist and the auto-switch derived selector
      handles all the edge cases the refs covered.
---

---
id: plan-05-daemon-events-ui-consumer
name: useDaemonEvents hook + UI consumer migration
depends_on: [plan-04-daemon-events-server]
branch: monitor-ui-cleaner-event-consumption-architecture/daemon-events-ui-consumer
---

# useDaemonEvents hook + UI consumer migration

## Architecture Context

With the daemon-side stream and client primitive in place (plan-04), this plan completes the PRD's Step 4 and Step 5 by:

1. Adding `useDaemonEvents()`, the second of the two SSE subscribers required by the PRD.
2. Migrating the runs list, sidebar, queue, and (currently SWR-polled) auto-build state onto the new reducer.
3. Replacing the `app.tsx` auto-switch refs (`knownLatestRef`, `userSelectedRef`, `isCurrentRunningRef`) and their two tracking effects (lines 65-87, 133-142) with a derived selector from `useDaemonEvents`.
4. Deleting `/api/latest-run`, `apiGetLatestRun`/`apiGetLatestRunIfRunning`, `LatestRunResponse`, and the `latestRun` SWR poll in `app.tsx`.
5. Cleaning up the remaining session-data SWR polls (`/api/session-metadata` in `sidebar.tsx`) — the optional Step 5 from the PRD.

After this plan, the monitor UI satisfies every PRD acceptance criterion: exactly two SSE subscribers (`useEforgeEvents` and `useDaemonEvents`), no `invalidateOnEvent` glue, no auto-switch refs, no `/api/latest-run`, no `/api/orchestration/:id`, and SWR is reserved for `projectContext` and `recovery sidecar` only.

### Daemon-state reducer shape

The new `useDaemonEvents` hook owns these slices, all derived from the `/api/daemon-events` SSE stream + a one-shot snapshot fetch on mount:

```ts
interface DaemonState {
  runs: RunInfo[];                    // sorted started_at DESC; [0] is the latest
  queue: QueueItem[];                 // current queue snapshot
  sessionMetadata: Record<string, SessionMetadata>;  // per-session profile + planCount
  autoBuild: { enabled: boolean; watcher: { running: boolean; pid: number | null; sessionId: string | null } } | null;
  connectionStatus: ConnectionStatus;
}
```

Reducer handlers:
- `session:start` / `session:end` → upsert into `runs`, refetch `sessionMetadata` if needed (or maintain it from events).
- `queue:prd:discovered` / `queue:prd:start` / `queue:prd:complete` / `queue:prd:skip` / `queue:complete` → mutate the queue slice.
- `enqueue:start` / `enqueue:complete` / `enqueue:failed` → upsert into `runs` (enqueue creates a run); mutate queue if needed.
- `daemon:auto-build:paused` → `autoBuild.enabled = false`, store reason.

### Snapshot endpoint to seed the reducer

The PRD says "A snapshot endpoint to seed the daemon-state reducer on mount. Could be the existing `/api/runs` plus the queue." Implement this in the hook by fetching `/api/runs`, `/api/queue`, `/api/session-metadata`, and `/api/auto-build` in parallel on mount (one-time, no `refreshInterval`), seeding the reducer via a `BATCH_LOAD` action analogous to `useEforgeEvents`. After that, `subscribeToDaemonEvents` (from plan-04) takes over for live updates.

### Auto-switch derived selector

The three refs and two effects in `app.tsx` (lines 34-36, 65-87, 133-142) implement: "on initial mount, select the latest session; auto-switch to a newer session only when the user hasn't explicitly picked one AND the current session isn't actively running."

The replacement is a derived selector reading from `useDaemonEvents().runs`:

```ts
const latestSessionId = daemonState.runs[0]?.sessionId ?? null;
const [userSelectedSessionId, setUserSelectedSessionId] = useState<string | null>(null);
const currentSessionId = userSelectedSessionId ?? latestSessionId;
```

The "don't auto-switch while a session is running" rule is satisfied because `userSelectedSessionId` is set the moment the user clicks a session in the sidebar (via `handleSelectSession`); subsequent newer sessions arriving via SSE don't override it. Clear `userSelectedSessionId` when `runState.isComplete` becomes true and the cleared session matches `userSelectedSessionId` — replaces the existing effect at lines 138-142. The "actively running" guard is implicitly handled by `userSelectedSessionId` being set during user interaction; the only remaining edge is auto-selection on initial mount, which `latestSessionId` covers naturally.

## Implementation

### Overview

1. **New reducer.** Create `packages/monitor-ui/src/lib/daemon-reducer.ts` defining `DaemonState`, `initialDaemonState`, `daemonReducer`, and selectors (`selectLatestSessionId`, `selectAutoBuildEnabled`, `selectQueueItems`, etc.). Decompose handlers per-event-group analogous to the existing `lib/reducer/` structure: `lib/daemon-reducer/handle-runs.ts`, `handle-queue.ts`, `handle-enqueue.ts`, `handle-auto-build.ts`. Apply the same `_Exhaustive` type-level check pattern as `lib/reducer/index.ts`, but scoped to the daemon-wide event subset.
2. **New hook.** Create `packages/monitor-ui/src/hooks/use-daemon-events.ts`:
   - On mount, parallel-fetch `/api/runs`, `/api/queue`, `/api/session-metadata`, `/api/auto-build` and dispatch a `BATCH_SEED` action to populate the initial state.
   - Then call `subscribeToDaemonEvents({ baseUrl: '', signal, onEvent: (event, meta) => dispatch({ type: 'ADD_EVENT', event, eventId: meta.eventId ?? '' }) })` to take over for live updates.
   - Return `{ daemonState, connectionStatus }`.
3. **app.tsx refactor.**
   - Add `const { daemonState } = useDaemonEvents()` near the top.
   - Delete the `useSWR` for `latestRun` (lines 44-48) and the auto-switch refs/effects (lines 34-36, 65-87, 133-142).
   - Replace with the derived-selector pattern shown above. `handleSelectSession` becomes `setUserSelectedSessionId(sessionId)`.
   - The `runState.isComplete` clear-effect for `userSelectedSessionId` keeps its semantic at lines 138-142.
   - Pass `daemonState` (or the relevant selectors) into `<Sidebar>` and `<QueueSection>` to displace their SWR fetches.
4. **sidebar.tsx + queue-section.tsx refactor.**
   - Delete `useSWR<RunInfo[]>(API_ROUTES.runs, ...)` and `useSWR<Record<string, SessionMetadata>>(API_ROUTES.sessionMetadata, ...)` from `sidebar.tsx`. Take `runs` and `metadataMap` as props.
   - Delete `useSWR<QueueItem[]>(API_ROUTES.queue, ...)` from `queue-section.tsx`. Take `items` as a prop.
   - The `RecoveryRow` SWR fetch on `['sidecar', item.id]` stays — recovery sidecar is on the kept-list per the PRD.
5. **header.tsx.** Read auto-build state from `daemonState.autoBuild` instead of `useAutoBuild()`'s SWR result. The `toggle` writer remains in `useAutoBuild` (which now becomes a writer-only hook). Or fold the writer into a small `setAutoBuildToggle` helper invoked from `header.tsx` directly using the existing `setAutoBuild` function in `lib/api.ts`. Either approach works — choose the one that minimises prop-drilling.
6. **Delete /api/latest-run + helpers.**
   - Remove `serveLatestRunId` (`server.ts:359-367`), the `else if (url === API_ROUTES.latestRun)` arm (line 2318-2319), and the import of `LatestRunResponse` if any.
   - Remove `latestRun: '/api/latest-run'` from `API_ROUTES` in `packages/client/src/routes.ts:119`.
   - Remove `LatestRunResponse` from `packages/client/src/types.ts:63-67`.
   - Remove `apiGetLatestRun` and `apiGetLatestRunIfRunning` from `packages/client/src/api/queue.ts:42-48`.
   - Remove their re-exports in `packages/client/src/index.ts:20-21`.
   - The `apiGetLatestRunFromRuns` helper from plan-04 stays — it now reads only via `/api/runs[0]`.
7. **Tests.**
   - Add `packages/monitor-ui/src/hooks/__tests__/use-daemon-events.test.ts` covering: snapshot seed → reducer state, SSE event → reducer state mutation, latestSessionId selector returns `runs[0].sessionId`.
   - Add `packages/monitor-ui/src/lib/__tests__/daemon-reducer.test.ts` for the reducer in isolation.
   - Add a test in `packages/monitor-ui/src/__tests__/two-sse-subscribers.test.ts` (or extend the existing api-routes-compliance test) that statically asserts only two `subscribeToSession`/`subscribeToDaemonEvents` call sites exist in `packages/monitor-ui/src/`.
   - Update `packages/monitor-ui/src/lib/__tests__/swr-fetcher.test.ts:34-39` — replace `API_ROUTES.latestRun` with another route (e.g. `API_ROUTES.runs`) for the 200-OK test.

### Key Decisions

1. **Single shared `daemonState` for all consumers.** Sidebar, QueueSection, and Header read from the same `useDaemonEvents()` instance held in `AppContent`. Avoids multiple hook instances all opening their own SSE connections and ensures the "two SSE subscribers total" PRD requirement is met. Pass slices via props (or a small context if prop-drilling becomes excessive).
2. **`useAutoBuild` becomes writer-only.** The reader path is now `selectAutoBuild(daemonState)`. Keep the `toggle` function exported from `useAutoBuild` (or move it to `lib/api.ts` as `toggleAutoBuild`) — the writer is a one-shot HTTP call that doesn't depend on local state.
3. **`userSelectedSessionId` replaces three refs.** Refs were used because the polling closure needed fresh state. With the SSE-driven reducer, the latest run is always pushed via `daemonState.runs[0]`, and React state suffices — no refs, no tracking effects needed beyond the one that clears `userSelectedSessionId` when the watched session completes.
4. **`session-metadata` migration.** Today `sessionMetadata` is an SWR poll at 10 s in `sidebar.tsx`. After this plan, it becomes a one-shot mount-time fetch + reducer-maintained slice. The reducer derives `planCount` from `planning:complete` events and `baseProfile` from `session:profile` events when they land on the daemon stream. Alternative: keep the snapshot fetch as a periodic refetch every 60 s as a backstop. Choose the simpler one-shot + reducer approach unless tests reveal a gap.

## Scope

### In Scope
- New `useDaemonEvents` hook + `daemonReducer` + handlers + selectors.
- Replatform `sidebar.tsx`, `queue-section.tsx`, `header.tsx`, and `app.tsx` to read from `daemonState`.
- Replace `app.tsx` auto-switch refs/effects with a derived selector.
- Delete `/api/latest-run` route, `LatestRunResponse` type, `apiGetLatestRun*` helpers, and the `latestRun` SWR poll.
- Update `swr-fetcher.test.ts` and any other references to `API_ROUTES.latestRun`.
- doc-sync to update `packages/monitor-ui/src/hooks/README.md` to document the two-subscriber architecture.

### Out of Scope
- The recovery sidecar SWR (`['sidecar', planId]`) — kept on PRD's allowlist of "genuinely on-demand reads".
- The `projectContext` SWR — kept on the same allowlist.
- Engine event format or wire protocol changes (forbidden by PRD scope).
- Introducing a new state-management library (forbidden by PRD scope).
- Any further changes to `subscribeToSession`'s reconnect / Last-Event-ID behaviour (frozen by PRD scope).

## Files

### Create
- `packages/monitor-ui/src/hooks/use-daemon-events.ts` — new hook.
- `packages/monitor-ui/src/lib/daemon-reducer.ts` — reducer + state + selectors.
- `packages/monitor-ui/src/lib/daemon-reducer/handle-runs.ts` — session lifecycle handlers.
- `packages/monitor-ui/src/lib/daemon-reducer/handle-queue.ts` — queue:* handlers.
- `packages/monitor-ui/src/lib/daemon-reducer/handle-enqueue.ts` — enqueue:* handlers.
- `packages/monitor-ui/src/lib/daemon-reducer/handle-auto-build.ts` — daemon:auto-build:paused handler.
- `packages/monitor-ui/src/lib/daemon-reducer/index.ts` — registry + exhaustiveness check (mirrors `lib/reducer/index.ts`).
- `packages/monitor-ui/src/hooks/__tests__/use-daemon-events.test.ts`.
- `packages/monitor-ui/src/lib/__tests__/daemon-reducer.test.ts`.
- `packages/monitor-ui/src/__tests__/two-sse-subscribers.test.ts` — static check that the codebase has exactly two SSE subscribers.

### Modify
- `packages/monitor-ui/src/app.tsx` — add `useDaemonEvents()` call; delete `latestRun` SWR (lines 44-48); delete auto-switch refs (lines 34-36) and tracking effects (lines 65-87, 133-142); replace with `userSelectedSessionId` state + derived `currentSessionId`. Pass `daemonState` slices into `<Sidebar>`, `<QueueSection>`, and `<Header>` as props.
- `packages/monitor-ui/src/components/layout/sidebar.tsx` — delete the two `useSWR` calls (lines 157-158); accept `runs` and `metadataMap` as props.
- `packages/monitor-ui/src/components/layout/queue-section.tsx` — delete `useSWR<QueueItem[]>(API_ROUTES.queue, ...)` (line 152); accept `items` as a prop.
- `packages/monitor-ui/src/components/layout/header.tsx` — read auto-build state from `daemonState` (passed as a prop or read via hook).
- `packages/monitor-ui/src/hooks/use-auto-build.ts` — strip down to writer-only (or delete entirely if `setAutoBuild` from `lib/api.ts` is invoked directly from header).
- `packages/monitor/src/server.ts` — delete `serveLatestRunId` (lines 359-367) and the route arm (line 2318-2319).
- `packages/client/src/routes.ts` — remove `latestRun` from `API_ROUTES`.
- `packages/client/src/types.ts` — remove `LatestRunResponse`.
- `packages/client/src/api/queue.ts` — remove `apiGetLatestRun` and `apiGetLatestRunIfRunning`. Keep `apiGetLatestRunFromRuns` (added in plan-04).
- `packages/client/src/index.ts` — remove the two re-exports.
- `packages/monitor-ui/src/lib/__tests__/swr-fetcher.test.ts` — replace `API_ROUTES.latestRun` (line 37) with `API_ROUTES.runs` or another remaining route.
- `packages/monitor-ui/src/hooks/README.md` — document the two-subscriber architecture (`useEforgeEvents` per session, `useDaemonEvents` daemon-wide); list `projectContext` and `recovery sidecar` as the only remaining SWR consumers.

## Verification

- [ ] `grep -rn 'subscribeToSession\|subscribeToDaemonEvents' packages/monitor-ui/src/` returns exactly two consumer files: `use-eforge-events.ts` and `use-daemon-events.ts`.
- [ ] `grep -rn '/api/latest-run\|API_ROUTES.latestRun\|LatestRunResponse\|apiGetLatestRun\b\|apiGetLatestRunIfRunning' packages/ test/` returns zero matches (the helper `apiGetLatestRunFromRuns` is allowed and still exists in `packages/client/src/api/queue.ts`).
- [ ] `grep -rn 'knownLatestRef\|userSelectedRef\|isCurrentRunningRef\|invalidateOnEvent' packages/monitor-ui/src/` returns zero matches.
- [ ] `grep -rn 'useSWR' packages/monitor-ui/src/` returns matches in only `app.tsx` (for `projectContext`) and `queue-section.tsx` (for `['sidecar', item.id]`). Sidebar and the auto-build SWR poll are gone.
- [ ] `pnpm type-check` passes; the daemon-reducer's `_Exhaustive` check accepts every daemon-wide event type emitted by `/api/daemon-events`.
- [ ] `pnpm test` passes; new tests cover the daemon reducer, the hook's snapshot+SSE flow, and the two-subscriber static check.
- [ ] In a manual smoke test: starting a new build via the daemon causes the sidebar to update within < 1 s (no longer 10 s), the queue badge updates within < 1 s, and the runs list updates without polling.
- [ ] Auto-switch behaviour: with no user-selected session, a newer session arriving via SSE flips the view; after the user clicks a session, no auto-switch occurs until that session completes (mirroring today's behaviour without refs).
- [ ] `effectiveOrchestration === runState.earlyOrchestration` always (carryover from plan-02; verify nothing in this plan reintroduces a second source).
