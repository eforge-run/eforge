---
id: plan-01-reducer-decomposition
name: Reducer decomposition with typed handlers, selective allocation, and
  regression-fixture tests
branch: monitor-ui-tech-debt/reducer-decomposition
agents:
  builder:
    effort: xhigh
    rationale: Load-bearing invariants in agent-thread matching, live-usage
      delta-vs-final replacement, expedition early-orchestration synthesis, and
      stage-advancement quirks must be preserved exactly. Decomposition into ~7
      handler files plus a compile-time exhaustiveness check plus a regression
      fixture is high-coordination work.
  reviewer:
    effort: high
    rationale: Behavior-preserving refactor — reviewer must verify each invariant
      survives the split, not just that the new code compiles.
  tester:
    effort: high
    rationale: Test suite is the safety net for a load-bearing refactor; tester must
      ensure every invariant listed in the acceptance criteria has explicit
      assertions.
---

---
id: plan-01-reducer-decomposition
name: Reducer decomposition with typed handlers, selective allocation, and regression-fixture tests
depends_on: []
branch: monitor-ui-tech-debt/reducer-decomposition
---

# Reducer decomposition with typed handlers, selective allocation, and regression-fixture tests

## Architecture Context

`packages/monitor-ui/src/lib/reducer.ts` is a 571-LOC monolith. Its `processEvent` function handles 20+ event variants as a flat sequence of `if (event.type === '...')` checks, manually narrowing each variant via `(event as { foo: string })` casts and `'foo' in event` guards even though `EforgeEvent` (`packages/engine/src/events.ts:146`) is already a discriminated union keyed on `type`. Every `ADD_EVENT` reducer call clones all 7 derived containers (`planStatuses`, `fileChanges`, `reviewIssues`, `agentThreads`, `moduleStatuses`, `mergeCommits`, `liveAgentUsage`) plus the `events` array — this is the upstream cause of the SSE re-render storm because downstream `React.memo` cannot see stable refs.

This plan converts `processEvent` into a flat handler registry keyed by exact `event.type`, organized for human readability into per-group files. Each handler narrows on `event.type` (no casts, no `'in' event` guards) and returns a `Partial<RunState> | undefined` delta describing only the slices it mutated. The reducer's `ADD_EVENT` case spreads only those slices, leaving unrelated containers as the same ref across events. A compile-time exhaustiveness check converts new engine event variants from runtime no-ops into TypeScript build errors. A regression-test fixture replays a captured SSE stream through the new reducer and asserts deep-equality with a snapshot of the pre-refactor reducer's final state — the binary safety gate that converts "behavior-preserving" from a vibe into a contract.

Key constraints from `AGENTS.md` and the source PRD:
- Engine emits, consumers render — `EforgeEvent` shapes are not modified.
- Public types from `lib/reducer.ts` (`RunState`, `initialRunState`, `RunAction`, `eforgeReducer`, `getSummaryStats`, `AgentThread`, `ModuleStatus`, `StoredEvent`) keep identical signatures so downstream consumers (`app.tsx`, all components) remain untouched.
- No mocks in tests; for SDK types use hand-crafted literals cast through `unknown` (existing pattern in `packages/monitor-ui/src/__tests__/api-routes-compliance.test.tsx` and `src/components/timeline/__tests__/event-card.test.tsx`).
- No backwards-compatibility shims — any transitional `_legacy.ts` reducer must be deleted before the plan is considered complete (per `feedback_no_backward_compat`).
- API-route hygiene is already enforced by `src/__tests__/api-routes-compliance.test.tsx`; introduce no new `/api/...` literals.

## Implementation

### Overview

1. Create `packages/monitor-ui/src/lib/reducer/` subfolder containing `handler-types.ts`, per-group handler files, and `index.ts` (the registry).
2. Move every `processEvent` branch into the appropriate per-group handler, narrowing on `event.type` to remove casts.
3. Define a flat `Record<EforgeEvent['type'], EventHandler<...>>` registry assembled from the per-group exports. Add an `IGNORED_EVENT_TYPES` tuple for variants the UI intentionally does not react to (e.g. `agent:message`, `agent:tool_use`, `agent:tool_result`, `agent:warning`, `agent:retry`).
4. Replace `ADD_EVENT` in `lib/reducer.ts` so it dispatches to the registry, spreads only the returned delta plus appends to `events`, and returns the same `state` ref when the delta is `undefined`.
5. Capture a real SSE event stream from a small live build, commit it as `__tests__/fixtures/sample-build.json`, and use it as the regression fixture.
6. Land the new reducer alongside a temporary `_legacy.ts` containing the current implementation, prove via `regression.test.ts` that both produce deep-equal `RunState`, then delete `_legacy.ts` in the same plan (no shims left behind).
7. Add per-handler unit tests covering the load-bearing invariants enumerated in the acceptance criteria.
8. Add a `test` and `test:watch` script to `packages/monitor-ui/package.json` if missing.

### Key Decisions

1. **Handler signature: `Partial<RunState> | undefined` delta.** Each handler receives the narrowed event plus a readonly state and returns only the slices it mutated. `undefined` signals "no state change" so the reducer can return the prior state ref unchanged. This is what makes downstream `React.memo` actually fire when an unrelated event arrives. Verbose container updates (e.g. `agent:usage` returning `{ liveAgentUsage: { ...state.liveAgentUsage, [agentId]: next }, agentThreads: state.agentThreads.map(...) }`) are contained via small private helpers (e.g. `updateThread(threads, predicate, patch)`) inside `handle-agent.ts`.

2. **Flat registry keyed by exact `event.type`.** A single `Record<EforgeEvent['type'], EventHandler<...>>` is assembled from the per-group exports. Per-group files exist for human file-organization only; dispatch is `O(1)` via a string lookup. Prefix-based dispatch (`if (event.type.startsWith('agent:'))`) was rejected because it loses TypeScript narrowing — the whole point of the refactor is to eliminate casts, and a string prefix can't produce `Extract<EforgeEvent, { type: 'agent:start' }>`.

3. **Compile-time exhaustiveness check.** A type-level `_Exhaustive` assertion fails the TypeScript build if any `EforgeEvent['type']` is neither in the registry keys nor in the explicit `IGNORED_EVENT_TYPES` tuple. New engine variants surface as build errors instead of silent runtime no-ops. The assertion encodes its expected shape via a `{ error: string; missing: ... }` branch so the failure mode is legible.

4. **Regression fixture is the binary safety gate.** A captured event stream (`__tests__/fixtures/sample-build.json`) is replayed through both the legacy reducer (kept temporarily as `_legacy.ts` during the implementation window) and the new reducer; the test asserts deep-equality on the resulting `RunState`. Once the test passes, the implementer inlines/snapshots the expected state into the test file (or commits an `expected.json` next to the fixture) and deletes `_legacy.ts` in the same plan.

5. **Fixture capture procedure for the implementer.** Run `pnpm --filter @eforge-build/monitor dev` (or start the daemon however local convention dictates), enqueue a small build, dump the per-session SSE stream from `/api/events?sessionId=<id>` (the daemon's existing route — no new routes), strip SSE framing, and write the resulting `[{ event, eventId }, ...]` array. Aim for 50–200 events covering planning → build → review → evaluate → merge so live agent-usage delta-vs-final replacement, agent-thread matching, and stage progression are all exercised authentically.

6. **No handler-level error handling.** Handlers do not try/catch. If a handler throws, it propagates to the reducer (matches today's behavior — the current reducer has no error handling). Adding an error boundary is out of scope.

7. **`_legacy.ts` is transitional only.** It exists strictly to enable the regression test during development. The plan does not ship with both reducers — `_legacy.ts` is deleted before the build is considered complete. The fixture stays as the canonical event-sequence asset.

## Scope

### In Scope

- Decompose `lib/reducer.ts:processEvent` into a per-group handler registry with no casts and no `'in' event` runtime guards.
- Selective state allocation in `ADD_EVENT` (spread only handler-returned slices).
- Compile-time exhaustiveness check via `IGNORED_EVENT_TYPES` and `_Exhaustive` type assertion.
- Per-handler unit tests covering load-bearing invariants:
  - `handle-agent.test.ts` — `agent:usage` non-final delta, `agent:usage` final replacement, `agent:result` reverse-walk thread matching, `agent:start` field population, `agent:stop` cleanup.
  - `handle-plan-build.test.ts` — stage-advancement quirks (doc-author parallel, doc-sync sequential, test-write doesn't advance, implement-complete doesn't advance, review-complete advances to evaluate, build-complete advances to complete, build-failed advances to failed), `reviewIssues` extraction, `fileChanges` Map updates, `mergeCommits` capture.
  - `handle-agent.test.ts` and `handle-plan-build.test.ts` cover the highest-risk invariants; the other handler tests cover the remaining variants.
  - `handle-session.test.ts` — `session:start` once-only `startTime`, `session:end` overrides, `phase:start` fallback.
  - `handle-expedition.test.ts` — `expedition:architecture:complete` synthesizes `earlyOrchestration` and seeds `moduleStatuses`; module lifecycle.
  - `handle-enqueue.test.ts` — `enqueue:start`, `enqueue:complete`, `enqueue:failed`, `enqueue:commit-failed`.
- End-to-end regression test (`regression.test.ts`) replaying a captured event sequence through the new reducer and asserting deep-equality with the snapshot of pre-refactor output.
- `test` and `test:watch` scripts added to `packages/monitor-ui/package.json` if not present (delegating to `vitest run` and `vitest`).
- Delete `_legacy.ts` in the same plan; no compat shims remain.

### Out of Scope

- Splitting `thread-pipeline.tsx`, `React.memo` on UI components, pipeline tests — owned by plan-02.
- Polling, shared cache, SWR / React-Query (PRD B territory).
- `EforgeEvent` shape changes in the engine (`packages/engine/src/events.ts` is read-only here).
- Adding a Zustand/Jotai/Redux store.
- Visual or behavioral changes outside the reducer.
- Fixing latent bugs uncovered by new tests — match current behavior; document discoveries in the PR description for a follow-up PRD (per source PRD R6).
- Changes to `packages/monitor/`, `packages/client/`, or any other package.

## Files

### Create

- `packages/monitor-ui/src/lib/reducer/handler-types.ts` — exports `EventHandler<T extends EforgeEvent['type']>` (`(event: Extract<EforgeEvent, { type: T }>, state: Readonly<RunState>) => Partial<RunState> | undefined`), `RunStateDelta = Partial<RunState>`, and shared narrowing helpers used by multiple handler files.
- `packages/monitor-ui/src/lib/reducer/handle-session.ts` — handlers for `session:start`, `session:end`, `session:profile`, `phase:start`, `phase:end`. Preserves `session:start` once-only `startTime` invariant.
- `packages/monitor-ui/src/lib/reducer/handle-planning.ts` — handler for `planning:complete` (sets initial plan statuses keyed by plan id).
- `packages/monitor-ui/src/lib/reducer/handle-plan-build.ts` — handlers for every `plan:build:*` and `plan:merge:*` variant. Owns `planStatuses`, `reviewIssues`, `fileChanges`, `mergeCommits`. Encodes the stage-advancement quirks (doc-author parallel, doc-sync sequential, test-write/implement-complete no-ops, review-complete → evaluate, build-complete → complete, build-failed → failed) explicitly via switch arms.
- `packages/monitor-ui/src/lib/reducer/handle-agent.ts` — handlers for `agent:start`, `agent:stop`, `agent:usage`, `agent:result`. Owns `agentThreads` and `liveAgentUsage`. Contains the delta-vs-final branch on `event.final === true`, the reverse-walk thread matching for `agent:result`, and a private `updateThread(threads, predicate, patch)` helper. Populates every `AgentThread` field from `agent:start` (`tier`, `tierSource`, `effort`, `effortSource`, `thinking`, `thinkingSource`, `harness`, `harnessSource`, `effortClamped`, `effortOriginal`, `perspective`).
- `packages/monitor-ui/src/lib/reducer/handle-expedition.ts` — handlers for `expedition:architecture:complete` (synthesizes partial `earlyOrchestration` and seeds `moduleStatuses`), `expedition:module:start`, `expedition:module:complete`.
- `packages/monitor-ui/src/lib/reducer/handle-enqueue.ts` — handlers for `enqueue:start`, `enqueue:complete`, `enqueue:failed`, `enqueue:commit-failed`. Removes the `(event as { source: string }).source` and `(event as { title: string }).title` casts.
- `packages/monitor-ui/src/lib/reducer/handle-misc.ts` — handlers for `config:warning` and `planning:warning` (today these only `console.log`; preserve that behavior and return `undefined`). Reserved bucket for one-offs that don't cleanly fit a group.
- `packages/monitor-ui/src/lib/reducer/index.ts` — exports the assembled `handlerRegistry: Record<...>` keyed by `EforgeEvent['type']`, the `IGNORED_EVENT_TYPES` tuple, and the `_Exhaustive` compile-time check.
- `packages/monitor-ui/src/lib/reducer/__tests__/handle-session.test.ts` — covers session/phase invariants.
- `packages/monitor-ui/src/lib/reducer/__tests__/handle-plan-build.test.ts` — covers every stage-advancement quirk listed in In-Scope.
- `packages/monitor-ui/src/lib/reducer/__tests__/handle-agent.test.ts` — covers all five agent-handler load-bearing invariants.
- `packages/monitor-ui/src/lib/reducer/__tests__/handle-expedition.test.ts` — covers architecture synthesis and module lifecycle.
- `packages/monitor-ui/src/lib/reducer/__tests__/handle-enqueue.test.ts` — covers all four enqueue states.
- `packages/monitor-ui/src/lib/reducer/__tests__/regression.test.ts` — replays the captured fixture through the new reducer and asserts deep-equality with the expected post-refactor `RunState` snapshot (taken from running the same fixture through the legacy reducer once during development).
- `packages/monitor-ui/src/lib/reducer/__tests__/fixtures/sample-build.json` — captured `[{ event: EforgeEvent, eventId: string }, ...]` sequence covering planning → build → review → evaluate → merge (50–200 events).
- `packages/monitor-ui/src/lib/reducer/__tests__/fixtures/expected-final-state.json` (or inlined in `regression.test.ts`) — the expected `RunState` snapshot for `sample-build.json`.

### Modify

- `packages/monitor-ui/src/lib/reducer.ts` — gut `processEvent`. Keep the public exports (`RunState`, `initialRunState`, `RunAction`, `eforgeReducer`, `getSummaryStats`, `AgentThread`, `ModuleStatus`, `StoredEvent`) with unchanged signatures. The new `eforgeReducer` body for `ADD_EVENT`:

  ```ts
  case 'ADD_EVENT': {
    const { event, eventId } = action;
    const handler = handlerRegistry[event.type];
    const delta = handler ? handler(event as never, state) : undefined;
    const events = [...state.events, { event, eventId }];
    return delta ? { ...state, events, ...delta } : { ...state, events };
  }
  ```

  `BATCH_LOAD` and `RESET` cases remain unchanged in observable behavior; if `BATCH_LOAD` currently calls `processEvent` in a loop, route it through the new registry instead.
- `packages/monitor-ui/package.json` — add `"test": "vitest run"` and `"test:watch": "vitest"` scripts if absent. Verify `pnpm test` from the repo root still routes correctly via the workspace.

### Transitional (created and deleted in the same plan)

- `packages/monitor-ui/src/lib/reducer/_legacy.ts` — a copy of the pre-refactor `processEvent` for the regression test to pin against. Deleted in the final commit of this plan once `regression.test.ts` is rewritten to assert against an inlined expected-state snapshot. No backwards-compatibility shim survives the plan.

## Verification

- [ ] `packages/monitor-ui/src/lib/reducer.ts` contains zero `(event as { ... })` casts and zero `'foo' in event` runtime narrowing guards. Verified by `grep -nE "as \{|in event\)" packages/monitor-ui/src/lib/reducer.ts` returning no matches.
- [ ] `packages/monitor-ui/src/lib/reducer/` directory exists and contains: `handler-types.ts`, `handle-session.ts`, `handle-planning.ts`, `handle-plan-build.ts`, `handle-agent.ts`, `handle-expedition.ts`, `handle-enqueue.ts`, `handle-misc.ts`, `index.ts`.
- [ ] Every handler returns `Partial<RunState> | undefined`; no handler reassigns fields on the input `state` argument.
- [ ] The reducer's `ADD_EVENT` case spreads only the slices in the handler-returned delta plus the events-array append; it does not pre-clone unrelated containers (no `{ ...state, planStatuses: { ...state.planStatuses }, fileChanges: new Map(state.fileChanges), ... }` block).
- [ ] Removing `'session:start'` from the registry causes a TypeScript compile error from `_Exhaustive`. Adding a fake `'fake:event'` to the registry that is not in `EforgeEvent['type']` also fails to compile.
- [ ] `packages/monitor-ui/src/lib/reducer.ts` still exports `eforgeReducer`, `initialRunState`, `RunState`, `RunAction`, `getSummaryStats`, `AgentThread`, `ModuleStatus`, `StoredEvent` with unchanged TypeScript signatures (verified by `pnpm type-check` passing without changes to any importing file in `app.tsx` or components).
- [ ] `_legacy.ts` does not exist in the final tree (`ls packages/monitor-ui/src/lib/reducer/_legacy.ts` returns no such file).
- [ ] `pnpm test` from the repo root passes, including all of: `handle-session.test.ts`, `handle-plan-build.test.ts`, `handle-agent.test.ts`, `handle-expedition.test.ts`, `handle-enqueue.test.ts`, `regression.test.ts`, plus the four pre-existing test files (`api-routes-compliance.test.tsx`, `event-card.test.tsx`, `verdict-chip.test.tsx`, `queue-section-recovery.test.tsx`).
- [ ] `handle-agent.test.ts` includes assertions for: (a) `agent:usage` with `final !== true` adds to `liveAgentUsage[agentId]` numeric fields; (b) `agent:usage` with `final === true` overwrites `liveAgentUsage[agentId]` with the event's totals; (c) `agent:result` updates the most recent thread matching `(agent, planId)` where `durationMs === null` (test must include a sequence with two such threads to prove reverse-walk); (d) `agent:start` populates all 11 enumerated fields; (e) `agent:stop` deletes `liveAgentUsage[agentId]` and sets `endedAt` on the matching thread.
- [ ] `handle-plan-build.test.ts` includes assertions for each enumerated stage-advancement rule: `doc-author:start` does not advance, `doc-sync:start` advances to `'doc-sync'`, `test:write:complete` does not advance, `implement:complete` does not advance, `review:complete` advances to `'evaluate'`, `build:complete` advances to `'complete'`, `build:failed` advances to `'failed'`.
- [ ] `regression.test.ts` runs the captured fixture through `eforgeReducer` and asserts the resulting `RunState` deep-equals the committed expected-state snapshot.
- [ ] `packages/monitor-ui/package.json` exposes `test` and `test:watch` scripts pointing at `vitest run` and `vitest` (or workspace equivalent).
- [ ] `pnpm type-check` passes for the entire workspace.
- [ ] `pnpm build:ui` succeeds.
- [ ] No new `/api/...` literals introduced (existing `api-routes-compliance.test.tsx` continues to pass).
- [ ] `packages/engine/src/events.ts` is byte-identical to its pre-plan state.
- [ ] No new dependencies added to `packages/monitor-ui/package.json` beyond the optional `test`/`test:watch` script entries.
