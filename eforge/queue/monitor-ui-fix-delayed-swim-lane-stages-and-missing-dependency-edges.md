---
title: Monitor UI: fix delayed swim-lane stages and missing dependency edges
created: 2026-05-05
---

# Monitor UI: fix delayed swim-lane stages and missing dependency edges

## Problem / Motivation

Since the SWR migration (`826aa60 — feat(plan-01-monitor-ui-swr-migration)`), the monitor UI exhibits two regressions:

1. **New swim lanes don't render their stages until quite a while after the first events arrive.** A swim lane row appears once `planStatuses` is populated, but the per-plan **build-stage cells**, **depth bars**, and dependency tooltip text are sourced from `orchestration.plans[].build` / `dependsOn`. Until `orchestration` is in hand, those parts of the row are blank.
2. **When the planner completes, dependency edges between subplans don't show up right away.** The dependency graph and inter-plan depth/edge rendering are derived solely from `orchestration.plans[].dependsOn`.

**Root cause:** after the migration, **orchestration is fetched once on session change** by SWR (`packages/monitor-ui/src/app.tsx:58–62`) with no `refreshInterval` and no event-driven revalidation. `invalidateOnEvent` (`packages/monitor-ui/src/hooks/use-eforge-events.ts:20–42`) revalidates `runs`/`queue`/`latestRun` but **never the orchestration key**.

The daemon's `/api/orchestration/:id` route (`packages/monitor/src/server.ts:342–402`) returns **`200 + null`** when no `planning:complete` event exists yet for the session — *not* a 404. SWR treats this as a successful response of `null` and caches it. With no `errorRetryInterval` retry path applicable and no event-driven `mutate()`, the cache stays at `null` until `revalidateOnFocus` fires (the next time the user clicks back into the tab). This is the "quite a while" delay.

Once `planning:complete` exists in the event log, the same daemon route builds the response **directly from that event's data** (`server.ts:354–365`), enriched from `planConfigs` (line 374) or filesystem `orchestration.yaml` (line 378). So the data the UI is waiting for is already in the event payload — the round-trip through the daemon is purely additive (legacy filesystem fallback).

In compile mode there is also no equivalent of expedition's `earlyOrchestration` (synthesized from `expedition:architecture:complete` in `handle-expedition.ts:14–58`). So compile-mode swim lanes have nothing to render with until the focus-revalidated SWR fetch eventually succeeds.

**Note on expedition mode:** `planning:complete` fires for expedition runs too (emitted at `packages/engine/src/pipeline/stages/compile-stages.ts:504`). `expedition:compile:complete` is in the reducer's `IGNORED_EVENT_TYPES` (`reducer/index.ts:198`), but `planning:complete` arrives at/after the same point and is the durable signal. So a single fix keyed on `planning:complete` covers both modes.

We want the fix to be event-driven — no new polling, no debounce/timer hacks, no new state library.

## Goal

Eliminate the post-`planning:complete` delay so swim-lane stages, depth bars, dependency tooltips, and dependency-graph edges render immediately when the planner completes — using a purely event-driven solution that mirrors patterns already in the codebase.

## Approach

Two complementary, event-driven fixes that mirror patterns already in the codebase.

### 1. Synthesize `earlyOrchestration` from `planning:complete`

The `planning:complete` event already carries everything we need:

```ts
// packages/client/src/events.ts:135–146, 302
type planning:complete = { type: 'planning:complete'; plans: PlanFile[]; planConfigs?: ... }
interface PlanFile { id; name; dependsOn: string[]; ... }
```

Update `handlePlanningComplete` in `packages/monitor-ui/src/lib/reducer/handle-planning.ts` to also populate `earlyOrchestration` (mode `'compile'`) with:

- `plans[]` mapped from `event.plans` → `{ id, name, dependsOn, branch: '', build: planConfigs[id]?.build ?? [], review: planConfigs[id]?.review ?? <stub> }`
- The same stub `pipeline`/empty fields used by `handleExpeditionArchitectureComplete` (`packages/monitor-ui/src/lib/reducer/handle-expedition.ts:20–51`)

Effects of this single change (because `effectiveOrchestration = orchestration ?? runState.earlyOrchestration` already exists at `app.tsx:161–164`):

- `ThreadPipeline` immediately gets `dependsByPlan` and `depthMap` (`thread-pipeline.tsx:38–55`) → dependency edges + depth bars render.
- `ThreadPipeline.buildStagesByPlan` (`thread-pipeline.tsx:84–94`) is populated when `planConfigs` is present → build-stage cells render.
- The dependency graph tab becomes available (`hasDependencyEdges` in `app.tsx:166`) without waiting for HTTP.

Do **not** broaden the synthesis to fields we don't have on the event (e.g. `pipeline.compile` ordering, `validate` commands). Those still come from the real orchestration fetch and remain a hydration step.

### 2. Revalidate orchestration on `planning:complete` (and `expedition:compile:complete`)

In `packages/monitor-ui/src/hooks/use-eforge-events.ts`, extend `invalidateOnEvent` so that when a new orchestration.yaml has just been written, we trigger SWR to refetch the real config:

- Pass `sessionId` to `invalidateOnEvent` (or inline the mutate at the call site at line 137).
- For `planning:complete` and `expedition:compile:complete`, call `void mutate(buildPath(API_ROUTES.orchestration, { runId: sessionId }))`.

This replaces the existing reliance on `revalidateOnFocus`. SWR's `mutate(key)` forces revalidation even if the previous fetch errored. The synthesized `earlyOrchestration` covers the in-flight window; the fetched value then takes precedence per the existing `??` fallback.

### Why this is clean

- Pure event-driven; no polling, no timers, no debouncing.
- Symmetry: compile mode now mirrors expedition mode for `earlyOrchestration` — same shape, same fallback path, no new code paths.
- The SWR HTTP fetch becomes a hydration of richer fields, not a critical render dependency.
- No new dependencies; no changes to subscription transport.

### Files to modify

- `packages/monitor-ui/src/lib/reducer/handle-planning.ts` — synthesize `earlyOrchestration` from `event.plans` (+ `event.planConfigs` if present). Mirror the shape used in `handle-expedition.ts:20–51`.
- `packages/monitor-ui/src/lib/reducer.ts` and/or `packages/monitor-ui/src/lib/reducer/index.ts` — confirm `earlyOrchestration` is in the partial-state delta type for `handlePlanningComplete` (it already is — see `regression.test.ts:198`).
- `packages/monitor-ui/src/hooks/use-eforge-events.ts` — extend `invalidateOnEvent` to mutate the orchestration key for `planning:complete` and `expedition:compile:complete`. Threading `sessionId` through is the simplest plumbing change.
- `packages/monitor-ui/src/lib/reducer/__tests__/handle-planning.test.ts` (already created during validation; extend) — flip the Test A assertions: `delta.earlyOrchestration` is no longer null; carries `mode: 'compile'`, plans with `dependsOn`, and `build`/`review` from `planConfigs` when present.
- `packages/monitor-ui/src/lib/reducer/__tests__/regression-orchestration-gap.test.ts` (already created during validation) — the "DESIRED" assertion will start passing post-fix; the "TODAY" assertion will need to be inverted or removed.
- `packages/monitor-ui/src/lib/reducer/__tests__/regression.test.ts:152` — `expect(state.earlyOrchestration).toBeNull()` will need to be replaced with assertions on the synthesized shape (the fixture contains `planning:complete` with dependsOn).
- `packages/monitor-ui/src/components/pipeline/__tests__/orchestration-dependency.test.ts` (already created during validation) — Tests B and C remain correct; they exercise the consumer-side derivation regardless of how earlyOrchestration is populated.

### Reuse / patterns to follow

- `packages/monitor-ui/src/lib/reducer/handle-expedition.ts:14–58` — existing `earlyOrchestration` synthesis. Lift the same shape; the only difference is `mode: 'compile'` and source data (`event.plans` instead of `event.modules`).
- `packages/monitor-ui/src/hooks/use-eforge-events.ts:20–42` — existing `invalidateOnEvent` switch. Just add cases.
- `packages/client/src/api-routes` — `API_ROUTES.orchestration` and `buildPath` are already imported in `use-eforge-events.ts` (line 5).

## Scope

### In scope

- Synthesize `earlyOrchestration` (mode `'compile'`) from `planning:complete` in `handlePlanningComplete`, mirroring the shape used by `handleExpeditionArchitectureComplete`.
- Extend `invalidateOnEvent` in `use-eforge-events.ts` to call `mutate(buildPath(API_ROUTES.orchestration, { runId: sessionId }))` on `planning:complete` and `expedition:compile:complete`. Plumb `sessionId` through as needed.
- Update / extend reducer and component tests as described in the Tests section below.

### Out of scope (intentionally)

- Removing `revalidateOnFocus` — leave SWR defaults alone. Event-driven mutate makes focus revalidation redundant but harmless.
- Reworking `dedupingInterval` or `errorRetryInterval` — not the bottleneck once mutate is event-driven.
- Touching `subscribeToSession` / SSE transport — unaffected.
- Rendering build-stage cells without a real `build[]` — we accept that until orchestration arrives, cells use whatever `planConfigs` provided (often empty for compile mode); this matches today's expedition behavior and is the cleanest degradation.
- Broadening the synthesis to fields we don't have on the event (e.g. `pipeline.compile` ordering, `validate` commands). Those still come from the real orchestration fetch and remain a hydration step.
- SWR retry-timing tests — not needed because the daemon route returns `200 + null`, not an error. `errorRetryInterval` never fires for this fetch.
- Daemon-route tests — route behavior already verified by reading; adding a test would not change confidence.
- `8945630` regression risk — verified by reading the diff; only import-path changes in `monitor-ui/src/`. No behavior change.

## Acceptance Criteria

### Validation results (already gathered, must remain consistent)

Three test files were written and run against the unmodified codebase to validate the hypothesis. **Outcome: all assumptions confirmed.**

Test files (committed alongside this plan; the suite is green so the in-flight queue-scheduler build's post-merge validation will not be affected):
- `packages/monitor-ui/src/lib/reducer/__tests__/handle-planning.test.ts` (Test A)
- `packages/monitor-ui/src/components/pipeline/__tests__/orchestration-dependency.test.ts` (Tests B + C + equivalence)
- `packages/monitor-ui/src/lib/reducer/__tests__/regression-orchestration-gap.test.ts` (Test E)

Suite status: **148 files / 2306 tests pass, 1 todo, 0 failed.** Type-check clean. The forward-looking "DESIRED post-fix" assertion is parked as `it.todo(...)` with a comment pointing the implementor at the contract to fill in. The eforge build that lands the fix should convert the todo into a real `it(...)` block asserting:
- `effectiveOrchestration` is non-null after replaying a compile-mode fixture with `state.orchestration === null`
- `effectiveOrchestration.plans.length === 2`
- `plans[0].dependsOn === []`, `plans[1].dependsOn === ['plan-01']`

| Assumption | Test | Result |
|---|---|---|
| `planning:complete` carries dependsOn data | A.event-payload, E.fixture-sanity | ✅ confirmed (`event.plans[1].dependsOn === ['plan-01']`) |
| Reducer drops dependsOn (root cause for compile mode) | A.handler-no-earlyOrchestration | ✅ confirmed (`delta.earlyOrchestration` is null/undefined) |
| `state.earlyOrchestration` is null after `planning:complete` | A.unreachable-downstream | ✅ confirmed |
| Null orchestration ⇒ empty depth map (symptom 1) | B.computeDepthMap-empty | ✅ confirmed |
| Synthesized earlyOrchestration ⇒ correct depths | B.synthesized-depths | ✅ confirmed (0 / 1 / 2 for 3-plan chain) |
| Null orchestration ⇒ no graph edges (symptom 2) | C.computeGraphLayout-empty | ✅ confirmed |
| Synthesized earlyOrchestration ⇒ correct edges | C.synthesized-edges | ✅ confirmed (`plan-01→plan-02`, `plan-02→plan-03`) |
| Synthesized shape matches what daemon returns from same event | equivalence test | ✅ confirmed |
| End-to-end: replaying compile fixture leaves effectiveOrchestration null | E.TODAY | ✅ confirmed (captures user-visible bug) |
| Post-fix: effectiveOrchestration populated immediately from event | E.DESIRED | 🅣 parked as `it.todo()` so the suite stays green; implementor converts to a real assertion as part of the fix |

**What this proves:**
- Symptoms 1 and 2 share a single root cause (null `effectiveOrchestration` during the planning→fetch window).
- The data the UI needs is already in the `planning:complete` event payload — synthesizing `earlyOrchestration` from the event closes the gap without any HTTP round-trip.
- The proposed synthesizer's output (shape, dependsOn, plan IDs) is equivalent to what the daemon returns from the same event.

**What this does not prove (acknowledged limits):**
- That symptom 2 is *only* about edges and not also about graph layout positioning under specific dependency shapes. Layout output was checked in `computeGraphLayout` but not visually.
- That `mutate()` on `planning:complete` actually triggers a refetch through SWR (Test D was deferred — it requires the fix to exist before it can be exercised meaningfully; it will be added alongside the implementation).

### Tests (assumption validation + regression coverage)

The following tests are designed both to catch the regression and to validate the hypothesis. Each is annotated with what it confirms or invalidates.

#### A. Reducer test — confirms the gap exists in compile mode
`packages/monitor-ui/src/lib/reducer/__tests__/handle-planning.test.ts` (extend or add):

- Feed today's reducer a sequence ending in `planning:complete` with `plans: [{ id: 'a', dependsOn: [] }, { id: 'b', dependsOn: ['a'] }]` and no `planConfigs`.
- Assert today: `state.earlyOrchestration === null` and `state.planStatuses === { a: 'plan', b: 'plan' }`. **Fails to capture user-visible state — proves the gap.**
- After the fix: `state.earlyOrchestration.plans[0].dependsOn === []`, `state.earlyOrchestration.plans[1].dependsOn === ['a']`, `mode === 'compile'`, `plans[].build === []` when `planConfigs` absent.
- Variant with `planConfigs` provided: assert `plans[].build` and `plans[].review` come from `planConfigs`.

**Confirms:** synthesis logic produces correct earlyOrchestration shape.
**Invalidates if it fails after the fix:** synthesis is wrong or partial.

#### B. Component render test — isolates whether `orchestration={null}` reproduces symptom 1
`packages/monitor-ui/src/components/pipeline/__tests__/thread-pipeline.test.tsx` (new):

- Render `<ThreadPipeline>` with realistic `agentThreads` + `planStatuses` and `orchestration={null}`. Assert: rows render (existing behavior post-`fb5cadf`), `BuildStageProgress` cells are absent, `DepthBars` show `depth=0`, and dependency tooltip text contains only the plan ID.
- Re-render with a synthesized `earlyOrchestration` object (built inline). Assert the inverse: build cells render for `plans[].build`, depth bars reflect dependency depth, tooltip contains `Depends on: …`.

**Confirms:** `orchestration={null}` is sufficient to reproduce the symptom.
**Invalidates if rendering still misses stages with non-null orchestration:** there is a second bug elsewhere (likely in `BuildStageProgress` or `computeDepthMap`).

#### C. Component render test — confirms symptom 2 shares the same cause
`packages/monitor-ui/src/components/graph/__tests__/dependency-graph.test.tsx` (new, parallel to B):

- Render `<DependencyGraph>` with `orchestration={null}` → assert no edges.
- Render with synthesized `earlyOrchestration` containing `dependsOn` → assert expected edges.

**Confirms:** symptom 2 is downstream of the same orchestration-null state.
**Invalidates if edges still missing with non-null orchestration:** symptom 2 is a separate bug in `DependencyGraph`.

#### D. Hook integration test — confirms the SWR mutate path triggers a refetch
`packages/monitor-ui/src/hooks/__tests__/use-eforge-events.test.ts` (new or extend):

- Mock `subscribeToSession` to inject a synthetic `planning:complete` event.
- Spy on `mutate` from `swr`. Assert it is called with `buildPath(API_ROUTES.orchestration, { runId: sessionId })` after the event is dispatched.

**Confirms:** the event-driven revalidation is wired correctly.
**Invalidates if mutate is not called:** plumbing of `sessionId` into `invalidateOnEvent` is incorrect.

#### E. End-to-end regression test — captures the full user-visible scenario
`packages/monitor-ui/src/lib/reducer/__tests__/regression.test.ts` (extend):

- Build a fixture replaying compile-mode events through `planning:complete` (mirror `fixtures/sample-build.json`).
- Compute `effectiveOrchestration = state.orchestration ?? state.earlyOrchestration` (mock `orchestration === null` since the SWR layer isn't engaged in this test).
- Assert today: `effectiveOrchestration === null`. **Captures the user-visible failure.**
- Assert after fix: `effectiveOrchestration.plans` matches the event payload's `plans`, dependsOn included.

**Confirms:** the user-visible symptom is reproduced and fixed by these changes.
**Invalidates if the test passes today (without the fix):** the bug isn't where I think it is — re-investigate.

#### F. Out-of-scope (not added)
- SWR retry-timing tests: not needed because the daemon route returns `200 + null`, not an error. `errorRetryInterval` never fires for this fetch.
- Daemon-route tests: route behavior already verified by reading; adding a test would not change confidence.
- `8945630` regression risk: verified by reading the diff — only import-path changes in `monitor-ui/src/`. No behavior change.

### Verification

End-to-end manual test (the regression is timing-sensitive, so a real run is more diagnostic than unit tests alone):

1. `pnpm build` and start the daemon (`mcp__plugin_eforge_eforge__eforge_daemon`).
2. Enqueue a small compile-mode build (any PRD with 2+ plans that depend on each other). Open the monitor UI **before** the planner completes.
3. Observe: as soon as `planning:complete` fires, swim lanes show their depth bars, dependency tooltips ("Depends on: …"), and (if `planConfigs` is in the event) the build-stage cells. The graph tab becomes enabled.
4. Confirm `effectiveOrchestration` switches from `earlyOrchestration` to the fetched `orchestration` shortly after — verify by checking that `validate` commands appear in the timeline (they only come from the fetched config).
5. Repeat for an expedition build — behavior must remain unchanged from today.

Unit tests:

- `pnpm test --filter monitor-ui handle-planning` — assert `earlyOrchestration` shape after `planning:complete`.
- `pnpm test --filter monitor-ui regression` — keep existing fixtures green; add the no-fetch dependency-edge case.
- `pnpm type-check` — `earlyOrchestration` partial-state typing is already wired; verify no breakage.
