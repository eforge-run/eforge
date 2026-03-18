---
title: Fix: Monitor Server Premature Shutdown on Startup
created: 2026-03-18
status: pending
---

## Problem / Motivation

The monitor lifecycle hardening introduced a startup race condition in `src/monitor/server-main.ts`. The countdown state machine shuts the server down after ~20 seconds because:

1. Server starts with no running runs in the DB (the CLI hasn't emitted `phase:start` yet)
2. After 10s idle (`IDLE_FALLBACK_MS`), the server transitions to COUNTDOWN
3. No SSE subscribers → `COUNTDOWN_WITHOUT_SUBSCRIBERS_MS = 10s`
4. Server exits before the CLI records its first event

The CLI takes 20+ seconds before emitting `phase:start` (engine setup, enqueue formatting agent call), so the server dies before the run even begins.

## Goal

Prevent the monitor server from entering the countdown shutdown sequence until it has observed at least one event recorded after the server started - eliminating the startup race while preserving normal countdown/shutdown behavior once events have flowed.

## Approach

Add a `serverStartedAt` timestamp and an `hasSeenActivity` gate in `src/monitor/server-main.ts`. In the WATCHING state check loop, before evaluating idle time, query the DB for the latest event timestamp. If any event has a timestamp >= `serverStartedAt`, set `hasSeenActivity = true`. The idle/countdown logic only runs after `hasSeenActivity` is true.

```typescript
const serverStartedAt = Date.now();
let hasSeenActivity = false;
```

In the WATCHING state handler:

```typescript
if (state === 'WATCHING') {
  const latestTimestamp = db.getLatestEventTimestamp();
  if (latestTimestamp) {
    const eventTime = new Date(latestTimestamp).getTime();
    if (eventTime > lastActivityTimestamp) {
      lastActivityTimestamp = eventTime;
    }
    // Mark that we've seen activity if any event arrived after server startup
    if (eventTime >= serverStartedAt) {
      hasSeenActivity = true;
    }
  }

  // Don't enter countdown until we've seen at least one event since startup
  if (!hasSeenActivity) return;

  const idleMs = Date.now() - lastActivityTimestamp;
  if (idleMs >= IDLE_FALLBACK_MS) {
    transitionToCountdown();
  }
  return;
}
```

Behavioral outcomes:
- Fresh server waiting for a CLI → stays in WATCHING indefinitely until first event
- `eforge monitor` standalone → stays in WATCHING until Ctrl+C/SIGTERM (no events = no countdown)
- After events have flowed and runs complete → normal countdown/shutdown behavior

## Scope

**In scope:**
- Adding `serverStartedAt` timestamp and `hasSeenActivity` flag to `src/monitor/server-main.ts`
- Gating the WATCHING → COUNTDOWN transition on `hasSeenActivity`
- Adding a test case in `test/monitor-shutdown.test.ts` verifying the `hasSeenActivity` gate prevents premature shutdown

**Out of scope:**
- N/A

## Acceptance Criteria

- The monitor server does not enter COUNTDOWN state before observing at least one event with a timestamp >= `serverStartedAt`
- A standalone `eforge monitor` (no CLI emitting events) stays in WATCHING until terminated via signal
- After events have flowed and runs complete, the normal countdown/shutdown sequence works as before
- A test in `test/monitor-shutdown.test.ts` verifies that `hasSeenActivity` prevents premature shutdown
- `pnpm type-check` passes
- `pnpm test` passes
- `pnpm build` passes
- Manual verification: `eforge run` on a PRD confirms the monitor server stays alive during enqueue/formatting and throughout the entire run
