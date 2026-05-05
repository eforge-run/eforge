---
id: plan-01-synthesize-and-revalidate-orchestration
name: Synthesize earlyOrchestration on planning:complete and event-driven SWR
  revalidation
branch: monitor-ui-fix-delayed-swim-lane-stages-and-missing-dependency-edges/synthesize-and-revalidate-orchestration
agents:
  builder:
    effort: high
    rationale: Two coupled changes across reducer + hook + four test files. The hook
      test (Test D) is new and requires careful mock plumbing for swr's mutate
      plus subscribeToSession. Higher effort prevents under-specifying the mock
      surface.
  reviewer:
    effort: high
    rationale: The fix shape (compile-mode synthesizer + invalidateOnEvent
      extension) must match the expedition-mode pattern in handle-expedition.ts
      byte-for-byte where applicable. Reviewer needs to verify shape symmetry,
      that earlyOrchestration is consumed correctly via app.tsx's `??` fallback,
      and that planConfigs handling matches the daemon route.
---

# Synthesize earlyOrchestration on planning:complete and event-driven SWR revalidation

## Architecture Context

Since the SWR migration (`826aa60`), the monitor UI fetches the orchestration config once per session change with no refresh interval and no event-driven revalidation. The daemon route `/api/orchestration/:id` returns `200 + null` (not 404) when no `planning:complete` event has been logged yet, so SWR caches `null` until `revalidateOnFocus` eventually fires - this produces the user-visible "new swim lanes don't render their stages until quite a while after the first events arrive" symptom.

Expedition mode already has the right pattern: `handleExpeditionArchitectureComplete` synthesizes `earlyOrchestration` from `expedition:architecture:complete` so the UI can render the plan graph before orchestration.yaml exists on disk. Compile mode has no equivalent - this plan adds it.

The consumer-side code is already wired:
- `app.tsx:161-164` resolves `effectiveOrchestration = orchestration ?? runState.earlyOrchestration`
- `ThreadPipeline` and `useGraphLayout` derive depth bars, dependency tooltips, build-stage cells, and graph edges from `effectiveOrchestration.plans[].dependsOn` / `build`
- The reducer's `Partial<RunState>` delta type already permits `earlyOrchestration` (verified by the existing `regression.test.ts:198` assertion)

So the only changes needed are: (1) populate the field on `planning:complete`, and (2) revalidate the SWR cache key when the daemon now has fresher data.

## Implementation

### Overview

Two complementary, event-driven changes plus targeted test updates.

**Change 1 — Compile-mode `earlyOrchestration` synthesis (`handle-planning.ts`):**

Extend `handlePlanningComplete` to also return `earlyOrchestration`. Mirror the shape produced by `handleExpeditionArchitectureComplete` exactly, with these substitutions:
- `mode: 'compile'` (not `'expedition'`)
- `pipeline.scope: 'plan'` (not `'expedition'`) - matches what the orchestration-dependency component test already validates as the equivalent shape
- `plans` mapped from `event.plans` (not `event.modules`)
- For each plan: `id`, `name`, `dependsOn`, `branch` come from the event's `PlanFile` entry
- `build` and `review` come from `event.planConfigs[id]` when present, otherwise defaults: `build: []`, `review: { strategy: 'auto', perspectives: [], maxRounds: 1, evaluatorStrictness: 'standard' }`

Keep the existing `planStatuses` seeding behavior. Return both fields in the same delta.

**Change 2 — Event-driven SWR revalidation (`use-eforge-events.ts`):**

Extend `invalidateOnEvent` to mutate the orchestration cache key when a new orchestration.yaml is durably available. The simplest plumbing: thread `sessionId` into `invalidateOnEvent` via a parameter. Call sites are inside the same hook so the change is local.

New cases:
- `planning:complete` → `void mutate(buildPath(API_ROUTES.orchestration, { runId: sessionId }))`
- `expedition:compile:complete` → same call (covers expedition mode where the real orchestration arrives later than `expedition:architecture:complete`)

Only call mutate when `sessionId` is non-null. Existing cases (`phase:start`, `session:end`, etc.) remain unchanged.

**Change 3 — Test updates (4 files, 1 new):**

- `handle-planning.test.ts` - flip the Test A "TODAY" assertions from `null/undefined` to assertions on the synthesized shape: `delta.earlyOrchestration.mode === 'compile'`, `plans[1].dependsOn === ['plan-01']`, `plans[].build === []` when `planConfigs` absent. Add a variant test that supplies `planConfigs` and asserts `plans[].build` and `plans[].review` propagate from it.
- `regression-orchestration-gap.test.ts` - convert the `it.todo('DESIRED: ...')` at the bottom into a real `it(...)` asserting `effectiveOrchestration.plans.length === 2`, `plans[0].dependsOn === []`, `plans[1].dependsOn === ['plan-01']`. Either delete the now-stale "TODAY: leaves effectiveOrchestration null" assertion or invert it; the cleanest path is deletion since the post-fix assertion fully replaces it.
- `regression.test.ts:152` - replace `expect(state.earlyOrchestration).toBeNull()` with assertions on the synthesized shape (the fixture's `planning:complete` event has `plans[1].dependsOn === ['plan-01']`). The line 198 `expect(batchState.earlyOrchestration).toEqual(addEventState.earlyOrchestration)` continues to work because both code paths run the same handler.
- `use-eforge-events.test.ts` (new) - Test D from the validation plan. Mock `subscribeToSession` to inject a synthetic `planning:complete` event. Spy on `mutate` from `swr`. Assert `mutate` is called with the orchestration path built from the test's session id. Mock the initial `fetch(/api/run-state/...)` to return `{ status: 'running', events: [] }` so the hook proceeds past the snapshot phase. Use `vi.mock('swr', ...)` to capture the mutate spy.

### Key Decisions

1. **Synthesizer mirrors expedition shape, with `mode: 'compile'` and `pipeline.scope: 'plan'`** - the existing equivalence test in `orchestration-dependency.test.ts:33-65` already declares this exact shape and proves it produces correct `computeDepthMap` and `computeGraphLayout` output. Re-using that shape avoids divergence.

2. **`planConfigs` handling matches the daemon route** - `packages/monitor/src/server.ts:354-374` builds the response by enriching `event.plans` with `planConfigs[id]` when present. The synthesizer applies the same enrichment, so `effectiveOrchestration` does not change shape when SWR eventually replaces it. Fields the event does not carry (`pipeline.compile`, `validate` commands) remain empty/default and are filled in by the SWR-fetched value.

3. **`invalidateOnEvent` gets `sessionId` as a parameter (not a closed-over ref)** - the function is currently a top-level helper with no React state. Threading the parameter through the single call site at line 137 is the minimal change. No new module-level state, no refs, no risk of stale closures.

4. **Both `planning:complete` and `expedition:compile:complete` trigger mutate** - in expedition mode `expedition:architecture:complete` populates `earlyOrchestration` with module-shaped data, but the real per-plan orchestration only exists after compile finishes. Mutating on `expedition:compile:complete` ensures the SWR cache picks up the freshly-written orchestration.yaml. (`planning:complete` also fires for expedition runs per `compile-stages.ts:504`, so it covers the expedition mid-compile window too; both events are kept for symmetry and durability.)

5. **Do not remove `revalidateOnFocus`** - leaving SWR defaults alone means the event-driven mutate is additive. Out of scope per PRD.

6. **Do not synthesize `pipeline.compile` ordering or `validate` commands** - those are not in the event payload. They arrive with the SWR fetch and remain a hydration step. Out of scope per PRD.

## Scope

### In Scope
- Synthesize `earlyOrchestration` (mode `'compile'`) from `planning:complete` in `handlePlanningComplete`, mirroring the shape used by `handleExpeditionArchitectureComplete`
- Honor `event.planConfigs` when present so synthesized `plans[].build` and `plans[].review` match what the daemon route returns from the same event
- Extend `invalidateOnEvent` in `use-eforge-events.ts` to `mutate(buildPath(API_ROUTES.orchestration, { runId: sessionId }))` on `planning:complete` and `expedition:compile:complete`
- Plumb `sessionId` through `invalidateOnEvent` via a function parameter
- Update `handle-planning.test.ts` Test A assertions to validate the synthesized shape (new) + add a `planConfigs`-supplied variant
- Convert `regression-orchestration-gap.test.ts`'s `it.todo` into a real `it(...)` asserting the post-fix shape, and remove or invert the now-stale "TODAY: null" assertion
- Replace `regression.test.ts:152` `toBeNull` with assertions on the synthesized shape consistent with the fixture's `planning:complete` payload
- Add `packages/monitor-ui/src/hooks/__tests__/use-eforge-events.test.ts` covering Test D: SSE event triggers SWR `mutate` with the correct orchestration path

### Out of Scope
- Removing `revalidateOnFocus` from the SWR config (SWR defaults stay; event-driven mutate is additive)
- Reworking `dedupingInterval` or `errorRetryInterval`
- Touching `subscribeToSession` or SSE transport
- Synthesizing `pipeline.compile` ordering or `validate` commands (not in event payload)
- Daemon-route tests (route behavior already verified by reading)
- SWR retry-timing tests (daemon returns `200 + null`, not an error - retry path never engages)

## Files

### Create
- `packages/monitor-ui/src/hooks/__tests__/use-eforge-events.test.ts` — Test D: mock `subscribeToSession` and `swr`'s `mutate`, dispatch a synthetic `planning:complete` event, assert `mutate` was called with `buildPath(API_ROUTES.orchestration, { runId: sessionId })`. Add a parallel case for `expedition:compile:complete`.

### Modify
- `packages/monitor-ui/src/lib/reducer/handle-planning.ts` — extend `handlePlanningComplete` to return `{ planStatuses, earlyOrchestration }`. Synthesize `earlyOrchestration` from `event.plans` (and `event.planConfigs` when present), mirroring the shape from `handleExpeditionArchitectureComplete` with `mode: 'compile'` and `pipeline.scope: 'plan'`.
- `packages/monitor-ui/src/hooks/use-eforge-events.ts` — change `invalidateOnEvent` signature to accept `sessionId: string | null`. Add cases for `planning:complete` and `expedition:compile:complete` that call `void mutate(buildPath(API_ROUTES.orchestration, { runId: sessionId }))` when `sessionId` is non-null. Update the call site at line 137 to pass `sessionId`.
- `packages/monitor-ui/src/lib/reducer/__tests__/handle-planning.test.ts` — flip Test A "TODAY" assertions to the post-fix shape; add a variant test feeding `planConfigs` and asserting `build`/`review` propagate from it; keep the `planStatuses` seeding test intact.
- `packages/monitor-ui/src/lib/reducer/__tests__/regression-orchestration-gap.test.ts` — convert the `it.todo('DESIRED: ...')` block into a real `it(...)` asserting `effectiveOrchestration` is non-null with `plans.length === 2` and the expected `dependsOn` chain; delete the obsolete "TODAY: leaves effectiveOrchestration null" assertion (the new test fully supersedes it).
- `packages/monitor-ui/src/lib/reducer/__tests__/regression.test.ts` — replace line 152's `expect(state.earlyOrchestration).toBeNull()` with assertions matching the fixture's `planning:complete` payload (mode `'compile'`, two plans, `plans[1].dependsOn === ['plan-01']`). Line 198 (`batchState.earlyOrchestration` equals `addEventState.earlyOrchestration`) requires no change because both code paths share the same handler.

## Verification

- [ ] `pnpm type-check` exits 0 with no new errors. The `RunState` partial-state delta type already permits `earlyOrchestration`, so adding it to the `handlePlanningComplete` return value compiles without further plumbing.
- [ ] `pnpm test --filter @eforge-build/monitor-ui` passes including the converted `regression-orchestration-gap.test.ts` (no remaining `.todo`), the updated Test A in `handle-planning.test.ts`, the updated line 152 in `regression.test.ts`, and the new `use-eforge-events.test.ts`.
- [ ] `pnpm test` passes across the workspace with no new failures attributable to this change.
- [ ] `git grep -n 'earlyOrchestration).toBeNull()' packages/monitor-ui/src/lib/reducer/__tests__/regression.test.ts` returns no results (the assertion at line 152 is replaced).
- [ ] `git grep -n 'it.todo' packages/monitor-ui/src/lib/reducer/__tests__/regression-orchestration-gap.test.ts` returns no results (the todo is converted).
- [ ] In `handle-planning.ts`, the synthesized `earlyOrchestration.mode === 'compile'` and `pipeline.scope === 'plan'` (greppable string literals).
- [ ] In `use-eforge-events.ts`, `invalidateOnEvent` accepts a `sessionId` parameter, contains a case for `'planning:complete'`, and contains a case for `'expedition:compile:complete'` (greppable).
- [ ] In `use-eforge-events.test.ts`, the test asserts `mutate` was invoked with a path string containing `/api/orchestration` and the test's session id. The mock for `subscribeToSession` injects a `planning:complete` event with at least one plan whose `dependsOn` is non-empty.
- [ ] After the fix lands, replaying the existing `fixtures/sample-build.json` through the reducer yields `state.earlyOrchestration.plans.length === 2` with `plans[1].dependsOn === ['plan-01']` (asserted in the updated `regression.test.ts`).
