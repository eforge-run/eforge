# Hooks

## When to use which hook

- `useEforgeEvents(sessionId)` — subscribe to a single session's live event stream. Use for per-session dashboards, pipeline views, timelines.
- `useAutoBuild(sessionId)` — read/toggle the auto-build state. Combines SWR polling (10s) with SSE-driven cache invalidation on `daemon:auto-build:paused`.

## Fetching non-session data

For resource endpoints (queue, runs, session metadata, plans, etc.) use `useSWR` directly with the shared `fetcher` from `lib/swr-fetcher.ts` and a key built from `API_ROUTES` / `buildPath`:

```ts
import useSWR from 'swr';
import { fetcher } from '@/lib/swr-fetcher';
import { API_ROUTES } from '@eforge-build/client/browser';

const { data, isLoading, error } = useSWR<RunInfo[]>(API_ROUTES.runs, fetcher, { refreshInterval: 10000 });
```

## Transport details

`useEforgeEvents` issues an initial HTTP GET to `/api/run-state/:id` (via
`API_ROUTES.runState`) to batch-load all stored events for the session. If the
session is still active, it then calls `subscribeToSession` from
`@eforge-build/client` with `baseUrl: ''` (same-origin relative URL) to stream
live events over SSE. `subscribeToSession` handles reconnect with exponential
backoff, `Last-Event-ID` replay, and abort via `AbortSignal`.

SSE events also drive SWR cache invalidation via the global `mutate()` call —
see `use-eforge-events.ts` for the event-to-invalidation mapping.
