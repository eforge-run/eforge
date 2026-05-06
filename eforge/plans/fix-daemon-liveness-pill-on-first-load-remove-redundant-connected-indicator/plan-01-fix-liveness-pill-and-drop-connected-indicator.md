---
id: plan-01-fix-liveness-pill-and-drop-connected-indicator
name: Fix daemon liveness pill on first load and drop redundant connected indicator
branch: fix-daemon-liveness-pill-on-first-load-remove-redundant-connected-indicator/plan-01-fix-liveness-pill-and-drop-connected-indicator
---

# Fix daemon liveness pill on first load and drop redundant connected indicator

## Architecture Context

The monitor UI header carries two overlapping liveness signals today:

1. **`DaemonStatusPill`** — fed by daemon-events SSE heartbeats (`packages/monitor/src/server.ts` heartbeat timer at line 449, `HEARTBEAT_INTERVAL_MS = 10_000`). Renders `alive Xs ago` (green/amber/red) via `selectHeartbeatStaleness()` in `packages/monitor-ui/src/lib/daemon-reducer.ts`.
2. **Per-session connection dot + label** — fed by `useEforgeEvents(currentSessionId).connectionStatus`. Renders a `connected / connecting / disconnected` dot in `packages/monitor-ui/src/components/layout/header.tsx` (lines 70-78).

These track different SSE connections but both convey the same user-facing concept ("is the UI getting live updates?"). The pill is strictly more informative (staleness age + click-through to the daemon activity drawer), so the per-session indicator is redundant.

A known defect reinforces the cleanup: on every page load and reload the pill renders `daemon offline` (red) for up to 10 s. Root cause confirmed by direct file inspection:

- `packages/monitor-ui/src/lib/daemon-reducer.ts:79` initialises `latestHeartbeat: null`.
- The `BATCH_SEED` action used by `seedSnapshot()` only seeds runs/queue/sessionMetadata/autoBuild — it does not seed a heartbeat.
- The daemon-events SSE handler in `packages/monitor/src/server.ts:366-384` deliberately skips replay for fresh connects (heartbeats are live-only and never persisted).
- The next periodic heartbeat tick is up to `HEARTBEAT_INTERVAL_MS` (10 s) away. During that window `selectHeartbeatStaleness()` returns `'dead'` (line 194) and the label reads `daemon offline`.

Removing the redundant indicator without fixing the flash would make the header look broken on every refresh, so both edits ship together — server first, then UI.

## Implementation

### Overview

Two tightly coupled edits in a single plan:

1. **Server**: extract heartbeat-payload construction in `packages/monitor/src/server.ts` into a small helper `buildHeartbeatPayload()` and emit one immediate heartbeat frame to the just-registered subscriber on the daemon-events SSE handler — kept live-only (no DB persistence, no SSE `id:` field).
2. **UI**: drop the redundant `connectionStatus` dot + label from the header and stop threading `connectionStatus` from `app.tsx` into `<Header />`. The `useEforgeEvents` hook itself is unchanged — its `connectionStatus` field stays on the return type so existing tests do not churn.

### Key Decisions

1. **Helper extraction over inline duplication.** The heartbeat payload is constructed in two places after this change (periodic tick + on-connect). Extracting `buildHeartbeatPayload()` keeps the two emission sites in lockstep, so a future field added to the payload only has to be added once.
2. **Live-only heartbeats stay live-only.** The on-connect frame is written directly to the connecting client's `res` and omits the SSE `id:` field — exactly like the periodic tick — so reconnect replay via `last-event-id` continues to ignore heartbeats. No DB persistence, no new endpoint, no reducer changes. This preserves the existing design that heartbeats are stateless.
3. **Emit after the resync marker and after subscriber registration.** The on-connect heartbeat write goes after the resync-marker block (`server.ts:366-384`) and after `daemonSubscribers.add(subscriber)` (line 388). That ordering ensures the resync-marker-driven `id:` cutoff is set first, and `subscribers` count in the heartbeat payload reflects the just-registered client (consistent with the periodic tick's view).
4. **No reducer / no daemon-status-pill changes.** Once the server fix lands, `latestHeartbeat` is non-null almost immediately on page load (typically <100 ms after SSE connect), so the existing `alive Xs ago` / `daemon offline` rendering is correct without UI modification. Avoiding reducer changes also means the existing daemon-reducer / use-daemon-events tests continue to pass with no edits.
5. **Preserve `useEforgeEvents` return shape.** Even though `connectionStatus` is no longer consumed in `app.tsx`, the hook's `connectionStatus` return field stays so existing hook tests do not need to be rewritten.

## Scope

### In Scope

- Extract `buildHeartbeatPayload()` in `packages/monitor/src/server.ts` and replace the inline construction in the periodic `setInterval` tick.
- Emit one immediate heartbeat frame to the just-registered subscriber inside the `daemonEvents` SSE handler in `packages/monitor/src/server.ts`.
- Remove the per-session connection dot + label and `connectionStatus` prop from `packages/monitor-ui/src/components/layout/header.tsx`.
- Stop destructuring and threading `connectionStatus` to `<Header />` in `packages/monitor-ui/src/app.tsx`.

### Out of Scope

- `packages/monitor-ui/src/components/daemon/daemon-status-pill.tsx` — unchanged.
- `packages/monitor-ui/src/lib/daemon-reducer.ts` — unchanged. No new initial state, no new action.
- `packages/monitor-ui/src/hooks/use-eforge-events.ts` — unchanged. The `connectionStatus` field stays on the return type so existing tests do not churn.
- No new HTTP snapshot endpoint. Heartbeats remain live-only by design.
- No DB persistence of heartbeats and no changes to SSE replay semantics.
- No new tests are required. AC item 2 explicitly notes the change is a single extra SSE write at connect time.

## Files

### Modify

- `packages/monitor/src/server.ts` — Extract `buildHeartbeatPayload()` (a function that captures `db`, `options`, `daemonSubscribers`, and `instanceStartedAt` from the enclosing closure). Replace the inline heartbeat-data construction inside the periodic `setInterval` (currently lines 453-485) with a single call: `const heartbeatData = buildHeartbeatPayload();`. In the `daemonEvents` SSE handler, after the resync-marker block (lines 366-384) and after `daemonSubscribers.add(subscriber)` (line 388), add `res.write(`data: ${buildHeartbeatPayload()}\n\n`);` — no SSE `id:` field, just like the periodic tick. Keep the existing `try { db.getRunningRuns().length } catch {}` and `try { readdirSync(queuePath) } catch {}` guards inside the helper so a closed DB or missing queue dir does not throw on first connect.
- `packages/monitor-ui/src/components/layout/header.tsx` — Drop `import type { ConnectionStatus } from '@/lib/types';` (line 3). Remove `connectionStatus: ConnectionStatus;` from `HeaderProps` (line 16). Remove `connectionStatus` from the destructured params of the `Header` function (line 44). Delete the dot `<div>` + label `<span>` block at lines 70-78. Leave the surrounding `flex items-center gap-2` container, `DaemonStatusPill`, and Auto-build switch untouched.
- `packages/monitor-ui/src/app.tsx` — On line 43, drop `connectionStatus` from the destructure of `useEforgeEvents(currentSessionId)`. Final shape: `const { runState, shutdownCountdown } = useEforgeEvents(currentSessionId);`. On line 241, remove the `connectionStatus={connectionStatus}` prop from `<Header />`. No other changes.

## Verification

- [ ] `pnpm --filter @eforge-build/monitor type-check` exits 0.
- [ ] `pnpm --filter @eforge-build/monitor-ui type-check` exits 0.
- [ ] `pnpm test` exits 0 — existing daemon-reducer and use-daemon-events tests still pass.
- [ ] `pnpm build` exits 0.
- [ ] In `packages/monitor/src/server.ts`, the periodic heartbeat `setInterval` body and the new on-connect emission both call `buildHeartbeatPayload()` — the inline JSON.stringify object is gone from the periodic tick.
- [ ] In `packages/monitor/src/server.ts`, the on-connect heartbeat write appears after `daemonSubscribers.add(subscriber)` in the `daemonEvents` handler, uses `res.write(`data: ${...}\n\n`)`, and contains no `id:` field.
- [ ] `packages/monitor-ui/src/components/layout/header.tsx` no longer imports `ConnectionStatus`, no longer declares `connectionStatus` in `HeaderProps`, and no longer renders a `connected / connecting / disconnected` dot or label. Grep for `connectionStatus` in this file returns zero matches.
- [ ] `packages/monitor-ui/src/app.tsx` no longer destructures `connectionStatus` from `useEforgeEvents` and no longer passes a `connectionStatus` prop to `<Header />`. Grep for `connectionStatus` in this file returns zero matches.
- [ ] After rebuilding eforge from source and restarting the daemon, opening the monitor UI and hard-reloading shows `alive 0s ago` (green pill) within a fraction of a second — never `daemon offline` followed by a flip.
- [ ] Only one liveness indicator is visible in the header (the pill, to the left of the Auto-build toggle). No secondary grey/green/yellow dot with a `connected / connecting / disconnected` label remains.
- [ ] Clicking the pill still opens the daemon activity drawer.
- [ ] Killing the daemon process turns the pill red with `daemon offline` within ~30 s; restarting the daemon and reloading returns the pill to green `alive 0s ago` immediately.
- [ ] In browser devtools (Network → daemon-events stream), on initial connect the first frame after the resync marker is a `daemon:heartbeat` payload with no `id:` line.
