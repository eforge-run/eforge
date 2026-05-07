---
id: plan-01-mutation-sweep
name: W6 daemon mutation sweep and enqueue:complete typed-field cleanup
branch: w6-async-daemon-mutation-sweep/plan-01-mutation-sweep
agents:
  builder:
    effort: high
    rationale: Builder must enumerate 23 routes, classify each, decide per-route
      result-channel semantics, and ripple a typed schema field through 4+
      producer/consumer sites. The typed-field rename has multiple consumers and
      the audit requires careful classification - high effort fits.
  reviewer:
    effort: high
    rationale: Reviewer must verify every one of the 23 routes is in the audit,
      classification is accurate, and no consumer of enqueue:complete still
      references event.title for the planSet derivation.
---

# W6 daemon mutation sweep and enqueue:complete typed-field cleanup

## Architecture Context

This is the remaining Wave 3 maintenance sweep in the event-source refactor. W3 (`stream:hello` SSE handshake) has landed (`packages/monitor/src/sse-handshake.ts` exists with 11 passing tests), unblocking W6. The event-schema spine has also landed: `packages/client/src/events.schemas.ts` is the wire-protocol source of truth and `EforgeEvent` is `z.infer`'d from it; `packages/client/src/event-registry.ts` carries persistence/projection/summary metadata for every event variant.

The daemon HTTP surface in `packages/monitor/src/server.ts` uses a manual dispatch pattern (`if (req.method === 'POST' && url === API_ROUTES.X)`), not Express. There are exactly **23** mutating handlers (POST or DELETE) in this file - this matches the source's count and was verified by grep:

```
keepAlive, enqueue, cancel, recover, applyRecovery, daemonStop, autoBuildSet,
schedulerKick, profileUse, profileCreate, profileDelete, playbookSave,
playbookEnqueue, playbookPromote, playbookDemote, playbookValidate,
playbookCopy, sessionPlanCreate, sessionPlanSetSection, sessionPlanSkipDimension,
sessionPlanSetStatus, sessionPlanSelectDimensions, sessionPlanMigrateLegacy
```

Key existing infrastructure:

- `WorkerTracker` lives in `packages/monitor/src/server-main.ts` (`createWorkerTracker`, line 357). All `spawn()` / `detached: true` usage is centralized there - `server.ts` has zero direct `spawn(`/`detached:` hits. Routes call `options.workerTracker.spawnWorker(command, args, onExit?)` and receive `{ sessionId, pid }`.
- `emitMutation(state, reason)` (server.ts lines 78-87) injects a `queue:mutation` event with `reason: 'enqueue' | 'playbook-enqueue' | 'apply-recovery' | 'external'` to wake the scheduler.
- `enqueue:complete` is currently emitted by `packages/engine/src/eforge.ts` (lines 466-472) with `{ id, filePath, title }`. The recorder (`packages/monitor/src/recorder.ts` line 108) stores `event.title` as `runs.plan_set`; the registry (`packages/client/src/event-registry.ts` line 957) projects `planSet: event.title` onto `state.runs[].planSet`. Both are post-hoc derivations from a display field.

Design constraints (from AGENTS.md and source):

- Engine emits, consumers render. Engine MUST NOT write to stdout; events must flow through `EforgeEvent`.
- All event variants and Zod schemas live in `packages/client/src/events.schemas.ts` only - never define event shapes elsewhere.
- All engine commits use `forgeCommit()` from `packages/engine/src/git.ts` (this plan does not add new commits but the constraint applies to any helper changes).
- Out of scope: redesigning queue/scheduler control flow, adding new daemon mutations, replacing worker-based enqueue/recovery if their session/event streams are already documented as the result channel.

## Implementation

### Overview

Two coordinated workstreams in a single plan because the audit may discover the need for a new `mutation:*` result event - which would touch the same schema/registry surface as the typed-field cleanup. Keeping them together avoids merge drift.

**Workstream A - Route audit and hardening:**

1. Read every one of the 23 mutating handlers in `packages/monitor/src/server.ts` and classify it as one of:
   - **synchronous** - awaits all mutation work before responding 2xx; success is observable on return.
   - **async-with-existing-result-channel** - delegates to a worker; the worker session's event stream / sidecar JSON is the documented result channel.
   - **async-needs-new-result-event** - currently returns success before the mutation is observable AND has no documented result channel; needs a fix.
   - **no-mutation** - read-only despite the verb (rare; e.g., `keepAlive` only updates an in-memory counter).
2. For every handler classified `synchronous` or `async-with-existing-result-channel`, the audit row must name the awaited operation(s) or the result channel (e.g., "worker session events for sessionId; recovery sidecar at .eforge/recovery/<set>/<prd>.json").
3. For any handler classified `async-needs-new-result-event`, fix it. Preference order:
   - **First**: convert to synchronous if the underlying operation is short and idempotent.
   - **Last resort**: introduce a typed result event (e.g., `mutation:result` with discriminant fields) AND add it to `events.schemas.ts` + `event-registry.ts` with persist/project/summary metadata.
4. Verify by grep that the post-implementation `server.ts` still has zero `spawn(`/`detached:` hits, OR each remaining indirect worker spawn path is covered by the audit with its result channel named.
5. Write the audit log to `docs/daemon-mutation-audit.md` (tracked - `tmp/` is gitignored per the source). Format: a markdown table with columns `Route | Method | Handler line | Classification | Result channel | Change made (if any)` followed by per-route notes for any non-trivial decision.

**Workstream B - enqueue:complete typed payload field:**

1. Decide the typed-field name. The recorder's `runs.plan_set` semantic is "the plan-set/title that this enqueue belongs to" - the same string currently extracted from `title`. The clean rename is to add `planSet: z.string()` to the `enqueue:complete` schema. (If the audit determines that `runs.plan_set` actually wants the queue PRD id rather than the plan-set name, use `prdId` instead - document the decision in the audit doc and in the plan body's commit. The default chosen here is `planSet: string`.)
2. Extend the Zod schema in `packages/client/src/events.schemas.ts` (lines 848-853): add `planSet: z.string()` to the `enqueue:complete` discriminant. Do not remove `title` - `title` is the display field and the registry summary `Enqueued: ${e.title}` should keep using it.
3. Update the engine emit site in `packages/engine/src/eforge.ts` (lines 466-472) to populate `planSet` (e.g., from the existing `enqueueResult.planSet` or the PRD's plan-set name; the engine already knows this value because `enqueue:start` carries it). The emitted event must satisfy the new schema.
4. Update `packages/monitor/src/recorder.ts` line 108 to call `db.updateRunPlanSet(enqueueRunId, event.planSet)` instead of `event.title`.
5. Update `packages/client/src/event-registry.ts` line 957 (the `enqueue:complete` `project` function) to map `planSet: event.planSet` instead of `planSet: event.title`. Keep `summary: (e) => `Enqueued: ${e.title}`` unchanged - that one is display, not derivation.
6. Audit the other 14 files that import `enqueue:complete` (per grep): `packages/engine/src/session.ts`, `packages/eforge/src/cli/run-or-delegate.ts`, `packages/eforge/src/cli/display.ts`, `packages/monitor-ui/src/lib/reducer/handle-enqueue.ts`, `packages/monitor-ui/src/lib/reducer/index.ts`, `packages/monitor-ui/src/components/timeline/event-card.tsx`, plus the test files. Update any consumer that currently reads `event.title` to derive a plan-set value; leave consumers using `event.title` for display alone.
7. The grep gate `grep -n 'planSet: event.title' packages/client/src/event-registry.ts` must return zero hits after this plan lands.

### Key Decisions

1. **Single plan, not two parallel plans.** The audit may add a new `mutation:*` result event whose schema lives in the same file the typed-field cleanup touches. Splitting them risks merge conflicts in `events.schemas.ts` and `event-registry.ts`. Keeping them together also lets one round of review verify all event-schema additions land coherently.

2. **Typed field is `planSet: string`, not `prdId`.** The current recorder writes the `title` value to `runs.plan_set`, and the registry projects it as `state.runs[].planSet`. The semantic is "plan-set name," not "queue entry id." The PRD id is already available as `event.id` (the existing field). If the builder's reading of the recorder/UI surface contradicts this, the builder must record the alternative decision in `docs/daemon-mutation-audit.md` and update the schema/consumers accordingly - but the default is `planSet`.

3. **Keep `title` for display.** `title` remains in the schema; only the post-hoc derivation is removed. The registry summary `Enqueued: ${e.title}` and any UI rendering of the title stay as-is.

4. **Audit lives in `docs/daemon-mutation-audit.md` (tracked), not `tmp/`.** The source notes `tmp/` is gitignored. Tracked location ensures the audit survives merges and is reviewable.

5. **No `app.post()` refactor.** The codebase uses manual dispatch (`if (req.method === 'POST' && url === API_ROUTES.X)`). Do not introduce a router framework - that is queue/scheduler scope creep per AGENTS.md and the source's out-of-scope list.

6. **Existing worker-based routes count as "async-with-existing-result-channel" only when explicitly documented in the audit.** `enqueue` (line 1228) emits `queue:mutation` via the `onExit` callback and the worker emits the full session event stream including `enqueue:complete` - this is the documented result channel and the audit must say so. `recover` (line 1344) currently has no `onExit` callback and writes a sidecar JSON; the audit must explicitly name the sidecar path as the result channel and consider whether adding an `onExit` callback (parity with `enqueue`) is worth doing - this is the most likely route to need a fix.

## Scope

### In Scope

- Audit and classify all 23 mutating handlers in `packages/monitor/src/server.ts`.
- Fix any handler that returns a misleading success response (target: zero such handlers post-merge, or each remaining one explicitly justified in the audit).
- Add `planSet: z.string()` to the `enqueue:complete` Zod schema in `packages/client/src/events.schemas.ts`.
- Populate `planSet` at the engine emit site in `packages/engine/src/eforge.ts`.
- Replace `db.updateRunPlanSet(enqueueRunId, event.title)` with `event.planSet` in `packages/monitor/src/recorder.ts`.
- Replace `planSet: event.title` with `planSet: event.planSet` in the `enqueue:complete` projection in `packages/client/src/event-registry.ts`.
- Update any other consumer that derives `planSet` (or equivalent) from `event.title`.
- Add tests for the new schema field, the recorder DB update, and any route whose semantics changed.
- Write `docs/daemon-mutation-audit.md` enumerating all 23 routes with classifications and decisions.
- If the audit drives addition of a new `mutation:*` result event, add the schema, registry entry (persist/project/summary), and at least one test.

### Out of Scope

- Reworking queue/scheduler control flow.
- Adding new daemon mutations (other than a `mutation:*` result event ONLY if the audit forces it).
- Replacing worker-based enqueue/recovery execution if their session/event streams are documented as the result channel.
- Migrating the manual dispatch pattern to Express/Fastify/etc.
- Changes to W4 (`RunInfo` row/API/UI type unification) - that is a parallel waveplan.
- Editing `CHANGELOG.md` (managed by release flow per memory).
- Bumping `packages/pi-eforge/package.json` version (managed at publish).

## Files

### Create

- `docs/daemon-mutation-audit.md` - audit log of all 23 mutating routes with classification, result channel, and change made. Becomes the durable artifact required by acceptance criterion #1.

### Modify

- `packages/client/src/events.schemas.ts` - add `planSet: z.string()` to the `enqueue:complete` schema (currently lines 848-853). If a new `mutation:*` result event is needed, define its schema here too.
- `packages/client/src/event-registry.ts` - in the `enqueue:complete` registry entry (lines 945-963), change the `project` function from `planSet: event.title` to `planSet: event.planSet`. If a new `mutation:*` event is added, add its registry entry (`scope`, `persist`, `summary`, `project`).
- `packages/engine/src/eforge.ts` - update the `enqueue:complete` emit site (lines 466-472) to include `planSet: <plan-set name>`. Use the existing local that `enqueue:start` already populates.
- `packages/monitor/src/recorder.ts` - line 108: change `db.updateRunPlanSet(enqueueRunId, event.title)` to `db.updateRunPlanSet(enqueueRunId, event.planSet)`.
- `packages/monitor/src/server.ts` - apply any route fix(es) the audit identifies. Most plausible target: `recover` (line 1344) gaining an `onExit` callback parity with `enqueue`. Other routes likely require zero behavior change once the audit confirms their result-channel decision.
- `packages/engine/src/session.ts` - if it constructs or re-emits `enqueue:complete`, ensure `planSet` is populated.
- `packages/eforge/src/cli/run-or-delegate.ts` and `packages/eforge/src/cli/display.ts` - if they read `event.title` to derive a plan-set value (not for display), switch to `event.planSet`. Display usage of `title` stays.
- `packages/monitor-ui/src/lib/reducer/handle-enqueue.ts` and `packages/monitor-ui/src/lib/reducer/index.ts` - same rule: derivations switch to `planSet`, display stays on `title`.
- `packages/monitor-ui/src/components/timeline/event-card.tsx` - same rule.
- `test/monitor-recording.test.ts` - update fixtures so emitted `enqueue:complete` events carry `planSet`; add a test asserting recorder writes `event.planSet` (not `event.title`) into `runs.plan_set`.
- `test/monitor-reducer.test.ts` - update fixture events to carry `planSet`; add a test that the reducer projection uses `event.planSet`.
- `test/session.test.ts` - update if it asserts the `enqueue:complete` shape.
- `packages/monitor-ui/src/lib/reducer/__tests__/handle-enqueue.test.ts` - update fixtures and add coverage for `planSet`.
- `packages/client/src/__tests__/events-schemas.test.ts` - add a test that an `enqueue:complete` event without `planSet` fails Zod parsing.
- For any route whose semantics changed, add a regression test under `test/` or `packages/monitor/src/__tests__/` (e.g., extend `test/apply-recovery-route.test.ts` patterns).

## Verification

- [ ] `docs/daemon-mutation-audit.md` exists, lists exactly 23 routes (one row per handler), and every row names a result channel or the change made.
- [ ] No row in `docs/daemon-mutation-audit.md` is classified `async-needs-new-result-event` post-implementation - every such row from the initial audit was either fixed (synchronous or new typed event) or downgraded to `async-with-existing-result-channel` with the channel named.
- [ ] `grep -n 'spawn(' packages/monitor/src/server.ts` returns zero hits.
- [ ] `grep -n 'detached:' packages/monitor/src/server.ts` returns zero hits.
- [ ] `grep -n 'planSet: event.title' packages/client/src/event-registry.ts` returns zero hits.
- [ ] `grep -n 'event.title' packages/monitor/src/recorder.ts` returns zero hits inside the `enqueue:complete` branch (lines around 108).
- [ ] The `enqueue:complete` Zod schema in `packages/client/src/events.schemas.ts` includes `planSet: z.string()` and `EforgeEventSchema.parse({ type: 'enqueue:complete', timestamp: '...', id: 'x', filePath: 'y', title: 'z' })` throws (missing `planSet`).
- [ ] The engine emit site at `packages/engine/src/eforge.ts:466-472` populates `planSet` with a non-empty string value.
- [ ] `packages/monitor/src/recorder.ts` line 108 (or its post-edit equivalent) reads `event.planSet`, not `event.title`.
- [ ] `pnpm type-check` exits with code 0.
- [ ] `pnpm test` exits with code 0 (or, if scoped, both `pnpm --filter @eforge-build/client test` and `pnpm --filter @eforge-build/monitor test` and the root `vitest run` exit with code 0).
- [ ] At least one new test asserts the recorder writes `event.planSet` into `runs.plan_set`.
- [ ] At least one new test asserts the `enqueue:complete` Zod schema rejects events missing `planSet`.
- [ ] If a new `mutation:*` event was introduced, it is present in `events.schemas.ts`, `event-registry.ts` (with `persist`, `project`, `summary`), and has at least one round-trip test.
- [ ] `enqueue:complete`'s `summary` in `event-registry.ts` still reads `Enqueued: ${e.title}` (display field unchanged).
