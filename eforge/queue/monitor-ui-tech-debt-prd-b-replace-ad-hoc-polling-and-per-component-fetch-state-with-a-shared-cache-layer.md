---
title: Monitor UI tech debt PRD B: replace ad-hoc polling and per-component fetch state with a shared cache layer
created: 2026-05-03
depends_on: ["monitor-ui-technical-debt-cleanup-remove-dead-code-reduce-casts-and-move-wire-protocol-types-toward-eforge-build-client"]
---

# Monitor UI tech debt PRD B: replace ad-hoc polling and per-component fetch state with a shared cache layer

## Problem / Motivation

Continuation of the 5-item tech-debt review. PRD A (in flight: session `2026-05-03-monitor-ui-tech-debt-top-5`) handled the reducer + pipeline + render-path. This PRD handles the request-lifecycle: ad-hoc polling, per-component fetch state, and the manual `refreshTrigger` choreography that today wires `app.tsx` → `Sidebar` → `QueueSection` → `useApi`.

### Current state — every polling/fetch site in monitor-ui

| Site | Pattern | Cadence | Notes |
|------|---------|---------|-------|
| `app.tsx:111-141` | `setInterval` → `fetchLatestSessionId()` | 2s | Bumps `setSidebarRefresh((c) => c + 1)` **on every tick regardless of result change** — coercive refresh signal that fans out to Sidebar + QueueSection |
| `app.tsx:144-152` | `useEffect` on `runState.events.length` | event-driven | Refreshes sidebar when last event is `phase:start` / `phase:end` |
| `app.tsx:156-160` | `useEffect` on `runState.isComplete` | event-driven | Refreshes sidebar on session completion |
| `app.tsx:283-289` | `setInterval` tick | 1s | UI duration update — not data fetching, **keep as-is** |
| `sidebar.tsx:157-158` | Two `useApi` (`runs`, `sessionMetadata`) + `refetch` on `refreshTrigger` | none direct (driven by app.tsx polling) | Each is an independent fetch; both refetched on every coercive refresh |
| `queue-section.tsx:73,85-90` | `useApi` (`queue`) + own `setInterval` | 5s + refreshTrigger | **Double-triggers**: polls itself AND refetches on the app.tsx refresh signal |
| `queue-section.tsx:102-128` | Per-failed-item `fetchRecoverySidecar()` piggybacked on items change | effectively 5s | Manual `fetchedKeysRef` to avoid re-fetching successful results; sidecars-not-found (404) get re-attempted next cycle |
| `use-auto-build.ts:17-27` | `setInterval` → `fetchAutoBuild()` | 5s | + SSE override (`daemon:auto-build:paused` event) for instant flip |
| `use-eforge-events.ts:21,55-93` | SSE + `cacheRef: Map<string, RunState>` | SSE-driven | **Unbounded in-memory cache** of completed sessions; never evicted |
| `plan-cards.tsx`, `plan-preview-panel.tsx` | `useApi` (one-shot) | none | Refetched on URL change |
| `shutdown-banner.tsx:13-22` | `setInterval` keep-alive ping (POST) | 30s | Outbound ping, not data — **keep as-is** |

### The actual hook in use today

`hooks/use-api.ts` is 54 LOC — per-component `useState` + `useEffect`. No dedupe, no cache, no shared identity. Every mount fires a fresh request. Two components asking for `API_ROUTES.runs` at the same time make two HTTP calls.

```ts
export function useApi<T>(url: string | null): UseApiResult<T> {
  const [data, setData] = useState<T | null>(null);
  // ... per-component state, fetches on every mount/url change
  const refetch = useCallback(() => setFetchCount((c) => c + 1), []);
}
```

### Why this matters

1. **Wasted requests.** Sidebar mounts both `runs` and `sessionMetadata` `useApi` calls; QueueSection separately polls `queue` every 5s; app.tsx polls `latestRun` every 2s. No request is shared. On every coercive refresh, Sidebar refetches both `runs` and `sessionMetadata` even when nothing changed.
2. **Coercive refresh chain.** `app.tsx`'s `sidebarRefresh` counter is a side-channel "go refetch everything" signal. It fires on a 2s timer, on `phase:start`/`phase:end` events, and on `isComplete`. The components downstream don't know what changed — they refetch every cached value.
3. **Polling cadence is hardcoded per site.** No centralized backoff. If the daemon is down, the 2s + 5s + 5s loops keep hammering.
4. **No tab-visibility pause.** Pages keep polling when the tab is in the background.
5. **Unbounded memory in `use-eforge-events.cacheRef`.** Every completed session viewed during a browser lifetime stays in memory forever.

### Codebase conventions (from `AGENTS.md` + memory)

- "Engine emits, consumers render" — the SSE stream remains the source of truth for live session data; this PRD does not replace SSE with polling, only standardizes the *non-SSE* polling.
- shadcn/ui only — no UI changes here.
- API_ROUTES + buildPath() enforced by existing test — keep using.
- "No backwards-compat hacks" (`feedback_no_backward_compat`) — when this lands, `useApi` and the `refreshTrigger` prop chain are deleted, not deprecated.
- "Optimize for agent debuggability" (`feedback_agent_debuggability`) — fewer custom abstractions, better behavior visible at the call site.

### Library landscape

Two real options:
- **SWR** (Vercel): ~5 KB gzip, focused on stale-while-revalidate, simple `useSWR(key, fetcher, options)` API. Good for read-heavy UIs. Has `refreshInterval`, `revalidateOnFocus`, `revalidateOnReconnect`, `dedupingInterval` built in.
- **TanStack Query** (formerly React Query): ~13 KB gzip, full request lifecycle (queries + mutations + optimistic updates + infinite queries + devtools). Heavier but the devtools are excellent for debugging.

For monitor-UI's current shape (10-ish read endpoints, 2-3 mutations, no infinite scroll, no optimistic updates), SWR is right-sized. TanStack would be overkill but defensible.

### Deconflict with other ready plans

Two other monitor-UI tech-debt sessions exist:

**PRD 0**: `2026-05-03-monitor-ui-tech-debt` (status: ready, profile: errand) — builds **before** this PRD per the user. Scope:
- Move event wire types from `@eforge-build/engine` to `@eforge-build/client` (possibly via a new browser-safe `@eforge-build/client/browser` subpath).
- Drop `@eforge-build/engine` as a monitor-UI dep + path alias.
- Remove unused helpers in `lib/api.ts`: `fetchRuns`, `fetchLatestRunId`, `fetchQueue`, `fetchPlanDiffs`.
- Replace recovery-sidecar verdict casts in `queue-section.tsx` and `sidecar-sheet.tsx`.
- Replace hand-written YAML parsing in `plan-content.ts` with the `yaml` library.
- Add a guard test preventing monitor-UI from reintroducing engine event imports.

**PRD A**: `2026-05-03-monitor-ui-tech-debt-top-5` (status: ready, profile: excursion, just enqueued) — may build before or after this PRD. Scope:
- Decompose `reducer.ts` into a grouped handler-map with delta returns.
- Split `thread-pipeline.tsx` into 6 files.
- Wrap `<ThreadPipeline>`, `<PlanRow>`, `<EventCard>` in `React.memo`.
- Add reducer/pipeline tests.

**File-overlap matrix and PRD B's response:**

| File | PRD 0 change | PRD A change | PRD B change | Conflict resolution |
|------|--------------|--------------|--------------|---------------------|
| `lib/api.ts` | Remove 4 unused helpers | — | Delete file (replaced by SWR fetcher) | PRD B starts from post-PRD-0 state. The four removed helpers are ones PRD B would have deleted anyway. |
| `lib/types.ts` | Switch event imports to client | — | Untouched | No conflict. |
| `package.json` | Remove `@eforge-build/engine` | — | Add `swr` | Independent operations. |
| `queue-section.tsx` | Replace verdict casts | — | Replace polling effect (lines 85-128) | PRD B starts from post-PRD-0 state. The verdict-cast cleanup must be preserved when rewriting the polling section. Different code regions in the same file. |
| `app.tsx` | Untouched | Memo prop refinement (line 337 area) | Polling effects (lines 111-160) | Different regions; PRD A and PRD B should merge cleanly without coordination. |
| `hooks/use-api.ts` | Untouched | Untouched | Delete entirely | No conflict. |
| `hooks/use-eforge-events.ts` | Untouched | Untouched | Bound `cacheRef` LRU | No conflict. |
| `hooks/use-auto-build.ts` | Untouched | Untouched | Replace polling with SWR | No conflict. |
| `reducer.ts`, `pipeline/*`, `event-card.tsx` | Untouched | Decompose / split / memo | Untouched | No conflict. |
| `lib/plan-content.ts` | Replace YAML parsing | — | Untouched | No conflict. |

**Sequencing assumption baked into this PRD:**
- PRD 0 lands first. Wire-protocol types live in `@eforge-build/client` (possibly a `/browser` subpath). Unused `lib/api.ts` helpers gone. Verdict casts in `queue-section.tsx` cleaned up.
- PRD B then lands on top. SWR fetcher imports from whichever client export PRD 0 settled on (`@eforge-build/client` or `@eforge-build/client/browser`). PRD B preserves PRD 0's verdict-cast structure when rewriting `queue-section.tsx`'s polling block.
- PRD A's relative ordering with PRD B doesn't matter — clean separation.

## Goal

Replace monitor-UI's ad-hoc polling and per-component fetch state with a shared SWR-based cache layer that handles request dedup, polling cadence, focus/reconnect revalidation, and SSE-driven invalidation, eliminating the coercive `refreshTrigger` prop chain and bounding the previously-unbounded completed-session cache.

## Approach

### Adopt SWR as the shared cache layer

Add `swr@^2` to `packages/monitor-ui/package.json`. Wrap the React tree in `<SWRConfig>` (in `main.tsx` or a new `lib/swr-config.ts` provider) with sensible global defaults: `revalidateOnFocus: true`, `revalidateOnReconnect: true`, `dedupingInterval: 2000`, `errorRetryInterval: 5000` with default exponential backoff.

### Delete the per-component fetch hook

Delete `hooks/use-api.ts` (54 LOC). Every call site migrates to `useSWR(API_ROUTES.X, fetcher)` directly.

### Delete the coercive `refreshTrigger` chain

Remove `sidebarRefresh` state and all `setSidebarRefresh(c => c + 1)` calls in `app.tsx` (lines 28, 92, 120-141, 144-152, 156-160). Remove the `refreshTrigger` prop from `<Sidebar>` and `<QueueSection>`. Cache invalidation comes from SWR's polling + focus revalidation + targeted `mutate(key)` calls when an SSE event tells us a specific cached value is now stale.

### Standardize polling cadence per route

| Route | Old cadence | New cadence (SWR `refreshInterval`) |
|-------|-------------|--------------------------------------|
| `API_ROUTES.latestRun` | 2s coercive | 10s |
| `API_ROUTES.runs` | refreshTrigger-driven | 10s |
| `API_ROUTES.sessionMetadata` | refreshTrigger-driven | 10s |
| `API_ROUTES.queue` | 5s setInterval + refreshTrigger | 5s |
| `API_ROUTES.autoBuildGet` | 5s setInterval | 10s (SSE invalidates on `daemon:auto-build:paused` via `mutate()`) |
| `API_ROUTES.readRecoverySidecar` (per prdId) | 5s effective | 10s with SWR dedupe |
| `API_ROUTES.projectContext` | once on mount | once (no polling) |
| `API_ROUTES.orchestration` | refetch on session change + hasPlans | session-key-keyed; revalidate on focus only |
| `API_ROUTES.plans` | refetch on URL change | session-key-keyed; revalidate on focus only |

### SSE-driven invalidation

`use-eforge-events` and `use-auto-build` use `mutate(key)` from SWR's global mutator to invalidate specific cache entries when SSE events tell us they're stale. Specifically:
- `phase:start` / `phase:end` → `mutate(API_ROUTES.runs)`, `mutate(API_ROUTES.sessionMetadata)`
- `session:end` (any session) → `mutate(API_ROUTES.runs)`, `mutate(API_ROUTES.latestRun)`
- `daemon:auto-build:paused` → `mutate(API_ROUTES.autoBuildGet)`
- `enqueue:complete` → `mutate(API_ROUTES.queue)`
- `plan:build:complete`, `plan:build:failed` → `mutate(API_ROUTES.queue)`, `mutate([API_ROUTES.readRecoverySidecar, prdId])` (for failed PRDs)

### Migrate recovery-sidecar fetching

Migrate the recovery-sidecar fetching in `queue-section.tsx` (lines 102-128) to `useSWR(['sidecar', prdId], fetcher)` per failed item. SWR's built-in dedupe replaces the manual `fetchedKeysRef`. 404 responses return `null` from the fetcher and naturally retry on the `refreshInterval`.

### Bound the in-memory completed-session cache

In `use-eforge-events.ts` (lines 21, 91), replace the unbounded `Map<string, RunState>` with a count-based LRU capped at **20 entries** using simple insertion-order eviction. New file: `lib/lru.ts` (or inline as a private helper in `use-eforge-events.ts` — implementer's choice; prefer inline if under ~30 LOC).

### Migrate `use-auto-build.ts`

The hook becomes `useSWR(API_ROUTES.autoBuildGet, fetcher, { refreshInterval: 10000 })` plus the existing SSE override (which now calls `mutate(API_ROUTES.autoBuildGet)` instead of a manual fetch).

### Restructure `lib/api.ts` post-PRD-0

- PRD 0 will already have removed `fetchRuns`, `fetchLatestRunId`, `fetchQueue`, `fetchPlanDiffs`.
- This PRD removes the remaining read-helpers that get replaced by direct `useSWR` calls: `fetchLatestSessionId`, `fetchOrchestration`, `fetchAutoBuild`, `fetchProjectContext`, `fetchFileDiff`, `fetchRecoverySidecar`.
- Mutation helpers (`setAutoBuild`, `cancelSession`, `triggerRecover`, `applyRecovery`) stay — they're called imperatively from event handlers and don't need SWR. They migrate to a renamed `lib/api-mutations.ts` (or stay in `lib/api.ts` if it shrinks to mostly mutations — implementer's call).

### Add a single `fetcher` utility

At `lib/swr-fetcher.ts`:

```ts
export const fetcher = async (key: string | [string, ...unknown[]]): Promise<unknown> => {
  const url = Array.isArray(key) ? key[0] : key;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
};
```

Returning `null` on 404 is critical for the recovery-sidecar use case (recovery-pending = no sidecar yet).

### Code Impact

#### Files added

- **NEW** `packages/monitor-ui/src/lib/swr-fetcher.ts` — single fetcher used for every `useSWR` call. Handles 404→null, throws on other non-2xx, parses JSON. ~15 LOC.
- **NEW** `packages/monitor-ui/src/lib/swr-config.tsx` — `<SWRConfigProvider>` wrapper component holding the global `<SWRConfig>` defaults. ~20 LOC. (Could live in `main.tsx` but a dedicated file keeps `main.tsx` minimal and lets the SSE-driven `mutate()` hook reach the same config.)
- **NEW** `packages/monitor-ui/src/lib/lru.ts` *(optional — implementer's call)* — small `BoundedMap<K, V>` helper for the completed-session LRU. Inline in `use-eforge-events.ts` if under ~30 LOC; extract if reused.
- **NEW** `packages/monitor-ui/src/lib/__tests__/swr-fetcher.test.ts` — covers 404→null, throws on 500, returns parsed JSON on 200.
- **NEW** `packages/monitor-ui/src/lib/__tests__/lru.test.ts` (or co-located in `use-eforge-events.test.ts` if inlined) — covers 20-entry bound, oldest-evicted-on-insert, hit-doesn't-promote (or hit-does-promote — implementer chooses; tests document the chosen semantics).

#### Files modified

- `packages/monitor-ui/package.json` — add `"swr": "^2.x.x"` (latest stable). Verify the resolved version once during implementation. No other dep changes.
- `packages/monitor-ui/src/main.tsx` — wrap `<App />` in `<SWRConfigProvider>`.
- `packages/monitor-ui/src/app.tsx`:
  - Remove `sidebarRefresh` state (line 28).
  - Remove `setSidebarRefresh` from `handleSelectSession` (line 92).
  - Replace the 2s polling effect (lines 109-141) with a `useSWR(API_ROUTES.latestRun, fetcher, { refreshInterval: 10000 })` and the auto-switch logic in a `useEffect` reacting to that SWR data.
  - Remove the `phase:start`/`phase:end` refresh effect (lines 144-152). Replace with SSE-driven `mutate()` calls (see below).
  - Remove the `isComplete` refresh effect (lines 156-160). Replace with SSE-driven `mutate(API_ROUTES.runs)` / `mutate(API_ROUTES.latestRun)` from `use-eforge-events`.
  - Replace `fetchOrchestration` direct call (line 168) with `useSWR(buildPath(API_ROUTES.orchestration, { runId: currentSessionId }), fetcher)` keyed on session.
  - Replace `fetchProjectContext` direct call (line 47) with `useSWR(API_ROUTES.projectContext, fetcher)` (one-shot — no refreshInterval).
  - Drop `refreshTrigger` prop from `<Sidebar>` and `<QueueSection>` calls.
  - Keep the 1s duration tick (lines 283-289) as-is.

- `packages/monitor-ui/src/components/layout/sidebar.tsx`:
  - Remove the `refreshTrigger` prop.
  - Replace `useApi` calls (lines 157-158) with `useSWR(API_ROUTES.runs, fetcher, { refreshInterval: 10000 })` and `useSWR(API_ROUTES.sessionMetadata, fetcher, { refreshInterval: 10000 })`.
  - Remove the `useEffect` that refetches on `refreshTrigger` (lines 163-168).
  - Drop `refreshTrigger` prop forwarding to `<QueueSection>`.

- `packages/monitor-ui/src/components/layout/queue-section.tsx`:
  - Preserve PRD-0's verdict-cast cleanup (do not revert).
  - Remove the `refreshTrigger` prop.
  - Replace `useApi(API_ROUTES.queue)` (line 73) with `useSWR(API_ROUTES.queue, fetcher, { refreshInterval: 5000 })`.
  - Remove the `useEffect`-with-`setInterval` (lines 85-90) and the `useEffect`-on-`refreshTrigger` (lines 93-97).
  - Replace the per-failed-item recovery-sidecar fetching block (lines 99-128) with one `useSWR(['sidecar', item.id], fetcher, { refreshInterval: 10000 })` per failed item, called from a small `<RecoveryRow>` sub-component (each row owns its own SWR call so SWR's per-key dedupe works correctly; calling `useSWR` inside a `.map()` is a hooks violation).
  - Remove `fetchedKeysRef` and the `sidecarData` state — both subsumed by SWR.

- `packages/monitor-ui/src/hooks/use-eforge-events.ts`:
  - Replace `cacheRef: useRef<Map<string, RunState>>(new Map())` with the bounded LRU (inline or imported from `lib/lru.ts`).
  - When the SSE stream sees `phase:start`, `phase:end`, `session:end`, `enqueue:complete`, `plan:build:complete`, or `plan:build:failed`, call SWR's global `mutate(key)` to invalidate the matching server-state cache entry. Use the `mutate` import from `swr` directly.
  - For `daemon:auto-build:paused` (currently handled in `use-auto-build`), the `useAutoBuild` hook will own its own `mutate(API_ROUTES.autoBuildGet)` call; `use-eforge-events` doesn't need to forward this one.

- `packages/monitor-ui/src/hooks/use-auto-build.ts`:
  - Replace the 5s `setInterval` + `fetchAutoBuild` (lines 17-27) with `useSWR(API_ROUTES.autoBuildGet, fetcher, { refreshInterval: 10000 })`.
  - The SSE override block (lines 32-52) calls `mutate(API_ROUTES.autoBuildGet)` instead of `fetchAutoBuild` directly.
  - The `toggle()` callback uses `mutate(API_ROUTES.autoBuildGet, optimisticData, { revalidate: false })` after a successful POST — this gives instant UI flip without waiting for the next refresh cycle.

- `packages/monitor-ui/src/lib/api.ts`:
  - Remove read-only fetch helpers: `fetchLatestSessionId`, `fetchOrchestration`, `fetchAutoBuild`, `fetchProjectContext`, `fetchFileDiff`, `fetchRecoverySidecar`. (PRD 0 already removes `fetchRuns`, `fetchLatestRunId`, `fetchQueue`, `fetchPlanDiffs`.)
  - Keep mutation helpers: `setAutoBuild`, `cancelSession`, `triggerRecover`, `applyRecovery`. These remain imperative.
  - If only mutation helpers remain, rename to `lib/api-mutations.ts` for clarity. Implementer's call.

- `packages/monitor-ui/src/components/plans/plan-cards.tsx` — replace `useApi` with `useSWR`. Mechanical.
- `packages/monitor-ui/src/components/preview/plan-preview-panel.tsx` — replace `useApi` with `useSWR`. Mechanical.

#### Files deleted

- `packages/monitor-ui/src/hooks/use-api.ts` — fully replaced by SWR. No callers left after migration.

#### Patterns to follow

- **`API_ROUTES` + `buildPath()`** — every SWR key is built from `API_ROUTES`. The existing `api-routes-compliance.test.tsx` greps for literal `/api/...` strings; SWR keys must obey the same rule. `useSWR` accepts string keys, so `useSWR(API_ROUTES.queue, fetcher)` works directly.
- **Tuple keys for parameterized routes** — `useSWR(['sidecar', prdId], fetcher)`. The fetcher destructures the tuple. Pattern documented in `swr-fetcher.ts`.
- **SSE invalidation** — call `mutate(key)` from `swr` (the global one, not the hook-scoped one), keyed identically to the `useSWR` call. Hook-scoped `mutate` only invalidates within that one hook instance; global `mutate` invalidates all subscribers.
- **No mocks in tests** (per AGENTS.md) — tests use real SWR with `fallbackData` or `<SWRConfig provider={() => new Map()}>` for cache isolation.

#### Shared utilities reused

- `API_ROUTES`, `buildPath()` from `@eforge-build/client` (or `@eforge-build/client/browser` if PRD 0 introduced that subpath).
- `subscribeToSession` from `@eforge-build/client` — unchanged.
- shadcn/ui primitives — unchanged.

#### Dependency relationships (post-migration data flow)

```
<SWRConfigProvider> (in main.tsx)
  └── <App />
        ├── useSWR(API_ROUTES.latestRun, ...)         ← app.tsx
        ├── useSWR(API_ROUTES.projectContext, ...)    ← app.tsx
        ├── useSWR(API_ROUTES.orchestration, ...)     ← app.tsx (session-keyed)
        ├── <Sidebar>
        │   ├── useSWR(API_ROUTES.runs, ...)
        │   ├── useSWR(API_ROUTES.sessionMetadata, ...)
        │   └── <QueueSection>
        │       ├── useSWR(API_ROUTES.queue, ...)
        │       └── <RecoveryRow> (per failed item)
        │           └── useSWR(['sidecar', prdId], ...)
        ├── useEforgeEvents(sessionId)                ← SSE; calls mutate() to invalidate cache
        └── useAutoBuild(sessionId)
            └── useSWR(API_ROUTES.autoBuildGet, ...)
```

### Profile Signal

**Recommended profile: excursion**

Rationale:
- Single package (`packages/monitor-ui/`) — rules out **expedition** (no cross-subsystem coordination).
- More than a typo or single mechanical fix: ~12 files modified, 5 files added, 1 file deleted, 1 new dependency, with a real architectural shift (coercive `refreshTrigger` → SSE-driven `mutate()` invalidation) — rules out **errand** by margin.
- Migration is mostly mechanical at the call sites (replace `useApi` with `useSWR`), but the SSE-invalidation wiring and the LRU bound carry non-trivial behavioral correctness requirements.
- Failure modes are user-visible (stale UI, missed updates, request hammering on daemon-down). Acceptance criteria are mostly verifiable by `pnpm test` + `pnpm type-check` + `pnpm build`, with a small set of behavioral checks ("sidebar updates within 10s of enqueue") that benefit from a review pass.
- Lighter than PRD A: no decomposition of complex stateful logic, no pixel-equivalent rendering risk, no regression-test fixture needed (the test surface is small enough to cover with unit tests).

**excursion** is the right size for one focused PR going through implement → review → test → evaluate.

## Scope

### In scope

1. **Adopt SWR** as the shared cache layer for all non-SSE HTTP fetches in monitor-UI. Add `swr@^2` to `packages/monitor-ui/package.json`. Wrap the React tree in `<SWRConfig>` (in `main.tsx` or a new `lib/swr-config.ts` provider) with sensible global defaults: `revalidateOnFocus: true`, `revalidateOnReconnect: true`, `dedupingInterval: 2000`, `errorRetryInterval: 5000` with default exponential backoff.

2. **Delete the per-component fetch hook** `hooks/use-api.ts` (54 LOC). Every call site migrates to `useSWR(API_ROUTES.X, fetcher)` directly.

3. **Delete the coercive `refreshTrigger` chain.** Remove `sidebarRefresh` state and all `setSidebarRefresh(c => c + 1)` calls in `app.tsx` (lines 28, 92, 120-141, 144-152, 156-160). Remove the `refreshTrigger` prop from `<Sidebar>` and `<QueueSection>`. Cache invalidation comes from SWR's polling + focus revalidation + targeted `mutate(key)` calls when an SSE event tells us a specific cached value is now stale.

4. **Standardize polling cadence per route** (see table in Approach).

5. **SSE-driven invalidation**: `use-eforge-events` and `use-auto-build` use `mutate(key)` from SWR's global mutator to invalidate specific cache entries when SSE events tell us they're stale (full event→key mapping in Approach).

6. **Migrate the recovery-sidecar fetching in `queue-section.tsx`** (lines 102-128) to `useSWR(['sidecar', prdId], fetcher)` per failed item. SWR's built-in dedupe replaces the manual `fetchedKeysRef`. 404 responses return `null` from the fetcher and naturally retry on the `refreshInterval`.

7. **Bound the in-memory completed-session cache** in `use-eforge-events.ts` (lines 21, 91). Replace the unbounded `Map<string, RunState>` with a count-based LRU capped at **20 entries** using simple insertion-order eviction. New file: `lib/lru.ts` (or inline as a private helper in `use-eforge-events.ts` — implementer's choice; prefer inline if under ~30 LOC).

8. **Migrate `use-auto-build.ts`** polling to SWR. The hook becomes `useSWR(API_ROUTES.autoBuildGet, fetcher, { refreshInterval: 10000 })` plus the existing SSE override (which now calls `mutate(API_ROUTES.autoBuildGet)` instead of a manual fetch).

9. **Restructure `lib/api.ts`** post-PRD-0:
   - PRD 0 will already have removed `fetchRuns`, `fetchLatestRunId`, `fetchQueue`, `fetchPlanDiffs`.
   - This PRD removes the remaining read-helpers that get replaced by direct `useSWR` calls: `fetchLatestSessionId`, `fetchOrchestration`, `fetchAutoBuild`, `fetchProjectContext`, `fetchFileDiff`, `fetchRecoverySidecar`.
   - Mutation helpers (`setAutoBuild`, `cancelSession`, `triggerRecover`, `applyRecovery`) stay — they're called imperatively from event handlers and don't need SWR. They migrate to a renamed `lib/api-mutations.ts` (or stay in `lib/api.ts` if it shrinks to mostly mutations — implementer's call).

10. **Add a single `fetcher` utility** at `lib/swr-fetcher.ts` (see Approach for the implementation). Returning `null` on 404 is critical for the recovery-sidecar use case (recovery-pending = no sidecar yet).

11. **Tests**:
    - Unit test for the fetcher's 404→null behavior.
    - Unit test for the LRU cache eviction (20-entry bound, oldest evicted on insert).
    - Component test for `<Sidebar>` showing it renders without `refreshTrigger` and refetches when SWR's mock cache mutates.
    - Smoke test that `<SWRConfig>` provider is in the tree (otherwise hooks throw at runtime).

### Out of scope

- **Anything PRD A or PRD 0 owns** — see Deconflict matrix in Problem / Motivation.
- **The SSE protocol or `subscribeToSession`** — unchanged. SSE remains the source of truth for live session events.
- **Mutation patterns** — the four mutation helpers stay imperative; not converting to `useSWRMutation`.
- **Optimistic updates** — no current call site benefits.
- **TanStack Query** — explicitly rejected; SWR is right-sized.
- **`<SWRConfig>` provider hierarchy** — single root provider, no per-subtree config overrides.
- **DevTools / debug logging** — skipped; browser network tab and React DevTools are sufficient.
- **The `app.tsx:283-289` 1s tick interval** for the duration display — pure UI clock, not data fetching, untouched.
- **The `shutdown-banner.tsx` 30s keep-alive ping** — outbound POST, not data fetching, untouched.
- **The countdown ticker in `use-eforge-events.ts:25-46`** — local UI countdown, unrelated to fetch lifecycle, untouched.
- **Engine, daemon, backend, or HTTP route changes** — UI-only.
- **Visual design** — pixel-equivalent rendering required.
- **Adding new routes or new data sources** — only migrate what already exists.
- **The reducer / pipeline / memoization** — that's PRD A.
- **Any new feature work** (cross-linking, search, command palette, cost breakdown).

### Files NOT touched

- `packages/monitor-ui/src/lib/reducer.ts` and `reducer/*` (PRD A territory, possibly post-decomposition).
- `packages/monitor-ui/src/components/pipeline/*` (PRD A territory).
- `packages/monitor-ui/src/components/timeline/event-card.tsx` (PRD A territory).
- `packages/monitor-ui/src/lib/types.ts` (PRD 0 territory).
- `packages/monitor-ui/src/lib/plan-content.ts` (PRD 0 territory).
- `packages/monitor-ui/src/components/recovery/sidecar-sheet.tsx` (PRD 0 territory — verdict casts).
- `packages/monitor-ui/src/components/layout/shutdown-banner.tsx` — keep-alive ping is unrelated.
- `packages/monitor-ui/src/components/layout/header.tsx`, `enqueue-section.tsx`, `app-layout.tsx` — no fetch logic to migrate.
- `packages/monitor-ui/src/components/heatmap/*`, `graph/*`, `console/*`, `recovery/verdict-chip.tsx` — no fetch logic to migrate.
- `packages/monitor/`, `packages/client/`, `packages/engine/` — UI-only PRD.
- HTTP API contracts unchanged.

### Natural boundary

PRD A bounded the *render* lifecycle (reducer, memoization, pipeline split). PRD B bounds the *request* lifecycle (fetch, cache, polling, invalidation). PRD 0 bounded the *type-ownership* lifecycle (wire types in client, dead helpers gone). Three orthogonal slices of monitor-UI tech debt; this is the third.

### What does NOT change

- HTTP API contracts.
- `EforgeEvent` shape.
- `RunState` shape (untouched — PRD A territory).
- The SSE subscription contract (`subscribeToSession`).
- Visual design of any component.
- The `lib/api-version.ts` `DAEMON_API_VERSION` constant — no API-version bump needed (UI-only refactor).

## Acceptance Criteria

### SWR adoption

- [ ] `swr@^2` is in `packages/monitor-ui/package.json` dependencies. No other new dependencies.
- [ ] `<SWRConfigProvider>` (or equivalent `<SWRConfig>`) wraps the app at `main.tsx`. Global defaults: `revalidateOnFocus: true`, `revalidateOnReconnect: true`, `dedupingInterval: 2000`, `errorRetryInterval: 5000`.
- [ ] `lib/swr-fetcher.ts` exists. Exports a `fetcher` function that returns parsed JSON on 2xx, returns `null` on 404, throws on other non-2xx.

### Hook deletion and replacement

- [ ] `packages/monitor-ui/src/hooks/use-api.ts` is deleted. No imports of `useApi` remain anywhere in the codebase. (`grep -r 'useApi' packages/monitor-ui/src` returns no source matches.)
- [ ] `packages/monitor-ui/src/lib/api.ts` no longer contains read-only fetch helpers (`fetchLatestSessionId`, `fetchOrchestration`, `fetchAutoBuild`, `fetchProjectContext`, `fetchFileDiff`, `fetchRecoverySidecar`). Only mutation helpers remain (`setAutoBuild`, `cancelSession`, `triggerRecover`, `applyRecovery`), or the file is renamed to `api-mutations.ts`.

### Coercive refresh chain removed

- [ ] `app.tsx` does not declare `sidebarRefresh`, `setSidebarRefresh`, or any incrementing counter for cross-component refresh signaling.
- [ ] `<Sidebar>` does not accept a `refreshTrigger` prop.
- [ ] `<QueueSection>` does not accept a `refreshTrigger` prop.
- [ ] No `useEffect` in `app.tsx`, `Sidebar`, or `QueueSection` exists solely to react to a refresh-counter prop.

### Polling cadence

- [ ] No `setInterval` in `app.tsx`, `Sidebar`, `QueueSection`, `use-auto-build.ts`, or any other monitor-UI file *except* the 1s duration tick (`app.tsx:283-289`), the SSE shutdown countdown ticker (`use-eforge-events.ts:25-46`), and the keep-alive ping (`shutdown-banner.tsx`). All other timed fetches are SWR `refreshInterval`.
- [ ] `useSWR(API_ROUTES.latestRun, ..., { refreshInterval: 10000 })` polls every 10s (down from 2s).
- [ ] `useSWR(API_ROUTES.queue, ..., { refreshInterval: 5000 })` polls every 5s (matches old cadence; still appropriate for queue throughput).
- [ ] `useSWR(API_ROUTES.runs, ..., { refreshInterval: 10000 })` and `useSWR(API_ROUTES.sessionMetadata, ..., { refreshInterval: 10000 })` poll every 10s (down from coercive-refresh-driven).
- [ ] `useSWR(API_ROUTES.autoBuildGet, ..., { refreshInterval: 10000 })` polls every 10s (down from 5s; SSE handles instant updates).
- [ ] Per-failed-item recovery sidecar fetch uses `useSWR(['sidecar', prdId], ..., { refreshInterval: 10000 })` — one hook call per failed item, dedupe handled by SWR's tuple-key cache.

### SSE-driven invalidation

- [ ] `use-eforge-events.ts` calls `mutate(API_ROUTES.runs)` and `mutate(API_ROUTES.sessionMetadata)` on `phase:start` and `phase:end` events.
- [ ] `use-eforge-events.ts` calls `mutate(API_ROUTES.runs)` and `mutate(API_ROUTES.latestRun)` on `session:end`.
- [ ] `use-eforge-events.ts` calls `mutate(API_ROUTES.queue)` on `enqueue:complete`, `plan:build:complete`, and `plan:build:failed`.
- [ ] `use-eforge-events.ts` calls `mutate(['sidecar', prdId])` on `plan:build:failed`.
- [ ] `use-auto-build.ts` calls `mutate(API_ROUTES.autoBuildGet)` on the `daemon:auto-build:paused` SSE event.
- [ ] `use-auto-build.ts`'s `toggle()` callback uses optimistic update: `mutate(API_ROUTES.autoBuildGet, optimisticState, { revalidate: false })` after the POST resolves.

### LRU cache bound

- [ ] `use-eforge-events.ts`'s completed-session cache is bounded to **20 entries**. Inserting a 21st entry evicts the oldest.
- [ ] If extracted to `lib/lru.ts`, the file exports a typed `BoundedMap<K, V>` and is unit-tested.

### Visual / behavioral preservation

- [ ] The Sidebar still updates when a new session is enqueued (verified: enqueue a build, observe sidebar shows it within ~10s).
- [ ] The QueueSection still shows pending items and updates on enqueue (within ~5s).
- [ ] The auto-build toggle still flips immediately on user click (optimistic update).
- [ ] The auto-build toggle still flips when the daemon pauses (SSE-driven; tested by triggering a daemon pause and observing the toggle).
- [ ] Recovery verdict chips appear within ~10s of a `plan:build:failed` event.
- [ ] No visible UI staleness or flicker introduced. Page transitions remain smooth.
- [ ] Tab going to background pauses polling (SWR's default `revalidateIfStale` + visibility behavior). Returning to tab triggers immediate revalidation (`revalidateOnFocus: true`).

### Tests

- [ ] `pnpm test` from the repo root passes.
- [ ] New test file `src/lib/__tests__/swr-fetcher.test.ts`:
  - Returns `null` on a 404 response.
  - Throws `Error` with status code on a 500 response.
  - Returns parsed JSON on a 200 response.
- [ ] New test for the bounded LRU (either `src/lib/__tests__/lru.test.ts` or co-located in `use-eforge-events` test):
  - Inserts up to 20 entries; all accessible.
  - 21st insert evicts the oldest entry; oldest is no longer accessible.
  - Documented eviction semantics on cache hit (promote vs. don't-promote).
- [ ] `<SWRConfigProvider>` renders without throwing; nested `useSWR` calls succeed in tests with seeded `fallbackData`.
- [ ] All existing tests still pass: `api-routes-compliance.test.tsx`, `event-card.test.tsx`, `verdict-chip.test.tsx`, `queue-section-recovery.test.tsx`, and any tests added by PRD 0 / PRD A.

### Type-checking and build

- [ ] `pnpm type-check` passes with no errors.
- [ ] `pnpm build` succeeds for `@eforge-build/monitor-ui`.
- [ ] No new TypeScript or lint warnings introduced.

### API route hygiene

- [ ] Every `useSWR` key string is built from `API_ROUTES` or `buildPath(API_ROUTES.X, ...)`. No literal `/api/...` strings introduced.
- [ ] `api-routes-compliance.test.tsx` continues to pass.

### Existing test coverage

- `api-routes-compliance.test.tsx` — still passes (SWR keys use `API_ROUTES.X`, no literal `/api/...`).
- `event-card.test.tsx`, `verdict-chip.test.tsx`, `queue-section-recovery.test.tsx` — must keep passing. The queue-section test in particular needs review: if it relied on `refreshTrigger` for setup, the test setup migrates to seeding SWR's cache via `<SWRConfig provider={...}>`.

### Out-of-scope checks (defensive — these should NOT change)

- [ ] No changes to `packages/monitor-ui/src/lib/reducer.ts` or `reducer/*` (PRD A territory).
- [ ] No changes to `packages/monitor-ui/src/components/pipeline/*` (PRD A territory).
- [ ] No changes to `packages/monitor-ui/src/components/timeline/event-card.tsx` (PRD A territory).
- [ ] No changes to `packages/monitor-ui/src/lib/types.ts` (PRD 0 territory).
- [ ] No changes to `packages/monitor-ui/src/lib/plan-content.ts` (PRD 0 territory).
- [ ] No changes to `packages/monitor-ui/src/components/recovery/sidecar-sheet.tsx` (PRD 0 territory).
- [ ] No changes to `packages/engine/`, `packages/monitor/`, `packages/client/` (UI-only PRD).
- [ ] No new HTTP routes, no changes to existing routes.
- [ ] No bump to `DAEMON_API_VERSION`.
- [ ] No visual design changes; rendering is behaviorally equivalent.
