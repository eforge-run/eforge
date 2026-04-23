---
id: plan-01-consolidate-sse-on-client
name: Consolidate SSE subscription on @eforge-build/client
depends_on: []
branch: hardening-08-monitor-ui-consumes-eforge-build-client-for-sse-and-api/consolidate-sse-on-client
agents:
  builder:
    effort: high
    rationale: subscribeToSession is currently node-only (uses node:http); adding a
      browser-compatible path plus refactoring the hook while preserving reducer
      dispatches requires careful cross-package reasoning.
---

# Consolidate SSE subscription on @eforge-build/client

## Architecture Context

`@eforge-build/client` already exports `subscribeToSession(sessionId, opts)` from `packages/client/src/session-stream.ts`. It handles SSE parsing, reconnect with exponential backoff (1s → 30s cap), `Last-Event-ID` replay, abort via `AbortSignal`, and resolves a `SessionSummary` on `session:end`. The CLI MCP proxy (`packages/eforge/src/cli/mcp-proxy.ts`) and the Pi extension consume it.

The monitor UI does not. `packages/monitor-ui/src/hooks/use-eforge-events.ts` instantiates `new EventSource(...)` twice (primary path and fallback), and reimplements its own reconnect/HTTP-fallback semantics. The reducer integration (`BATCH_LOAD` vs `ADD_EVENT` dispatches in `packages/monitor-ui/src/lib/reducer.ts`) is orthogonal to the transport and must be preserved exactly.

`packages/monitor-ui/src/lib/api.ts` already uses `API_ROUTES` typed helpers exclusively — out of scope for this plan.

### Key constraint: browser compatibility of subscribeToSession

The current `subscribeToSession` implementation uses `node:http` (`http.get(url, ...)`), which is node-only and also requires an absolute URL. To make the helper usable from the monitor UI bundle without forking a second implementation, the builder must add a browser-compatible code path while preserving the existing node semantics (reconnect/backoff cap, `Last-Event-ID` replay, `session:end` resolution, aggregates in `SessionSummary`).

The recommended shape:

- `resolveBaseUrl()` treats `baseUrl === ''` as an explicit "same-origin relative" opt-in and returns `''`.
- `connect()` branches on `typeof EventSource !== 'undefined'` (browser runtime). In the browser branch:
  - Open `new EventSource(\`${baseUrl}/api/events/${encodeURIComponent(sessionId)}\`)` where `baseUrl` may be `''` (relative URL is valid for `EventSource`).
  - Drive reconnect/backoff by listening for `onerror` / closed-state transitions, reusing the same `reconnectDelay` / `reconnectCount` / `hasReceivedValidEvent` variables and the same `maxReconnects` cap.
  - Track `lastEventId` via `MessageEvent.lastEventId` so replay semantics match the node path (the browser's native `EventSource` already sets `Last-Event-ID` on reconnect).
  - Call `handleEvent(msg.data)` for each received message; `handleEvent` already covers JSON parse, aggregate counters, `onEvent` dispatch, and `session:end` → `settleResolve`.
  - Honor `opts.signal` by calling `es.close()` from `cleanup()`.
- Node path stays as-is (requires absolute `baseUrl` or a resolvable lockfile `cwd`).
- If `baseUrl === ''` is passed in a non-browser runtime, throw a clear error (`subscribeToSession: baseUrl: '' is only supported in browser runtimes`) rather than letting node's `http.get` fail obscurely.

This is one function with two transport branches sharing aggregate/settlement/reconnect logic — not a fork. Keep all aggregates, `SessionSummary` shape, and `onEvent`/`onEnd`/`signal` behavior identical between branches.

## Implementation

### Overview

Extend `subscribeToSession` with a browser transport path (triggered by `baseUrl: ''` + `typeof EventSource !== 'undefined'`), replace the hand-rolled `EventSource` logic in `useEforgeEvents` with a single `subscribeToSession` call, and document the SSE-vs-fetch choice plus the reducer action types.

### Key Decisions

1. **One function, two transport branches.** Do not fork a second module. The browser branch uses `window.EventSource`; the node branch keeps `node:http`. Reconnect/backoff counters, aggregate counters, `SessionSummary` construction, and settlement are shared.
2. **`baseUrl: ''` is the explicit browser opt-in.** Callers that pass `''` are declaring "same-origin relative URLs". `resolveBaseUrl()` returns `''` for this case and `connect()` constructs `'/api/events/...'` (relative).
3. **Preserve reducer dispatches exactly.** The hook refactor must continue to dispatch `{ type: 'BATCH_LOAD', events: parsed, serverStatus }` for the initial HTTP snapshot and `{ type: 'ADD_EVENT', event, eventId }` for each live event. The cache, countdown timer, and `connectionStatus` lifecycle must be preserved.
4. **Initial HTTP snapshot stays in the hook.** `subscribeToSession` handles only the SSE stream. The batch-load from `API_ROUTES.runState` is a separate concern (used to short-circuit completed sessions and cache them) and remains inside `useEforgeEvents`. After the snapshot, when the server reports the session is live, the hook calls `subscribeToSession` for live events.
5. **Shutdown countdown events stay in the hook.** The `monitor:shutdown-pending` / `monitor:shutdown-cancelled` named SSE events are not part of the `EforgeEvent` type surface. They are consumed by a thin pass-through: when using the browser `EventSource` path, the hook either (a) adds `addEventListener` calls on the `EventSource` instance exposed back from `subscribeToSession`, or (b) receives them via a new optional `onNamedEvent(name, data)` hook added to `SubscribeOptions`. Prefer option (b) — it keeps the hook's consumer surface clean and avoids leaking the transport object. Document the new option in the JSDoc on `SubscribeOptions`.

### Implementation sketch for `useEforgeEvents`

```ts
useEffect(() => {
  if (!sessionId) {
    dispatch({ type: 'RESET' });
    setConnectionStatus('disconnected');
    return;
  }
  const cached = cacheRef.current.get(sessionId);
  if (cached) {
    dispatch({ type: 'BATCH_LOAD', events: cached.events });
    setConnectionStatus('connected');
    return;
  }

  const abort = new AbortController();
  setConnectionStatus('connecting');

  (async () => {
    // Initial HTTP snapshot (replaces current fetch/parse code).
    const res = await fetch(buildPath(API_ROUTES.runState, { id: sessionId }), { signal: abort.signal });
    const data = (await res.json()) as RunStateResponse;
    const parsed = data.events.flatMap((ev) => {
      try { return [{ event: JSON.parse(ev.data) as EforgeEvent, eventId: String(ev.id) }]; }
      catch { return []; }
    });
    dispatch({ type: 'BATCH_LOAD', events: parsed, serverStatus: data.status });
    setConnectionStatus('connected');

    if (data.status === 'completed' || data.status === 'failed') {
      // cache and stop — no live subscription needed.
      cacheRef.current.set(sessionId, computeFinalState(parsed));
      return;
    }

    // Live subscription — thin wrapper around subscribeToSession.
    await subscribeToSession<EforgeEvent>(sessionId, {
      baseUrl: '',
      signal: abort.signal,
      onEvent: (event) => dispatch({ type: 'ADD_EVENT', event, eventId: /* lastEventId from helper */ '' }),
      onNamedEvent: (name, payload) => {
        if (name === 'monitor:shutdown-pending') startCountdownTick((payload as { countdown: number }).countdown);
        else if (name === 'monitor:shutdown-cancelled') cancelCountdownTick();
      },
    });
  })().catch((err) => {
    if (abort.signal.aborted) return;
    console.error('subscribeToSession failed:', err);
    setConnectionStatus('disconnected');
  });

  return () => { abort.abort(); cancelCountdownTick(); };
}, [sessionId, startCountdownTick, cancelCountdownTick]);
```

Note: `onEvent` in the hook needs the `eventId` that corresponds to each SSE message so `ADD_EVENT` stores the stable id. Either pass `eventId` alongside the parsed event from `subscribeToSession` (extend the `onEvent` signature to `(event, meta: { eventId?: string })`), or — preferred minimal change — track the last-seen `lastEventId` inside `subscribeToSession`'s browser branch and expose it on the event callback. The builder chooses the minimal shape; a `meta` object on `onEvent` keeps node/browser symmetric.

### Documentation

- `packages/monitor-ui/src/hooks/README.md` (new): a short explainer with the exact wording from the source —
  - `useEforgeEvents(sessionId)` — subscribe to a single session's live event stream. Use for per-session dashboards, pipeline views, timelines.
  - `useApi(endpoint)` — one-shot typed fetch for resource data (queue list, backend list, runs). Use when the data is not session-scoped or is a snapshot.
- `packages/monitor-ui/src/lib/reducer.ts`: add a top-of-file JSDoc block enumerating the action types (`ADD_EVENT`, `BATCH_LOAD`, `RESET`) and their effects on state (`ADD_EVENT` appends and updates aggregates; `BATCH_LOAD` rebuilds state from a full event array plus optional `serverStatus` authoritative override; `RESET` returns initial state with fresh mutable containers).

## Scope

### In Scope

- Extend `packages/client/src/session-stream.ts` with `baseUrl: ''` same-origin relative-URL support, a browser `EventSource` transport branch, and an optional `onNamedEvent(name, data)` callback on `SubscribeOptions` (used by the monitor for `monitor:shutdown-pending` / `monitor:shutdown-cancelled`).
- Export any added types (`onNamedEvent` signature, etc.) from `packages/client/src/index.ts` if they are part of `SubscribeOptions`.
- Refactor `packages/monitor-ui/src/hooks/use-eforge-events.ts` to call `subscribeToSession` instead of `new EventSource(...)`. Preserve reducer dispatches (`BATCH_LOAD`, `ADD_EVENT`, `RESET`), the client-side completed-session cache, the shutdown countdown timer, and the `connectionStatus` state machine.
- Delete the bespoke reconnect and HTTP-fallback logic (the `.catch()` branch that opens a second `EventSource`).
- Create `packages/monitor-ui/src/hooks/README.md` with the specified SSE-vs-fetch guidance.
- Add a top-of-file JSDoc block to `packages/monitor-ui/src/lib/reducer.ts` enumerating action types.
- Keep `test/session-stream.test.ts` green. Add at least one test that exercises the `baseUrl: ''` error path in a non-browser runtime (should throw the documented error) so the node branch stays safe.

### Out of Scope

- Redesigning the reducer.
- Adding new event types to `EforgeEvent`.
- Shadcn sweep (hardening-09).
- Any changes to `packages/monitor-ui/src/lib/api.ts` or `useApi` — already aligned with `API_ROUTES`.
- Changes to `packages/eforge/src/cli/mcp-proxy.ts` or the Pi extension (they already use `subscribeToSession` correctly).

## Files

### Create

- `packages/monitor-ui/src/hooks/README.md` — short explainer: when to use `useEforgeEvents(sessionId)` vs `useApi(endpoint)`, matching the wording in the source document.

### Modify

- `packages/client/src/session-stream.ts` — (a) `resolveBaseUrl()` returns `''` when `baseUrl === ''`; (b) `connect()` gains a browser branch using `window.EventSource` when `typeof EventSource !== 'undefined'`, sharing reconnect/aggregate/settlement state with the node branch; (c) add optional `onNamedEvent?: (name: string, data: string) => void` to `SubscribeOptions` and invoke it when a named SSE event (no `type` JSON field, or a custom event) arrives; (d) throw a clear error if `baseUrl: ''` is used in a non-browser runtime.
- `packages/monitor-ui/src/hooks/use-eforge-events.ts` — replace both `new EventSource(...)` sites and the hand-rolled fallback with a single `subscribeToSession` call using `baseUrl: ''`, `signal: abort.signal`, and `onNamedEvent` for shutdown countdown events. Preserve reducer dispatches, cache behavior, and `connectionStatus` transitions exactly.
- `packages/monitor-ui/src/lib/reducer.ts` — add a top-of-file JSDoc block documenting `ADD_EVENT`, `BATCH_LOAD`, and `RESET` action types and their state effects. No logic changes.
- `test/session-stream.test.ts` — add coverage for the new `baseUrl: ''` validation path (non-browser runtime rejection). Existing node-transport tests must continue to pass unchanged.

## Verification

- [ ] `pnpm type-check` exits with zero errors.
- [ ] `pnpm build` produces a working monitor UI bundle (`packages/monitor-ui/dist` exists and contains bundled JS).
- [ ] `pnpm test` passes, including existing `test/session-stream.test.ts` suites and any added `baseUrl: ''` non-browser-runtime test.
- [ ] `rg "new EventSource" packages/monitor-ui/src` returns zero matches.
- [ ] `packages/monitor-ui/src/hooks/use-eforge-events.ts` imports `subscribeToSession` from `@eforge-build/client` and contains exactly one call to it.
- [ ] `packages/monitor-ui/src/hooks/use-eforge-events.ts` still dispatches `{ type: 'BATCH_LOAD', ... }` for the initial snapshot and `{ type: 'ADD_EVENT', event, eventId }` for each live event; the `RESET` dispatch on null `sessionId` is retained.
- [ ] `packages/monitor-ui/src/hooks/README.md` exists and contains both bullet lines with the exact wording from the source document (`useEforgeEvents(sessionId) — subscribe to a single session's live event stream. Use for per-session dashboards, pipeline views, timelines.` and `useApi(endpoint) — one-shot typed fetch for resource data (queue list, backend list, runs). Use when the data is not session-scoped or is a snapshot.`).
- [ ] `packages/monitor-ui/src/lib/reducer.ts` has a top-of-file JSDoc block that names `ADD_EVENT`, `BATCH_LOAD`, and `RESET` and describes their state effects.
- [ ] `packages/client/src/session-stream.ts` `resolveBaseUrl()` returns `''` when `baseUrl === ''` is passed explicitly (verifiable by reading the function).
- [ ] `packages/client/src/session-stream.ts` `connect()` branches on `typeof EventSource !== 'undefined'` and uses `window.EventSource` in the browser branch; the node branch continues to use `node:http`.
- [ ] Manual verification: `pnpm --filter @eforge-build/monitor-ui dev` renders without runtime errors; opening an active session, killing the daemon, and restarting it triggers reconnect and events resume (handled by `subscribeToSession`'s shared reconnect logic).
- [ ] Manual verification: browser Network tab shows one EventSource connection per active session (no duplicate connections from the old primary-plus-fallback pattern).
