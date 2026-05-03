---
title: Monitor UI tech debt: split thread-pipeline god-file, decompose reducer + add discriminated event unions, fix SSE re-render storm, add reducer/hooks tests, replace ad-hoc polling with shared cache
created: 2026-05-03
---

# Monitor UI tech debt: split thread-pipeline god-file, decompose reducer + add discriminated event unions, fix SSE re-render storm, add reducer/hooks tests, replace ad-hoc polling with shared cache

## Problem / Motivation

The five highest-impact tech-debt items identified in the monitor-UI review:

1. **`thread-pipeline.tsx` is a 911 LOC god-file** — currently the largest UI file. Mixes color/style constants, stage→agent mapping, depth-graph computation, activity-overlay rendering, and a ~240-LOC `PlanRow` sub-component all in one file.
2. **`reducer.ts` is a 571 LOC monolith** — single `processEvent` handles 20+ event types as a sequence of `if (event.type === '...')` checks with manual narrowing via `'foo' in event` guards and `(event as { foo: string })` casts.
3. **Re-render storm on SSE events** — every `ADD_EVENT` allocates a new `events` array plus 6 new container objects (planStatuses, fileChanges Map, reviewIssues, agentThreads, moduleStatuses, mergeCommits, liveAgentUsage). Combined with passing `runState.events` directly to `<ThreadPipeline>`, the entire pipeline re-renders per event during a busy build.
4. **Insufficient test coverage** — only 3 test files for ~70 source files. The reducer (pure, central, fragile) is the highest-value untested surface.
5. **Ad-hoc polling without a shared cache layer** — `app.tsx` polls `/latest-run` every 2s and bumps `sidebarRefresh` unconditionally; `Sidebar` and `queue-section` each maintain their own polling intervals. No deduplication, no shared cache, no backoff.

### Verified findings vs. earlier audit

I read the code rather than trust the audit report. A few corrections matter for planning:

- **`EforgeEvent` is already a discriminated union** keyed on `type` (`packages/engine/src/events.ts:146`). The reducer's `(event as { source: string })`, `(event as { planId: string })`, `'planId' in event` casts are *unnecessary* — narrowing on `event.type === 'enqueue:start'` already gives the typed payload. The fix isn't "add discriminated unions" — it's **stop casting; let TypeScript narrow**, then split the switch into a handler map.
- **API-route hygiene is already enforced by a test** (`src/__tests__/api-routes-compliance.test.tsx` greps for literal `/api/...` strings). So that aspect is not on this PRD; route plumbing is fine.
- **The actual re-render root cause** is in `reducer.ts:470-484` — `ADD_EVENT` rebuilds 7 containers + the events array on every event. Even with downstream `useMemo`s, the parent `<AppContent>` re-renders, then `<ThreadPipeline>` re-renders, then every `<PlanRow>` re-renders. Memoizing alone won't fix it; we need to either (a) wrap children in `React.memo` with stable prop refs, or (b) reduce what gets allocated per event.

### Codebase touchpoints

- `packages/monitor-ui/src/lib/reducer.ts` — `processEvent` (lines 122–417), `eforgeReducer` (419–494), `getSummaryStats` (496–571). Imports `EforgeEvent` from `@/lib/types` (which re-exports from engine).
- `packages/monitor-ui/src/components/pipeline/thread-pipeline.tsx` — color constants (15–67), stage mapping (97–123), `BuildStageProgress`/`StageOverview` sub-components (134–323), `computeDepthMap` (404–434), `ThreadPipeline` (450–617), `PlanRow` (673+), `ActivityOverlay`, `DepthBars`, `IssuesSummary`.
- `packages/monitor-ui/src/app.tsx` — top-level state coordination (5 useEffect blocks for polling/refresh), passes `events`, `planStatuses`, `agentThreads` etc. into `<ThreadPipeline>` as fresh refs per event (line 337).
- `packages/monitor-ui/src/hooks/use-eforge-events.ts` — initial HTTP snapshot + `subscribeToSession` SSE; uses an unbounded in-memory cache (`cacheRef`, line 21) for completed sessions.
- `packages/monitor-ui/src/lib/api.ts` — fetch wrappers (no React-Query/SWR layer; pure async functions returning JSON).
- `packages/engine/src/events.ts:146` — `EforgeEvent` discriminated union (28 exported types, 60+ event variants in the union).

### Existing test infra

- Vitest is wired up (api-routes-compliance.test.tsx, event-card.test.tsx, verdict-chip.test.tsx, queue-section-recovery.test.tsx). No `test` script in `packages/monitor-ui/package.json` — tests run from the repo root via `pnpm test`.
- Pattern from existing tests: real components, no mocks; for SDK types use hand-crafted objects cast through `unknown` (per AGENTS.md testing convention).

### Conventions in scope

From `AGENTS.md`:
- "Engine emits, consumers render" — UI must not change `EforgeEvent` shapes; only consume.
- shadcn/ui primitives only (already true here).
- No mocks in tests; fixtures only for I/O.
- `@eforge-build/client` `API_ROUTES` + `buildPath()` — already enforced, no work to do.
- No backwards-compatibility hacks (`feedback_no_backward_compat`).

### Risks worth flagging up front

- **Reducer behavior is load-bearing.** Live agent usage overlay logic (lines 336–382 — additive deltas vs. `final: true` last-wins replacement) and the agent-thread matching logic in `agent:result` (lines 397–416, "find most recent thread matching agent + planId where durationMs is null") encode subtle invariants. A naive split into per-event handlers must preserve these.
- **`thread-pipeline` cosmetic regression risk is high.** It owns the most pixel-dense view in the app. Splitting must be behavior-preserving with visual diff.
- **Re-render fix scope is fuzzy.** "Fix the re-render storm" can mean anything from "wrap in React.memo" to "switch to a fine-grained store like Zustand/Jotai". Need to scope tightly.

## Goal

Decompose the two heaviest monitor-UI files (`reducer.ts` and `thread-pipeline.tsx`) into typed, testable units, eliminate the SSE-driven re-render storm via selective state allocation plus targeted `React.memo`, and back the refactor with reducer/handler tests and a regression-test fixture — without changing public types, visual rendering, engine event shapes, or any other UI surface.

## Approach

### Reducer decomposition + selective allocation

- Split `reducer.ts:processEvent` into a grouped handler map (~6 handlers): `handleSession`, `handlePlanning`, `handlePlanBuild`, `handleAgent`, `handleExpedition`, `handleEnqueue` (with a small `handleMisc` bucket for `session:profile`, `config:warning`, `planning:warning`, etc. if cleaner). Each handler narrows on `event.type` so all `(event as { foo: string })` casts and `'foo' in event` guards are removed. The public action contract (`ADD_EVENT` / `BATCH_LOAD` / `RESET`) and the `RunState` shape are unchanged.
- Handlers return a partial state delta describing only the slices they mutated. The reducer's `ADD_EVENT` case spreads only those slices instead of cloning all 7 containers (`planStatuses`, `fileChanges`, `reviewIssues`, `agentThreads`, `moduleStatuses`, `mergeCommits`, `liveAgentUsage`) on every event. The `events` array still appends every event (that's correct behavior).

### `thread-pipeline.tsx` split

Split into a `components/pipeline/` subfolder:
- `pipeline-colors.ts` — `AGENT_COLORS`, `TIER_COLORS`, `DEPTH_BAR_BG`, pill class strings, `getAgentColor`, `getTierColor`.
- `agent-stage-map.ts` — `AGENT_TO_STAGE`, `COMPOSITE_STAGES`, `resolveBuildStage`, `getBuildStageStatuses`, `buildStageName`.
- `compute-depth-map.ts` — `computeDepthMap` for the dependency-depth gutter.
- `activity-overlay.tsx` — `ActivityOverlay` component + bucket constants.
- `stage-overview.tsx` — `StagePill`, `Chevron`, `StageOverview`, `BuildStageProgress`.
- `plan-row.tsx` — `PlanRow`, `IssuesSummary`, `DepthBars`, plan-pill helpers.
- `thread-pipeline.tsx` becomes a thin orchestrator (~150 LOC) that composes the above.

### Targeted memoization

- `React.memo` on the proven hot components: `<ThreadPipeline>`, `<PlanRow>`, `<EventCard>` (timeline rows). Combined with selective allocation, an `agent:tool_use` event for an unrelated agent should re-render *no* PlanRows and only the EventCard for that one event.

### Tests

Vitest, no mocks; hand-crafted `EforgeEvent` payloads cast through `unknown` per AGENTS.md:
- One test file per reducer handler group (e.g. `reducer/handle-agent.test.ts`). Cover the load-bearing invariants: live-usage delta-vs-final replacement, agent-thread matching in `agent:result`, expedition module lifecycle, plan-status stage progression with the doc-author/doc-sync/test-write quirks.
- Pure-helper tests for `computeDepthMap`, `resolveBuildStage`, `getBuildStageStatuses`.
- End-to-end reducer test: replay a captured `EforgeEvent` sequence through the full handler chain and assert final `RunState` matches a snapshot of the pre-refactor reducer's output (regression gate).
- Add a `test` script to `packages/monitor-ui/package.json` if missing.

### Code Impact

#### Files modified

**Reducer (decomposition + selective allocation):**

- `packages/monitor-ui/src/lib/reducer.ts` — gutted. Keeps the public exports (`RunState`, `initialRunState`, `RunAction`, `eforgeReducer`, `getSummaryStats`, `AgentThread`, `ModuleStatus`, `StoredEvent`). Internally becomes a thin orchestrator that dispatches to handlers.
- **NEW** `packages/monitor-ui/src/lib/reducer/handler-types.ts` — shared `EventHandler<TEventType>` type and `RunStateDelta` (partial state) type. Defines the contract: `(event, state) => RunStateDelta | undefined` (undefined = no mutation).
- **NEW** `packages/monitor-ui/src/lib/reducer/handle-session.ts` — `session:start`, `session:end`, `session:profile`, `phase:start`, `phase:end`.
- **NEW** `packages/monitor-ui/src/lib/reducer/handle-planning.ts` — `planning:complete` (sets initial plan statuses).
- **NEW** `packages/monitor-ui/src/lib/reducer/handle-plan-build.ts` — all `plan:build:*` and `plan:merge:*` events that drive `planStatuses`, `reviewIssues`, `fileChanges`, `mergeCommits`.
- **NEW** `packages/monitor-ui/src/lib/reducer/handle-agent.ts` — `agent:start`, `agent:stop`, `agent:usage` (the load-bearing delta-vs-final logic), `agent:result` (the load-bearing thread-matching logic).
- **NEW** `packages/monitor-ui/src/lib/reducer/handle-expedition.ts` — `expedition:architecture:complete`, `expedition:module:start`, `expedition:module:complete`.
- **NEW** `packages/monitor-ui/src/lib/reducer/handle-enqueue.ts` — `enqueue:start`, `enqueue:complete`, `enqueue:failed`, `enqueue:commit-failed`.
- **NEW** `packages/monitor-ui/src/lib/reducer/handle-misc.ts` — `config:warning`, `planning:warning` (currently console.log only). Reserved for one-offs that don't fit a group.
- **NEW** `packages/monitor-ui/src/lib/reducer/index.ts` — re-exports the handler registry (a `Record` mapping event-type prefix or exact type → handler).

**Pipeline split:**

- `packages/monitor-ui/src/components/pipeline/thread-pipeline.tsx` — shrinks to ~150 LOC. Keeps `ThreadPipeline` as the orchestrator; imports the extracted helpers and sub-components.
- **NEW** `packages/monitor-ui/src/components/pipeline/pipeline-colors.ts` — `AGENT_COLORS`, `TIER_COLORS`, `DEPTH_BAR_BG`, `DEPTH_PILL_CLASS`, `pillClass`, `prdPillClass`, `planPillClass`, `planPillClassFor`, `getAgentColor`, `getTierColor`, `FALLBACK_COLOR`, `DEFAULT_TIER`, `STAGE_STATUS_STYLES`, plus shared `EMPTY_THREADS`, `EMPTY_EVENTS`, `EMPTY_SET` constants and the `abbreviatePlanId` helper.
- **NEW** `packages/monitor-ui/src/components/pipeline/agent-stage-map.ts` — `AGENT_TO_STAGE`, `COMPOSITE_STAGES`, `REVIEW_AGENTS`, `resolveBuildStage`, `getBuildStageStatuses`, `buildStageName`, `getStageStatus`, `StageStatus` type, `MIN_TIMELINE_WINDOW_MS`.
- **NEW** `packages/monitor-ui/src/components/pipeline/compute-depth-map.ts` — `computeDepthMap`.
- **NEW** `packages/monitor-ui/src/components/pipeline/activity-overlay.tsx` — `ActivityOverlay`, `ACTIVITY_BUCKET_MS`, `ACTIVITY_STREAMING_TYPES`, `getActivityOpacity`.
- **NEW** `packages/monitor-ui/src/components/pipeline/stage-overview.tsx` — `StagePill`, `Chevron`, `StageOverview`, `BuildStageProgress`.
- **NEW** `packages/monitor-ui/src/components/pipeline/plan-row.tsx` — `PlanRow` (memoized via `React.memo`), `IssuesSummary`, `DepthBars`. Imports from the four files above.
- `packages/monitor-ui/src/app.tsx` — single line change at line 337: wrap usage of `<ThreadPipeline>` to ensure prop refs that change per event don't defeat memo. Likely just confirms the existing prop set is already memo-friendly (most props are derived via `useMemo`); may need to memoize one or two inline objects.

**Memoization beyond pipeline:**

- `packages/monitor-ui/src/components/timeline/event-card.tsx` — wrap default export in `React.memo` (`EventCard` is mapped over `events` in `timeline.tsx:13` with `key={i}`; memoization here prevents re-rendering all prior events when a new event arrives).

**Tests:**

- **NEW** `packages/monitor-ui/src/lib/reducer/__tests__/handle-session.test.ts` — covers `session:start` setting `startTime` only once, `session:end` overriding `isComplete`/`endTime`/`resultStatus`, `phase:start` fallback when no `session:start`.
- **NEW** `packages/monitor-ui/src/lib/reducer/__tests__/handle-plan-build.test.ts` — covers the stage progression quirks (doc-author runs in parallel, doc-sync sequential, test-write doesn't advance, evaluate triggered by review-complete), `reviewIssues` extraction from `plan:build:review:complete` and `plan:build:test:complete`, `fileChanges` Map updates, `mergeCommits` from `plan:merge:complete`.
- **NEW** `packages/monitor-ui/src/lib/reducer/__tests__/handle-agent.test.ts` — the most invariant-heavy:
  - `agent:start` creates an `AgentThread` carrying every field (`tier`, `tierSource`, `effort`, `effortSource`, `thinking`, `thinkingSource`, `harness`, `harnessSource`, `effortClamped`, `effortOriginal`, `perspective`).
  - `agent:usage` non-final = additive delta into `liveAgentUsage` AND incremental update of the matching `AgentThread`.
  - `agent:usage` `final: true` = last-wins replacement of `liveAgentUsage` AND finalize the matching thread.
  - `agent:result` = "find most recent thread matching agent + planId where durationMs is null" (regression test for the matching loop).
  - `agent:stop` deletes `liveAgentUsage[agentId]` and sets `endedAt` on the matching thread.
- **NEW** `packages/monitor-ui/src/lib/reducer/__tests__/handle-expedition.test.ts` — `expedition:architecture:complete` synthesizes `earlyOrchestration` and seeds `moduleStatuses`; module lifecycle transitions.
- **NEW** `packages/monitor-ui/src/lib/reducer/__tests__/handle-enqueue.test.ts` — the three enqueue states.
- **NEW** `packages/monitor-ui/src/lib/reducer/__tests__/regression.test.ts` — the end-to-end gate. Loads a captured event sequence (a small JSON fixture committed under `__tests__/fixtures/`), runs the new reducer over it, asserts the resulting `RunState` matches a snapshot of the *current* (pre-refactor) reducer's output. This is the safety net.
- **NEW** `packages/monitor-ui/src/components/pipeline/__tests__/compute-depth-map.test.ts` — depth for linear, branching, and cyclic dependency graphs (cycle guard).
- **NEW** `packages/monitor-ui/src/components/pipeline/__tests__/agent-stage-map.test.ts` — `resolveBuildStage` with composite stages (`review-cycle`, `test-cycle`), `getBuildStageStatuses` for completed/failed/in-progress states, parallel groups.
- `packages/monitor-ui/package.json` — add `"test": "vitest run"` and `"test:watch": "vitest"` if not already inherited from the workspace root. (Verify: tests currently run via `pnpm test` at the repo root; need to confirm whether monitor-ui needs its own script.)

#### Patterns to follow

- **Discriminated-union narrowing** — `event-card.tsx:eventSummary` (lines 44+) is the model: a `switch (event.type)` block with no casts. Apply the same pattern in every reducer handler.
- **Pure-helper testing** — `verdict-chip.test.tsx` is the existing template for component-adjacent unit tests.
- **AGENTS.md test conventions** — no mocks; for SDK types use `as unknown as EforgeEvent` on hand-crafted literals; group tests by logical unit.
- **shadcn/ui only** — no new UI primitives needed for this PRD.
- **`forgeCommit()` for any engine-side commits** — N/A here (UI-only PRD).

#### Shared utilities reused

- `EforgeEvent` discriminated union from `@/lib/types` (re-exported from `@eforge-build/engine`).
- `formatDuration`, `formatThinking`, `formatNumber` from `@/lib/format` (no changes).
- `cn` from `@/lib/utils`.
- shadcn primitives (`Tooltip`, `Button`) — already imported in `thread-pipeline.tsx`; carry over into `plan-row.tsx`.

#### Dependency relationships (new files)

```
reducer.ts (orchestrator)
  └── reducer/index.ts (registry)
        ├── reducer/handler-types.ts
        ├── reducer/handle-session.ts
        ├── reducer/handle-planning.ts
        ├── reducer/handle-plan-build.ts
        ├── reducer/handle-agent.ts
        ├── reducer/handle-expedition.ts
        ├── reducer/handle-enqueue.ts
        └── reducer/handle-misc.ts

components/pipeline/thread-pipeline.tsx (orchestrator)
  ├── pipeline/pipeline-colors.ts
  ├── pipeline/agent-stage-map.ts
  ├── pipeline/compute-depth-map.ts
  ├── pipeline/activity-overlay.tsx (uses pipeline-colors, agent-stage-map)
  ├── pipeline/stage-overview.tsx (uses pipeline-colors, agent-stage-map)
  └── pipeline/plan-row.tsx (uses all of the above)
```

#### Existing test coverage

- `src/__tests__/api-routes-compliance.test.tsx` — passes today; must keep passing (no new `/api/...` literals introduced).
- `src/components/timeline/__tests__/event-card.test.tsx` — render assertions; must keep passing after `EventCard` is wrapped in `React.memo`.
- `src/components/recovery/__tests__/verdict-chip.test.tsx` — unaffected.
- `src/components/layout/__tests__/queue-section-recovery.test.tsx` — unaffected.

#### What does NOT change

- `EforgeEvent` shape and the engine. UI consumes; engine emits.
- `RunState` shape (consumers throughout the app rely on the public type).
- Any other UI surface (timeline, heatmap, graph, recovery sidecar, plan-preview, console, sidebar, header, layout, summary cards).
- HTTP API contracts (`packages/client`), routes, or the daemon.

### Design Decisions

#### D1. Handler signature: partial-state delta

Each handler returns `Partial<RunState> | undefined` describing only the slices it changed. `undefined` means no mutation.

```ts
export type EventHandler<T extends EforgeEvent['type']> = (
  event: Extract<EforgeEvent, { type: T }>,
  state: Readonly<RunState>,
) => Partial<RunState> | undefined;
```

The reducer's `ADD_EVENT` case becomes:

```ts
case 'ADD_EVENT': {
  const { event, eventId } = action;
  const handler = handlerRegistry[event.type];
  const delta = handler ? handler(event as never, state) : undefined;
  return {
    ...state,
    events: [...state.events, { event, eventId }],
    ...(delta ?? {}),
  };
}
```

**Why over the alternative (mutation accumulator like today):** the current reducer pre-clones all 7 containers (`planStatuses`, `fileChanges`, `reviewIssues`, `agentThreads`, `moduleStatuses`, `mergeCommits`, `liveAgentUsage`) on every `ADD_EVENT` because *any* handler might mutate *any* of them. That's the re-render storm root cause. A delta-return contract makes "what changed" explicit at the per-event level, so the reducer only spreads what changed, and downstream `React.memo` actually fires.

**Trade-off:** handlers that update *one entry inside* a container construct a new container ref themselves, e.g. `agent:usage` returns `{ liveAgentUsage: { ...state.liveAgentUsage, [agentId]: newUsage }, agentThreads: state.agentThreads.map(...) }`. Verbose but explicit. A small `updateThread(threads, agentId, patch)` helper in `handle-agent.ts` will keep the verbosity contained.

#### D2. Handler registry: lookup by exact `event.type`

Single flat `Record<EforgeEvent['type'], EventHandler<...>>` keyed by exact event type, assembled from per-group handler files. `O(1)` dispatch. Unknown event types fall through with no-op (preserves today's behavior).

**Rejected alternative:** prefix-based dispatch (`if (event.type.startsWith('agent:')) handleAgent(event)`). Loses TypeScript narrowing — the handler can't get `Extract<EforgeEvent, { type: 'agent:start' }>` from a string-prefix check, so we're back to casting. The whole point of decomposition is to *eliminate* casts.

The grouping into `handle-session.ts`, `handle-agent.ts`, etc. is for *file organization only*; the registry itself is flat.

#### D3. Compile-time exhaustiveness check

Build the registry as a `const` object and use a TypeScript type assertion that fails at compile time if any `EforgeEvent['type']` is neither in the registry nor in an explicit `IGNORED_EVENT_TYPES` set:

```ts
const IGNORED_EVENT_TYPES = [
  'agent:message', 'agent:tool_use', 'agent:tool_result',
  'agent:warning', 'agent:retry',
  // ... event types the UI intentionally doesn't react to in state
] as const;

type CoveredTypes = keyof typeof handlerRegistry | typeof IGNORED_EVENT_TYPES[number];
type _Exhaustive = EforgeEvent['type'] extends CoveredTypes ? true :
  { error: 'Missing handler for event types', missing: Exclude<EforgeEvent['type'], CoveredTypes> };
const _exhaustivenessCheck: _Exhaustive = true; // type error if not exhaustive
```

**Why:** when the engine adds a new event variant, the UI gets a build error instead of a silent no-op. This is the highest-leverage benefit of the decomposition — it converts a runtime hazard into a compile-time gate.

#### D4. `React.memo` comparison

Default shallow comparison. No custom `areEqual` functions. Rely on stable refs from `useMemo` upstream.

Where stable refs are expensive to compute (e.g. `events: StoredEvent[]` passed to `<PlanRow>` purely for the activity overlay), narrow the prop instead. `<PlanRow>` should receive `eventsByAgent: Map<string, StoredEvent[]>` (already computed in a `useMemo` inside `PlanRow` today — lift it to the parent or pre-bucket once in `<ThreadPipeline>`).

**Why not custom `areEqual`:** shifts cost from "render + diff" to "deep-compare every render", with high drift risk between props and comparison logic. Fix the prop shape, not the comparison.

#### D5. End-to-end regression test fixture

Capture a real event sequence by running a small build in eforge, dumping the SSE stream to a JSON file, and committing it as `packages/monitor-ui/src/lib/reducer/__tests__/fixtures/sample-build.json`.

The regression test (`__tests__/regression.test.ts`):
1. Loads the fixture.
2. Runs the *current* (pre-refactor) `eforgeReducer` over it — kept temporarily as `eforgeReducerLegacy` in a private `_legacy.ts` file.
3. Runs the *new* `eforgeReducer` over the same sequence.
4. Asserts both final `RunState` objects are deep-equal.

**Why:** without this, "behavior-preserving" is a vibe. With it, the gate is binary.

**Cleanup:** after the regression test passes and the PR lands, delete `_legacy.ts` in a follow-up commit (or as the final commit of the same PR — implementer's call). The fixture stays as the canonical event-sequence test asset.

**Fixture capture procedure** (for the implementer): run `pnpm --filter @eforge-build/monitor a small build, then `curl -N http://localhost:4567/api/events?sessionId=<id>` to dump the SSE stream, then strip SSE framing to get a JSON array of `{event, eventId}` objects. Aim for ~50-200 events covering the full pipeline (planning → build → review → evaluate → merge). Capture from a real build to exercise live agent-usage deltas authentically.

#### D6. Handler error handling

Handlers do not try/catch. If a handler throws, it propagates to the reducer and crashes the React tree. This matches today's behavior — the reducer has no error handling. Adding an error boundary is a separate concern (mentioned as a quick win in the original review) and out of scope for this PRD.

#### D7. File naming and layout

- Reducer handlers: `handle-{group}.ts` matching the function names (`handleSession`, `handlePlanBuild`, etc.). Folder: `packages/monitor-ui/src/lib/reducer/`.
- Pipeline pieces: `pipeline-colors.ts`, `agent-stage-map.ts`, `compute-depth-map.ts`, `activity-overlay.tsx`, `stage-overview.tsx`, `plan-row.tsx`. Folder: `packages/monitor-ui/src/components/pipeline/`.
- Test files mirror source structure: `<source-folder>/__tests__/<source-stem>.test.ts`.

#### D8. Migration order (implementer guidance)

The implementer should land the regression fixture first, then the new reducer in parallel with the old one (export both, but only wire the new one), then verify the regression test passes, then delete the old one. This minimizes the window where the codebase is in a half-migrated state.

### Risks

#### R1. Reducer behavior regression — load-bearing invariants

The current `processEvent` encodes several non-obvious invariants that a careless decomposition could silently break:

- **Live agent usage delta-vs-final replacement** (`reducer.ts:336-382`). `agent:usage` events fire per-turn as additive deltas AND once at session end as a `final: true` cumulative total. Mixing them double-counts. The handler MUST branch on `event.final === true`.
- **Agent-thread matching in `agent:result`** (`reducer.ts:397-416`). Walks `agentThreads` in *reverse order* to find the most recent thread matching `(agent, planId)` where `durationMs === null`. This is how multiple invocations of the same agent role on the same plan get correctly attributed. A naive `.find()` from the front would attribute to the first invocation instead of the latest.
- **Stage advancement quirks** (`reducer.ts:198-238`). `plan:build:doc-author:start` does NOT advance `planStatuses` because doc-author runs in parallel with implement. `plan:build:test:write:complete` does NOT advance because the next stage sets it. `plan:build:implement:complete` does NOT advance for the same reason. These "intentional no-ops" must be preserved.
- **`session:start` once-only** (`reducer.ts:149-151`). Only sets `startTime` if it's still `null`, because `phase:start` may have set it first.
- **Expedition early orchestration synthesis** (`reducer.ts:270-292`). `expedition:architecture:complete` synthesizes a partial `OrchestrationConfig` so the dependency graph can render before real orchestration data arrives. The synthesized config has empty strings for fields the renderer doesn't read; if the renderer ever does start reading them, this breaks.

**Mitigation:** the regression-test fixture (D5) catches these. The handler-level unit tests are the secondary net.

#### R2. Pixel regression in `thread-pipeline`

It owns the most pixel-dense view in the app — depth bars, stage pills with hover-dim, activity-density buckets, plan-pill colors per dependency depth, build-stage breadcrumbs with composite-stage chevrons. Splitting can subtly break layout in ways unit tests won't catch.

**Mitigation:** before/after visual diff is mandatory. The implementer should:
1. Capture a screenshot of `<ThreadPipeline>` in 3 states (no-events idle, mid-build with multiple plans, completed build with failures) before refactoring.
2. After refactoring, compare. Pixel-equivalent or explain the diff.
3. The implementer may use the `ui:browser-qa` agent to drive the monitor in headless Chrome and capture screenshots.

#### R3. `React.memo` defeated by inline objects/closures

`<ThreadPipeline>` receives several props at `app.tsx:337`. If any prop is a new object/array/function literal per render (e.g. `{ planArtifacts: [{ ... }] }` constructed inline), `React.memo` is a no-op.

**Mitigation:** audit `app.tsx:337` and the surrounding `useMemo` blocks to ensure every prop passed to memoized children is either a primitive, a stable ref, or already wrapped in `useMemo`. Spot-checks during implementation; not testable as such.

#### R4. Compile-time exhaustiveness check fragility

The `_Exhaustive` type assertion (D3) depends on `EforgeEvent['type']` being a closed string-literal union. If the engine ever changes `EforgeEvent` to include `type: string` somewhere (broadening), the check silently passes for everything.

**Mitigation:** the assertion encodes its expected shape via the `{ error: '...', missing: ... }` object branch, making the failure mode legible. If the engine widens the union, the check still narrows correctly because `Extract` and `extends` operate on the union members. This is more theoretical than practical — the engine's events.ts is structurally a discriminated union and unlikely to widen.

#### R5. Regression-test fixture staleness

The captured event sequence (D5) reflects the engine's event shapes at capture time. If the engine adds a new event type or changes a payload shape, the fixture goes stale and the regression test passes only because the new event types fall through both reducers.

**Mitigation:** this is acceptable for the *initial* refactor — the regression test's purpose is to catch refactor-introduced behavior changes, not to enforce ongoing engine ↔ UI compatibility. The compile-time exhaustiveness check (D3) catches new event types at the type level. Routine fixture refresh can be a follow-up if drift becomes a problem.

#### R6. Test coverage uncovers latent bugs

Writing per-handler unit tests will likely surface latent bugs in the *current* reducer (e.g. an edge case in agent-thread matching that's been wrong but unobserved). This is a feature, not a bug — but it complicates the "behavior-preserving" framing.

**Mitigation:** when a unit test catches a latent bug, the implementer should:
1. Document the bug in the PR description.
2. Match the *current* (buggy) behavior in the new reducer so the regression test passes.
3. Open a follow-up PRD to fix the bug. Don't bundle the fix into this PRD — that violates "behavior-preserving."

#### R7. Backward compatibility temptation

The `_legacy.ts` file holding the old reducer during transition is a backwards-compat shim. Per `feedback_no_backward_compat`, it must be deleted before the PR is considered done.

**Mitigation:** explicit acceptance criterion that `_legacy.ts` is removed in the same PR. The regression test stays (it depends only on the fixture and the *new* reducer; once both reducers' outputs match, we don't need the old one anymore — the snapshot of expected output can be inlined or moved to a JSON expectation file).

#### R8. Performance gain is unmeasured

"Re-render storm" is qualitative today. After the fix, we'll claim it's better, but without a baseline measurement, it's hard to prove.

**Mitigation:** record a quick before/after using React DevTools Profiler during a single live build (the implementer adds the screenshots/numbers to the PR description). Not a blocking criterion — qualitative confirmation that "agent:tool_use no longer re-renders all PlanRows" is sufficient. Hard numbers are a nice-to-have.

#### R9. Partial-application risk for eforge orchestration

This PRD is a single coherent change to monitor-UI. There's no engine work, no daemon work, no schema migration. If the build fails partway through (e.g. reducer split lands but pipeline split doesn't), the failure mode is just "a half-merged PR." Unlike engine work, no production data or running session state is at risk.

**Mitigation:** none needed — the failure mode is benign.

### Profile Signal

**Recommended profile: excursion**

Rationale:
- Single package (`packages/monitor-ui/`); no cross-subsystem coordination — rules out **expedition**.
- Substantially more than a typo or single-file fix: ~10 new source files, ~5 modified files, ~10 new test files, a regression-test fixture, and a load-bearing decomposition of two of the heaviest files in the package — rules out **errand**.
- Internally has natural sub-units (reducer split, pipeline split, tests, memoization), but they all live in one package and one PR. The reducer split is the keystone — pipeline memoization and tests both depend on it.
- High but bounded behavioral risk (handled via the regression-test fixture and per-handler unit tests). Not architectural in scope: contracts and shapes are unchanged.

**excursion** is the right size for one focused PR with multi-stage build (implement → review → test → evaluate) and the orchestration overhead of a single dependency chain rather than parallel modules.

## Scope

### In scope

1. **Reducer decomposition** — split `reducer.ts:processEvent` into a grouped handler map (~6 handlers): `handleSession`, `handlePlanning`, `handlePlanBuild`, `handleAgent`, `handleExpedition`, `handleEnqueue` (with a small `handleMisc` bucket for `session:profile`, `config:warning`, `planning:warning`, etc. if cleaner). Each handler narrows on `event.type` so all `(event as { foo: string })` casts and `'foo' in event` guards are removed. The public action contract (`ADD_EVENT` / `BATCH_LOAD` / `RESET`) and the `RunState` shape are unchanged.

2. **Selective allocation in `ADD_EVENT`** — handlers return a partial state delta describing only the slices they mutated. The reducer's `ADD_EVENT` case spreads only those slices instead of cloning all 7 containers (`planStatuses`, `fileChanges`, `reviewIssues`, `agentThreads`, `moduleStatuses`, `mergeCommits`, `liveAgentUsage`) on every event. The `events` array still appends every event (that's correct behavior).

3. **`thread-pipeline.tsx` split** into a `components/pipeline/` subfolder:
   - `pipeline-colors.ts` — `AGENT_COLORS`, `TIER_COLORS`, `DEPTH_BAR_BG`, pill class strings, `getAgentColor`, `getTierColor`.
   - `agent-stage-map.ts` — `AGENT_TO_STAGE`, `COMPOSITE_STAGES`, `resolveBuildStage`, `getBuildStageStatuses`, `buildStageName`.
   - `compute-depth-map.ts` — `computeDepthMap` for the dependency-depth gutter.
   - `activity-overlay.tsx` — `ActivityOverlay` component + bucket constants.
   - `stage-overview.tsx` — `StagePill`, `Chevron`, `StageOverview`, `BuildStageProgress`.
   - `plan-row.tsx` — `PlanRow`, `IssuesSummary`, `DepthBars`, plan-pill helpers.
   - `thread-pipeline.tsx` becomes a thin orchestrator (~150 LOC) that composes the above.

4. **Targeted `React.memo`** on the proven hot components: `<ThreadPipeline>`, `<PlanRow>`, `<EventCard>` (timeline rows). Combined with item 2, an `agent:tool_use` event for an unrelated agent should re-render *no* PlanRows and only the EventCard for that one event.

5. **Tests for the new shapes** (vitest, no mocks; hand-crafted `EforgeEvent` payloads cast through `unknown` per AGENTS.md):
   - One test file per reducer handler group (e.g. `reducer/handle-agent.test.ts`). Cover the load-bearing invariants: live-usage delta-vs-final replacement, agent-thread matching in `agent:result`, expedition module lifecycle, plan-status stage progression with the doc-author/doc-sync/test-write quirks.
   - Pure-helper tests for `computeDepthMap`, `resolveBuildStage`, `getBuildStageStatuses`.
   - End-to-end reducer test: replay a captured `EforgeEvent` sequence through the full handler chain and assert final `RunState` matches the pre-refactor reducer's output (regression gate).
   - Add a `test` script to `packages/monitor-ui/package.json` if missing.

### Out of scope

- **Polling, shared cache, SWR / React-Query** — that's PRD B (separate session). `app.tsx`'s polling effects, `Sidebar`/`queue-section` polling, and `use-eforge-events`'s in-memory cache are untouched here.
- **`EforgeEvent` shape changes** in the engine. UI only consumes; engine is untouched. ("Engine emits, consumers render.")
- **Switching to Zustand / Jotai / Redux** (selector-based store). This was considered (Option B) and explicitly deferred to a hypothetical PRD C if Option A's memo-based fix proves insufficient after shipping.
- **Broader memoization** (summary cards, heatmap cells, graph nodes). Their re-renders are driven by *data* changes that the reducer fix already addresses. Memoizing them would add ceremony without measurable benefit.
- **Visual design changes** in the pipeline. The split must be pixel-equivalent to the current rendering.
- **New features** (cross-linking, search, command palette, cost breakdown, playbook UI). All separate.
- **Monitor backend** (`packages/monitor/`) and the daemon. UI-only.
- **Other monitor-UI components** unrelated to the reducer or pipeline (recovery sidecar, plan-preview panel, console panel, dependency graph).

### Natural boundary

The reducer is the upstream cause of the re-render storm; the pipeline is the heaviest consumer. Fixing both together is the smallest coherent unit. Polling and cache are a separate concern (request lifecycle, not render lifecycle) and live in a separate PRD.

## Acceptance Criteria

### Reducer

- [ ] `packages/monitor-ui/src/lib/reducer.ts` contains no `(event as { ... })` casts and no `'foo' in event` runtime narrowing guards. All event-shape access is via `event.type`-narrowed properties.
- [ ] `packages/monitor-ui/src/lib/reducer/` directory exists with the per-group handler files (`handle-session.ts`, `handle-planning.ts`, `handle-plan-build.ts`, `handle-agent.ts`, `handle-expedition.ts`, `handle-enqueue.ts`, `handle-misc.ts` if needed), `handler-types.ts`, and `index.ts`.
- [ ] Every handler returns `Partial<RunState> | undefined`; no handler mutates `state` directly.
- [ ] The reducer's `ADD_EVENT` case spreads only the slices returned in the handler's delta, plus the `events` array append. It does not pre-clone unrelated containers.
- [ ] A compile-time exhaustiveness check ensures every `EforgeEvent['type']` is either in the handler registry or in an explicit `IGNORED_EVENT_TYPES` list. Adding a new event type to the engine without updating monitor-UI causes a TypeScript build error.
- [ ] `eforgeReducer`, `initialRunState`, `RunState`, `RunAction`, `getSummaryStats`, `AgentThread`, `ModuleStatus`, `StoredEvent` are still exported from `packages/monitor-ui/src/lib/reducer.ts` with unchanged public types.
- [ ] `_legacy.ts` (or wherever the old reducer lives during transition) is deleted before the PR is considered done. No backwards-compat shims remain.

### Pipeline split

- [ ] `packages/monitor-ui/src/components/pipeline/thread-pipeline.tsx` is under 200 LOC.
- [ ] `packages/monitor-ui/src/components/pipeline/` contains `pipeline-colors.ts`, `agent-stage-map.ts`, `compute-depth-map.ts`, `activity-overlay.tsx`, `stage-overview.tsx`, `plan-row.tsx` as standalone files.
- [ ] No file in the pipeline folder exceeds 300 LOC.
- [ ] The visual rendering of `<ThreadPipeline>` is pixel-equivalent to before the refactor in three states: idle (no events), mid-build (multiple plans, mixed stages, at least one in-progress agent), completed-with-failure. Verified by before/after screenshots attached to the PR.

### Memoization

- [ ] `<ThreadPipeline>`, `<PlanRow>`, and `<EventCard>` are wrapped in `React.memo` with default shallow comparison.
- [ ] When a new `agent:tool_use` event arrives during a live build, no `<PlanRow>` re-renders (verified via React DevTools Profiler). The matching `<EventCard>` for the new event renders; previous `<EventCard>` instances do not re-render.
- [ ] All props passed to memoized components from `app.tsx` and `thread-pipeline.tsx` are either primitives, stable refs, or wrapped in `useMemo`. No inline object/array literals.

### Tests

- [ ] `pnpm test` from the repo root passes.
- [ ] New test files exist:
  - `src/lib/reducer/__tests__/handle-session.test.ts`
  - `src/lib/reducer/__tests__/handle-plan-build.test.ts`
  - `src/lib/reducer/__tests__/handle-agent.test.ts`
  - `src/lib/reducer/__tests__/handle-expedition.test.ts`
  - `src/lib/reducer/__tests__/handle-enqueue.test.ts`
  - `src/lib/reducer/__tests__/regression.test.ts`
  - `src/lib/reducer/__tests__/fixtures/sample-build.json`
  - `src/components/pipeline/__tests__/compute-depth-map.test.ts`
  - `src/components/pipeline/__tests__/agent-stage-map.test.ts`
- [ ] `handle-agent.test.ts` covers the load-bearing invariants explicitly:
  - `agent:usage` non-final adds to `liveAgentUsage[agentId]` and the matching thread's running totals.
  - `agent:usage` `final: true` replaces (not adds to) `liveAgentUsage[agentId]` and finalizes the matching thread.
  - `agent:result` matches the most recent thread with `(agent, planId)` where `durationMs === null` (regression test for the reverse-walk loop).
  - `agent:start` populates every field including `tier`, `tierSource`, `effort`, `effortSource`, `thinking`, `thinkingSource`, `harness`, `harnessSource`, `effortClamped`, `effortOriginal`, `perspective`.
  - `agent:stop` deletes `liveAgentUsage[agentId]` and sets `endedAt` on the matching thread.
- [ ] `handle-plan-build.test.ts` covers the stage advancement quirks:
  - `plan:build:doc-author:start` does NOT advance `planStatuses` (parallel with implement).
  - `plan:build:doc-sync:start` advances to `'doc-sync'`.
  - `plan:build:test:write:complete` does NOT advance.
  - `plan:build:implement:complete` does NOT advance.
  - `plan:build:review:complete` advances to `'evaluate'`.
  - `plan:build:complete` advances to `'complete'`.
  - `plan:build:failed` advances to `'failed'`.
- [ ] `regression.test.ts` replays a fixture event sequence through the new reducer and asserts the final `RunState` deep-equals an expected snapshot (from running the same fixture through the pre-refactor reducer once during development).
- [ ] All existing tests still pass: `api-routes-compliance.test.tsx`, `event-card.test.tsx`, `verdict-chip.test.tsx`, `queue-section-recovery.test.tsx`.

### Type-checking and build

- [ ] `pnpm type-check` passes with no errors.
- [ ] `pnpm build` succeeds for `@eforge-build/monitor-ui`.
- [ ] No new ESLint/TypeScript warnings introduced.

### Out-of-scope checks (defensive — these should NOT change)

- [ ] No changes to `packages/engine/src/events.ts` (`EforgeEvent` shape).
- [ ] No changes to `packages/monitor/`, `packages/client/`, or any other package.
- [ ] No new HTTP routes, no changes to existing routes, no new API_ROUTES entries.
- [ ] No changes to polling logic in `app.tsx`, `Sidebar`, or `queue-section.tsx` (PRD B territory).
- [ ] No changes to `use-eforge-events.ts` SSE subscription or in-memory cache (PRD B territory).
- [ ] No new dependencies added to `packages/monitor-ui/package.json`.
- [ ] No visual design changes; pipeline rendering is pixel-equivalent.
