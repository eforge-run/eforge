---
id: plan-01-event-id-renames
name: Rename Event IDs Across Engine, Consumers, and Tests
depends_on: []
branch: event-id-renames/rename
agents:
  builder:
    effort: xhigh
    rationale: Coordinated discriminated-union rename across ~25 emitter sites,
      multiple consumer subsystems (CLI display, monitor-ui reducer, monitor
      server, recorder), and tests. The builder must apply every rename
      consistently and resist the temptation to add aliases or compat shims.
      Type errors are the verification net but only catch missed sites - the
      builder still needs to reason about scope semantics (e.g. not renaming
      merge:finalize:*, splitting schedule:* by scope, introducing
      plan:build:progress).
  reviewer:
    effort: high
    rationale: "Reviewer must verify exhaustive coverage of the rename table (24
      build:* + 4 merge:* + 1 schedule:ready + ~25 planning:* renames) and
      confirm no bare build: or per-plan merge: strings survived in any layer
      (events.ts union, emitters, switch cases, test assertions, monitor
      queries, SSE recorders, hook config docs)."
  evaluator:
    effort: high
    rationale: Evaluator must confirm DAEMON_API_VERSION was bumped (HTTP contract
      change) and that no compat aliases were introduced - the user explicitly
      asked for a clean break.
---

# Rename Event IDs Across Engine, Consumers, and Tests

## Architecture Context

The `EforgeEvent` discriminated union in `packages/engine/src/events.ts` is the single source of truth for every event the engine emits. Consumers (CLI display, monitor server queries, monitor-ui reducer, SSE recorder, hook scripts, tests) all switch on `event.type` string literals.

The current taxonomy has two structural problems:

1. **`build:*` reads as session-scoped but is per-plan.** All variants carry `planId` and fire once per plan from `runBuildPipeline`. Hooks listening on `build:complete` therefore fire N times per run.
2. **`plan:*` is actually planning-phase activity, not per-plan.** `plan:start`, `plan:complete`, `plan:review:*`, `plan:evaluate:*` fire **once per planning phase** with payloads like `plans: PlanFile[]` rather than `planId`.

Going forward, prefixes carry scope unambiguously:

| Scope | Prefix | Payload corroboration |
|-------|--------|-----------------------|
| Run-wide envelope | `session:` | `sessionId` |
| Per-command (compile or build) | `phase:` | `runId` |
| Compile-phase activity (one set per phase) | `planning:` | `plans: PlanFile[]` |
| Per-plan artifact lifecycle | `plan:` | `planId` |
| Feature-branch finalization (run-wide) | `merge:finalize:` | run-scoped (unchanged) |
| Per-agent invocation | `agent:` | `agentId` (unchanged) |
| Expedition wave/module orchestration | `expedition:` | `wave` / `moduleId` (unchanged) |

The user has confirmed there are no external consumers, so this is a clean break - no compat shims, no aliases, no DB migration. Pre-rename historical event rows in SQLite retain their old `type` strings; new queries use only the new names.

## Implementation

### Overview

Apply the rename in three coordinated waves within the same plan (TypeScript will guide you between them):

1. **Update the discriminated union** in `packages/engine/src/events.ts` - rename every variant per the rename tables below and add the new `plan:build:progress` variant. This will produce TypeScript errors at every emitter and consumer.
2. **Update emitters** across the engine source files listed in Files → Modify so they emit the new names. Replace the cross-namespace leak at `pipeline/runners.ts:221` with `plan:build:progress`.
3. **Update consumers** - CLI display switch cases, monitor-ui reducer state machine cases, monitor server event-count queries, SSE recorder type checks, and every test that asserts on event-type strings.
4. **Bump `DAEMON_API_VERSION`** in `packages/client/src/api-version.ts` because event names are part of the SSE payload contract.

At each step, run `pnpm type-check` to drive out the next batch of fixes. When type-check is clean, run `pnpm test` to surface any test assertions still using old names.

### Key Decisions

1. **Single atomic plan, not multiple ordered plans.** Splitting the type definition change from its consumer updates would leave intermediate states with thousands of TypeScript errors. The PRD's own scope rule is non-negotiable: "never split a type change from the updates to its consumers."

2. **No compat shims, no aliases, no migration.** The user explicitly accepted historical SQLite rows retaining old `type` strings. Do not introduce any layer that translates old names to new names. The codebase becomes simpler, not more complex.

3. **Add `plan:build:progress` rather than letting the leak migrate.** `plan:progress` currently fires from inside `runBuildPipeline` (post-parallel-group auto-commit failure) at `packages/engine/src/pipeline/runners.ts:221`. After the planning rename, that line would emit `planning:progress` from the build pipeline, which is wrong. Introduce `plan:build:progress { planId: string; message: string }` in the events union and emit that instead.

4. **`merge:finalize:*` stays as-is.** The `:finalize` infix already separates run-scoped feature-branch merges from per-plan merges. Renaming it would conflate scopes again.

5. **Split `schedule:*` by scope.** `schedule:start` carries `planIds: string[]` and is session-scoped - keep as `schedule:start`. `schedule:ready` carries a single `planId` and is per-plan - rename to `plan:schedule:ready`.

## Scope

### In Scope

#### Rename table - `build:*` → `plan:build:*` (24 events, all carry `planId`)

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

#### Rename table - `merge:*` (per-plan) → `plan:merge:*`

```
merge:start                  → plan:merge:start
merge:complete               → plan:merge:complete
merge:resolve:start          → plan:merge:resolve:start
merge:resolve:complete       → plan:merge:resolve:complete
```

`merge:finalize:start`, `merge:finalize:complete`, `merge:finalize:skipped` are run-scoped and **stay as-is**.

#### Rename - `schedule:*` (split by scope)

```
schedule:start    (session-scoped, planIds: string[])  → keep as schedule:start
schedule:ready    (per-plan, planId)                   → plan:schedule:ready
```

#### Rename table - `plan:*` (planning-phase activity) → `planning:*`

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

#### New event variant

Add to `packages/engine/src/events.ts`:

```ts
{ type: 'plan:build:progress'; planId: string; message: string }
```

Emit from `packages/engine/src/pipeline/runners.ts:221` in place of the current `plan:progress` emission (the post-parallel-group auto-commit failure path).

#### Untouched namespaces (do not rename)

`session:*`, `phase:*`, `agent:*`, `expedition:*`, `config:warning`, `merge:finalize:*` are already correctly scoped.

### Out of Scope

- **No back-compat aliases or shim layer.** Do not add a translation map or alias type.
- **No SQLite data migration.** Pre-rename historical event rows retain their old `type` strings - the user has accepted this. New queries use only the new names.
- **No changes to local user hook config.** `~/.config/eforge/config.yaml` was already migrated to `session:end` for notifications in a prior session.
- **No new event variants beyond `plan:build:progress`.** This rename is a structural cleanup, not a feature change.
- **No changes to CHANGELOG.md.** Per project policy, CHANGELOG is owned by the release flow.

## Files

### Create

No new files. The new `plan:build:progress` variant is added to the existing union in `packages/engine/src/events.ts`.

### Modify

**Type definitions (1 file):**
- `packages/engine/src/events.ts` - rename every union variant per the tables above, add the new `plan:build:progress` variant, update section comments to reflect the new scope contract.

**Engine emitters (~21 files):**
- `packages/engine/src/pipeline/runners.ts` - rename `build:start` and `build:complete` emitters; replace the `plan:progress` emission at line 221 with `plan:build:progress`.
- `packages/engine/src/agents/builder.ts` - rename 5 `build:implement:*` emit sites.
- `packages/engine/src/agents/tester.ts` - rename 4 `build:test:*` emit sites.
- `packages/engine/src/agents/doc-updater.ts` - rename 2 `build:doc-update:*` emit sites.
- `packages/engine/src/agents/reviewer.ts` - rename `build:review:start` and `build:review:complete` emit sites to their `plan:build:review:*` equivalents.
- `packages/engine/src/agents/review-fixer.ts` - rename 2 `build:review:fix:*` emit sites.
- `packages/engine/src/agents/parallel-reviewer.ts` - rename 5 `build:review:parallel:*` and `build:review:*` emit sites.
- `packages/engine/src/agents/planner.ts` - rename all `plan:*` planning-phase emitters to `planning:*` (includes `plan:start` at line 165, `plan:complete` at line 322, plus warning/error/clarification/progress/continuation/pipeline/submission/skip emitters).
- `packages/engine/src/agents/plan-reviewer.ts` - rename `plan:review:start` / `plan:review:complete` emitters to `planning:review:start` / `planning:review:complete`.
- `packages/engine/src/agents/plan-evaluator.ts` - rename the `startEvent` / `completeEvent` string-literal constants for `plan:evaluate:*`, `plan:cohesion:evaluate:*`, and `plan:architecture:evaluate:*` to their `planning:*` counterparts.
- `packages/engine/src/agents/architecture-reviewer.ts` - rename `plan:architecture:review:start` and `plan:architecture:review:complete` emit sites to `planning:architecture:review:*`.
- `packages/engine/src/agents/cohesion-reviewer.ts` - rename `plan:cohesion:start` and `plan:cohesion:complete` emit sites to `planning:cohesion:*`.
- `packages/engine/src/agents/pipeline-composer.ts` - rename any `plan:*` planning-phase emit sites present here to their `planning:*` counterparts.
- `packages/engine/src/pipeline/git-helpers.ts` - rename 2 `build:files_changed` emit sites to `plan:build:files_changed`.
- `packages/engine/src/pipeline/stages/compile-stages.ts` - rename `plan:*` planning-phase emitters and the `plan:cohesion:*` / `plan:architecture:*` variants to their `planning:*` counterparts.
- `packages/engine/src/pipeline/stages/build-stages.ts` - update switch cases on `build:*` event types to `plan:build:*`.
- `packages/engine/src/pipeline/error-translator.ts` - rename `build:failed` emitter to `plan:build:failed`.
- `packages/engine/src/orchestrator/phases.ts` - rename `build:failed` to `plan:build:failed`, per-plan `merge:*` to `plan:merge:*`, and `schedule:ready` to `plan:schedule:ready` (keep `schedule:start` as-is).
- `packages/engine/src/eforge.ts` - rename `build:failed`, `plan:warning` (→ `planning:warning`), and any other planning emitters present here.
- `packages/engine/src/cleanup.ts` - rename any `plan:*` planning-phase emit sites present here to their `planning:*` counterparts.
- `packages/engine/src/retry.ts` - rename continuation events (`build:implement:continuation` → `plan:build:implement:continuation`, `build:evaluate:continuation` → `plan:build:evaluate:continuation`, `plan:evaluate:continuation` → `planning:evaluate:continuation`, `plan:architecture:evaluate:continuation` → `planning:architecture:evaluate:continuation`, `plan:cohesion:evaluate:continuation` → `planning:cohesion:evaluate:continuation`).

Note: the file list above expands the PRD's "9 files / ~25 sites" figure after grep verification. Additional emit sites may still exist - the `pnpm type-check` pass against the updated discriminated union is the authoritative completeness gate.

**Consumers (5 files):**
- `packages/eforge/src/cli/display.ts` - update switch cases for every renamed event (~50 case branches across `build:*`, `plan:*` planning, per-plan `merge:*`, and `schedule:ready`).
- `packages/monitor-ui/src/lib/reducer.ts` - update plan-status state-machine cases (currently keyed off `build:*`); update `state.reviewIssues[planId]` extraction from `build:review:complete` and `build:test:complete` to their `plan:build:*` equivalents.
- `packages/monitor-ui/src/components/timeline/event-card.tsx` - update title/label rendering for each renamed event.
- `packages/monitor/src/server.ts` - update event-count queries (`db.getEventsByTypeForSession(sessionId, 'build:*')` etc.) to use new names.
- `packages/monitor/src/recorder.ts` - update `event.type === 'build:files_changed'` diff extraction check to `plan:build:files_changed`.

**Tests (rename event-string assertions):**
- `test/hooks.test.ts` - update event-type assertions to new names.
- `test/files-changed-event.test.ts` - update `build:files_changed` assertions to `plan:build:files_changed`.
- `test/monitor-*.test.ts` - update any event-type assertions.
- `test/session-stream.test.ts` - update event-type assertions.
- Any compile/build pipeline tests that assert on event types - run `pnpm test` to discover and update.

**Daemon HTTP version bump (1 file):**
- `packages/client/src/api-version.ts` - bump `DAEMON_API_VERSION` because event names are part of the SSE payload contract.

## Verification

- [ ] `pnpm type-check` exits with zero errors after all renames are applied.
- [ ] `pnpm test` exits with zero failures; every test asserting on an event-type string uses the new name.
- [ ] `pnpm build` produces a successful bundle for all workspace packages.
- [ ] Grep for `'build:` (single-quoted) and `"build:` (double-quoted) across `packages/` returns zero matches outside of `packages/engine/src/events.ts` comments referring to historical naming, and zero matches in switch/case branches anywhere.
- [ ] Grep for `'plan:start'`, `'plan:complete'`, `'plan:review:`, `'plan:evaluate:`, `'plan:architecture:`, `'plan:cohesion:`, `'plan:warning'`, `'plan:progress'`, `'plan:continuation'`, `'plan:submission'`, `'plan:skip'`, `'plan:error'`, `'plan:clarification'`, `'plan:pipeline'` returns zero matches across `packages/` (these are now `planning:*`).
- [ ] Grep for `'merge:start'`, `'merge:complete'`, `'merge:resolve:` returns zero matches across `packages/` (these are now `plan:merge:*`); `'merge:finalize:` matches are preserved.
- [ ] Grep for `'schedule:ready'` returns zero matches; `'plan:schedule:ready'` is present in emitters and consumers.
- [ ] `packages/engine/src/events.ts` discriminated union contains a `plan:build:progress` variant with shape `{ type: 'plan:build:progress'; planId: string; message: string }`.
- [ ] `packages/engine/src/pipeline/runners.ts` line ~221 emits `plan:build:progress` (not `plan:progress` and not `planning:progress`) for the post-parallel-group auto-commit failure path.
- [ ] `packages/client/src/api-version.ts` `DAEMON_API_VERSION` is incremented from its previous value.
- [ ] Zero compat aliases, translation maps, or shim layers exist anywhere in the diff. Searching the diff for `// alias`, `// compat`, `legacy`, `oldName`, or `translateEventType` returns no matches introduced by this plan.
- [ ] After `pnpm build` succeeds, restart the daemon via the `eforge-daemon-restart` skill and run a small expedition (e.g. a 2-plan PRD) end-to-end. In the monitor UI, verify: (a) each plan transitions through implement → review → evaluate → complete in its per-plan card; (b) exactly one `session:end` event is emitted per run; (c) exactly one `plan:build:complete` event per plan; (d) exactly one `planning:complete` event per run carrying the full plan-set.
- [ ] Tail `~/.config/eforge/hooks/notify-build.sh` log (or pushover history) after the test expedition - confirm exactly one notification per run, not N per run.
- [ ] Inspect a recorded SSE stream for the test run via `packages/client` - confirm zero events with bare `build:` prefix and zero per-plan events with bare `merge:` prefix (other than the run-scoped `merge:finalize:*` events).
