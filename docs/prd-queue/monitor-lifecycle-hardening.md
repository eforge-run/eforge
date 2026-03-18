---
title: Monitor Lifecycle Hardening
created: 2026-03-18
status: pending
---

# Monitor Lifecycle Hardening

## Problem / Motivation

Two problems with the monitor's current design:

1. **Recording is coupled to the web server.** `--no-monitor` disables both SQLite persistence and the web dashboard. The `enqueue` command hardcodes `noMonitor=true`, so enqueue events are never recorded. Events should always persist to SQLite - the flag should only control whether the web server runs.

2. **Shutdown is a 30-second idle guess.** When a run completes, the detached server polls timestamps and waits 30s of silence. No way for the user to keep the server alive to inspect results, and no way for the server to know the difference between "run ended" and "between events."

## Goal

Decouple event recording from the web server so events always persist to SQLite, replace the idle timeout with a countdown plus browser keep-alive mechanism, and keep the idle timeout as a short crash-recovery fallback.

## Approach

Three-part implementation:

### Part 1: Always Record Events

`withRecording()` wraps every event stream. `--no-monitor` only controls the web server.

**`src/monitor/index.ts`** - Change `ensureMonitor` signature to accept `{ port?, noServer? }`:

```typescript
export async function ensureMonitor(
  cwd: string,
  options?: { port?: number; noServer?: boolean },
): Promise<Monitor>
```

When `noServer` is true:
- Still open the DB (`openDatabase(dbPath)`)
- Still return a full `Monitor` with `wrapEvents` (which calls `withRecording`)
- Set `server` to `null`
- Skip the lockfile check, server spawn, and `waitForServer`

Change `Monitor` interface:

```typescript
export interface Monitor {
  db: MonitorDB;
  server: { port: number; url: string } | null;  // null when noServer
  wrapEvents(events: AsyncGenerator<EforgeEvent>): AsyncGenerator<EforgeEvent>;
  stop(): void;
}
```

**`src/cli/index.ts`** - `withMonitor()` always calls `ensureMonitor`. Pass the `noMonitor` flag as `noServer`:

```typescript
async function withMonitor<T>(
  noServer: boolean | undefined,
  fn: (monitor: Monitor) => Promise<T>,
): Promise<T> {
  const monitor = await ensureMonitor(process.cwd(), { noServer: noServer ?? false });
  activeMonitor = monitor;
  if (monitor.server) {
    console.error(chalk.dim(`  Monitor: ${monitor.server.url}`));
  }
  try {
    return await fn(monitor);
  } finally {
    if (activeMonitor) {
      monitor.stop();
      activeMonitor = undefined;
    }
  }
}
```

The `fn` callback now always receives a `Monitor` (never `undefined`). Update all call sites.

**`wrapEvents()`** always wraps with recording since `monitor` is always present:

```typescript
function wrapEvents(
  events: AsyncGenerator<EforgeEvent>,
  monitor: Monitor,
  hooks: readonly HookConfig[],
  sessionOpts?: SessionOptions,
): AsyncGenerator<EforgeEvent> {
  let wrapped = sessionOpts ? withSessionId(events, sessionOpts) : events;
  if (hooks.length > 0) wrapped = withHooks(wrapped, hooks, process.cwd());
  return monitor.wrapEvents(wrapped);
}
```

The `enqueue` command keeps `withMonitor(true, ...)` - this now means "record events but don't spawn web server."

### Part 2: Countdown Shutdown with Browser Keep-Alive

Server announces shutdown with a countdown. Browser shows a banner. User can click "Keep Alive" to prevent shutdown.

**`src/monitor/server.ts`** - Add to `MonitorServer` interface:

```typescript
export interface MonitorServer {
  readonly port: number;
  readonly url: string;
  stop(): Promise<void>;
  broadcast(eventName: string, data: object): void;
  readonly subscriberCount: number;
  onKeepAlive: (() => void) | null;
}
```

`broadcast(eventName, data)` writes a named SSE event to all connected subscribers:

```typescript
broadcast(eventName: string, data: object): void {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const sub of subscribers) {
    try { sub.res.write(payload); } catch {}
  }
}
```

`subscriberCount` is a getter returning `subscribers.size`.

`POST /api/keep-alive` is a new endpoint that calls `server.onKeepAlive?.()` and returns 200. Add to the request handler in `createServer`.

**`src/monitor/server-main.ts`** - Replace the idle timeout with a state machine:

```
WATCHING → COUNTDOWN → SHUTDOWN
    ↑          │
    └──────────┘  (keep-alive or new run)
```

States:
- `WATCHING`: Runs are active. Check every 3s.
- `COUNTDOWN`: No running runs. Counting down. Broadcast `monitor:shutdown-pending` every 5s with seconds remaining.
- `SHUTDOWN`: Countdown expired. Clean exit.

Countdown durations:
- `COUNTDOWN_WITH_SUBSCRIBERS_S = 60` - someone is watching, give them time
- `COUNTDOWN_NO_SUBSCRIBERS_S = 10` - nobody's watching, shut down quickly
- `COUNTDOWN_CHECK_INTERVAL_MS = 3000` - how often to check state

Transitions:
- `WATCHING → COUNTDOWN`: `getRunningRuns()` returns empty
- `COUNTDOWN → WATCHING`: `getRunningRuns()` returns non-empty (new run started)
- `COUNTDOWN → COUNTDOWN` (reset): `/api/keep-alive` received (via `server.onKeepAlive` callback)
- `COUNTDOWN → SHUTDOWN`: countdown reaches 0

SSE events pushed during countdown:

```
event: monitor:shutdown-pending
data: {"secondsRemaining": 55}

event: monitor:shutdown-cancelled
data: {"reason": "keep-alive"}
```

Keep-alive behavior when `/api/keep-alive` is called:
1. Reset countdown to `COUNTDOWN_WITH_SUBSCRIBERS_S`
2. Broadcast `monitor:shutdown-cancelled`
3. Stay in `COUNTDOWN` state (countdown restarts, not back to `WATCHING`)

Orphan detection stays unchanged (every 5s, marks dead PIDs as 'killed'). This feeds into the countdown - once a run is marked killed, `getRunningRuns()` returns empty, and the countdown starts.

Idle timeout fallback: Keep a simple idle timeout (10s with no events, no running runs) as crash recovery for cases where the browser isn't connected and the CLI died. This is the existing logic with reduced constants.

**`src/monitor/ui/src/hooks/use-eforge-events.ts`** - Add shutdown state to the hook return:

```typescript
interface UseEforgeEventsResult {
  runState: RunState;
  connectionStatus: ConnectionStatus;
  shutdownCountdown: number | null;  // seconds remaining, null if not shutting down
}
```

Register named event listeners on the `EventSource`:

```typescript
es.addEventListener('monitor:shutdown-pending', (e) => {
  const data = JSON.parse(e.data);
  setShutdownCountdown(data.secondsRemaining);
});

es.addEventListener('monitor:shutdown-cancelled', () => {
  setShutdownCountdown(null);
});
```

**`src/monitor/ui/src/components/layout/shutdown-banner.tsx`** - New component using shadcn `Alert` component (`src/monitor/ui/src/components/ui/alert.tsx`):

```
┌─────────────────────────────────────────────────────────────┐
│  Server shutting down in 45s              [ Keep Alive ]    │
└─────────────────────────────────────────────────────────────┘
```

- Built on shadcn `Alert` + `AlertDescription` with a `Button` for the action
- Amber/yellow variant styling consistent with the existing design language
- "Keep Alive" button sends `POST /api/keep-alive`
- On click, starts a periodic ping (every 30s) to `/api/keep-alive` for as long as the tab is open
- Banner disappears when `shutdownCountdown` becomes null (cancelled or new run)

**`src/monitor/ui/src/app.tsx`** - Pass `shutdownCountdown` from the hook to `ShutdownBanner`. Render it above the main content area.

### Part 3: Standalone Monitor Command

**`src/monitor/index.ts`** - Extract `signalMonitorShutdown`:

```typescript
export async function signalMonitorShutdown(cwd: string): Promise<void>
```

Reads lockfile, checks server alive, checks no running runs, sends SIGTERM. All errors swallowed. This replaces the 20+ lines of inline logic in the `monitor` command handler.

**`src/cli/index.ts`** - Replace the inline check-and-kill logic (lines 424-448) in the `monitor` command with `await signalMonitorShutdown(cwd)`.

The `run` command does NOT call `signalMonitorShutdown` - the server manages its own countdown.

## Scope

### In scope

| File | Change |
|------|--------|
| `src/monitor/index.ts` | `ensureMonitor` accepts `noServer`, `Monitor.server` nullable, add `signalMonitorShutdown` |
| `src/monitor/server.ts` | Add `broadcast`, `subscriberCount`, `onKeepAlive` to `MonitorServer`. Add `POST /api/keep-alive` route |
| `src/monitor/server-main.ts` | Replace idle timeout with countdown state machine. Wire `server.onKeepAlive`. Reduce fallback constants |
| `src/cli/index.ts` | `withMonitor` always creates recorder. `wrapEvents` always records. Simplify `monitor` command |
| `src/monitor/ui/src/hooks/use-eforge-events.ts` | Add `shutdownCountdown` state, named SSE event listeners |
| `src/monitor/ui/src/components/layout/shutdown-banner.tsx` | New component: countdown banner with keep-alive button |
| `src/monitor/ui/src/app.tsx` | Render `ShutdownBanner`, pass countdown from hook |
| `test/monitor-shutdown.test.ts` | Tests for `signalMonitorShutdown` |
| `test/monitor-recording.test.ts` | Tests for decoupled recording (events recorded when `noServer=true`) |

### Out of scope

N/A

## Acceptance Criteria

1. `pnpm type-check` passes
2. `pnpm test` passes (existing + new tests in `test/monitor-shutdown.test.ts` and `test/monitor-recording.test.ts`)
3. `pnpm build` passes (including UI build)
4. `eforge run --no-monitor` on a simple PRD records events to `.eforge/monitor.db`
5. `eforge run` shows a countdown banner in the monitor after run completes. Clicking "Keep Alive" keeps the server alive. Closing the tab causes the server to shut down after ~60s
6. `eforge run` with Ctrl+C causes the server to start a countdown after detecting the orphaned run
7. Two concurrent `eforge run` processes - server stays alive until both complete
