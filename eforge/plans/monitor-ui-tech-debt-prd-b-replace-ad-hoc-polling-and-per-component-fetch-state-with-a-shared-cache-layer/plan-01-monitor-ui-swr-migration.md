---
id: plan-01-monitor-ui-swr-migration
name: Adopt SWR cache layer in monitor-UI; delete useApi and refreshTrigger chain
branch: monitor-ui-tech-debt-prd-b-replace-ad-hoc-polling-and-per-component-fetch-state-with-a-shared-cache-layer/swr-migration
agents:
  builder:
    effort: high
    rationale: ~16 file changeset with one architectural shift (coercive
      refreshTrigger → SSE-driven mutate) and behavioral correctness
      requirements (LRU bound, 404→null fetcher contract, optimistic update for
      autoBuild). The mechanical replacements (useApi → useSWR) are easy, but
      the SSE invalidation wiring and the per-failed-item RecoveryRow extraction
      are subtle enough to warrant high effort over the default.
  reviewer:
    effort: high
    rationale: Reviewer must verify (a) every banned setInterval is gone except the
      three explicitly-allowed ones; (b) every SSE event listed in Acceptance
      Criteria fires the matching mutate(key); (c) refreshTrigger prop and
      sidebarRefresh state are fully removed; (d) LRU bound is genuinely
      20-entry; (e) no literal /api/ strings introduced. These are checklist
      items easy to miss without thorough review.
---

# Adopt SWR cache layer in monitor-UI; delete useApi and refreshTrigger chain

## Architecture Context

This plan implements PRD B of the monitor-UI tech-debt cleanup series. PRD 0 (already merged) moved wire-protocol types to `@eforge-build/client/browser`, removed dead `lib/api.ts` helpers (`fetchRuns`, `fetchLatestRunId`, `fetchQueue`, `fetchPlanDiffs`, `fetchPlans`-callers), and added the engine-import guard test. PRD A (parallel — separate worktree) bounds the *render* lifecycle (reducer + pipeline + memoization). This plan bounds the *request* lifecycle: ad-hoc polling, per-component fetch state, and the manual `refreshTrigger` choreography.

The key constraint baked into the codebase: "Engine emits, consumers render." The SSE stream (`subscribeToSession`) remains the source of truth for live session events — this plan does **not** replace SSE with polling, only standardizes the *non-SSE* polling and adds SSE-driven cache invalidation via SWR's `mutate()`.

A matching test (`api-routes-compliance.test.tsx`) greps source files for literal `/api/...` strings and fails the build if any are introduced; every SWR key must be built from `API_ROUTES` / `buildPath()`. A second guard test (`no-engine-imports.test.ts`) prohibits `@eforge-build/engine` imports from monitor-UI source.

## Implementation

### Overview

Add `swr@^2` as a monitor-UI dependency, wrap the React tree in `<SWRConfigProvider>` with sensible global defaults, replace all `useApi` call sites with `useSWR`, delete `hooks/use-api.ts`, remove the entire `sidebarRefresh` / `refreshTrigger` prop-chain choreography, replace ad-hoc `setInterval` polling with SWR `refreshInterval`, wire SSE events to targeted `mutate(key)` invalidation, bound the completed-session in-memory cache in `use-eforge-events.ts` to 20 entries via insertion-order eviction, and remove the read-only fetch helpers from `lib/api.ts` (mutation helpers stay imperative).

### Key Decisions

1. **SWR over TanStack Query.** SWR is ~5 KB gzip and right-sized for a read-heavy UI with no infinite-scroll, no optimistic-update churn, and no devtools requirement. TanStack would be ~13 KB and overkill. Decision baked into the PRD; no re-litigation.
2. **Global `mutate()` over hook-scoped `mutate()`.** `use-eforge-events` and `use-auto-build` need to invalidate cache entries owned by sibling subtrees (Sidebar, QueueSection). Hook-scoped `mutate` returned by `useSWR` only invalidates within that hook instance. The global `mutate` import from `swr` invalidates across the entire `<SWRConfigProvider>` tree.
3. **Tuple keys for parameterized routes.** Recovery sidecar fetching uses `useSWR(['sidecar', prdId], fetcher, ...)`. The fetcher destructures the tuple to extract the prdId and constructs the URL via `API_ROUTES.readRecoverySidecar` + `URLSearchParams`. SSE invalidation uses the same tuple shape: `mutate(['sidecar', prdId])`. The `api-routes-compliance` regex (`/['\"`]\/api\//`) does not flag tuple keys because the route literal lives inside `routes.ts` (in `@eforge-build/client`), not the call site.
4. **404 → null in the fetcher.** The recovery-sidecar route returns 404 when no sidecar exists yet (recovery pending). The shared `fetcher` in `lib/swr-fetcher.ts` returns `null` on 404, throws on other non-2xx, and parses JSON on 2xx. This preserves the existing `RecoveryVerdictChip` semantics (null verdict → "recovery pending" indicator) without per-call-site error handling.
5. **Per-row `<RecoveryRow>` sub-component.** Calling `useSWR` inside a `.map()` is a Rules-of-Hooks violation. Each failed queue item gets its own row component instance, which calls `useSWR(['sidecar', item.id], fetcher, { refreshInterval: 10000 })` once. SWR's per-key dedupe handles concurrent identical calls automatically, replacing the manual `fetchedKeysRef`.
6. **Insertion-order LRU, 20 entries.** Replace `useRef<Map<string, RunState>>` with a small `BoundedMap<K, V>` helper. On `set`, if `size >= cap`, delete the oldest key (`map.keys().next().value`) before inserting. This is the simplest viable LRU and matches the PRD's "prefer inline if under ~30 LOC" guidance. Whether a hit promotes to most-recently-used is a documented choice — this plan opts for **non-promoting** (insertion-order only) because hits in `useEforgeEvents` are user-driven session re-selection, and FIFO eviction matches user expectations ("oldest viewed session falls off first"). The unit test documents this choice.
7. **Optimistic update only on autoBuild toggle.** The PRD calls out one optimistic-update site: `useAutoBuild`'s `toggle()` callback. After the POST resolves, `mutate(API_ROUTES.autoBuildGet, optimisticState, { revalidate: false })` flips the toggle instantly without waiting for the next 10s poll. No other optimistic updates are introduced.
8. **`fetchFileDiff` removal — inline in DiffViewer.** `fetchFileDiff` is called from a sequential async loop in `diff-viewer.tsx` (lines 62-73), one fetch per planId in `planIds`. SWR doesn't fit a dynamic loop cleanly without restructuring the entire component. Decision: keep the imperative loop but inline the fetch using the `fetcher` from `lib/swr-fetcher.ts` (or a small dedicated helper) so the `lib/api.ts` helper can still be deleted. The DiffViewer's prop-driven re-fetch behavior is preserved exactly.
9. **Mutation helpers stay in `lib/api.ts`.** `setAutoBuild`, `cancelSession`, `triggerRecover`, `applyRecovery` remain. After read-helper removal, the file holds only mutations. Per the PRD the implementer may rename to `lib/api-mutations.ts`. This plan keeps the filename `lib/api.ts` to minimize import-statement churn across call sites — the file's *contents* shrink to mutations only, which the file's leading doc-comment (added by the builder) makes explicit. Renaming is an aesthetic call that doesn't justify dozens of import-line edits.
10. **No bump to `DAEMON_API_VERSION`.** UI-only refactor; HTTP API contracts unchanged.

## Scope

### In Scope

- Add `swr@^2` dependency to `packages/monitor-ui/package.json`. No other new dependencies.
- Create `packages/monitor-ui/src/lib/swr-fetcher.ts` exporting the shared `fetcher`.
- Create `packages/monitor-ui/src/lib/swr-config.tsx` exporting `<SWRConfigProvider>` with global defaults: `revalidateOnFocus: true`, `revalidateOnReconnect: true`, `dedupingInterval: 2000`, `errorRetryInterval: 5000`.
- Wrap `<App />` in `<SWRConfigProvider>` in `packages/monitor-ui/src/main.tsx`.
- Migrate every `useApi` call site to `useSWR(API_ROUTES.X, fetcher, options)`:
  - `app.tsx`: `latestRun` (10s), `projectContext` (no refresh), `orchestration` (session-keyed, focus-only).
  - `sidebar.tsx`: `runs` (10s), `sessionMetadata` (10s).
  - `queue-section.tsx`: `queue` (5s).
  - `plan-cards.tsx`: `plans` (mechanical).
  - `plan-preview-panel.tsx`: `plans` (mechanical).
- Replace per-failed-item recovery sidecar fetching in `queue-section.tsx` with a `<RecoveryRow>` sub-component that calls `useSWR(['sidecar', item.id], fetcher, { refreshInterval: 10000 })`. Remove `fetchedKeysRef` and the `sidecarData` state.
- Migrate `use-auto-build.ts` to `useSWR(API_ROUTES.autoBuildGet, fetcher, { refreshInterval: 10000 })`. SSE override calls `mutate(API_ROUTES.autoBuildGet)`. `toggle()` performs optimistic update via `mutate(key, optimisticState, { revalidate: false })`.
- Wire SSE-driven invalidation in `use-eforge-events.ts`. On the listed events, call the global `mutate(key)` from `swr`:
  - `phase:start` / `phase:end` → `mutate(API_ROUTES.runs)`, `mutate(API_ROUTES.sessionMetadata)`.
  - `session:end` → `mutate(API_ROUTES.runs)`, `mutate(API_ROUTES.latestRun)`.
  - `enqueue:complete` → `mutate(API_ROUTES.queue)`.
  - `plan:build:complete` → `mutate(API_ROUTES.queue)`.
  - `plan:build:failed` → `mutate(API_ROUTES.queue)`, `mutate(['sidecar', prdId])`.
  - `daemon:auto-build:paused` is owned by `use-auto-build.ts` (already SSE-listening on the active session); it calls `mutate(API_ROUTES.autoBuildGet)` itself.
- Bound the completed-session cache in `use-eforge-events.ts` to **20 entries** via insertion-order eviction. Inline `BoundedMap<K, V>` if under ~30 LOC, else extract to `lib/lru.ts`.
- Delete `packages/monitor-ui/src/hooks/use-api.ts`.
- Remove read-only helpers from `lib/api.ts`: `fetchLatestSessionId`, `fetchOrchestration`, `fetchPlans`, `fetchAutoBuild`, `fetchProjectContext`, `fetchFileDiff`, `fetchRecoverySidecar`. Keep `setAutoBuild`, `cancelSession`, `triggerRecover`, `applyRecovery`. Keep `AutoBuildState` type export (still used by `use-auto-build.ts`).
- Inline the diff fetch in `diff-viewer.tsx` directly (using the shared `fetcher` or an equivalent inline `fetch` call) so `fetchFileDiff` can be removed from `lib/api.ts`.
- Remove `sidebarRefresh` state from `app.tsx`. Remove all `setSidebarRefresh(c => c + 1)` calls. Remove the `phase:start`/`phase:end` refresh effect, the `isComplete` refresh effect, and the 2s coercive-refresh polling effect (replaced by `useSWR(API_ROUTES.latestRun, ..., { refreshInterval: 10000 })` plus a small `useEffect` that auto-switches to a new latest session under the same conditions as today: `!userSelectedRef.current && !isCurrentRunningRef.current`).
- Remove the `refreshTrigger` prop from `<Sidebar>` and `<QueueSection>` and from their callers. Remove the `useEffect` that refetches `runs`/`sessionMetadata`/`queue` on `refreshTrigger`.
- Add unit tests for the fetcher (404→null, throws on 500, parses JSON on 200) and for the LRU bound (20-entry cap, oldest-evicted-on-21st-insert, documented hit semantics).
- Verify all existing tests still pass: `api-routes-compliance.test.tsx`, `no-engine-imports.test.ts`, `queue-section-recovery.test.tsx`, `verdict-chip.test.tsx`, plus any tests added by PRD A.

### Out of Scope

- The SSE protocol and `subscribeToSession` — unchanged.
- The four mutation helpers (`setAutoBuild`, `cancelSession`, `triggerRecover`, `applyRecovery`) — stay imperative. Not converting to `useSWRMutation`.
- Optimistic updates beyond the single autoBuild-toggle site.
- TanStack Query — explicitly rejected.
- Per-subtree `<SWRConfig>` overrides — single root provider only.
- DevTools or debug logging.
- The `app.tsx:283-289` 1s duration tick — pure UI clock; untouched.
- The `shutdown-banner.tsx` 30s keep-alive ping — outbound POST; untouched.
- The countdown ticker in `use-eforge-events.ts:25-46` — local UI countdown; untouched.
- Engine, daemon, backend, or HTTP route changes — UI-only.
- Visual design changes — pixel-equivalent rendering required.
- Adding new routes or new data sources.
- Reducer / pipeline / memoization (PRD A territory).
- Wire-protocol type ownership / `lib/types.ts` / `lib/plan-content.ts` / `sidecar-sheet.tsx` verdict casts (PRD 0 territory; already merged).
- Renaming `lib/api.ts` to `lib/api-mutations.ts` (kept as `api.ts` to minimize import churn — see Decision 9).
- Bump to `DAEMON_API_VERSION` — UI-only refactor.

## Files

### Create

- `packages/monitor-ui/src/lib/swr-fetcher.ts` — exports `fetcher: (key: string | [string, ...unknown[]]) => Promise<unknown>`. Returns `null` on 404, throws `Error` with status code on other non-2xx, returns parsed JSON on 2xx. Tuple keys: the first element is the route literal from `API_ROUTES`, subsequent elements are interpolation params. For the `['sidecar', prdId]` shape, the fetcher constructs `${API_ROUTES.readRecoverySidecar}?${URLSearchParams({ prdId })}`. ~25 LOC including JSDoc.
- `packages/monitor-ui/src/lib/swr-config.tsx` — exports `<SWRConfigProvider>` wrapping `<SWRConfig>` with the global defaults listed in scope. ~25 LOC including JSDoc.
- `packages/monitor-ui/src/lib/__tests__/swr-fetcher.test.ts` — covers (a) 404 → returns null, (b) 500 → throws Error containing status code, (c) 200 with JSON body → returns parsed object, (d) tuple-key shape `['sidecar', prdId]` → fetches the correct URL with prdId in query params. Uses `globalThis.fetch` stub via `vi.stubGlobal`.
- `packages/monitor-ui/src/lib/__tests__/lru.test.ts` *(or co-located in a `use-eforge-events` test file if `BoundedMap` is inlined)* — covers (a) inserts up to 20 entries, all accessible, (b) 21st insert evicts the oldest entry, oldest no longer accessible, (c) hit-on-existing-entry does NOT promote (insertion-order semantics — the implementer's chosen policy is documented in the test name).

### Modify

- `packages/monitor-ui/package.json` — add `"swr": "^2.2.5"` (or whatever resolves as latest stable in the `^2` range at implementation time) to `dependencies`. No other dep changes. Run `pnpm install` so `pnpm-lock.yaml` updates accordingly. Do NOT add `@types/swr` — SWR ships its own types.
- `packages/monitor-ui/src/main.tsx` — wrap `<App />` in `<SWRConfigProvider>`. Maintain `<StrictMode>` outermost.
- `packages/monitor-ui/src/app.tsx`:
  - Remove `sidebarRefresh` state (line 28) and all `setSidebarRefresh` calls.
  - Replace the 2s polling effect (lines 109-141) with `useSWR(API_ROUTES.latestRun, fetcher, { refreshInterval: 10000 })`. The auto-switch logic moves into a `useEffect` that watches the SWR-returned `data` (under the gate `!userSelectedRef.current && !isCurrentRunningRef.current`).
  - Remove the `phase:start`/`phase:end` refresh effect (lines 144-152). Invalidation now flows through `use-eforge-events` → `mutate()`.
  - Remove the `isComplete` refresh effect (lines 156-160).
  - Replace the imperative `fetchOrchestration` call (lines 163-171) with `useSWR(currentSessionId ? buildPath(API_ROUTES.orchestration, { runId: currentSessionId }) : null, fetcher)` keyed on session.
  - Replace the imperative `fetchProjectContext` call (lines 46-50) with `useSWR(API_ROUTES.projectContext, fetcher)` (no `refreshInterval`).
  - Drop `refreshTrigger` from `<Sidebar>` props (line 323).
  - Keep the 1s duration tick (lines 287-292) as-is.
- `packages/monitor-ui/src/components/layout/sidebar.tsx`:
  - Remove the `refreshTrigger` prop from `SidebarProps` and the destructure.
  - Replace `useApi<RunInfo[]>(API_ROUTES.runs)` (line 157) with `useSWR<RunInfo[]>(API_ROUTES.runs, fetcher, { refreshInterval: 10000 })`.
  - Replace `useApi<Record<string, SessionMetadata>>(API_ROUTES.sessionMetadata)` (line 158) with `useSWR<Record<string, SessionMetadata>>(API_ROUTES.sessionMetadata, fetcher, { refreshInterval: 10000 })`.
  - Remove the `useEffect` that refetches on `refreshTrigger > 0` (lines 163-168). Drop `refetch` / `refetchMetadata`.
  - Drop the `refreshTrigger` prop forwarded to `<QueueSection>` (line 214).
- `packages/monitor-ui/src/components/layout/queue-section.tsx`:
  - Preserve all `eforge:region` markers exactly as-is — they bound code from prior plans (`plan-04-monitor-ui`, `plan-05-piggyback-and-queue-scheduling`) and the verdict-cast cleanup landed in PRD 0. Do NOT revert any of that.
  - Remove the `refreshTrigger` prop and the `QueueSectionProps` interface field.
  - Replace `useApi<QueueItem[]>(API_ROUTES.queue)` (line 73) with `useSWR<QueueItem[]>(API_ROUTES.queue, fetcher, { refreshInterval: 5000 })`.
  - Remove the `useEffect`-with-`setInterval` polling block (lines 85-90).
  - Remove the `useEffect` that refetches on `refreshTrigger > 0` (lines 93-97).
  - Extract failed-item rendering into a small `<RecoveryRow>` sub-component (defined in the same file, no new file). Each `<RecoveryRow>` calls `useSWR<ReadSidecarResponse | null>(['sidecar', item.id], fetcher, { refreshInterval: 10000 })`. SWR's per-key dedupe replaces the manual `fetchedKeysRef`. The fetcher returns `null` on 404, so `data === undefined` means "loading" and `data === null` means "no sidecar yet (recovery pending)" — the same three-state contract the existing computeRecoveryState test enforces.
  - Remove `sidecarData` state, `fetchedKeysRef`, and the per-failed-item `useEffect` (lines 78-128). The `<RecoveryRow>` owns its own SWR call.
  - The non-failed branch of the row (everything outside the recovery-pending / verdict-chip block) stays inline in the parent map. Only the rendering that depends on the sidecar moves into `<RecoveryRow>` — keep the visual output identical.
- `packages/monitor-ui/src/hooks/use-eforge-events.ts`:
  - Replace `cacheRef: useRef<Map<string, RunState>>(new Map())` (line 21) with a 20-entry `BoundedMap`. Implementation choice: inline a 25-line helper class above the hook *or* import `BoundedMap` from `lib/lru.ts`. Default to **inline** unless extraction makes the test cleaner. The cache writes happen at line 91 (`cacheRef.current.set(...)`) — that's the only mutating call; lookups at line 56 are read-only.
  - At the appropriate dispatch points in the `subscribeToSession` `onEvent` callback, call the global `mutate` from `swr` for the events listed in scope. Recommended approach: a small helper `function invalidateOnEvent(event: EforgeEvent) { ... }` that switches on `event.type` and calls `mutate(...)` for the matching keys. Keep the tuple-key invalidation `mutate(['sidecar', event.planId])` in sync with the consuming `useSWR(['sidecar', prdId], ...)` shape — both must use the same array structure for SWR's key matching.
  - The countdown ticker (lines 25-46) is untouched.
- `packages/monitor-ui/src/hooks/use-auto-build.ts`:
  - Replace the 5s `setInterval` + `fetchAutoBuild` block (lines 17-27) with `useSWR<AutoBuildState | null>(API_ROUTES.autoBuildGet, fetcher, { refreshInterval: 10000 })`. The hook returns `state = data ?? null`.
  - The SSE override block (lines 32-52) calls `mutate(API_ROUTES.autoBuildGet)` on the `daemon:auto-build:paused` event instead of `fetchAutoBuild` directly.
  - The `toggle()` callback (lines 54-63) replaces its `setState(result)` after a successful POST with `mutate(API_ROUTES.autoBuildGet, result, { revalidate: false })`. This flips the toggle instantly. The local `toggling` state (used for the disabled/loading visual) is preserved.
  - Remove the `fetchAutoBuild` import. The `setAutoBuild` import stays. The `AutoBuildState` type import stays (re-exported from `lib/api.ts`).
- `packages/monitor-ui/src/lib/api.ts`:
  - Delete `fetchLatestSessionId` (lines 3-8).
  - Delete `fetchOrchestration` (lines 10-14).
  - Delete `fetchPlans` (lines 16-20).
  - Delete `fetchFileDiff` (lines 22-30).
  - Delete `fetchAutoBuild` (lines 37-45).
  - Delete `fetchProjectContext` (lines 61-65).
  - Delete `fetchRecoverySidecar` (lines 110-132) and its leading doc comment.
  - Drop the `ReadSidecarResponse` import — no longer needed (only `fetchRecoverySidecar` referenced it).
  - Keep `setAutoBuild`, `cancelSession`, `triggerRecover`, `applyRecovery`, and the `AutoBuildState` interface unchanged. Keep the `API_ROUTES`, `buildPath` import (still used by mutations).
  - Add a leading file doc comment: this file now holds only mutation helpers — read fetches go through `useSWR(...)` with the fetcher from `lib/swr-fetcher.ts`.
- `packages/monitor-ui/src/components/plans/plan-cards.tsx`:
  - Replace `useApi<PlanData[]>(...)` (line 16) with `useSWR<PlanData[]>(sessionId ? buildPath(API_ROUTES.plans, { runId: sessionId }) : null, fetcher)`. Drop the `refetchTrigger` query-string hack — SWR's session-keyed refetch covers it. Keep the `refetchTrigger` prop in the interface as a no-op for now if removing it churns callers; otherwise remove. (Implementer's call — prefer removing if all callers can be updated in this same plan.)
  - Replace `loading` / `error` derivation with the SWR equivalents: `isLoading` (or `!data && !error`) and `error`.
- `packages/monitor-ui/src/components/preview/plan-preview-panel.tsx`:
  - Replace `useApi<PlanData[]>(...)` (line 21) with `useSWR<PlanData[]>(selectedPlanId && sessionId ? buildPath(API_ROUTES.plans, { runId: sessionId }) : null, fetcher)`.
  - Replace `loading` / `error` with SWR equivalents.
- `packages/monitor-ui/src/components/heatmap/diff-viewer.tsx`:
  - Inline the diff fetch in the `useEffect` loop (lines 42-88) directly: `await fetcher(\`${buildPath(API_ROUTES.diff, { sessionId, planId: pid })}?file=${encodeURIComponent(filePath)}\`)`. Cast the result through the existing typed shape (`{ diff: string | null; commitSha: string; tooLarge?: boolean; binary?: boolean }`) since `fetcher` returns `unknown`. Drop the `fetchFileDiff` import. The looping behavior, error handling, and shiki-highlight pipeline remain unchanged.

### Delete

- `packages/monitor-ui/src/hooks/use-api.ts` — fully replaced by SWR. Verified by `grep -r 'useApi' packages/monitor-ui/src` returning zero source matches after migration.

## Verification

### Hook deletion and refresh-chain removal

- [ ] `packages/monitor-ui/src/hooks/use-api.ts` does not exist on disk.
- [ ] `grep -r 'useApi' packages/monitor-ui/src` returns no source matches (test files may reference the symbol only inside string fixtures, which is acceptable; the grep checks production source).
- [ ] `grep -r 'sidebarRefresh\|setSidebarRefresh\|refreshTrigger' packages/monitor-ui/src` returns no matches.
- [ ] `<Sidebar>` and `<QueueSection>` JSX call sites in `app.tsx` and `sidebar.tsx` do not pass any `refreshTrigger` prop.

### SWR adoption

- [ ] `packages/monitor-ui/package.json` lists `swr` under `dependencies` with a `^2` version range. `pnpm-lock.yaml` resolves it to a real version (verified by `pnpm install` succeeding without warnings about peer-deps).
- [ ] `packages/monitor-ui/src/lib/swr-fetcher.ts` exists and exports a `fetcher` function. Reading the file confirms: returns `null` on 404, throws `Error` containing the HTTP status on other non-2xx, returns `await res.json()` on 2xx.
- [ ] `packages/monitor-ui/src/lib/swr-config.tsx` exists and exports `<SWRConfigProvider>`. Reading the file confirms global defaults: `revalidateOnFocus: true`, `revalidateOnReconnect: true`, `dedupingInterval: 2000`, `errorRetryInterval: 5000`.
- [ ] `packages/monitor-ui/src/main.tsx` renders `<SWRConfigProvider>` wrapping `<App />`.

### Polling cadence

- [ ] `grep -n 'setInterval' packages/monitor-ui/src` returns at most three matches: `app.tsx` (1s duration tick), `use-eforge-events.ts` (countdown ticker), `shutdown-banner.tsx` (30s keep-alive ping). No other `setInterval` exists in monitor-UI source.
- [ ] In `app.tsx`, `useSWR(API_ROUTES.latestRun, fetcher, { refreshInterval: 10000 })` is present.
- [ ] In `sidebar.tsx`, `useSWR(API_ROUTES.runs, fetcher, { refreshInterval: 10000 })` and `useSWR(API_ROUTES.sessionMetadata, fetcher, { refreshInterval: 10000 })` are present.
- [ ] In `queue-section.tsx`, `useSWR(API_ROUTES.queue, fetcher, { refreshInterval: 5000 })` is present.
- [ ] In `use-auto-build.ts`, `useSWR(API_ROUTES.autoBuildGet, fetcher, { refreshInterval: 10000 })` is present.
- [ ] In `queue-section.tsx`, the `<RecoveryRow>` sub-component calls `useSWR(['sidecar', item.id], fetcher, { refreshInterval: 10000 })`.

### SSE-driven invalidation

- [ ] `use-eforge-events.ts` imports the global `mutate` from `swr`.
- [ ] On `phase:start` and `phase:end` events, `mutate(API_ROUTES.runs)` and `mutate(API_ROUTES.sessionMetadata)` are called.
- [ ] On `session:end` events, `mutate(API_ROUTES.runs)` and `mutate(API_ROUTES.latestRun)` are called.
- [ ] On `enqueue:complete`, `plan:build:complete`, and `plan:build:failed` events, `mutate(API_ROUTES.queue)` is called.
- [ ] On `plan:build:failed` events, `mutate(['sidecar', event.planId])` is called (the tuple shape matches the consumer `useSWR` call exactly).
- [ ] `use-auto-build.ts` calls `mutate(API_ROUTES.autoBuildGet)` on the `daemon:auto-build:paused` SSE event.
- [ ] `use-auto-build.ts`'s `toggle()` callback calls `mutate(API_ROUTES.autoBuildGet, optimisticState, { revalidate: false })` after the POST resolves with a non-null result.

### LRU cache bound

- [ ] In `use-eforge-events.ts`, the completed-session cache is bounded to 20 entries. Inserting a 21st entry evicts the oldest entry (verified by the unit test).
- [ ] If extracted to `lib/lru.ts`, the file exports a typed `BoundedMap<K, V>` and is unit-tested.

### `lib/api.ts` shape

- [ ] `lib/api.ts` does not export `fetchLatestSessionId`, `fetchOrchestration`, `fetchPlans`, `fetchAutoBuild`, `fetchProjectContext`, `fetchFileDiff`, or `fetchRecoverySidecar`.
- [ ] `lib/api.ts` still exports `setAutoBuild`, `cancelSession`, `triggerRecover`, `applyRecovery`, and the `AutoBuildState` type.
- [ ] `grep -rn 'fetchLatestSessionId\|fetchOrchestration\|fetchPlans\|fetchAutoBuild\|fetchProjectContext\|fetchFileDiff\|fetchRecoverySidecar' packages/monitor-ui/src` returns no matches.

### Unit tests

- [ ] `packages/monitor-ui/src/lib/__tests__/swr-fetcher.test.ts` exists and contains tests covering: returns `null` on 404, throws `Error` on 500, returns parsed JSON on 200, and handles the tuple-key shape `['sidecar', prdId]` to build the correct URL.
- [ ] A test for the bounded LRU exists (either `lib/__tests__/lru.test.ts` or co-located in a `use-eforge-events` test) covering: inserts up to 20, 21st evicts oldest, and the documented hit-promotion semantics (test name reflects the chosen policy).
- [ ] `pnpm test` from the repo root passes. Existing tests still pass: `api-routes-compliance.test.tsx`, `no-engine-imports.test.ts`, `queue-section-recovery.test.tsx`, `verdict-chip.test.tsx`, plus any tests added by PRD A.

### Type-check, build, lint hygiene

- [ ] `pnpm type-check` passes from the repo root with no errors. Specifically, `pnpm --filter @eforge-build/monitor-ui type-check` succeeds (no `useApi` references, no missing `swr` types, no missing imports after `lib/api.ts` shrinks).
- [ ] `pnpm build` from the repo root succeeds. Specifically, `pnpm --filter @eforge-build/monitor-ui build` produces a working bundle.
- [ ] No new TypeScript or build warnings are introduced.

### API-route hygiene

- [ ] Every `useSWR` key string is constructed from `API_ROUTES.X` or `buildPath(API_ROUTES.X, params)`. No new literal `/api/...` strings introduced anywhere in monitor-UI source.
- [ ] `api-routes-compliance.test.tsx` continues to pass.
- [ ] `no-engine-imports.test.ts` continues to pass — `swr` imports from `swr`, not from any engine-internal path.

### Out-of-scope checks (these MUST NOT change)

- [ ] No changes to `packages/monitor-ui/src/lib/reducer.ts` or `packages/monitor-ui/src/lib/reducer/*` (PRD A territory). Verified by `git diff --stat eforge/monitor-ui-tech-debt-prd-b...HEAD -- packages/monitor-ui/src/lib/reducer*`.
- [ ] No changes to `packages/monitor-ui/src/components/pipeline/*` (PRD A territory).
- [ ] No changes to `packages/monitor-ui/src/components/timeline/event-card.tsx` (PRD A territory).
- [ ] No changes to `packages/monitor-ui/src/lib/types.ts` (PRD 0 territory; already merged).
- [ ] No changes to `packages/monitor-ui/src/lib/plan-content.ts` (PRD 0 territory).
- [ ] No changes to `packages/monitor-ui/src/components/recovery/sidecar-sheet.tsx` (PRD 0 territory).
- [ ] No changes under `packages/engine/`, `packages/monitor/`, or `packages/client/` (UI-only PRD).
- [ ] No new HTTP routes; no changes to existing routes.
- [ ] No bump to `DAEMON_API_VERSION` in `packages/client/src/api-version.ts`.
- [ ] Visual rendering remains pixel-equivalent — no design changes to any component.