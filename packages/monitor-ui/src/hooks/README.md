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

- Performs an initial HTTP GET to `/api/run-state/:id` to batch-load all stored events.
- Then calls `subscribeToSession` for live SSE updates.
- Returns `{ runState, connectionStatus, shutdownCountdown }`.

### `useDaemonEvents()`

Subscribe to the daemon-wide SSE stream. Owns the runs list, queue, session metadata, and auto-build slices for the whole app. Intended to be called **once** in `AppContent` and passed as props to sub-components.

- Performs one-shot parallel snapshot fetches (`/api/runs`, `/api/queue`, `/api/session-metadata`, `/api/auto-build`) on mount.
- Then calls `subscribeToDaemonEvents` for live SSE updates.
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

Both SSE hooks use `subscribeToSession` / `subscribeToDaemonEvents` from `@eforge-build/client/browser` with `baseUrl: ''` (same-origin relative URL). The underlying helper handles reconnect with exponential backoff, `Last-Event-ID` replay, and abort via `AbortSignal`.
