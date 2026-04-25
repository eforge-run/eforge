# Hooks

## When to use which hook

- `useEforgeEvents(sessionId)` — subscribe to a single session's live event stream. Use for per-session dashboards, pipeline views, timelines.
- `useApi(endpoint)` — one-shot typed fetch for resource data (queue list, profile list, runs). Use when the data is not session-scoped or is a snapshot.

## Transport details

`useEforgeEvents` issues an initial HTTP GET to `/api/run-state/:id` (via
`API_ROUTES.runState`) to batch-load all stored events for the session. If the
session is still active, it then calls `subscribeToSession` from
`@eforge-build/client` with `baseUrl: ''` (same-origin relative URL) to stream
live events over SSE. `subscribeToSession` handles reconnect with exponential
backoff, `Last-Event-ID` replay, and abort via `AbortSignal`.

`useApi` is a thin wrapper around `fetch` — use it for one-shot resource
endpoints that return JSON snapshots (queue, profiles, run list).
