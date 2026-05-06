---
title: Close spine AC shortfalls from event-source-spine merge
created: 2026-05-06
---

# Close spine AC shortfalls from event-source-spine merge

## Problem / Motivation

Merge `14f3fb4` (event-source-spine expedition) shipped on 2026-05-06. The build that produced it failed to spawn review agents. A post-merge code review surfaced three Acceptance Criteria from `tmp/event-source-refactor/expedition-spine.md` that the merge claims to meet but did not fully deliver:

- **AC #6** — "Reducer no longer uses inference heuristics. Status comes from `plan:status:change` events, not from `plan:build:start` presence." Engine state IS event-sourced via `mutateState`, but the monitor UI still infers plan-row status from build events.
- **AC #8** — "An `agent:start` carrying `thinkingCoerced` and `thinkingOriginal` reaches the monitor UI hover." Fields reach the hover, but render as raw JSON instead of formatted text because `formatThinking` reads `budgetTokens` (camelCase) while the wire schema emits `budget_tokens` (snake_case).
- **AC #1** — "Pure-event replay equivalence test passes: given a recorded session's event log, the reducer reconstructs an `EforgeState` byte-equivalent to that session's `state.json`. Test must fail on `main`; passes after merge." What shipped is a synthetic-fixture self-consistency test (ADD_EVENT vs BATCH_LOAD using the same reducer), not a replay-vs-snapshot equivalence test.

Three follow-up PRDs (`w3` SSE handshake, `w4` row types, `w6` async mutation sweep) sit in `tmp/event-source-refactor/`. None of them addresses these three shortfalls. They target separate findings (F4/F5, F7, F10/F11) from the original assessment. This planning conversation owns these three gaps as a self-contained bundle.

### Concrete state of each gap (verified 2026-05-06)

**AC #6 — lifecycle events stop at the engine boundary.**
- Engine yields/emits zero of the five new variants. Confirmed by `grep "yield\|emit("` over `packages/engine/src/orchestrator/plan-lifecycle.ts` and `packages/engine/src/worktree-manager.ts`: zero hits. `mutateState(state, event)` is called locally; the event object is never put on the orchestrator's event stream.
- Registry entries (`packages/client/src/event-registry.ts:558-574, 637-645`) are `scope: 'session', persist: false` with **no `project()` function**. So even if the events flowed on the SSE wire, the registry-driven daemon-reducer would not project them into UI state.
- Session reducer lists them in `IGNORED_EVENT_TYPES` (`packages/monitor-ui/src/lib/reducer/index.ts:259-265`) with the explicit comment "monitor UI handling is deferred." This is purely for `_Exhaustive` type-check satisfaction, not because the events ever flow.
- The monitor UI still derives plan-row state from `plan:build:start`, `plan:build:complete`, `plan:build:failed`, etc. — the inference heuristics the spine claimed to delete.

**AC #8 — `formatThinking` wire format mismatch is documented as known behavior.**
- `packages/monitor-ui/test/format-thinking.test.ts:76-92` documents: "The Zod schema emits `budget_tokens`; `formatThinking` reads `budgetTokens`." The test deliberately weakens its assertion to `expect(typeof result === 'string' || result === undefined).toBe(true)` to allow the JSON-fallback path.
- Net effect at runtime: when `thinkingOriginal` arrives via the wire, the agent-stage hover shows `{"type":"enabled","budget_tokens":32000}` instead of `enabled (32.0k tokens)`.
- Either the wire deserializer needs to normalize snake → camel, or `formatThinking` needs to read both keys. The systemic fix is the deserializer (this would also catch any future snake_case fields).

**AC #1 — replay-equivalence test is a self-consistency check, not a replay-vs-snapshot gate.**
- `packages/monitor-ui/test/event-replay-equivalence.test.ts:9-16` says "MUST fail on main because (a) `packages/monitor-ui/test/` is not in main's vitest include patterns, (b) the assertions on `thinkingCoerced`/`thinkingOriginal` depend on plan-04 adding those fields." That's a test-ergonomics fail, not a behavior fail.
- The test compares `ADD_EVENT` vs `BATCH_LOAD` paths through the *same* (new) reducer, not the new reducer's replay output against a recorded `state.json`. Three scenarios (merge / errors / recovery) are hand-crafted programmatically (lines 86-333), not pulled from a real `event-log.jsonl`.
- AC #1's promise was about replay equivalence over a *recorded* session. That requires (a) a recorded fixture (a real `event-log.jsonl` and the corresponding `state.json` it produced), (b) replaying through the new reducer, (c) deep-equal against the snapshot.

### Architectural note (surfaced while gathering context)

The on-disk "event log" (`event-log.jsonl`, written by `appendSnapshotToEventLog` at `packages/engine/src/state.ts:54-65`) contains only `__snapshot` rows — full state snapshots — not raw event deltas. The engine's "event sourcing" is actually snapshot-sourced. This is fine as a recovery mechanism, but it means there is currently no on-disk event-delta artifact to use as an AC #1 fixture. Recording sessions for the AC #1 fixture means writing event deltas to the log, or deriving them from the daemon's `monitor.db` `events` table. **This is a real design question for the AC #1 dimension.**

### Project conventions in scope

- **Engine emits, consumers render** (AGENTS.md). Re-yielding lifecycle events from the orchestrator is consistent with this principle.
- **State mutation is single-entry-point** (AGENTS.md). All mutations already route through `mutateState`. Yielding the same event after `mutateState` returns preserves the invariant.
- **Event types and schemas are co-located** (AGENTS.md). The five lifecycle variants are already in `events.schemas.ts`; only registry metadata changes.
- **DAEMON_API_VERSION** must bump if the SSE wire surface changes (AGENTS.md note in api-version.ts).

### Roadmap alignment

`docs/roadmap.md` line 32 ("Typed SSE events in client package") was removed in plan-04 of the spine. No roadmap item explicitly tracks lifecycle-events-to-UI; it was bundled inside the spine and slipped. Closing it does not require a roadmap edit unless the user wants to surface it as a follow-up commitment.

## Goal

Close the three Acceptance Criteria shortfalls (AC #6, #8, #1) from the event-source-spine merge by projecting lifecycle events end-to-end into monitor UI state, fixing the `formatThinking` snake_case ↔ camelCase mismatch, and replacing the synthetic replay-equivalence fixture with a sharper regression gate against inference reintroduction — all in a single self-contained PRD / build with shared review session and acceptance gate.

## Approach

### High-level technical decisions

**1. Per-session SSE only — not daemon-events SSE.** Plan progression is per-session state. The lifecycle events flow on the per-session SSE stream (the same stream that already carries `plan:build:*`). They do not need to flow on the daemon-events SSE. *Why:* plan status is scoped to a single eforge build session; the multi-session queue/runs panel doesn't need fine-grained plan transitions.

**2. `scope: 'session'` stays, `persist: true` flips on.** `persist: true` so the daemon stores them in `monitor.db` events. Consequences: (a) reconnecting clients replay them via the SSE handshake, (b) `DAEMON_EVENT_TYPES` derivation pulls them in automatically, (c) the AC #1 regression gate has realistic inputs available.

**3. Projection lives in the session reducer, not in the registry's `project()` function.** The registry's `project()` is consumed by the daemon-reducer (cross-session UI). Plan status is per-session — the per-session reducer (`packages/monitor-ui/src/lib/reducer/index.ts`) is the right home. `project: undefined` is acceptable in the registry for these five variants; the `_Exhaustive` type gate is satisfied because the variants are now keys in the session-reducer handler registry rather than in `IGNORED_EVENT_TYPES`.

**4. `formatThinking` fix: Path A (deserializer-side normalization).** Normalize at extraction time in `handle-agent.ts:71-72`. One small `normalizeThinking()` helper maps `budget_tokens` → `budgetTokens` when storing into `AgentThread.thinkingOriginal` / `thinkingCoerced`. *Why:* contains snake/camel translation to the wire boundary, doesn't pollute `formatThinking` with both-keys logic. Defensive both-keys reading in `formatThinking` itself is acceptable as a belt-and-suspenders cheap addition, not the primary fix.

**5. `transitionPlan()` becomes a generator.** Convert to `function* transitionPlan(...)`; callers use `yield* transitionPlan(...)`. *Why:* matches how the orchestrator already composes via `yield* executePlans(ctx)`. Events flow naturally through the chain. Cleaner than the alternative of building up an `EforgeEvent[]` and yielding it manually.

**6. `WorktreeManager` methods return `readonly EforgeEvent[]`, callers yield.** WorktreeManager is class-based, not generator-based. Generator-shaping the whole class is out of scope. Each mutating method returns the events it produced; the orchestrator caller does `for (const e of events) yield e;`. Pattern matches `phases.ts:387-390`'s existing `failureEvents` handling.

**7. New file: `packages/monitor-ui/src/lib/reducer/handle-plan-lifecycle.ts`.** One handler per variant. Mirrors the shape of `handle-session.ts`. The session reducer dispatches the five new types here.

**8. `DAEMON_API_VERSION` bump v20 → v21.** The variants existed at v19 but never reached the wire; flipping `persist: true` and emitting them is an effective wire-surface change. Reconnecting old clients will see unfamiliar event types and skip them — additive, no breakage.

### Code Impact

**Files that change for AC #6:**

- `packages/engine/src/orchestrator/plan-lifecycle.ts:46, 96, 105` — at the existing `mutateState(...)` call sites, additionally `yield` the same event so it reaches the SSE stream. `transitionPlan()` and `resumeState()` currently return; convert `transitionPlan()` to a generator (or have callers `yield` after invocation) and propagate via `yield*`. The orchestrator's generator at `packages/engine/src/orchestrator.ts:198` (`yield* executePlans(ctx)`) and downstream phases at `packages/engine/src/orchestrator/phases.ts:355` (`yield event;`) already pump events through to the wire.
- `packages/engine/src/worktree-manager.ts:238, 247, 255, 271, 285, 306` — same treatment for the six `mutateState` call sites. WorktreeManager is class-based, not generator-based — return events from each method as `EforgeEvent[]` and have the orchestrator caller yield them. (Pattern: see how `phases.ts:389` does `for (const e of failureEvents) yield e;`.)
- `packages/client/src/event-registry.ts:558-574, 637-645` — flip `persist: false` → `persist: true` for the five variants and add `project()` functions. Projection target: see design-decisions for the reducer-vs-registry split.
- `packages/monitor-ui/src/lib/reducer/index.ts:259-265` — remove the five from `IGNORED_EVENT_TYPES`, add handlers via a new `handle-plan-lifecycle.ts` file (matching the existing handler-file shape).
- `packages/monitor-ui/src/lib/reducer/handle-plan-build.ts` — delete the inference-heuristic logic that derives `planStatuses` from `plan:build:start` / `plan:build:complete` / `plan:build:failed`. Keep build events for stage-advance, timing, and agent-thread bookkeeping; status derives only from `plan:status:change` going forward.
- `packages/monitor/src/db.ts` — no manual change needed; `DAEMON_EVENT_TYPES` already derives from `persist: true` registry entries, so flipping the flag pulls them in automatically.
- `packages/client/src/api-version.ts` — bump v20 → v21 (SSE wire surface gains five persisted variants).

**Files that change for AC #8:**

- `packages/monitor-ui/src/lib/reducer/handle-agent.ts:71-72` — normalize the `thinking` payload at extraction time. One small helper (e.g., `normalizeThinking(raw): { type, budgetTokens? }`) that maps `budget_tokens` → `budgetTokens`. Apply to both `thinkingOriginal` and `thinkingCoerced` when populating `AgentThread`.
- `packages/monitor-ui/test/format-thinking.test.ts:76-92` — strengthen the snake_case test from `expect(typeof result === 'string').toBe(true)` to `expect(formatThinking(snakeCasePayload)).toBe('enabled (32.0k tokens)')`. Update `formatThinking` itself only if the deserializer-side fix doesn't fully cover (it should — but also accept both keys defensively in `formatThinking` if cheap).
- Optionally: `packages/monitor-ui/test/format-thinking.test.ts` gains edge cases for `budgetTokens: 0` and very large budgets.

**Files that change for AC #1:**

- `packages/monitor-ui/test/event-replay-equivalence.test.ts` — rewrite. Construct one synthetic event sequence including `plan:status:change` lifecycle events. Replay through the reducer. Assert `planStatuses` reflects the lifecycle (e.g., plan-A `merged`, plan-B `failed`). Replay the same sequence with `plan:status:change` events filtered out. Assert the resulting `planStatuses` is empty / does not infer status from the still-present `plan:build:*` events. This proves inference heuristics aren't sneaking back. ~30–50 lines.
- No fixtures directory, no capture script.

**Existing patterns to reuse:**

- Event-emit pattern: `packages/engine/src/orchestrator/phases.ts:206-217` for clean `yield { timestamp, type, ... }` calls. Mirror that shape.
- Returning events from a class method (worktree-manager pattern): `phases.ts:387-390` consumes `failureEvents: EforgeEvent[]` via `for (const e of failureEvents) yield e;`.
- Handler-file pattern: `packages/monitor-ui/src/lib/reducer/handle-session.ts` for one-function-per-event handler files.
- Registry `project()` pattern: `packages/client/src/event-registry.ts` already has `project()` functions for daemon-scoped events (e.g., `enqueue:complete` ~line 898). Mirror the shape.

**Test coverage:**

- `test/agent-wiring.test.ts` (or new `test/lifecycle-event-emission.test.ts`) — assert the orchestrator emits `plan:status:change` when transitioning. Use `StubHarness` per AGENTS.md.
- `packages/monitor-ui/test/event-replay-equivalence.test.ts` — the AC #1 regression gate (rewritten).
- `packages/monitor-ui/test/format-thinking.test.ts` — AC #8 strengthened assertion.

**Dependency relationships within the build:**

- AC #6 wire-up first (engine emission + registry + reducer handler + heuristic deletion).
- AC #8 fix can land in parallel (no dependency on AC #6).
- AC #1 test rewrite must come after AC #6 (the test exercises the new reducer behavior).

### Natural boundaries

- `packages/engine/src/orchestrator/plan-lifecycle.ts`, `packages/engine/src/worktree-manager.ts` — emission paths.
- `packages/client/src/event-registry.ts` — registry metadata for the five variants.
- `packages/monitor/src/db.ts` — `DAEMON_EVENT_TYPES` derivation extends to include the now-persistent variants (auto via existing `persist: true` filter).
- `packages/monitor-ui/src/lib/reducer/index.ts` — remove from `IGNORED_EVENT_TYPES`, add handlers, delete inference heuristics.
- `packages/monitor-ui/src/lib/format.ts` (or wire deserializer upstream) — `formatThinking` fix.
- `packages/monitor-ui/test/event-replay-equivalence.test.ts` — rewritten to be a regression gate against inference reintroduction.
- `packages/client/src/api-version.ts` — bump (SSE wire surface gains five variants).

### Risks

**1. Pre-spine recorded sessions render with empty `planStatuses`.** Sessions in users' `.eforge/monitor.db` from before the spine merge don't contain `plan:status:change` events. After heuristic deletion, opening such a session in the monitor UI shows plan rows with no derived status. **Decision: accept the regression** — pre-spine sessions are pre-history, looking back at them is rare, and the alternative (keep one narrow fallback in the session reducer) muddies the "events are the source of truth" stance.

**2. Plan-merge partial-application risk inside the build.** eforge orchestrates multi-plan builds. If a hypothetical split landed engine emission as one plan and UI handlers as another, in-flight builds would emit events nobody consumes. **Mitigation: bundle all AC #6 wire-up** (engine emission + registry flag + session reducer handlers + heuristic deletion) into **one** plan within the build. The plan is ~7 files; one cohesive unit.

**3. `transitionPlan()` generator conversion misses a caller.** Callers must change from `transitionPlan(...)` to `yield* transitionPlan(...)`. A missed caller silently fails to emit. **Mitigation:** TypeScript flags this — `yield*` of a non-generator is a type error. Run `pnpm type-check` and grep for `transitionPlan(` after the change.

**4. Backward-compat with the existing replay-equivalence test.** The current synthetic test (ADD_EVENT vs BATCH_LOAD) replays event sequences without `plan:status:change`. After heuristic deletion, those replays produce different `planStatuses` than the test asserts. **Mitigation:** AC #1's test rewrite covers this — same plan.

**5. Volume increase in `monitor.db` events table.** `persist: true` for the five variants adds ~3 rows per plan transition. A 4-plan expedition is ~12 extra rows (~1 KB/build). Negligible.

**6. `formatThinking` fix surface — multiple agent event paths read `thinking`.** `handle-agent.ts` reads `thinking` for `agent:start` and possibly future `agent:*` events. The `normalizeThinking()` helper must be applied at every read site. **Mitigation:** keep the helper small; grep `event.thinking` after the change.

**7. SSE event ordering at lifecycle boundaries.** `mutateState` runs synchronously; the `yield` follows. Order is `[mutateState] → [yield]`. The state is already mutated by the time consumers receive the event. This is correct semantics (the event is a notification that the mutation happened); flagged because it's the inverse of an emit-then-apply pattern. No action needed — just don't refactor to "emit before apply."

**8. Reconnect duplicates with `persist: true`.** Once persisted, lifecycle events replay on reconnect via SSE `Last-Event-ID`. Non-idempotent handlers could double-apply. **Mitigation:** all five lifecycle handlers are naturally idempotent — `plan:status:change` sets `planStatuses[planId] = newStatus`; `plan:error:set` / `merge:worktree:set` overwrite; clears delete. Verify during implementation.

### Profile Signal

**Recommendation: Excursion.**

Rationale:
- ~7–10 files modified across 4 packages (engine, client, monitor-ui, monitor) — typical multi-file refactor scope.
- One cohesive change, not 4+ independent subsystems. The three AC closures are tightly coupled (AC #6 wire-up enables AC #1's regression gate; AC #8 piggybacks on the same monitor-ui changeset).
- Design decisions are resolved upfront (8 settled in design-decisions); the implementing agent doesn't have architecture-level judgment calls left.
- No new functionality — completing a refactor the spine started.
- Above the Errand bar (not a typo / single-line fix); below the Expedition bar (no cross-cutting subsystem split).

## Scope

All three AC closures bundle into a single PRD / single build. Shared review session and shared acceptance gate.

### In scope

1. **AC #6 — lifecycle events end-to-end.** Yield the five lifecycle variants (`plan:status:change`, `plan:error:set`, `plan:error:clear`, `merge:worktree:set`, `merge:worktree:clear`) from the orchestrator alongside their `mutateState` calls. Add registry metadata (`persist: true` + a `project()` function) so the daemon-reducer projects them into UI state. Move the variants out of the session reducer's `IGNORED_EVENT_TYPES` and add real handlers. Delete the inference heuristics in the session reducer that derive plan status from `plan:build:start` / `plan:build:complete` / `plan:build:failed` — those build events become wire-level signals only, with status derived from explicit `plan:status:change` events.

2. **AC #8 — thinking-field rendering.** Make `thinkingOriginal` / `thinkingCoerced` render correctly in the agent-stage hover regardless of wire-format casing. Strengthen `packages/monitor-ui/test/format-thinking.test.ts` from a "doesn't throw" assertion to a specific-output assertion that catches the regression.

3. **AC #1 — pragmatic replay-equivalence gate (redefined).** AC #1's stated wording was "recorded session, byte-equivalent state.json replay" — recorded fixtures are heavy and the inference-heuristics-during-fixture-synthesis irony makes the strict reading awkward. The valuable underlying property is "test catches a regression that reintroduces inference heuristics." Closure: rewrite (or augment) `packages/monitor-ui/test/event-replay-equivalence.test.ts` so it replays a synthetic event sequence that includes `plan:status:change` events, asserts `planStatuses` reflects the lifecycle, then replays the same sequence with `plan:status:change` events stripped and asserts `planStatuses` is empty/incomplete — proving the reducer relies on explicit lifecycle events, not inference. ~30–50 lines, self-documenting, sharper regression gate than a recorded fixture would have given.

### Out of scope

- The `w3` (SSE handshake), `w4` (row types), `w6` (async mutation sweep) follow-up PRDs — separate workstreams.
- Switching `event-log.jsonl` from snapshot-rows to event-delta-rows.
- Recorded-session fixtures and any `scripts/capture-fixture.ts` helper.
- Adding new event variants. The five lifecycle variants exist; we're wiring them.
- Changes to Pi extension surface (Pi consumes the registry — it inherits whichever projection lands).
- Roadmap edits.

## Acceptance Criteria

### AC #6 — Lifecycle events drive UI state

1. The orchestrator emits all five lifecycle variants (`plan:status:change`, `plan:error:set`, `plan:error:clear`, `merge:worktree:set`, `merge:worktree:clear`) on the SSE stream wherever `mutateState` is called for them. Each `mutateState(state, lifecycleEvent)` call site has a paired `yield`/return-and-yield path. Asserted in a new emission test using `StubHarness` (per AGENTS.md test conventions).
2. The five variants have `persist: true` and a `project()` function each in `packages/client/src/event-registry.ts`.
3. `packages/monitor-ui/src/lib/reducer/index.ts` no longer lists the five in `IGNORED_EVENT_TYPES`; they are dispatched to a new `handle-plan-lifecycle.ts`.
4. The inference logic in `handle-plan-build.ts` that derives `planStatuses` from `plan:build:start` / `plan:build:complete` / `plan:build:failed` is deleted. `planStatuses` is populated only from `plan:status:change` going forward.
5. `DAEMON_API_VERSION` is bumped v20 → v21 with a comment line citing the lifecycle wire-up.

### AC #8 — Thinking-field rendering

6. An `agent:start` event whose `thinking` payload is `{ type: 'enabled', budget_tokens: 32000 }` (snake_case wire shape) renders `enabled (32.0k tokens)` in the agent-stage hover — not raw JSON.
7. `packages/monitor-ui/test/format-thinking.test.ts:76-92` is strengthened from `expect(typeof result === 'string').toBe(true)` to a deterministic equality assertion. The "documents current behavior" comment is removed.

### AC #1 — Regression gate against inference reintroduction

8. `packages/monitor-ui/test/event-replay-equivalence.test.ts` includes a test that replays a synthetic event sequence including `plan:status:change` events, asserts `planStatuses` reflects the lifecycle, then replays the same sequence with `plan:status:change` events stripped and asserts `planStatuses` does NOT reach the same value (proving inference is not happening).
9. Reintroducing any branch of the deleted `handle-plan-build.ts` heuristic logic causes test #8 to fail.

### Cross-cutting

10. `pnpm type-check` passes across all 8 workspaces.
11. `pnpm test` passes for the full suite.
12. After the build, manually opening the monitor UI on a fresh eforge build shows plan rows transitioning `pending → running → completed/merged` driven by `plan:status:change` events visible in the SSE network panel — not by build event presence.
