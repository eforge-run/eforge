---
id: plan-03-monitor-ui-fsm-card
name: Monitor UI Scheduler FSM Status Card
branch: redesign-auto-build-queue-watcher-lifecycle-around-an-fsm-supervisor/plan-03-monitor-ui-fsm-card
agents:
  builder:
    effort: high
    rationale: Consumes the new daemon state model across shared UI types, reducer
      snapshots, the daemon drawer, and static component tests.
  reviewer:
    effort: medium
    rationale: UI work is contained but needs API-contract and regression review for
      snapshot-only state rendering.
---

# Monitor UI Scheduler FSM Status Card

## Architecture Context

Plan-02 makes the daemon emit canonical auto-build supervisor snapshots through existing REST/SSE paths. This plan updates the monitor UI to render those snapshot fields directly. Event history remains contextual; the UI must not infer the canonical FSM state from daemon activity entries.

## Implementation

### Overview

Add a scheduler/auto-build status card to the existing daemon drawer above the heartbeat metrics. The card displays desired state, runtime mode, scheduler liveness/injection state, watcher session, queue/running build counts, capacity when supplied, and last transition reason. The activity feed gains a scheduler-focused filter or group.

### Key Decisions

1. Import or re-export `AutoBuildState` from `@eforge-build/client/browser` instead of duplicating the wire type in `packages/monitor-ui/src/lib/api.ts`.
2. Render canonical `daemonState.autoBuild` snapshot fields. Use heartbeat only for queue depth/running build counts and never to derive the runtime FSM mode.
3. Treat missing optional detail fields as legacy snapshots and render `unknown` or `not reported` instead of synthesizing a mode from event history.
4. Add distinct visual status treatments for `running`, `paused`, transitional modes (`starting`, `stopping`, `restarting`), `disabled`, and `faulted`.
5. Add a scheduler activity filter for `daemon:auto-build:*`, `daemon:scheduler:*`, scheduler/auto-build `daemon:error`, and queue lifecycle events that explain scheduler progress.

## Scope

### In Scope

- Extend monitor UI types/reducer fixtures to preserve enriched `AutoBuildState` snapshots.
- Add a daemon drawer status card near the top of `DaemonDrawer`.
- Pass `daemonState.autoBuild` into the drawer from `DaemonStatusPill`.
- Show queue depth and running builds from `latestHeartbeat` next to scheduler state.
- Add a scheduler-focused activity filter or recent-transition list.
- Update hook/reducer/component tests for enriched snapshots and rendering contracts.

### Out of Scope

- New daemon endpoints.
- UI state inference from historical events.
- Broad monitor layout redesign.
- Engine scheduler changes.

## Files

### Create

- `packages/monitor-ui/src/components/daemon/__tests__/daemon-drawer.test.tsx` — Static/type-level tests for the daemon drawer status card, scheduler filter, and snapshot-only state contract.

### Modify

- `packages/monitor-ui/src/lib/api.ts` — Replaces the local `AutoBuildState` interface with an import/re-export from `@eforge-build/client/browser` while keeping `setAutoBuild()` behavior.
- `packages/monitor-ui/src/lib/daemon-reducer.ts` — Updates heartbeat/auto-build typings and selectors so enriched auto-build snapshots survive `BATCH_SEED`, `SET_AUTO_BUILD`, and event projections.
- `packages/monitor-ui/src/lib/__tests__/daemon-reducer.test.ts` — Updates fixtures and assertions for enriched auto-build state and transition event projections.
- `packages/monitor-ui/src/hooks/use-daemon-events.ts` — Keeps the enriched `snapshot.autoBuild` object from `stream:hello` and preserves any optional liveness detail fields needed by the drawer.
- `packages/monitor-ui/src/hooks/__tests__/use-daemon-events.test.ts` — Updates snapshot and manual toggle fixtures to include representative FSM fields.
- `packages/monitor-ui/src/components/daemon/daemon-drawer.tsx` — Adds the FSM status card, status chip helpers, scheduler liveness rows, last transition display, and scheduler activity filter/group.
- `packages/monitor-ui/src/components/daemon/daemon-status-pill.tsx` — Passes `daemonState.autoBuild` into `DaemonDrawer` and optionally includes runtime mode in the button title for quick inspection.
- `packages/monitor-ui/src/components/layout/header.tsx` — Updates the auto-build toggle label/title to reference runtime mode when present so the header does not imply runnable health from `enabled` alone.

## Verification

- [ ] The daemon drawer source contains a status card that renders `desired`, `mode`, `scheduler`, `watcher.sessionId`, and `lastTransition` from `autoBuild` props.
- [ ] The status card displays queue depth and running build count from `latestHeartbeat`, and displays capacity when the supervisor snapshot supplies it.
- [ ] The drawer has a scheduler activity filter that includes `daemon:auto-build:`, `daemon:scheduler:`, scheduler/auto-build `daemon:error`, and queue wake/progress event entries.
- [ ] Legacy snapshots containing only `enabled` and `watcher` render fallback text instead of throwing.
- [ ] `useDaemonEvents` stores the enriched `stream:hello.autoBuild` object without dropping optional detail fields.
- [ ] `setDaemonAutoBuild()` updates state with an enriched `AutoBuildState` response from `POST /api/auto-build`.
- [ ] `pnpm test -- packages/monitor-ui/src/lib/__tests__/daemon-reducer.test.ts packages/monitor-ui/src/hooks/__tests__/use-daemon-events.test.ts packages/monitor-ui/src/components/daemon/__tests__/daemon-drawer.test.tsx` exits 0.
