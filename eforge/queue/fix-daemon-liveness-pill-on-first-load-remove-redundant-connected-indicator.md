---
title: Fix daemon liveness pill on first load + remove redundant "connected" indicator
created: 2026-05-06
---

# Fix daemon liveness pill on first load + remove redundant "connected" indicator

## Problem / Motivation

The header currently shows two overlapping liveness signals:

1. **`DaemonStatusPill`** — green/amber/red dot with `alive Xs ago` label, fed by daemon-events SSE heartbeats. Clickable to open the daemon activity drawer.
2. **`connectionStatus` dot + label** — green/yellow/grey dot + text (`connected` / `connecting` / `disconnected`), fed by the per-session SSE stream (`useEforgeEvents`).

These track different connections (daemon-events SSE vs. per-session SSE) but both convey "is the UI getting live updates?" so they are redundant. The pill is strictly more informative (staleness age + drill-down drawer).

The user pointed out a second, related defect: on every page load and reload, the pill shows **`daemon offline`** (red) for up to 10 seconds, while the per-session "connected" dot is correct immediately. Removing "connected" without fixing this would make the header look broken on every refresh. So we need to ship both changes together.

### Root cause of the first-load flash

`packages/monitor-ui/src/lib/daemon-reducer.ts:79` initializes `latestHeartbeat: null`. The `BATCH_SEED` action (used by `seedSnapshot()` in `use-daemon-events.ts`) only seeds runs / queue / sessionMetadata / autoBuild — it does not seed a heartbeat. The daemon-events SSE handler in `packages/monitor/src/server.ts:366–384` deliberately skips replay for fresh connects (heartbeats are live-only, never persisted). So the client must wait 0–10s for the next periodic heartbeat tick (`HEARTBEAT_INTERVAL_MS = 10_000`, `server.ts:448`) before the pill turns green. During that window `selectHeartbeatStaleness()` returns `'dead'` (`daemon-reducer.ts:194`) and the label reads `daemon offline`.

## Goal

Eliminate the first-load `daemon offline` flash on the daemon liveness pill, and remove the redundant per-session "connected" indicator from the header so a single, more informative liveness signal remains.

## Approach

Two tightly coupled edits, server first:

### 1. Server: emit an immediate heartbeat on SSE connect

**File:** `packages/monitor/src/server.ts`

Refactor the heartbeat payload construction (currently inlined at lines 453–485 inside the periodic `setInterval`) into a small helper, e.g.:

```ts
function buildHeartbeatPayload(): string {
  const uptime = Date.now() - instanceStartedAt;
  let runningBuilds = 0;
  try { runningBuilds = db.getRunningRuns().length; } catch { /* DB may be closed */ }
  let queueDepth = 0;
  if (options?.cwd) {
    try {
      const queuePath = resolve(options.cwd, options?.queueDir ?? 'eforge/queue');
      queueDepth = readdirSync(queuePath).filter(f => f.endsWith('.md')).length;
    } catch { /* queue dir may not exist yet */ }
  }
  return JSON.stringify({
    type: 'daemon:heartbeat',
    timestamp: new Date().toISOString(),
    uptime,
    queueDepth,
    runningBuilds,
    autoBuild: {
      enabled: options?.daemonState?.autoBuild ?? false,
      paused: options?.daemonState?.autoBuildPaused ?? false,
    },
    subscribers: daemonSubscribers.size,
  });
}
```

Then:

- Replace the inline construction inside the periodic `setInterval` (lines 453–485) with a single call: `const heartbeatData = buildHeartbeatPayload();`.
- In the `daemonEvents` handler, **after** the resync-marker block (`server.ts:366–384`) and **after** the subscriber is registered into `daemonSubscribers` (line 388), write one heartbeat frame to *this* `res` only:
  ```ts
  res.write(`data: ${buildHeartbeatPayload()}\n\n`);
  ```
  Just like the periodic tick, omit the SSE `id:` field so this frame is not treated as replayable history. `subscribers` count in the payload reflects the just-registered client, which is fine.

This keeps heartbeats strictly live-only (no DB persistence, no replay) while guaranteeing the very first heartbeat lands within one round-trip of the connect — typically <100 ms.

### 2. UI: remove the per-session "connected" indicator

**File:** `packages/monitor-ui/src/components/layout/header.tsx`

- Drop `import type { ConnectionStatus } from '@/lib/types';` (line 3).
- Remove `connectionStatus: ConnectionStatus;` from `HeaderProps` (line 16).
- Remove `connectionStatus` from the destructured params (line 44).
- Delete the dot `<div>` + label `<span>` block (lines 70–78).

**File:** `packages/monitor-ui/src/app.tsx`

- Line 43: drop `connectionStatus` from the destructure of `useEforgeEvents(currentSessionId)` — it is no longer consumed anywhere.
  Result: `const { runState, shutdownCountdown } = useEforgeEvents(currentSessionId);`
- Line 241: remove the `connectionStatus={connectionStatus}` prop from `<Header />`.

The `useEforgeEvents` hook itself is unchanged — its `connectionStatus` field stays on the return type so existing tests don't churn.

## Scope

### In scope

- `packages/monitor/src/server.ts` — extract `buildHeartbeatPayload()` and emit one frame on fresh SSE connect.
- `packages/monitor-ui/src/components/layout/header.tsx` — drop the redundant indicator + prop.
- `packages/monitor-ui/src/app.tsx` — stop threading `connectionStatus` through to `<Header />`.

### Out of scope / not changing

- `DaemonStatusPill` / `daemon-status-pill.tsx` — unchanged. Once the server fix lands, `latestHeartbeat` is non-null almost immediately on page load, so the existing `alive Xs ago` / `daemon offline` rendering is correct without UI modification.
- `daemon-reducer.ts` — unchanged. No new initial state, no new action.
- No new HTTP snapshot endpoint. Heartbeats remain live-only by design.
- The `useEforgeEvents` hook itself — its `connectionStatus` field stays on the return type so existing tests don't churn.

## Acceptance Criteria

1. `pnpm --filter @eforge-build/monitor type-check && pnpm --filter @eforge-build/monitor-ui type-check` — clean.
2. `pnpm test` — existing daemon-reducer / use-daemon-events tests should continue to pass; no new test required because the change is a single extra SSE write at connect time.
3. End-to-end:
   - Rebuild eforge from source and restart the daemon (eforge-daemon-restart skill).
   - Open the monitor UI and **hard reload** the page. The header should show `alive 0s ago` (green) within a fraction of a second — not `daemon offline` followed by a flip.
   - Confirm only one liveness indicator remains in the header (the pill, to the left of the Auto-build toggle). The grey/green/yellow dot + `connected/connecting/disconnected` label is gone.
   - Click the pill → daemon activity drawer still opens.
   - Stop the daemon (`pkill` the daemon process) → within ~30s the pill should turn red and label should switch to `daemon offline`.
   - Restart the daemon and reload → pill returns to green `alive 0s ago` immediately.
4. Sanity-check the SSE frame in browser devtools (Network → daemon-events stream): on initial connect the first frame after the resync marker should be a `daemon:heartbeat` payload with no `id:` line.
