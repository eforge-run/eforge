---
title: Monitor UI: cleaner event-consumption architecture
created: 2026-05-06
---

# Monitor UI: cleaner event-consumption architecture

## Problem / Motivation

The monitor UI's current event-consumption architecture has accumulated several pain points that have been the source of recurring swimlane / orchestration bugs:

### Current state

```mermaid
flowchart LR
  subgraph Daemon
    SSE[/api/events/:sessionId<br/>SSE]
    REST_RUNSTATE[/api/run-state/:id<br/>full event log]
    REST_ORCH[/api/orchestration/:id<br/>broken: events[0] only]
    REST_RUNS[/api/runs<br/>session list]
    REST_META[/api/session-metadata<br/>per-session counts]
    REST_QUEUE[/api/queue]
    REST_LATEST[/api/latest-run]
    REST_AB[/api/auto-build/get]
    REST_PC[/api/project-context]
    REST_SIDECAR[/api/recover/sidecar/:planId]
  end

  subgraph UI[Monitor UI hooks/components]
    UEE[useEforgeEvents<br/>SSE #1<br/>useReducer]
    UAB[useAutoBuild<br/>SSE #2<br/>SWR poll 10s]
    APP[app.tsx<br/>SWR latestRun 10s<br/>SWR orchestration<br/>SWR projectContext]
    SB[Sidebar<br/>SWR runs 10s<br/>SWR sessionMetadata 10s]
    QS[QueueSection<br/>SWR queue 5s]
    QSI[QueueItem<br/>SWR sidecar on-demand]
    INV[invalidateOnEvent<br/>SSE -> SWR mutate bridge]
  end

  SSE --> UEE
  SSE --> UAB
  REST_RUNSTATE --> UEE
  REST_ORCH --> APP
  REST_LATEST --> APP
  REST_PC --> APP
  REST_RUNS --> SB
  REST_META --> SB
  REST_QUEUE --> QS
  REST_AB --> UAB
  REST_SIDECAR --> QSI

  UEE -. "dispatches into" .-> INV
  INV -. "mutates" .-> APP
  INV -. "mutates" .-> SB
  INV -. "mutates" .-> QS
  INV -. "mutates" .-> UAB
  INV -. "mutates" .-> QSI
```

### Pain points

1. **Two SSE subscribers per session.** `useEforgeEvents` and `useAutoBuild` both open `/api/events/:sessionId`. The second one only reads `daemon:auto-build:paused`.
2. **Two sources of truth for orchestration.** Reducer synthesizes `earlyOrchestration` from `planning:complete`. SWR fetches `/api/orchestration/:id` separately. The REST endpoint reads `events[0]` only (`packages/monitor/src/server.ts:382`), so it is broken for multi-plan sessions, and `earlyOrchestration` papers over it.
3. **`invalidateOnEvent` is a glue layer between two state systems.** Whenever an event fires, it manually nudges 5 different SWR caches. This is the surface that has been thrashed by the recurring swimlane / orchestration bugs.
4. **Auto-switch logic uses three refs and two effects.** `knownLatestRef`, `userSelectedRef`, `isCurrentRunningRef` plus a 10 s `latestRun` poll, plus tracking effects in `app.tsx:65-87, 133-142`.
5. **`/api/latest-run` is redundant** with `/api/runs`. The latest is just the first item in the runs list.

## Goal

Simplify the monitor UI's event-consumption architecture to two SSE subscribers (one per concern) backed by reducers, eliminating the SSE-to-SWR bridge that has been the source of recurring swimlane / orchestration bugs.

## Approach

### Proposed architecture

```mermaid
flowchart LR
  subgraph Daemon
    SSE_S[/api/events/:sessionId<br/>SSE]
    SSE_D[/api/daemon-events<br/>SSE - new]
    REST_RUNSTATE2[/api/run-state/:id]
    REST_RUNS2[/api/runs]
    REST_PC2[/api/project-context]
    REST_SIDECAR2[/api/recover/sidecar/:planId]
  end

  subgraph UI2[Monitor UI hooks/components]
    UEE2[useEforgeEvents<br/>SSE #1<br/>useReducer]
    UDE[useDaemonEvents<br/>SSE #2 daemon-wide<br/>useReducer]
    APP2[app.tsx]
    SB2[Sidebar]
    QS2[QueueSection]
  end

  SSE_S --> UEE2
  REST_RUNSTATE2 --> UEE2
  SSE_D --> UDE
  REST_RUNS2 --> UDE
  REST_PC2 --> APP2
  REST_SIDECAR2 -. "on demand" .-> QS2

  UEE2 -. "selectors" .-> APP2
  UDE -. "selectors" .-> SB2
  UDE -. "selectors" .-> APP2
  UDE -. "selectors" .-> QS2
```

Two subscribers total, one per concern:

- **`useEforgeEvents(sessionId)`**: per-session live state. Reducer owns plan statuses, agent threads, validation, orchestration (synthesised from `planning:complete`), auto-build state for the current session.
- **`useDaemonEvents()`** (new, daemon-wide): cross-session live state. Reducer owns the runs list, queue, daemon-wide auto-build state, project context lifecycle.

Everything else falls out:

- **Delete `useAutoBuild`'s SSE.** Auto-build state becomes a slice in `useEforgeEvents`'s reducer. Reading is `selectAutoBuild(runState)`. Writing (`POST /api/auto-build/set`) stays as a one-shot HTTP call.
- **Delete the `/api/orchestration/:id` endpoint and its SWR fetch.** `earlyOrchestration` is the only source of truth. (It already is, in practice, because `/api/orchestration/:id` is broken.) The reducer derives orchestration from `planning:complete` and `expedition:compile:complete`.
- **Delete `invalidateOnEvent`.** The bridge disappears because nothing on the live event path needs to mutate an SWR cache anymore. SWR is left for genuinely RESTful, on-demand resources only: project context, recovery sidecar.
- **Delete the auto-switch refs** in `app.tsx`. Replace with a derived selector from `useDaemonEvents`: "if no user-selected session and a more recent session exists, follow it." One line, no refs.
- **Delete `/api/latest-run` + the `latestRun` SWR poll.** The first entry in `useDaemonEvents`'s runs list is the latest.

### Daemon-side work

The new daemon-wide endpoint:

- `GET /api/daemon-events` (SSE): emits the existing daemon-level events, namespaced or not. Today's `daemon:auto-build:paused`, `queue:*`, `enqueue:*`, plus a thin "session lifecycle" stream (`session:start`, `session:end`).
- A snapshot endpoint to seed the daemon-state reducer on mount. Could be the existing `/api/runs` plus the queue.

Implementation cost on the daemon side is small: one route, one subscriber set, the same poll loop pattern as `serveSSE`. No new event types are required if we route the existing daemon-level events through a new stream rather than only embedding them in per-session streams.

### Migration order

Each step shippable independently. Delete-only steps go first.

| Step | Change | Net LoC |
|------|--------|---------|
| 1 | Delete `useAutoBuild`'s SSE block. Add `autoBuildState` slice to RunState; handle `daemon:auto-build:paused` in the existing reducer; add a selector. Keep the SWR poll as fallback. | -10 |
| 2 | Make `effectiveOrchestration` always be `earlyOrchestration`. Delete the `orchestration` SWR fetch in `app.tsx` and the `/api/orchestration/:id` endpoint in `packages/monitor/src/server.ts`. Delete `invalidateOnEvent`'s `planning:complete` / `expedition:compile:complete` arms. | -120 |
| 3 | Delete `invalidateOnEvent` entirely. Confirm 5 s queue poll + 10 s runs poll are acceptable freshness. If not, push these caches into a new daemon reducer in step 4. | -45 |
| 4 | Add `useDaemonEvents` + `/api/daemon-events` SSE. Move runs list, queue, auto-build off polling onto this stream. Delete `/api/latest-run`, the `latestRun` SWR hook, and the auto-switch refs. | +180 / -90 |
| 5 (optional) | Tear out remaining `useSWR` polls on per-session data. | -30 |

Steps 1 to 3 are pure simplifications and likely fix the recurring swimlane bug regardless of which exact failure mode it had, because they delete the SSE-to-SWR bridge that has been the source of recent regressions. Step 4 is the bigger replatform.

### Tradeoffs and things to push back on

- **Step 2 assumes `planning:complete` always carries the full plan list with `dependsOn` and per-plan `build`/`review` config.** Today it does (see `handlePlanningComplete` in `packages/monitor-ui/src/lib/reducer/handle-planning.ts:18-58`). Worth confirming for expedition-mode runs before committing.
- **Step 3 makes runs list and queue lag by up to 10 s and 5 s** instead of being pushed by SSE. If you want sub-second updates on those, Step 4 is required, not optional.
- **Step 4 is a daemon-side change.** Worth doing only after Steps 1 to 3 prove the simplification holds.
- **Single global SSE for everything (one stream period)** is the obvious "even cleaner" alternative. Rejected because (a) the per-session stream is the right granularity for the high-volume per-session events, and (b) a global stream couples session-scoped backfill (Last-Event-ID) with daemon-scoped backfill in one cursor, which gets awkward. Two subscribers, one per concern, is simpler than one subscriber doing both jobs.

## Scope

### In scope

- Two SSE subscribers total: `useEforgeEvents(sessionId)` (per-session) and `useDaemonEvents()` (daemon-wide, new).
- Folding auto-build state into `useEforgeEvents`'s reducer; deleting `useAutoBuild`'s SSE.
- Deleting `/api/orchestration/:id` endpoint and its SWR fetch; making `earlyOrchestration` the sole source of truth.
- Deleting `invalidateOnEvent` glue layer.
- Replacing auto-switch refs in `app.tsx` with a derived selector from `useDaemonEvents`.
- Deleting `/api/latest-run` + `latestRun` SWR poll.
- New daemon endpoint `GET /api/daemon-events` (SSE) emitting existing daemon-level events (`daemon:auto-build:paused`, `queue:*`, `enqueue:*`, plus a thin session lifecycle stream `session:start`, `session:end`).
- Snapshot endpoint to seed daemon-state reducer on mount (could be existing `/api/runs` plus the queue).
- Migration in 5 steps (Step 5 optional), each shippable independently, delete-only steps first.

### What stays

- `useReducer` per session, reducer decomposition into typed handlers, regression fixtures. The reducer architecture is clean. The bug is at its boundaries.
- `subscribeToSession` from `@eforge-build/client`. Reused by both `useEforgeEvents` and the new `useDaemonEvents` (one new endpoint name, same client primitive).
- SWR for `projectContext` and `recovery sidecar` (genuinely on-demand reads).
- shadcn UI components.

### Out of scope

- Does not touch the reducer architecture, handlers, or fixtures.
- Does not change the engine or the wire format of any event.
- Does not change `subscribeToSession`'s reconnect / Last-Event-ID behaviour.
- Does not introduce a new state-management library.
- Single global SSE for everything (one stream period) is explicitly rejected.

## Acceptance Criteria

- Only two SSE subscribers exist in the monitor UI: `useEforgeEvents(sessionId)` and `useDaemonEvents()`.
- `useAutoBuild`'s SSE block is removed; auto-build state is a slice in `useEforgeEvents`'s reducer with a `selectAutoBuild(runState)` selector; writing still uses `POST /api/auto-build/set` as a one-shot HTTP call.
- `effectiveOrchestration` always equals `earlyOrchestration`; the `/api/orchestration/:id` endpoint in `packages/monitor/src/server.ts` is deleted; the `orchestration` SWR fetch in `app.tsx` is deleted; `invalidateOnEvent`'s `planning:complete` / `expedition:compile:complete` arms are removed.
- `invalidateOnEvent` is deleted entirely; nothing on the live event path mutates SWR caches; SWR is used only for `projectContext` and `recovery sidecar`.
- The auto-switch refs (`knownLatestRef`, `userSelectedRef`, `isCurrentRunningRef`) and tracking effects in `app.tsx:65-87, 133-142` are removed and replaced by a derived selector from `useDaemonEvents`: "if no user-selected session and a more recent session exists, follow it."
- `/api/latest-run` endpoint and the `latestRun` SWR poll are deleted; the latest run is read as the first entry in `useDaemonEvents`'s runs list.
- `GET /api/daemon-events` (SSE) is implemented, emitting `daemon:auto-build:paused`, `queue:*`, `enqueue:*`, and a session lifecycle stream (`session:start`, `session:end`); it uses the same poll loop pattern as `serveSSE` with one route and one subscriber set.
- A snapshot endpoint seeds the daemon-state reducer on mount (existing `/api/runs` plus the queue is acceptable).
- The reducer architecture, handlers, and regression fixtures are unchanged.
- The engine and the wire format of events are unchanged.
- `subscribeToSession`'s reconnect / Last-Event-ID behaviour is unchanged and is reused by both `useEforgeEvents` and `useDaemonEvents`.
- No new state-management library is introduced.
- Each migration step (1 through 5) is shipped as an independent change in the documented order, with delete-only steps first.
- Step 2 verification: `planning:complete` is confirmed to always carry the full plan list with `dependsOn` and per-plan `build`/`review` config (including for expedition-mode runs) before Step 2 is committed.
