---
title: Event ID Renames
created: 2026-04-24
---

# Event ID Renames

## Problem / Motivation

The current event taxonomy in `packages/engine/src/events.ts` has two structural problems:

1. **`build:*` reads as session-scoped but is per-plan.** Every variant carries `planId` and is emitted once per plan from `runBuildPipeline` (`packages/engine/src/pipeline/runners.ts:236`). Hooks listening on `build:complete` therefore fire N times per run, which is what produced the user's 9-notification expedition. The bare `build:` prefix is misleading.

2. **The existing `plan:*` namespace is actually the *planning-phase activity*, not per-plan.** `plan:start`, `plan:complete`, `plan:review:*`, `plan:evaluate:*`, etc. are emitted **once per planning phase**, with payloads like `plans: PlanFile[]` rather than `planId`. The prefix collides semantically with the per-plan lifecycle we want to expose.
   - Confirmed: `plan:complete` is emitted once with the full plan-set in `packages/engine/src/agents/planner.ts:322`.
   - Confirmed: `plan:start` is emitted once at the start of planning in `packages/engine/src/agents/planner.ts:165`.
   - `plan:progress` already leaks across the boundary, fired from inside the build pipeline at `packages/engine/src/pipeline/runners.ts:221`.

The user has confirmed there are no external consumers, so we will do a clean break — no compat shims, no aliases, no DB migration.

## Goal

Produce a namespace where the prefix unambiguously indicates the scope (`session:` / `phase:` = run-wide, `planning:` = compile phase, `plan:` = per-plan artifact lifecycle, `agent:` = per-invocation, `expedition:` = wave/module orchestration), so consumers (hooks, UI, monitor queries) can reason about event cardinality from the name alone.

## Approach

### Recommended namespace scheme

| Scope | Prefix | Examples |
|-------|--------|----------|
| Run-wide envelope | `session:` | `session:start`, `session:end` |
| Per command (compile or build) | `phase:` | `phase:start`, `phase:end` |
| Compile phase activity (one set of events per phase) | `planning:` | `planning:start`, `planning:complete`, `planning:review:complete` |
| Per-plan artifact lifecycle | `plan:` | `plan:build:complete`, `plan:merge:start`, `plan:schedule:ready` |
| Feature-branch finalization (run-wide, after all plans) | `merge:finalize:` | unchanged — distinct from `plan:merge:*` |
| Per-agent invocation | `agent:` | unchanged |
| Expedition wave/module orchestration | `expedition:` | unchanged |
| Global warnings | `config:warning`, `planning:warning` | `plan:warning` → `planning:warning` |

Rule going forward: **the prefix carries the scope; payload field corroborates** (`session:` ↔ `sessionId`, `phase:` ↔ `runId`, `plan:` ↔ `planId`, `agent:` ↔ `agentId`, `expedition:wave:` ↔ `wave`, `expedition:module:` ↔ `moduleId`).

### Rename table

#### `build:*` → `plan:build:*` (24 events, all carry `planId`)

```
build:start                                  → plan:build:start
build:implement:start                        → plan:build:implement:start
build:implement:progress                     → plan:build:implement:progress
build:implement:continuation                 → plan:build:implement:continuation
build:implement:complete                     → plan:build:implement:complete
build:files_changed                          → plan:build:files_changed
build:review:start                           → plan:build:review:start
build:review:complete                        → plan:build:review:complete
build:review:parallel:start                  → plan:build:review:parallel:start
build:review:parallel:perspective:start      → plan:build:review:parallel:perspective:start
build:review:parallel:perspective:complete   → plan:build:review:parallel:perspective:complete
build:review:fix:start                       → plan:build:review:fix:start
build:review:fix:complete                    → plan:build:review:fix:complete
build:evaluate:start                         → plan:build:evaluate:start
build:evaluate:continuation                  → plan:build:evaluate:continuation
build:evaluate:complete                      → plan:build:evaluate:complete
build:doc-update:start                       → plan:build:doc-update:start
build:doc-update:complete                    → plan:build:doc-update:complete
build:test:write:start                       → plan:build:test:write:start
build:test:write:complete                    → plan:build:test:write:complete
build:test:start                             → plan:build:test:start
build:test:complete                          → plan:build:test:complete
build:complete                               → plan:build:complete
build:failed                                 → plan:build:failed
```

#### `merge:*` (per-plan) → `plan:merge:*`

```
merge:start                  → plan:merge:start
merge:complete               → plan:merge:complete
merge:resolve:start          → plan:merge:resolve:start
merge:resolve:complete       → plan:merge:resolve:complete
```

`merge:finalize:start | :complete | :skipped` stay as-is — they are run-scoped (feature branch → base) and the distinct `:finalize` infix already separates them from per-plan merges.

#### `schedule:*` (split scope) → split

```
schedule:start    (session-scoped, planIds: string[])  → keep as schedule:start
schedule:ready    (per-plan, planId)                   → plan:schedule:ready
```

#### `plan:*` (planning-phase activity) → `planning:*`

```
plan:warning                          → planning:warning
plan:start                            → planning:start
plan:skip                             → planning:skip
plan:submission                       → planning:submission
plan:error                            → planning:error
plan:clarification                    → planning:clarification
plan:clarification:answer             → planning:clarification:answer
plan:progress                         → planning:progress
plan:continuation                     → planning:continuation
plan:pipeline                         → planning:pipeline
plan:complete                         → planning:complete

plan:review:start                     → planning:review:start
plan:review:complete                  → planning:review:complete
plan:evaluate:start                   → planning:evaluate:start
plan:evaluate:continuation            → planning:evaluate:continuation
plan:evaluate:complete                → planning:evaluate:complete

plan:architecture:review:start        → planning:architecture:review:start
plan:architecture:review:complete     → planning:architecture:review:complete
plan:architecture:evaluate:start      → planning:architecture:evaluate:start
plan:architecture:evaluate:continuation → planning:architecture:evaluate:continuation
plan:architecture:evaluate:complete   → planning:architecture:evaluate:complete

plan:cohesion:start                   → planning:cohesion:start
plan:cohesion:complete                → planning:cohesion:complete
plan:cohesion:evaluate:start          → planning:cohesion:evaluate:start
plan:cohesion:evaluate:continuation   → planning:cohesion:evaluate:continuation
plan:cohesion:evaluate:complete       → planning:cohesion:evaluate:complete
```

#### Fix the cross-namespace leak

`packages/engine/src/pipeline/runners.ts:221` currently emits `plan:progress` from inside the build pipeline (post-parallel-group auto-commit failure). After rename, that becomes `planning:progress` which would be wrong. Replace with a new per-plan build event:

```
+ plan:build:progress  { planId: string; message: string }
```

and emit that from runners.ts:221 instead.

#### Untouched

`session:*`, `phase:*`, `agent:*`, `expedition:*`, `config:warning`, `merge:finalize:*` — already correct.

## Scope

### In scope

Source of truth + emitters + consumers, all in `/Users/markschaake/projects/eforge-build/eforge`:

**Type definitions (1):**
- `packages/engine/src/events.ts` — update all union variants and section comments.

**Engine emitters (~25 sites across 9 files):**
- `packages/engine/src/pipeline/runners.ts` (build:start/complete + the new `plan:build:progress`)
- `packages/engine/src/agents/builder.ts` (5 sites)
- `packages/engine/src/agents/tester.ts` (4 sites)
- `packages/engine/src/agents/doc-updater.ts` (2 sites)
- `packages/engine/src/agents/review-fixer.ts` (2 sites)
- `packages/engine/src/agents/parallel-reviewer.ts` (5 sites)
- `packages/engine/src/agents/planner.ts` (planning:* emitters)
- `packages/engine/src/agents/plan-reviewer.ts` (planning:review:* emitters)
- `packages/engine/src/pipeline/git-helpers.ts` (`build:files_changed`, 2 sites)
- `packages/engine/src/pipeline/stages/compile-stages.ts` (planning:* + planning:cohesion:* + planning:architecture:*)
- `packages/engine/src/pipeline/stages/build-stages.ts` (switch cases on build:*)
- `packages/engine/src/pipeline/error-translator.ts` (`build:failed`)
- `packages/engine/src/orchestrator/phases.ts` (`build:failed`, `merge:*`, `schedule:*`)
- `packages/engine/src/eforge.ts` (`build:failed`, `plan:warning` emitters, planning emitters)
- `packages/engine/src/retry.ts` (continuation events)

**Consumers:**
- `packages/eforge/src/cli/display.ts` — switch cases for every renamed event (~50 case branches across build/plan/planning/merge).
- `packages/monitor-ui/src/lib/reducer.ts` — plan-status state machine cases (currently keyed off `build:*`); `state.reviewIssues[planId]` pull from `build:review:complete` and `build:test:complete`.
- `packages/monitor-ui/src/components/timeline/event-card.tsx` — title/label rendering for each event.
- `packages/monitor/src/server.ts` — event-count queries (`db.getEventsByTypeForSession(sessionId, 'build:*')` etc.).
- `packages/monitor/src/recorder.ts` — `event.type === 'build:files_changed'` diff extraction.

**Tests (rename event-string assertions):**
- `test/hooks.test.ts`, `test/files-changed-event.test.ts`, `test/monitor-*.test.ts`, `test/session-stream.test.ts`, plus any compile/build pipeline tests that assert on event types.

**Daemon HTTP version bump:**
- `packages/client/src/api-version.ts` — bump `DAEMON_API_VERSION` (event names are part of the SSE payload contract).

**Local user hook config (already partly updated this session):**
- `~/.config/eforge/config.yaml` — already migrated to `session:end` for notifications, no further change required.

### Explicitly NOT in scope

- No back-compat aliases or shim layer.
- No SQLite data migration; pre-rename historical event rows will retain their old `type` strings. The user has accepted this. New queries use only the new names.

## Acceptance Criteria

End-to-end checks before considering the rename done:

1. `pnpm type-check` — TypeScript will catch every mismatched switch case in display.ts, reducer.ts, event-card.tsx, server.ts, recorder.ts, and stages.
2. `pnpm test` — tests assert on event-type strings; will fail for any missed rename. Update assertions to new names.
3. `pnpm build` — confirm bundle succeeds for all workspace packages.
4. Restart the daemon (use the `eforge-daemon-restart` skill) and run a small expedition end-to-end (e.g. a 2-plan PRD). Verify in the monitor UI:
   - Each plan transitions through implement → review → evaluate → complete in the per-plan card.
   - Exactly one `session:end` is emitted (where the user's notification hook now fires).
   - Exactly one `plan:build:complete` per plan (no longer named `build:complete`).
   - `planning:complete` fires once with the plan-set, not per plan.
5. Tail `~/.config/eforge/hooks/notify-build.sh` log (or pushover history) to confirm one notification per run.
6. Inspect a recorded SSE stream for the run via `packages/client` — confirm no event type still uses the bare `build:` or per-plan `merge:` (other than `merge:finalize:*`).
