---
id: plan-01-auto-build-slice
name: Auto-build slice in useEforgeEvents reducer
branch: monitor-ui-cleaner-event-consumption-architecture/auto-build-slice
agents:
  builder:
    effort: medium
    rationale: Reducer slice addition + handler registration is well-trodden
      territory in this codebase.
---

---
id: plan-01-auto-build-slice
name: Auto-build slice in useEforgeEvents reducer
depends_on: []
branch: monitor-ui-cleaner-event-consumption-architecture/auto-build-slice
---

# Auto-build slice in useEforgeEvents reducer

## Architecture Context

Today `useAutoBuild` in `packages/monitor-ui/src/hooks/use-auto-build.ts` opens a *second* SSE subscription on `/api/events/:sessionId` whose only job is to call `mutate(API_ROUTES.autoBuildGet)` when a `daemon:auto-build:paused` event arrives. The PRD requires the monitor UI to converge on exactly two SSE subscribers: per-session (`useEforgeEvents`) and daemon-wide (`useDaemonEvents`, added in plan-05). This plan removes the per-session SSE in `useAutoBuild` and folds auto-build state into the existing `useEforgeEvents` reducer so the SSE connection used by `useEforgeEvents` becomes the only path for auto-build pause notifications scoped to the watched session.

The SWR poll on `API_ROUTES.autoBuildGet` (10 s `refreshInterval`) is *kept* as a fallback so the toggle still reflects daemon state when no session is being watched (e.g. fresh app load with no current session) and to backstop reconnect gaps. Writing remains a one-shot `POST /api/auto-build/set` via `setAutoBuild` in `packages/monitor-ui/src/lib/api.ts` — no change.

Reducer architecture, handler decomposition, and regression fixtures stay as-is; this plan adds *one* new handler file and *one* new slice field.

## Implementation

### Overview

1. Add an `autoBuildPausedReason: string | null` slice (and `autoBuildPausedAt: string | null` timestamp) to `RunState` in `packages/monitor-ui/src/lib/reducer.ts`.
2. Create a new handler file `packages/monitor-ui/src/lib/reducer/handle-daemon.ts` with `handleDaemonAutoBuildPaused` returning the new slice fields.
3. Register the handler in `packages/monitor-ui/src/lib/reducer/index.ts` (key: `'daemon:auto-build:paused'`). Note: this event does not currently appear in the `EforgeEvent` discriminated union (it is daemon-internal; see `packages/monitor/src/server-main.ts:181-192` `writeAutoBuildPausedEvent`), so add it to the union in `packages/client/src/events.ts` with shape `{ type: 'daemon:auto-build:paused'; reason: string }`. The exhaustiveness check in `reducer/index.ts` will then enforce it is handled.
4. Export a `selectAutoBuild(runState: RunState): { paused: boolean; reason: string | null }` selector from `packages/monitor-ui/src/lib/reducer.ts`.
5. In `packages/monitor-ui/src/hooks/use-auto-build.ts`, delete the entire `useEffect` block that calls `subscribeToSession`, the `subscribeToSession` import, and the `sessionId` parameter usage that drove it. Keep the `useSWR` poll (the fallback) and the `toggle` writer untouched. The hook signature stays `useAutoBuild(sessionId?: string | null)` for caller compatibility, but `sessionId` becomes unused (annotate accordingly).
6. In `packages/monitor-ui/src/app.tsx`, wire `selectAutoBuild(runState)` next to the existing `useAutoBuild()` call so callers that need the paused-reason detail (currently only the header banner if any) can read it; existing `state.enabled` from SWR continues driving the toggle UI. Pass the selector result into the existing `<Header>` props if it already accepts it; otherwise leave the consumer wiring for plan-05 and only export the selector here.

### Key Decisions

1. **Add `daemon:auto-build:paused` to `EforgeEvent` union.** The event is already on the wire (recorded by the daemon as a real event with `type: 'daemon:auto-build:paused'`) but is structurally typed as `{ type: string }` in `useAutoBuild`'s `subscribeToSession<{ type: string }>` call. Promoting it to the discriminated union makes the new reducer handler type-safe and forces the exhaustiveness check to recognize it.
2. **Keep SWR poll as fallback.** The PRD explicitly says "Keep the SWR poll as fallback." The slice in `useEforgeEvents` covers the watched-session path; the SWR poll covers the no-session and reconnect-gap paths.
3. **Don't change `useAutoBuild`'s public signature.** Avoids a wide refactor of `app.tsx` and `header.tsx` — those changes are queued for plan-05 when the daemon-wide event stream replaces the SWR poll entirely.

## Scope

### In Scope
- Add `autoBuildPausedReason` and `autoBuildPausedAt` to `RunState` and `initialRunState`.
- New handler file `handle-daemon.ts` for `daemon:auto-build:paused`.
- Register handler in the reducer registry.
- Add `daemon:auto-build:paused` to `EforgeEvent` union in `packages/client/src/events.ts`.
- Export `selectAutoBuild` selector from `packages/monitor-ui/src/lib/reducer.ts`.
- Delete SSE block (and `subscribeToSession` import) from `useAutoBuild`.
- Vitest unit tests covering the new handler and selector.

### Out of Scope
- Removing the SWR poll (deferred to plan-05).
- The `daemon:auto-build:paused` event being emitted on a daemon-wide stream (plan-04).
- Changing the daemon-side emit code in `server-main.ts` (the event continues being recorded on the watcher session).

## Files

### Create
- `packages/monitor-ui/src/lib/reducer/handle-daemon.ts` — `handleDaemonAutoBuildPaused` handler.
- `packages/monitor-ui/src/lib/reducer/__tests__/handle-daemon.test.ts` — vitest fixture covering the new handler (input event → returned delta).

### Modify
- `packages/client/src/events.ts` — add `| { type: 'daemon:auto-build:paused'; reason: string }` to the `EforgeEvent` union.
- `packages/monitor-ui/src/lib/reducer.ts` — add `autoBuildPausedReason: string | null` and `autoBuildPausedAt: string | null` to `RunState`, mirror them in `initialRunState`, mirror them in the `RESET` case spread, export `selectAutoBuild(state)` selector.
- `packages/monitor-ui/src/lib/reducer/index.ts` — import and register `handleDaemonAutoBuildPaused` under key `'daemon:auto-build:paused'`. The `_Exhaustive` check will then accept the new event type.
- `packages/monitor-ui/src/hooks/use-auto-build.ts` — delete the `useEffect` SSE subscription block, the `subscribeToSession` import, and the `useState/useEffect` imports if no longer needed. Keep `sessionId` parameter (unused) for caller compatibility.
- `packages/monitor-ui/src/hooks/README.md` — update the "When to use which hook" section to remove the SSE-driven cache invalidation sentence for `useAutoBuild`.

## Verification

- [ ] `pnpm --filter @eforge-build/monitor-ui type-check` passes; the `_Exhaustive` check in `reducer/index.ts` accepts `daemon:auto-build:paused` as handled.
- [ ] `pnpm test` passes; the new `handle-daemon.test.ts` unit test asserts that dispatching a `daemon:auto-build:paused` event with `reason: 'Build failed: foo'` returns a delta with `autoBuildPausedReason: 'Build failed: foo'` and a non-null `autoBuildPausedAt`.
- [ ] Searching `packages/monitor-ui/src/hooks/use-auto-build.ts` for `subscribeToSession` returns zero matches.
- [ ] Searching `packages/monitor-ui/src` for `subscribeToSession` returns exactly one consumer (`use-eforge-events.ts`).
- [ ] `selectAutoBuild(initialRunState)` returns `{ paused: false, reason: null }`; after applying a `daemon:auto-build:paused` event via the reducer, it returns `{ paused: true, reason: '<reason>' }`.
- [ ] `useAutoBuild` still returns the same `{ state, toggling, toggle }` shape and the SWR poll on `API_ROUTES.autoBuildGet` is unchanged (grep confirms `refreshInterval: 10000` line is intact).
