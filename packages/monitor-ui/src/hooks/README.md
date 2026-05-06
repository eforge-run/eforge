# Hooks

## Two-subscriber architecture

The monitor UI maintains **exactly two SSE connections** at any given time:

| Hook | Stream | Purpose |
|------|--------|---------|
| `useEforgeEvents(sessionId)` | `GET /api/events/:sessionId` | Per-session build events (pipeline, agents, plans) |
| `useDaemonEvents()` | `GET /api/daemon-events` | Daemon-wide events (runs list, queue, auto-build) |

This constraint (PRD requirement) prevents unbounded connection growth and keeps event routing clear.

## When to use which hook

### `useEforgeEvents(sessionId)`

Subscribe to a single session's live event stream. Use for per-session dashboards, pipeline views, and timelines.

- Uses `subscribeWithSnapshot` from `@eforge-build/client/browser` to connect to the per-session SSE stream.
- The first frame on every (re)connect is a `stream:hello` snapshot carrying all session events and current status.
- For terminal sessions (completed/failed), the server closes the connection after the snapshot frame; no live subscription is established.
- Returns `{ runState, connectionStatus, shutdownCountdown }`.

### `useDaemonEvents()`

Subscribe to the daemon-wide SSE stream. Owns the runs list, queue, session metadata, auto-build, activity ring-buffer, and latest heartbeat slices for the whole app. Intended to be called **once** in `AppContent` and passed as props to sub-components.

- Uses `subscribeWithSnapshot` from `@eforge-build/client/browser` to connect to `/api/daemon-events`.
- The first frame on every (re)connect is a `stream:hello` snapshot carrying `runs`, `queue`, `sessionMetadata`, `autoBuild`, `recentActivity`, and `liveness` fields. All are fed into a single `BATCH_SEED` dispatch, so no separate REST snapshot fetches are needed.
- The `liveness` field is dispatched as a synthetic `daemon:heartbeat` payload so the liveness pill renders green immediately on (re)connect.
- Returns `{ daemonState, connectionStatus, setDaemonAutoBuild }`.

### `useAutoBuild(autoBuildState, onUpdate)`

Writer-only hook for the auto-build toggle. The reader path is `daemonState.autoBuild` from `useDaemonEvents`. This hook only fires the HTTP mutation (`POST /api/auto-build`) and tracks in-flight state to prevent double-clicks.

## Remaining SWR consumers

SWR is reserved for genuinely on-demand reads that are not covered by the two SSE subscribers:

| Location | SWR key | Purpose |
|----------|---------|---------|
| `app.tsx` | `API_ROUTES.projectContext` | Project name / git remote (static per daemon session) |
| `queue-section.tsx` (RecoveryRow) | `['sidecar', item.id]` | Recovery sidecar for individual failed PRDs (on-demand) |

All live event-driven UI updates flow through `useEforgeEvents` or `useDaemonEvents` — SWR cache invalidation on SSE events is no longer used.

## Transport details

Both SSE hooks use `subscribeWithSnapshot` from `@eforge-build/client/browser`. The generator handles reconnect with exponential backoff, `Last-Event-ID` capture (from the `cursor` field in the `stream:hello` frame), and abort via `AbortSignal`.

On every (re)connect, the server emits a `stream:hello` named SSE event carrying a full snapshot. The client intercepts it and surfaces it as a `{ kind: 'snapshot' }` frame — no `Last-Event-ID` replay needed on initial connect since the snapshot contains all required state. When `Last-Event-ID` is present (reconnect), the server emits `stream:hello` first and then replays all events past that cutoff.
