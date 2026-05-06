---
id: plan-02-orchestration-single-source
name: earlyOrchestration as the sole orchestration source
branch: monitor-ui-cleaner-event-consumption-architecture/orchestration-single-source
agents:
  builder:
    effort: medium
    rationale: Mostly deletion + simplification across server, client, and UI; the
      cross-package route removal needs care to delete every consumer.
---

---
id: plan-02-orchestration-single-source
name: earlyOrchestration as the sole orchestration source
depends_on: [plan-01-auto-build-slice]
branch: monitor-ui-cleaner-event-consumption-architecture/orchestration-single-source
---

# earlyOrchestration as the sole orchestration source

## Architecture Context

Today the monitor UI has two parallel sources of truth for orchestration: (1) the reducer-synthesized `earlyOrchestration` produced by `handlePlanningComplete` in `packages/monitor-ui/src/lib/reducer/handle-planning.ts:35-59` from the `planning:complete` event payload, and (2) an `OrchestrationConfig` fetched via SWR from `GET /api/orchestration/:runId` in `packages/monitor-ui/src/app.tsx:58-62`. The server-side endpoint at `packages/monitor/src/server.ts:369-429` (`serveOrchestration`) reads `events[0]` only — see line 382: `const data = JSON.parse(events[0].data);` — which is broken for sessions that emit multiple `planning:complete` events (e.g. expedition-mode, where compile-stages emits a fresh `planning:complete` after `expedition:compile:complete` per `packages/engine/src/pipeline/stages/compile-stages.ts:503-504`). `earlyOrchestration` papers over this bug today via the `effectiveOrchestration = orchestration ?? runState.earlyOrchestration` fallback in `app.tsx:161-164`.

Verification before committing this plan: `planning:complete` carries the full plan list with `dependsOn`, `branch`, and per-plan `build`/`review` (via the optional `planConfigs` array) for both modes:
- **Compile mode:** emitted by `packages/engine/src/agents/planner.ts:330-335` with `planConfigs` derived from `planSetPayload.orchestration.plans` (lines 322-328).
- **Expedition mode:** emitted by `packages/engine/src/pipeline/stages/compile-stages.ts:504` with `planConfigs` derived from the parsed orchestration.yaml (lines 495-501) — `expeditionPlanConfigs.map(p => ({ id, build, review }))`.

Both pathways therefore satisfy the PRD's Step 2 verification: `planning:complete` always carries the full plan list with `dependsOn` and per-plan `build`/`review` config.

This plan deletes the second source. After this plan, `effectiveOrchestration === earlyOrchestration` always, the `/api/orchestration/:runId` route is gone, and the SWR fetch + the `invalidateOnEvent` arms that drive it are deleted.

## Implementation

### Overview

1. Make `effectiveOrchestration = runState.earlyOrchestration` directly in `app.tsx`. Delete the `useSWR<OrchestrationConfig>(...)` call at lines 58-62 and the `orchestration` const at line 62. The `isCompilePhase = orchestration === null` predicate at line 174 must be reframed — replace it with `isCompilePhase = runState.earlyOrchestration === null` *after* the architecture has been compiled (use `runState.expeditionModules.length > 0 && Object.values(runState.moduleStatuses).some(s => s !== 'complete')` as the compile-phase predicate, or derive from the existing `expedition:compile:complete` event presence in `runState.events`). The simpler heuristic: `isCompilePhase = runState.expeditionModules.length > 0 && !runState.events.some(e => e.event.type === 'expedition:compile:complete')`.
2. Delete the `serveOrchestration` function and its route handler arm in `packages/monitor/src/server.ts` (function at lines 369-429; arm at lines 2328-2335; constants `ORCHESTRATION_BASE` at line 28). Also delete `enrichOrchestrationWithPlanConfigs` (lines 83-95) and `readBuildConfigFromOrchestration` (search the file for the helper) along with their imports if they have no other call sites.
3. Remove `orchestration: '/api/orchestration/:runId'` from `API_ROUTES` in `packages/client/src/routes.ts:121` and the `OrchestrationResponse` interface at `packages/client/src/types.ts:82-93`.
4. Delete `apiGetOrchestration` from `packages/client/src/api/queue.ts:88-94` and remove its export from `packages/client/src/index.ts:27`.
5. In `packages/monitor-ui/src/hooks/use-eforge-events.ts`, delete the `case 'planning:complete'` and `case 'expedition:compile:complete'` arms in `invalidateOnEvent` (lines 39-44). The function continues to exist (deleted entirely in plan-03), but its orchestration arms become unreachable here.
6. Delete `test/orchestration-logic.test.ts` lines 796-859 (the `enrichOrchestrationWithPlanConfigs` describe block) — the function no longer exists. If the rest of the file is empty, leave a stub describe with a `it.skip` placeholder, or delete the file if it only contained these tests. Inspect first.
7. Update `packages/monitor-ui/src/hooks/__tests__/use-eforge-events.test.ts` — the four tests at lines 33-103 assert behavior on the `planning:complete`/`expedition:compile:complete` arms of `invalidateOnEvent`. Delete the two positive tests (lines 33-67) and update the two negative tests (lines 69-103) to assert that *no* `mutate(...)` call is made when those events fire (since the arms are now removed). The orchestration-path assertions become orphan and should be removed.
8. Update `packages/monitor-ui/src/hooks/README.md` to remove any mention of the orchestration SWR fetch.

### Key Decisions

1. **`isCompilePhase` predicate.** Today the predicate uses `orchestration === null` (the SWR result was null until the server returned data, then the reducer's compile-phase rendering switched off). With `earlyOrchestration` synthesized as soon as `planning:complete` arrives — which in expedition mode is *after* `expedition:compile:complete` — the new predicate must check whether the expedition has finished compiling. Using `runState.events.some(e => e.event.type === 'expedition:compile:complete')` (or equivalently `runState.earlyOrchestration && runState.expeditionModules.length === 0` for compile-mode) gives the same UX: animated blue "in-flight" module nodes during the compile phase, then static plan nodes once the orchestration is concrete. Compile-mode (no expedition) flips `isCompilePhase = false` immediately on `planning:complete` because `expeditionModules` is empty — this matches today's behavior.
2. **Keep `OrchestrationConfig` type.** The type is still used by `runState.earlyOrchestration` and by every component that reads `effectiveOrchestration`. Only the `OrchestrationResponse` *wire* type is deleted (it was used solely by the SWR fetch).

## Scope

### In Scope
- Delete `/api/orchestration/:runId` route, handler, constants, and helper functions in `packages/monitor/src/server.ts`.
- Delete `OrchestrationResponse` from `packages/client/src/types.ts` and `orchestration` from `API_ROUTES` in `packages/client/src/routes.ts`.
- Delete `apiGetOrchestration` from `packages/client/src/api/queue.ts` and its re-export in `packages/client/src/index.ts`.
- Delete the `useSWR<OrchestrationConfig>(...)` block in `app.tsx`; make `effectiveOrchestration = runState.earlyOrchestration` directly.
- Replace `isCompilePhase` predicate with one that does not depend on the deleted SWR fetch.
- Remove `planning:complete` and `expedition:compile:complete` arms from `invalidateOnEvent`.
- Update / remove the existing tests that exercise the deleted code (`test/orchestration-logic.test.ts` block + monitor-ui `__tests__/use-eforge-events.test.ts`).
- doc-sync to update `packages/monitor-ui/src/hooks/README.md` and any AGENTS.md / engineering-notes that mention the deleted endpoint.

### Out of Scope
- Deleting `invalidateOnEvent` entirely (plan-03).
- Daemon-side event stream changes (plan-04).
- The `OrchestrationConfig` type itself (kept; still used by reducer + UI components).

## Files

### Modify
- `packages/monitor/src/server.ts` — delete `serveOrchestration`, `ORCHESTRATION_BASE`, the route arm `else if (url.startsWith(\`${ORCHESTRATION_BASE}/\`))`, `enrichOrchestrationWithPlanConfigs`, and `readBuildConfigFromOrchestration` (verify no other callers first).
- `packages/client/src/routes.ts` — remove `orchestration: '/api/orchestration/:runId'` from `API_ROUTES`.
- `packages/client/src/types.ts` — remove `OrchestrationResponse` interface (lines 82-93).
- `packages/client/src/api/queue.ts` — remove `apiGetOrchestration` (lines 88-94) and remove `OrchestrationResponse` from the type imports.
- `packages/client/src/index.ts` — remove the `apiGetOrchestration` re-export at line 27 and any `OrchestrationResponse` re-export.
- `packages/monitor-ui/src/app.tsx` — delete lines 58-62 (orchestration SWR), simplify `effectiveOrchestration` (lines 161-164) to `runState.earlyOrchestration`, replace `isCompilePhase` predicate at line 174.
- `packages/monitor-ui/src/hooks/use-eforge-events.ts` — delete `case 'planning:complete'` and `case 'expedition:compile:complete'` arms (lines 39-44) and the `buildPath` import if no longer needed (still used for runState path — keep).
- `packages/monitor-ui/src/hooks/__tests__/use-eforge-events.test.ts` — delete tests for deleted arms (positive cases at 33-67), update negative tests to assert no orchestration mutate calls.
- `test/orchestration-logic.test.ts` — delete the `enrichOrchestrationWithPlanConfigs` describe block (lines 796-859); if the file becomes empty, delete it.
- `packages/monitor-ui/src/hooks/README.md` — remove any reference to the orchestration SWR endpoint.

## Verification

- [ ] `grep -rn '/api/orchestration\|API_ROUTES.orchestration\|apiGetOrchestration\|OrchestrationResponse\|serveOrchestration\|enrichOrchestrationWithPlanConfigs' packages/ test/` returns zero matches.
- [ ] `pnpm type-check` passes (no broken imports of removed exports).
- [ ] `pnpm test` passes; the deleted `enrichOrchestrationWithPlanConfigs` tests are gone and the modified `use-eforge-events.test.ts` only asserts that `phase:start`/`session:end`/`enqueue:complete`/`plan:build:*` arms still mutate the appropriate caches.
- [ ] In `app.tsx`, `grep -n 'useSWR' app.tsx` shows `projectContext` and `latestRun` only (orchestration is gone). `latestRun` removal is plan-05.
- [ ] Manually trace `effectiveOrchestration` in `app.tsx`: it now resolves to `runState.earlyOrchestration` unconditionally; no SWR-fetched data is involved.
- [ ] In an expedition-mode run, the dependency graph populates after `planning:complete` (which is emitted post-`expedition:compile:complete` per `compile-stages.ts:503-504`) — confirms the PRD's Step 2 verification holds.
