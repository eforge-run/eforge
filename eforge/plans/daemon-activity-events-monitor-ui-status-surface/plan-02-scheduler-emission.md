---
id: plan-02-scheduler-emission
name: Scheduler decision events with dedup
branch: daemon-activity-events-monitor-ui-status-surface/scheduler-emission
agents:
  builder:
    effort: high
    rationale: "Dedup logic at two granularities (per-tick total for capacity,
      per-(prdId)-per-tick for dependency) requires careful state tracking and
      is the named risk #2 in the PRD."
---

# Scheduler decision events with dedup

## Architecture Context

Per AGENTS.md "engine emits, consumers render", scheduler decisions originate inside the engine, not the daemon. The scheduler is the only call site that knows *why* it didn't dequeue (capacity vs. dependency); a daemon-side wrapper would have to recreate the decision context. The daemon consumes the events through the existing recording pipeline like any other engine event.

The naming `daemon:scheduler:*` (vs `engine:scheduler:*`) is honest because the scheduler currently only runs inside the daemon's lifetime. If the scheduler is ever extracted into a standalone process, we rename then.

Key verified facts:

- The scheduler lives at `packages/engine/src/queue/scheduler.ts` (the PRD said `packages/engine/src/scheduler.ts`).
- `QueueScheduler` is defined around line 91-387; `tick()` is the private async method around line 331.
- The dequeue path that sets `state.status = 'running'` is around line 278 in `startReadyPrds()`.
- The existing `queue:prd:discovered` emission uses `eventQueue.push(...)` around lines 226-231 and 248-253 — this is the pattern to follow.
- Engine tests live in `packages/engine/test/` (not `src/__tests__/`).
- This plan's new event types (`daemon:scheduler:dequeued`, `:capacity-blocked`, `:dependency-blocked`) are added to the wire union in plan-01; this plan strictly produces them.

## Implementation

### Overview

Push three new daemon-scoped events from `QueueScheduler.tick()` and its callees, with two flavors of dedup so the stream stays informative rather than spamming.

### Key Decisions

1. **Dedup state lives inside `tick()`.** Each `tick()` invocation creates fresh local sets, so dedup naturally resets between ticks. No instance-level state to clear.
2. **Capacity-blocked: at most one event per `tick()` total.** If the concurrency limit prevents starting any PRD this tick, emit one event regardless of how many candidates were rejected. Track via a single boolean local (e.g. `capacityBlockedEmittedThisTick`).
3. **Dependency-blocked: at most one event per `(prdId)` per tick.** Multiple PRDs can be blocked, but each PRD only emits once per tick. Track via a `Set<string>` of `prdId`s already emitted this tick.
4. **Dequeued is unconditional.** Push immediately after `state.status = 'running'` is set — no dedup needed because each successful dequeue is meaningful.
5. **Reuse existing `eventQueue.push(...)` pattern.** Same call shape as `queue:prd:discovered` at line 226. The recording infra downstream already handles persistence and SSE delivery for daemon-allowlisted events.
6. **sessionId/runId on these events.** Reuse whatever session context is already in scope at the emission point (matching how `daemon:auto-build:paused` is currently emitted at the daemon level). The UI-side daemon-only filter is at render time, not at emission time, so any sessionId is acceptable.

## Scope

### In Scope

- Modify `QueueScheduler.tick()` (and `startReadyPrds()`) in `packages/engine/src/queue/scheduler.ts` to push:
  - `daemon:scheduler:dequeued` immediately after `state.status = 'running'` is set in the dequeue path, with `{ prdId, queueDepth, capacityRemaining }`.
  - `daemon:scheduler:capacity-blocked` once per `tick()` total when concurrency limit prevents at least one start, with `{ queueDepth, runningCount, limit }`.
  - `daemon:scheduler:dependency-blocked` once per `(prdId)` per `tick()` when `isReady()` returns false, with `{ prdId, blockedBy: string[] }`.
- Add or extend a vitest in `packages/engine/test/scheduler.test.ts` (path subject to actual test layout — use the directory that mirrors existing engine tests) that drives the scheduler with synthetic PRDs against a real `EventEmitter` + `AsyncEventQueue`, then asserts:
  - `:dequeued` fires once per successful dequeue with the documented fields.
  - `:capacity-blocked` fires at most once per tick when capacity is exhausted, regardless of how many PRDs were waiting.
  - `:dependency-blocked` fires at most once per `(prdId)` per tick, regardless of how many missing dependencies the PRD has.

### Out of Scope

- Adding the wire types to `events.ts` — handled by plan-01.
- Adding the new types to `DAEMON_EVENT_TYPES` allowlist — handled by plan-01.
- Daemon UI handling — handled by plan-03.
- Any `daemon:scheduler:tick` event — explicitly excluded by the PRD.

## Files

### Modify

- `packages/engine/src/queue/scheduler.ts` — add the three emissions and dedup state inside `tick()`. The exact placement: `:dequeued` immediately after `state.status = 'running'` (~line 278); `:capacity-blocked` and `:dependency-blocked` inside the candidate-evaluation loop in `startReadyPrds()`. Keep changes additive to the existing `eventQueue.push(...)` pattern; do not introduce new abstractions.
- `packages/engine/test/scheduler.test.ts` (extend or create at the location matching the existing engine test layout) — vitest coverage as described above. No mocks; construct PRDs and a real `EventEmitter`+`AsyncEventQueue` directly, drain the queue and inspect emitted events.

## Verification

- [ ] Pushing N PRDs onto the queue with a concurrency limit of K (where N > K) produces exactly K `daemon:scheduler:dequeued` events in the first tick; each carries `prdId`, `queueDepth` (matching `N - already-dequeued`), and `capacityRemaining` (matching `limit - runningCount`).
- [ ] The same scenario emits exactly one `daemon:scheduler:capacity-blocked` event per tick where capacity was exhausted, regardless of how many PRDs were left waiting; payload carries `queueDepth`, `runningCount`, and `limit`.
- [ ] Pushing a PRD with M unmet dependencies emits exactly one `daemon:scheduler:dependency-blocked` event per tick (not M), with `blockedBy` listing all M blockers.
- [ ] Pushing two PRDs each with unmet dependencies in the same tick emits exactly two `daemon:scheduler:dependency-blocked` events (one per `(prdId)` per tick), not 2*M.
- [ ] Across two consecutive `tick()` invocations where both ticks are capacity-blocked, exactly two `daemon:scheduler:capacity-blocked` events are emitted (dedup is per-tick, not global).
- [ ] No new abstractions added; emissions use the existing `eventQueue.push(...)` pattern, identical in shape to the `queue:prd:discovered` emission at lines 226-231.
- [ ] `pnpm type-check`, `pnpm test`, and `pnpm build` all pass.
