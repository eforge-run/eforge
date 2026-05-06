---
id: plan-01-close-spine-ac-shortfalls
name: Close spine AC shortfalls — lifecycle events, thinking format, regression gate
branch: close-spine-ac-shortfalls-from-event-source-spine-merge/plan-01-close-spine-ac-shortfalls
---


# Close spine AC shortfalls — lifecycle events, thinking format, regression gate

## Architecture Context

The event-source-spine expedition (merge `14f3fb4`) routed all engine-side state mutation through the single-entry-point `mutateState(state, event)` in `packages/engine/src/state.ts`. Five lifecycle event variants were added (`plan:status:change`, `plan:error:set`, `plan:error:clear`, `merge:worktree:set`, `merge:worktree:clear`) and exist in `packages/client/src/events.schemas.ts` as the wire-protocol source of truth.

Three gaps remained after merge:

1. **AC #6** — those five variants are constructed by `mutateState` callers but never reach the SSE wire. The orchestrator's generator does not `yield` them. The registry entries are `persist: false` with no `project()` function. The session reducer lists them in `IGNORED_EVENT_TYPES`. The monitor UI still derives plan-row status from `plan:build:start`/`plan:build:complete`/`plan:build:failed` (the inference heuristics the spine claimed to delete).
2. **AC #8** — `agent:start` carries `thinkingOriginal: { type: 'enabled', budget_tokens: 32000 }` (snake_case wire shape from Zod). `formatThinking` reads `budgetTokens` (camelCase). At runtime the agent-stage hover renders raw JSON instead of `enabled (32.0k tokens)`. The existing test at `format-thinking.test.ts:76-85` deliberately weakens its assertion to `expect(typeof result === 'string' || result === undefined).toBe(true)` to allow the JSON fallback.
3. **AC #1** — `event-replay-equivalence.test.ts` is a synthetic ADD_EVENT-vs-BATCH_LOAD self-consistency check through the same reducer. It is not a regression gate against inference reintroduction.

### Project conventions in scope

- **Engine emits, consumers render** — re-yielding lifecycle events from the orchestrator alongside `mutateState` calls preserves this principle.
- **State mutation is single-entry-point** — all mutations stay routed through `mutateState`. Yielding the same event after `mutateState` returns preserves the invariant.
- **Event types and schemas are co-located** — the five variants are already in `events.schemas.ts`; only registry metadata changes.
- **`DAEMON_API_VERSION` must bump** when SSE wire surface changes. Current value: `21` (set for an unrelated `planning:module:build-config:invalid` change). Bump to `22`.
- **Per-session SSE only** — plan progression is per-session state, so events flow on the per-session SSE stream, not on daemon-events.

### Architectural note (AC #1)

The on-disk `event-log.jsonl` (written by `appendSnapshotToEventLog` in `packages/engine/src/state.ts`) contains only `__snapshot` rows, not raw event deltas. There is no recorded event-delta artifact suitable as an AC #1 fixture. The PRD redefines AC #1 as a sharper regression gate: prove the reducer relies on explicit `plan:status:change` events, not inference. This is the valuable underlying property; recorded fixtures are out of scope.

## Implementation

### Overview

Wire the five existing lifecycle variants end-to-end so plan-row status in the monitor UI is driven exclusively by explicit `plan:status:change` events; delete the inference heuristics in `handle-plan-build.ts` that previously derived `planStatuses` from build events; normalize the `thinking` payload at the wire-deserialization boundary so snake_case `budget_tokens` becomes camelCase `budgetTokens` before reaching `formatThinking`; rewrite the replay-equivalence test as a regression gate proving inference is gone.

### Key Decisions (from the PRD's settled design-decisions)

1. **Per-session SSE only.** Plan progression is per-session. The lifecycle events flow on the per-session SSE stream (the same one carrying `plan:build:*`). They do not flow on the daemon-events SSE.
2. **`scope: 'session'` stays, `persist: true` flips on.** Persistence makes (a) reconnecting clients replay them via the SSE handshake, (b) `DAEMON_EVENT_TYPES` derivation pull them in automatically, (c) the AC #1 regression gate operate over realistic inputs.
3. **Projection lives in the session reducer, not in the registry's `project()` function.** Plan status is per-session state; the per-session reducer is the right home. The registry entries do need `project: undefined` (or a no-op) declared explicitly so the daemon-reducer's `_Exhaustive` gate compiles, but the meaningful UI state update happens in the new `handle-plan-lifecycle.ts`. (If a `project()` is needed structurally for the registry shape, supply a minimal one that returns the state slice unchanged for these per-session events.)
4. **`formatThinking` fix: deserializer-side normalization (Path A).** Add a `normalizeThinking()` helper invoked at extraction time in `handle-agent.ts` when populating `AgentThread.thinkingOriginal` / `thinkingCoerced`. Maps `budget_tokens` → `budgetTokens`. Belt-and-suspenders defensive both-keys reading inside `formatThinking` itself is acceptable as a cheap addition but is not the primary fix.
5. **`transitionPlan()` becomes a generator.** Convert to `function* transitionPlan(...)` yielding the lifecycle event(s); callers use `yield* transitionPlan(...)`. Mirrors `yield* executePlans(ctx)` shape already used in `orchestrator.ts:198`.
6. **`resumeState()` becomes a generator too.** Same conversion — it calls `transitionPlan` and `mutateState` directly, and is itself called from `orchestrator.ts:112` and `:127`. Conversion strategy: see Files → Modify below for whether to switch the call sites to `yield*` or to drain the generator into the existing event-collection pattern at those sites.
7. **`WorktreeManager` methods return `readonly EforgeEvent[]`.** WorktreeManager is class-based; do not generator-shape the whole class. `reconcile(state)` already returns `Promise<ReconciliationReport>`; extend the report with an `events: EforgeEvent[]` field (or change the return type to `Promise<{ report: ReconciliationReport; events: readonly EforgeEvent[] }>`). The orchestrator caller does `for (const e of events) yield e;`. Pattern matches `phases.ts:387-390`'s existing `for (const e of failureEvents) yield e;`.
8. **New file: `packages/monitor-ui/src/lib/reducer/handle-plan-lifecycle.ts`** — one handler per variant, mirroring the shape of `handle-session.ts`. The session reducer's `handlerRegistry` dispatches the five new types here.
9. **`DAEMON_API_VERSION` 21 → 22.** Comment cites the lifecycle wire-up.
10. **Backward-compat: accept the regression for pre-spine sessions.** Sessions in users' `.eforge/monitor.db` from before the spine merge do not contain `plan:status:change` events. After heuristic deletion, opening such a session shows plan rows with no derived status. This is acceptable per the PRD's risk analysis.

## Scope

### In Scope

- AC #6 — emit lifecycle events from orchestrator/worktree-manager, flip registry to `persist: true` with `project()` shim, add session-reducer handlers, delete inference heuristics in `handle-plan-build.ts`, bump `DAEMON_API_VERSION`.
- AC #8 — wire-side `normalizeThinking()` helper applied at extraction in `handle-agent.ts`; defensive both-keys reading in `formatThinking` if cheap; strengthen `format-thinking.test.ts` from "doesn't throw" to specific-output equality.
- AC #1 — rewrite `event-replay-equivalence.test.ts` to assert (a) replay with `plan:status:change` produces correct `planStatuses`, (b) replay with `plan:status:change` events stripped does NOT produce the same `planStatuses` (proving inference is not happening). Reintroducing any branch of the deleted `handle-plan-build.ts` heuristic logic must cause this test to fail.
- New emission test (`test/lifecycle-event-emission.test.ts` or augmenting `test/agent-wiring.test.ts`) using `StubHarness` per AGENTS.md test conventions, proving the orchestrator emits each of the five lifecycle variants when expected.

### Out of Scope

- The `w3` (SSE handshake), `w4` (row types), `w6` (async mutation sweep) follow-up PRDs.
- Switching `event-log.jsonl` from snapshot-rows to event-delta-rows.
- Recorded-session fixtures or any `scripts/capture-fixture.ts` helper.
- Adding new event variants (the five lifecycle variants exist; we are wiring them).
- Changes to Pi extension surface (Pi consumes the registry — it inherits whichever projection lands here).
- Roadmap edits.
- Restoring inference fallbacks for pre-spine sessions.

## Files

### Create

- `packages/monitor-ui/src/lib/reducer/handle-plan-lifecycle.ts` — one handler function per lifecycle variant. Each handler is naturally idempotent: `plan:status:change` sets `planStatuses[planId] = newStatus`; `plan:error:set` writes; `plan:error:clear` deletes; `merge:worktree:set` writes `mergeWorktreePath`; `merge:worktree:clear` clears it. Mirror `handle-session.ts`'s shape: top-level doc comment listing what the file owns, then exported `handle*` functions typed via `EventHandler<'plan:status:change'>` etc. Stage-advancement responsibility moves here for plan status; build events become wire-level signals only.
- `test/lifecycle-event-emission.test.ts` (or extend `test/agent-wiring.test.ts` if more cohesive) — uses `StubHarness` to drive a small build and asserts the orchestrator yields each of the five lifecycle variants at the expected boundaries: `plan:status:change` for pending→running→completed→merged transitions; `plan:error:set` on failed transitions with metadata; `plan:error:clear` on `resumeState` resets; `merge:worktree:set`/`:clear` on reconcile/merge ops.

### Modify

- `packages/engine/src/orchestrator/plan-lifecycle.ts` — convert `transitionPlan` to `function* transitionPlan(...)` yielding the `plan:status:change` event (and the `plan:error:set` event when `metadata?.error` is set). Convert `resumeState` to `function* resumeState(...)` similarly, yielding `plan:error:clear` events and propagating `transitionPlan` via `yield*`. Both functions still call `mutateState` synchronously before yielding so consumers receive the event after the state mutation has been applied (correct semantics: the event is a notification of a completed mutation).
- `packages/engine/src/orchestrator/phases.ts` — at the five `transitionPlan(state, ...)` call sites (lines 101, 262, 280, 287, 293, 383, 406, 414), replace bare calls with either `yield* transitionPlan(...)` (when in a generator) or push events into `eventQueue` via the existing producer pattern (when in `launchPlan`'s async closure). Critical: `launchPlan` runs as an `async` function, not a generator — adapt by collecting events into an array (or pushing into `eventQueue` directly) the same way `propagateFailure`'s `failureEvents` are handled. Preserve event ordering: `mutateState` runs first, then the event reaches the wire.
- `packages/engine/src/orchestrator.ts` — at lines 112 and 127 where `resumeState(...)` is called outside a generator context, drain the generator into a buffer or restructure so the returned events flow into the orchestrator's event stream. If `executeRun` is itself a generator, prefer `yield* resumeState(...)`. Preserve resumed-state semantics.
- `packages/engine/src/worktree-manager.ts` — at the six `mutateState` call sites in `reconcile()` (lines 238, 247, 255, 271, 285, 306), instead of mutating-and-discarding, append the corresponding `EforgeEvent` to a local events array. Extend `reconcile`'s return type to expose those events to the caller. The orchestrator caller then does `for (const e of events) yield e;` (or pushes into `eventQueue`). Pattern matches `phases.ts:387-390`'s `for (const e of failureEvents) yield e;` shape.
- `packages/client/src/event-registry.ts` — at lines 565-581 (`plan:status:change`, `plan:error:set`, `plan:error:clear`) and 644-652 (`merge:worktree:set`, `merge:worktree:clear`), flip `persist: false` → `persist: true`. Add a `project()` function for each. Per design-decision #3, the meaningful UI projection happens in the session reducer; the registry's `project()` for these per-session events should be a structural minimum — return the state slice unchanged or a no-op signature consistent with existing per-session entries that satisfy the registry type. If the existing daemon-reducer infrastructure requires `project()` to update some daemon-scope state slice, supply the minimal correct shim. Inspect existing session-scoped registry entries that already have `project()` defined for the right pattern to follow.
- `packages/monitor-ui/src/lib/reducer/index.ts` — at lines 261-266, remove the five `plan:status:change`, `plan:error:set`, `plan:error:clear`, `merge:worktree:set`, `merge:worktree:clear` entries from `IGNORED_EVENT_TYPES`. Add the corresponding handlers from the new `./handle-plan-lifecycle` module to `handlerRegistry`. The `_Exhaustive` compile-time check then verifies coverage: removing from `IGNORED_EVENT_TYPES` and adding to `handlerRegistry` must net to zero missing keys.
- `packages/monitor-ui/src/lib/reducer/handle-plan-build.ts` — delete the inference logic that derives `planStatuses` from build events. Specifically: `handlePlanBuildStart` (line 40-41) and `handlePlanBuildImplementStart` (line 43-44) currently call `setStatus(state, planId, 'implement')`; remove the status-setting (keep the handler if it still does other work, or remove the registration if it becomes empty). `handlePlanBuildComplete` (line 99-100) sets `'complete'`; remove. `handlePlanBuildFailed` (line 102-103) sets `'failed'`; remove. `handlePlanMergeComplete` (line 136-139) sets `'complete'`; remove the status-setting (keep `mergeCommits` capture). `handlePlanBuildReviewComplete` (line 91-94) sets `'evaluate'`; this is a stage-within-build advancement, not a plan-level status; keep IF stage-advancement is still UI-relevant per the PipelineStage type — verify via grep on `PipelineStage` consumers. Do NOT remove `fileChanges` updates, `reviewIssues` extraction, or `perspectiveErrors` accumulation; those remain wire-level signals. Document at the top of the file that `planStatuses` is now driven exclusively by `plan:status:change` events.
- `packages/monitor-ui/src/lib/reducer/handle-agent.ts` — add a `normalizeThinking(raw: unknown): { type: string; budgetTokens?: number } | undefined` helper that maps `budget_tokens` → `budgetTokens` (and leaves a value with `budgetTokens` already present untouched). Apply when populating `thinkingOriginal` (line 75) and `thinkingCoerced` (line 74 — note: `thinkingCoerced` is currently a boolean; it is `thinkingOriginal` that is the structured payload to normalize. Verify and apply normalization to whichever fields carry the structured `{ type, budget_tokens }` shape per the wire schema). Keep `formatThinking(event.thinking)` for the display field at line 69; either change to use the normalized version or extend `formatThinking` to defensively read both keys. Pick whichever change matches the data flow: the test in `format-thinking.test.ts` exercises `formatThinking` directly, so `formatThinking` must produce the correct output for snake_case input under the strengthened test.
- `packages/monitor-ui/src/lib/format.ts` — defensively accept both `budgetTokens` and `budget_tokens` in `formatThinking`. One extra line in the existing object-shape branch (line 64-71). This makes the function correct regardless of whether deserializer-side normalization fired; the test then asserts the public-facing behavior.
- `packages/monitor-ui/test/format-thinking.test.ts` — at lines 76-85, replace the weak "either string or undefined" assertion with `expect(formatThinking({ type: 'enabled', budget_tokens: 32000 })).toBe('enabled (32.0k tokens)')`. Remove the "documents current behavior" comment. At lines 103-111, strengthen the same way: `expect(result).toBe('enabled (32.0k tokens)')` (the original wirePayload uses 32000 tokens). Add an edge case for `budget_tokens: 0` (should render `enabled (0 tokens)` per `formatNumber(0)` → `'0'`) and verify large budgets render with the `k` abbreviation.
- `packages/monitor-ui/test/event-replay-equivalence.test.ts` — rewrite the file (or replace the existing fixtures) with a focused regression-gate test. Construct one synthetic event sequence including `plan:status:change` events (e.g., plan-A pending→running→completed→merged; plan-B pending→running→failed). Replay through the reducer; assert `planStatuses['plan-A'] === 'merged'` and `planStatuses['plan-B'] === 'failed'`. Then strip all `plan:status:change` events from the same sequence and replay again; assert `planStatuses` is empty (or does not contain the post-strip statuses), proving the reducer no longer infers from `plan:build:*` events. Keep ~30-50 lines, self-documenting comments. Include a third assertion that `thinkingOriginal` survives round-trip with the post-AC-#8 normalization in place (from `agent:start` → `AgentThread.thinkingOriginal` deep-equal). The PRD says this test passes only after the implementation lands; that property holds because it asserts the new behavior (lifecycle-driven status) directly.
- `packages/client/src/api-version.ts` — bump `DAEMON_API_VERSION` from `21` to `22`. Update the trailing comment to cite the lifecycle wire-up: `// v22: lifecycle events (plan:status:change, plan:error:set, plan:error:clear, merge:worktree:set, merge:worktree:clear) flipped to persist:true and now flow on per-session SSE.`
- `packages/monitor/src/db.ts` — verify (no manual change should be needed): `DAEMON_EVENT_TYPES` derivation already filters registry entries by `persist: true`. Flipping the five flags should pull them in automatically. Confirm by inspection during implementation; if a separate manual list exists, append the five.

### Files NOT to modify (confirmation)

- `packages/client/src/events.schemas.ts` — the five variant schemas already exist; no change needed.
- `packages/engine/src/state.ts` — `mutateState` already handles all five variants; no change.
- `packages/pi-eforge/` — Pi inherits from the registry; no manual change.
- `eforge-plugin/` — no plugin-surface change.
- `docs/roadmap.md` — per PRD, no roadmap edit required.
- `CHANGELOG.md` — per global feedback, do not edit in feature/migration PRs; release flow owns it.

## Verification

- [ ] `pnpm type-check` passes across all 8 workspaces.
- [ ] `pnpm test` passes the full suite, including the rewritten `event-replay-equivalence.test.ts` and the strengthened `format-thinking.test.ts`.
- [ ] `grep -rn "yield\|emit(" packages/engine/src/orchestrator/plan-lifecycle.ts packages/engine/src/worktree-manager.ts` shows non-zero hits proving lifecycle events reach the event stream (initial state per the PRD's gap analysis was zero hits).
- [ ] `grep -n "plan:status:change\|plan:error:set\|plan:error:clear\|merge:worktree:set\|merge:worktree:clear" packages/monitor-ui/src/lib/reducer/index.ts` shows all five as keys in `handlerRegistry` and zero occurrences inside `IGNORED_EVENT_TYPES`.
- [ ] `grep -n "setStatus\|planStatuses" packages/monitor-ui/src/lib/reducer/handle-plan-build.ts` shows no remaining writes to `planStatuses` from `plan:build:start`, `plan:build:implement:start`, `plan:build:complete`, `plan:build:failed`, or `plan:merge:complete` handlers.
- [ ] In `packages/client/src/event-registry.ts`, the five lifecycle variants have `persist: true` and a `project` field defined.
- [ ] `packages/client/src/api-version.ts` exports `DAEMON_API_VERSION = 22` with an updated comment.
- [ ] Running `formatThinking({ type: 'enabled', budget_tokens: 32000 })` returns the literal string `'enabled (32.0k tokens)'` (asserted by the strengthened test).
- [ ] Stripping `plan:status:change` events from the regression-gate test fixture produces a `planStatuses` object that does NOT contain `'merged'` for plan-A or `'failed'` for plan-B (asserted by the rewritten test).
- [ ] `test/lifecycle-event-emission.test.ts` (or augmented `test/agent-wiring.test.ts`) passes via `StubHarness` and asserts at least one emission of each of the five lifecycle variants under the appropriate orchestrator path.
- [ ] No raw direct field assignments to `plan.status`, `plan.error`, `state.completedPlans`, or `state.mergeWorktreePath` outside `packages/engine/src/state.ts` (existing repo invariant — verified via the same grep gate AGENTS.md describes).
- [ ] Manual smoke (post-merge): start a fresh eforge build, open the monitor UI, watch plan rows transition `pending → running → completed → merged`. The SSE network panel shows `plan:status:change` frames. No plan-row status updates are derived from `plan:build:start`/`plan:build:complete`/`plan:build:failed` alone.
