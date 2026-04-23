---
title: Hardening 08: Monitor UI Consumes @eforge-build/client for SSE and API
created: 2026-04-23
depends_on: ["hardening-12-pipeline-ts-refactor-and-eforge-build-client-boundary-decision"]
---

# Hardening 08: Monitor UI Consumes @eforge-build/client for SSE and API

## Metadata

- **title:** "Hardening 08: monitor UI consumes @eforge-build/client for SSE and API"
- **scope:** excursion
- **depends_on:** [2026-04-22-hardening-01-shared-types-and-constants, 2026-04-22-hardening-02-daemon-route-contract]

## Problem / Motivation

`@eforge-build/client` already exports a battle-tested SSE subscriber (`subscribeToSession` in `packages/client/src/session-stream.ts`) with reconnect, backoff, and session lifecycle handling. The CLI MCP proxy uses it correctly (`packages/eforge/src/cli/mcp-proxy.ts:297`).

The monitor UI does not. `packages/monitor-ui/src/hooks/use-eforge-events.ts:107` and `:150` instantiate `new EventSource(...)` directly and reimplement their own reconnect and HTTP-fallback logic. Two implementations means:

- Bug fixes (e.g., reconnect timeout tuning) only land in one place.
- Adding a new event type requires touching both.
- The UI has no reason to diverge - the client package works in browsers (EventSource is a browser API).

Additionally, the UI has two parallel data-fetching hooks (`useApi` in `use-api.ts` and `useEforgeEvents` in `use-eforge-events.ts`) with overlapping responsibilities and no guidance on which to use. Components pick inconsistently. With PRD 02's typed API helpers available, this can be unified.

## Goal

- `useEforgeEvents` is a thin wrapper around `subscribeToSession`.
- A single tiny typed API layer in `packages/monitor-ui/src/lib/api.ts` wraps the PRD-02 route helpers for browser fetches.
- Clear guidance in a short README or comment on when to use SSE (`useEforgeEvents`) vs on-demand fetch (`useApi`).

## Approach

### 1. Refactor `useEforgeEvents`

Replace the direct `EventSource` + fallback logic in `packages/monitor-ui/src/hooks/use-eforge-events.ts` with a call to `subscribeToSession`. The client helper returns an async generator (or callback-based API - check signature) producing `DaemonStreamEvent`s with reconnect handled internally.

Sketch:

```ts
useEffect(() => {
  const abort = new AbortController();
  subscribeToSession<DaemonStreamEvent>(sessionId, {
    baseUrl: '', // same-origin for the monitor UI
    signal: abort.signal,
    onEvent: (event) => dispatch({ type: 'ADD_EVENT', event }),
    onBatchLoad: (events) => dispatch({ type: 'BATCH_LOAD', events }),
  });
  return () => abort.abort();
}, [sessionId]);
```

Confirm `subscribeToSession` either supports a `baseUrl: ''` relative-URL mode or has a browser-friendly alternative. If it doesn't today, add that capability as a minimal extension - don't fork a second implementation.

Delete the old `new EventSource(...)` and reconnect logic. Keep the reducer integration (`BATCH_LOAD` vs `ADD_EVENT` dispatches) exactly as-is.

### 2. Unify the API layer

`packages/monitor-ui/src/lib/api.ts` becomes a thin wrapper over the PRD-02 `API_ROUTES` + typed helpers. Export browser-appropriate versions (using `fetch` directly rather than `daemonRequest`) that return the same typed response shapes. If the PRD-02 helpers can be configured with a transport, reuse them directly.

`useApi` stays but is narrowed to consume only the typed helpers - no raw URLs.

### 3. Document the choice

Add a short comment block at the top of `packages/monitor-ui/src/hooks/` (or a `README.md` in that directory if preferred):

> - `useEforgeEvents(sessionId)` - subscribe to a single session's live event stream. Use for per-session dashboards, pipeline views, timelines.
> - `useApi(endpoint)` - one-shot typed fetch for resource data (queue list, backend list, runs). Use when the data is not session-scoped or is a snapshot.

### 4. Clean up state management

The reducer in `packages/monitor-ui/src/lib/reducer.ts` is the state-machine core but is undocumented. Add a top-of-file JSDoc block enumerating the action types and their effects on state. Not a rewrite - just a comment for the next contributor.

## Scope

### In scope

- Refactoring `useEforgeEvents` to be a thin wrapper around `subscribeToSession`.
- Unifying the API layer in `packages/monitor-ui/src/lib/api.ts` around PRD-02 `API_ROUTES` + typed helpers.
- Narrowing `useApi` to consume only typed helpers (no raw URLs).
- Documenting SSE vs on-demand fetch choice via comment or `README.md` in `packages/monitor-ui/src/hooks/`.
- Adding a top-of-file JSDoc block to `packages/monitor-ui/src/lib/reducer.ts` enumerating action types and effects.
- Possibly extending `packages/client/src/session-stream.ts` with minimal support for browser-relative URLs (`baseUrl: ''`) if not already present.

### Files touched

- `packages/monitor-ui/src/hooks/{use-eforge-events,use-api}.ts`
- `packages/monitor-ui/src/lib/{api,reducer}.ts`
- Possibly `packages/client/src/session-stream.ts` (small addition to support browser-relative URLs if not already)

### Out of scope

- Redesigning the reducer.
- Adding new event types.
- Shadcn sweep (PRD 09).

## Acceptance Criteria

- `useEforgeEvents` is implemented as a thin wrapper around `subscribeToSession` from `@eforge-build/client`.
- The old `new EventSource(...)` and bespoke reconnect/HTTP-fallback logic in `use-eforge-events.ts` is deleted.
- The reducer integration (`BATCH_LOAD` vs `ADD_EVENT` dispatches) is preserved exactly as-is.
- `subscribeToSession` supports `baseUrl: ''` relative-URL mode (extended minimally if needed, not forked).
- `packages/monitor-ui/src/lib/api.ts` is a thin wrapper over PRD-02 `API_ROUTES` + typed helpers, exporting browser-appropriate versions returning the same typed response shapes.
- `useApi` consumes only typed helpers - no raw URLs.
- Guidance on when to use `useEforgeEvents(sessionId)` vs `useApi(endpoint)` is documented via a comment block at the top of `packages/monitor-ui/src/hooks/` or a `README.md` in that directory, matching the specified wording.
- A top-of-file JSDoc block in `packages/monitor-ui/src/lib/reducer.ts` enumerates the action types and their effects on state.
- `pnpm build` produces a working monitor UI bundle.
- `pnpm --filter monitor-ui dev` renders without errors.
- Manual verification: opening the monitor UI during an active build, killing the daemon, and restarting it triggers reconnect and events resume (handled by `subscribeToSession` post-refactor).
- Network tab shows one EventSource per active session (no duplicate connections).
- `rg "new EventSource" packages/monitor-ui/src` returns zero hits.
